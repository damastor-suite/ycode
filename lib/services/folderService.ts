/**
 * Folder Service
 *
 * Business logic for page folder operations
 */

import type { Knex } from 'knex';

import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  getConflictColumns,
  resolveTenantIdForTable,
} from '@/lib/repositories/knex-repository-utils';
import type { PageFolder } from '@/types';

/**
 * Result of folder publishing operation
 */
export interface PublishFoldersResult {
  count: number;
}

/**
 * Collect ancestor folder IDs for given page folder IDs
 * Traverses up the folder tree to ensure all parent folders are published
 */
async function collectAncestorFolderIds(
  pageIds: string[],
  db: Knex
): Promise<Set<string>> {
  const folderIdsToPublish = new Set<string>();

  // Fetch pages to get their folder IDs
  let pagesQuery = db('pages')
    .select('page_folder_id')
    .whereIn('id', pageIds)
    .where('is_published', false)
    .whereNull('deleted_at');
  pagesQuery = await addTenantFilter(db, pagesQuery, 'pages');
  const pagesToPublish = await pagesQuery as Array<{ page_folder_id: string | null }>;

  // Get all draft folders to traverse ancestors
  let foldersQuery = db('page_folders')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at');
  foldersQuery = await addTenantFilter(db, foldersQuery, 'page_folders');
  const allDraftFolders = await foldersQuery as PageFolder[];

  const foldersById = new Map<string, PageFolder>(
    allDraftFolders.map((f: PageFolder) => [f.id, f])
  );

  // Collect all ancestor folder IDs
  const collectAncestors = (folderId: string | null): void => {
    if (!folderId) return;
    const folder = foldersById.get(folderId);
    if (folder) {
      folderIdsToPublish.add(folder.id);
      collectAncestors(folder.page_folder_id);
    }
  };

  for (const page of pagesToPublish) {
    if (page.page_folder_id) {
      collectAncestors(page.page_folder_id);
    }
  }

  return folderIdsToPublish;
}

/**
 * Publish folders by their IDs
 * Handles soft-deleted folders and sorts by depth to ensure parents are published first
 *
 * @param folderIds - Array of folder IDs to publish (empty array = publish all)
 * @param pageIds - Optional array of page IDs to collect ancestor folders from
 * @returns Number of folders published
 */
export async function publishFolders(
  folderIds: string[] = [],
  pageIds?: string[]
): Promise<PublishFoldersResult> {
  const db = await getDb();

  const isPublishingAll = folderIds.length === 0;
  const folderIdsToPublish = new Set<string>(folderIds);

  // Collect ancestor folders if page IDs provided
  if (!isPublishingAll && pageIds && pageIds.length > 0) {
    const ancestorIds = await collectAncestorFolderIds(pageIds, db);
    ancestorIds.forEach(id => folderIdsToPublish.add(id));
  }

  // Skip if no folders to publish
  if (!isPublishingAll && folderIdsToPublish.size === 0) {
    return { count: 0 };
  }

  // Get all draft folders (including soft-deleted for cleanup)
  let draftFoldersQuery = db('page_folders')
    .select('*')
    .where('is_published', false);
  draftFoldersQuery = await addTenantFilter(db, draftFoldersQuery, 'page_folders');
  const allDraftFolders = await draftFoldersQuery as PageFolder[];

  // Filter folders based on request
  const foldersToProcess = isPublishingAll
    ? allDraftFolders
    : allDraftFolders.filter((f: PageFolder) => folderIdsToPublish.has(f.id));

  // Separate active and soft-deleted folders
  const activeFolders = foldersToProcess.filter((f: PageFolder) => f.deleted_at === null);
  const softDeletedFolders = foldersToProcess.filter((f: PageFolder) => f.deleted_at !== null);

  // Get existing published folders (need full data to verify parent relationships)
  const folderIdsToCheck = foldersToProcess.map((f: PageFolder) => f.id);
  
  // Also get all parent folder IDs that we might need to reference
  const parentFolderIds = new Set<string>();
  foldersToProcess.forEach((f: PageFolder) => {
    if (f.page_folder_id) {
      parentFolderIds.add(f.page_folder_id);
    }
  });
  
  const allIdsToCheck = [...new Set([...folderIdsToCheck, ...parentFolderIds])];

  // Fetch all published folders we need to reference
  let existingPublishedQuery = db('page_folders')
    .select('*')
    .where('is_published', true)
    .whereIn('id', allIdsToCheck);
  existingPublishedQuery = await addTenantFilter(db, existingPublishedQuery, 'page_folders');
  const existingPublished = allIdsToCheck.length > 0
    ? await existingPublishedQuery as PageFolder[]
    : [];

  const publishedFoldersById = new Map<string, PageFolder>(
    existingPublished.map((f: PageFolder) => [f.id, f])
  );
  const publishedIds = new Set(publishedFoldersById.keys());

  if (folderIdsToCheck.length > 0) {
    // Soft-delete published versions of soft-deleted drafts
    const idsToSoftDelete = softDeletedFolders
      .filter((f: PageFolder) => publishedIds.has(f.id))
      .map((f: PageFolder) => f.id);

    if (idsToSoftDelete.length > 0) {
      let softDeleteQuery = db('page_folders')
        .update({ deleted_at: new Date().toISOString() })
        .where('is_published', true)
        .whereIn('id', idsToSoftDelete)
        .whereNull('deleted_at');
      softDeleteQuery = await addTenantFilter(db, softDeleteQuery, 'page_folders');
      await softDeleteQuery;
    }
  }

  // Sort active folders by depth (parents first)
  const sortedFolders = [...activeFolders].sort(
    (a: PageFolder, b: PageFolder) => (a.depth || 0) - (b.depth || 0)
  );

  // Track folders being published in this batch
  const foldersBeingPublished = new Set<string>();

  // Prepare folders to upsert, resolving parent folder IDs to published versions
  const foldersToUpsert: Array<{
    id: string;
    name: string;
    slug: string;
    page_folder_id: string | null;
    order: number | null;
    depth: number;
    settings: PageFolder['settings'];
    is_published: boolean;
  }> = [];

  for (const folder of sortedFolders) {
    let publishedParentId: string | null = null;
    
    if (folder.page_folder_id) {
      // Check if parent is already published or being published in this batch
      const parentIsPublished = publishedFoldersById.has(folder.page_folder_id);
      const parentIsInBatch = foldersBeingPublished.has(folder.page_folder_id);
      
      if (!parentIsPublished && !parentIsInBatch) {
        // Parent folder is not published and not in this batch - skip this folder
        continue;
      }
      
      // Use the same ID since published folders share the same ID as drafts
      publishedParentId = folder.page_folder_id;
    }
    
    foldersBeingPublished.add(folder.id);

    // Skip if published version exists and is identical
    const existing = publishedFoldersById.get(folder.id);
    if (
      existing &&
      existing.name === folder.name &&
      existing.slug === folder.slug &&
      existing.page_folder_id === publishedParentId &&
      existing.order === folder.order &&
      existing.depth === folder.depth &&
      JSON.stringify(existing.settings) === JSON.stringify(folder.settings)
    ) {
      continue;
    }
    
    foldersToUpsert.push({
      id: folder.id,
      name: folder.name,
      slug: folder.slug,
      page_folder_id: publishedParentId,
      order: folder.order,
      depth: folder.depth,
      settings: folder.settings,
      is_published: true,
    });
  }

  if (foldersToUpsert.length === 0) {
    return { count: 0 };
  }

  const tenantId = await resolveTenantIdForTable(db, 'page_folders');
  const conflictColumns = await getConflictColumns(db, 'page_folders', ['id', 'is_published'], tenantId);
  const rows = await Promise.all(
    foldersToUpsert.map((folder) => addTenantIdToRow(db, 'page_folders', folder, tenantId ?? undefined))
  );
  await db('page_folders')
    .insert(rows)
    .onConflict(conflictColumns)
    .merge();

  return { count: foldersToUpsert.length };
}
