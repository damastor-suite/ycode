/**
 * Page Folder Repository
 *
 * Data access layer for page folder operations with Knex
 */

import type { Knex } from 'knex';

import { getDb, isMissingTableError } from '@/lib/platform/db';
import { addTenantFilter, batchUpdateColumn } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { incrementSiblingOrders } from '@/lib/services/pageService';
import type { Page, PageFolder, PageLayers } from '@/types';

/**
 * Query filters for page folder lookups
 */
export interface QueryFilters {
  [key: string]: string | number | boolean | null;
}

/**
 * Data required to create a new page folder
 */
export interface CreatePageFolderData {
  id?: string;
  name: string;
  slug: string;
  depth?: number;
  order?: number;
  settings?: Record<string, any>;
  is_published?: boolean;
  page_folder_id?: string | null;
}

/**
 * Data that can be updated on an existing page folder
 */
export interface UpdatePageFolderData {
  name?: string;
  slug?: string;
  depth?: number;
  order?: number;
  settings?: Record<string, any>;
  is_published?: boolean;
  page_folder_id?: string | null;
}

type InsertRow = Record<string, unknown>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function applyTenantFilter(
  knex: Knex,
  query: Knex.QueryBuilder,
  tableName: string,
  tenantId?: string
): Promise<Knex.QueryBuilder> {
  if (tenantId) {
    const hasColumn = await knex.schema.hasColumn(tableName, 'tenant_id');
    if (hasColumn) return query.where('tenant_id', tenantId);
  }
  return addTenantFilter(knex, query, tableName);
}

async function withTenantOnInsert<T extends InsertRow>(row: T): Promise<T> {
  const tenantId = await getTenantIdFromHeaders();
  if (!tenantId) return row;
  return { ...row, tenant_id: tenantId } as T;
}

function applyFilters(query: Knex.QueryBuilder, filters?: QueryFilters): Knex.QueryBuilder {
  if (!filters) return query;

  for (const [column, value] of Object.entries(filters)) {
    if (value === null) {
      query.whereNull(column);
    } else {
      query.where(column, value);
    }
  }

  return query;
}

/**
 * Retrieves all page folders from the database
 */
export async function getAllPageFolders(filters?: QueryFilters): Promise<PageFolder[]> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .whereNull('deleted_at')
      .orderBy('order', 'asc');
    query = applyFilters(query, filters);
    query = await applyTenantFilter(knex, query, 'page_folders');
    return await query as PageFolder[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch page folders: ${getErrorMessage(error)}`);
  }
}

/**
 * Get page folder by ID
 */
export async function getPageFolderById(id: string, isPublished = false): Promise<PageFolder | null> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .where('id', id)
      .where('is_published', isPublished)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_folders');
    return (await query.first() as PageFolder | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all child folders of a parent folder
 */
export async function getChildFolders(
  parentId: string | null,
  orderBy: 'order' | 'created_at' = 'order'
): Promise<PageFolder[]> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .whereNull('deleted_at')
      .orderBy(orderBy, 'asc');

    if (parentId === null) {
      query.whereNull('page_folder_id');
    } else {
      query.where('page_folder_id', parentId);
    }

    query = await applyTenantFilter(knex, query, 'page_folders');
    return await query as PageFolder[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch child folders: ${getErrorMessage(error)}`);
  }
}

/**
 * Create new page folder
 */
export async function createPageFolder(folderData: CreatePageFolderData): Promise<PageFolder> {
  const knex = await getDb();

  try {
    const insertData = await withTenantOnInsert({ ...folderData });
    const rows = await knex('page_folders').insert(insertData).returning('*') as PageFolder[];
    const data = rows[0];
    if (!data) throw new Error('No page folder returned');
    return data;
  } catch (error) {
    throw new Error(`Failed to create page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Update page folder
 */
export async function updatePageFolder(id: string, updates: UpdatePageFolderData): Promise<PageFolder> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .where('id', id)
      .where('is_published', false)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_folders');
    const rows = await query.update({ ...updates, updated_at: new Date().toISOString() }).returning('*') as PageFolder[];
    const data = rows[0];
    if (!data) throw new Error('Page folder not found');
    return data;
  } catch (error) {
    throw new Error(`Failed to update page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all descendant folder IDs recursively
 */
async function getDescendantFolderIdsFromDB(folderId: string): Promise<string[]> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('id', 'page_folder_id')
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_folders');
    const allFolders = await query as Array<{ id: string; page_folder_id: string | null }>;

    if (allFolders.length === 0) {
      return [];
    }

    const foldersByParent = new Map<string, string[]>();
    for (const folder of allFolders) {
      const parentId = folder.page_folder_id || 'root';
      if (!foldersByParent.has(parentId)) {
        foldersByParent.set(parentId, []);
      }
      foldersByParent.get(parentId)!.push(folder.id);
    }

    const collectDescendants = (parentId: string): string[] => {
      const children = foldersByParent.get(parentId) || [];
      const descendants: string[] = [...children];

      for (const childId of children) {
        descendants.push(...collectDescendants(childId));
      }

      return descendants;
    };

    return collectDescendants(folderId);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch folders: ${getErrorMessage(error)}`);
  }
}

/**
 * Batch update order for multiple folders
 */
export async function batchUpdateFolderOrder(updates: Array<{ id: string; order: number }>): Promise<void> {
  if (updates.length === 0) return;

  const knex = await getDb();

  try {
    await batchUpdateColumn(knex, 'page_folders', 'order',
      updates.map(u => ({ id: u.id, value: u.order })),
      {
        extraWhereClause: 'AND is_published = false AND deleted_at IS NULL',
        castType: 'integer',
      }
    );
  } catch (error) {
    throw new Error(`Failed to update folder order: ${getErrorMessage(error)}`);
  }
}

/**
 * Reorder all siblings (both pages and folders) at the same parent level
 */
export async function reorderSiblings(parentId: string | null, depth: number): Promise<void> {
  const knex = await getDb();

  let foldersQuery = knex('page_folders')
    .select('id', 'order')
    .where('depth', depth)
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('order', 'asc');

  if (parentId === null) {
    foldersQuery.whereNull('page_folder_id');
  } else {
    foldersQuery.where('page_folder_id', parentId);
  }

  foldersQuery = await applyTenantFilter(knex, foldersQuery, 'page_folders');
  const siblingFolders = await foldersQuery as Array<{ id: string; order: number | null }>;

  let pagesQuery = knex('pages')
    .select('id', 'order')
    .where('depth', depth)
    .where('is_published', false)
    .whereNull('deleted_at')
    .whereNull('error_page')
    .orderBy('order', 'asc');

  if (parentId === null) {
    pagesQuery.whereNull('page_folder_id');
  } else {
    pagesQuery.where('page_folder_id', parentId);
  }

  pagesQuery = await applyTenantFilter(knex, pagesQuery, 'pages');
  const siblingPages = await pagesQuery as Array<{ id: string; order: number | null }>;

  const allSiblings = [
    ...siblingFolders.map(f => ({ id: f.id, order: f.order ?? 0, type: 'folder' as const })),
    ...siblingPages.map(p => ({ id: p.id, order: p.order ?? 0, type: 'page' as const })),
  ].sort((a, b) => a.order - b.order);

  const folderUpdates: Array<{ id: string; order: number }> = [];
  const pageUpdates: Array<{ id: string; order: number }> = [];

  allSiblings.forEach((sibling, index) => {
    if (sibling.order !== index) {
      if (sibling.type === 'folder') {
        folderUpdates.push({ id: sibling.id, order: index });
      } else {
        pageUpdates.push({ id: sibling.id, order: index });
      }
    }
  });

  if (folderUpdates.length > 0) {
    await batchUpdateColumn(knex, 'page_folders', 'order',
      folderUpdates.map(u => ({ id: u.id, value: u.order })),
      {
        extraWhereClause: 'AND is_published = false AND deleted_at IS NULL',
        castType: 'integer',
      }
    );
  }

  if (pageUpdates.length > 0) {
    await batchUpdateColumn(knex, 'pages', 'order',
      pageUpdates.map(u => ({ id: u.id, value: u.order })),
      {
        extraWhereClause: 'AND is_published = false AND deleted_at IS NULL AND error_page IS NULL',
        castType: 'integer',
      }
    );
  }
}

/**
 * Soft delete a page folder and all its nested pages and folders
 */
export async function deletePageFolder(id: string): Promise<void> {
  const knex = await getDb();
  const deletedAt = new Date().toISOString();

  const folderToDelete = await getPageFolderById(id);
  if (!folderToDelete) {
    throw new Error('Folder not found');
  }

  const descendantFolderIds = await getDescendantFolderIdsFromDB(id);
  const allFolderIds = [id, ...descendantFolderIds];

  try {
    let affectedPagesQuery = knex('pages')
      .select('id')
      .whereIn('page_folder_id', allFolderIds)
      .where('is_published', false)
      .whereNull('deleted_at');
    affectedPagesQuery = await applyTenantFilter(knex, affectedPagesQuery, 'pages');
    const affectedPages = await affectedPagesQuery as Array<{ id: string }>;
    const affectedPageIds = affectedPages.map(p => p.id);

    if (affectedPageIds.length > 0) {
      let layersQuery = knex('page_layers')
        .whereIn('page_id', affectedPageIds)
        .where('is_published', false)
        .whereNull('deleted_at');
      layersQuery = await applyTenantFilter(knex, layersQuery, 'page_layers');
      await layersQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });
    }

    let pagesQuery = knex('pages')
      .whereIn('page_folder_id', allFolderIds)
      .where('is_published', false)
      .whereNull('deleted_at');
    pagesQuery = await applyTenantFilter(knex, pagesQuery, 'pages');
    await pagesQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });

    let foldersQuery = knex('page_folders')
      .whereIn('id', allFolderIds)
      .where('is_published', false)
      .whereNull('deleted_at');
    foldersQuery = await applyTenantFilter(knex, foldersQuery, 'page_folders');
    await foldersQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });
  } catch (error) {
    throw new Error(`Failed to delete folders: ${getErrorMessage(error)}`);
  }

  try {
    await reorderSiblings(folderToDelete.page_folder_id, folderToDelete.depth);
  } catch (reorderError) {
    console.error('[deletePageFolder] Failed to reorder siblings:', reorderError);
  }
}

/**
 * Restore a soft-deleted page folder
 */
export async function restorePageFolder(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .where('id', id)
      .where('is_published', false)
      .whereNotNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_folders');
    await query.update({ deleted_at: null, updated_at: new Date().toISOString() });
  } catch (error) {
    throw new Error(`Failed to restore page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Force delete a page folder (permanent deletion)
 */
export async function forceDeletePageFolder(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('page_folders').where('id', id);
    query = await applyTenantFilter(knex, query, 'page_folders');
    await query.delete();
  } catch (error) {
    throw new Error(`Failed to force delete page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Get draft page folder by ID
 */
export async function getDraftPageFolderById(id: string): Promise<PageFolder | null> {
  return getPageFolderById(id, false);
}

/**
 * Get published page folder by ID
 */
export async function getPublishedPageFolderById(id: string): Promise<PageFolder | null> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .where('id', id)
      .where('is_published', true)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_folders');
    return (await query.first() as PageFolder | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch published page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all draft page folders (is_published = false)
 */
export async function getAllDraftPageFolders(includeSoftDeleted = false): Promise<PageFolder[]> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .where('is_published', false)
      .orderBy('order', 'asc');

    if (!includeSoftDeleted) {
      query.whereNull('deleted_at');
    }

    query = await applyTenantFilter(knex, query, 'page_folders');
    return await query as PageFolder[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch draft folders: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all published page folders
 */
export async function getAllPublishedPageFolders(includeSoftDeleted = false, tenantId?: string): Promise<PageFolder[]> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .where('is_published', true)
      .orderBy('order', 'asc');

    if (!includeSoftDeleted) {
      query.whereNull('deleted_at');
    }

    query = await applyTenantFilter(knex, query, 'page_folders', tenantId);
    return await query as PageFolder[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch published folders: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published page folders by IDs
 */
export async function getPublishedPageFoldersByIds(ids: string[]): Promise<PageFolder[]> {
  if (ids.length === 0) {
    return [];
  }

  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .whereIn('id', ids)
      .where('is_published', true);
    query = await applyTenantFilter(knex, query, 'page_folders');
    return await query as PageFolder[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch published folders: ${getErrorMessage(error)}`);
  }
}

/**
 * Get page folder by slug
 */
export async function getPageFolderBySlug(slug: string, filters?: QueryFilters): Promise<PageFolder | null> {
  const knex = await getDb();

  try {
    let query = knex('page_folders')
      .select('*')
      .where('slug', slug)
      .whereNull('deleted_at');
    query = applyFilters(query, filters);
    query = await applyTenantFilter(knex, query, 'page_folders');
    return (await query.first() as PageFolder | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch page folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Reorder folders within a parent
 */
export async function reorderFolders(updates: Array<{ id: string; order: number }>): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const knex = await getDb();

  await batchUpdateColumn(knex, 'page_folders', 'order',
    updates.map(u => ({ id: u.id, value: u.order })),
    {
      extraWhereClause: 'AND is_published = false AND deleted_at IS NULL',
      castType: 'integer',
    }
  );
}

/**
 * Duplicate a page folder recursively
 */
export async function duplicatePageFolder(folderId: string): Promise<PageFolder> {
  const knex = await getDb();

  const originalFolder = await getPageFolderById(folderId);
  if (!originalFolder) {
    throw new Error('Folder not found');
  }

  const newName = `${originalFolder.name} (Copy)`;
  const baseSlug = newName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  let query = knex('page_folders')
    .select('slug')
    .whereNull('deleted_at');

  if (originalFolder.page_folder_id === null) {
    query.whereNull('page_folder_id');
  } else {
    query.where('page_folder_id', originalFolder.page_folder_id);
  }

  query = await applyTenantFilter(knex, query, 'page_folders');
  const existingFolders = await query as Array<{ slug: string }>;
  const existingSlugs = existingFolders.map(f => f.slug.toLowerCase());

  let newSlug = baseSlug;
  if (existingSlugs.includes(baseSlug)) {
    let counter = 2;
    newSlug = `${baseSlug}-${counter}`;
    while (existingSlugs.includes(newSlug)) {
      counter++;
      newSlug = `${baseSlug}-${counter}`;
    }
  }

  const newOrder = originalFolder.order + 1;
  await incrementSiblingOrders(newOrder, originalFolder.depth, originalFolder.page_folder_id);

  try {
    const insertData = await withTenantOnInsert({
      name: newName,
      slug: newSlug,
      is_published: false,
      page_folder_id: originalFolder.page_folder_id,
      order: newOrder,
      depth: originalFolder.depth,
      settings: originalFolder.settings || {},
    });
    const rows = await knex('page_folders').insert(insertData).returning('*') as PageFolder[];
    const newFolder = rows[0];
    if (!newFolder) throw new Error('No page folder returned');

    await duplicateFolderContents(knex, folderId, newFolder.id);
    return newFolder;
  } catch (error) {
    throw new Error(`Failed to create duplicate folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Helper function to recursively duplicate all contents of a folder
 */
async function duplicateFolderContents(
  knex: Knex,
  originalFolderId: string,
  newFolderId: string
): Promise<void> {
  let childFoldersQuery = knex('page_folders')
    .select('*')
    .where('page_folder_id', originalFolderId)
    .whereNull('deleted_at')
    .orderBy('order', 'asc');
  childFoldersQuery = await applyTenantFilter(knex, childFoldersQuery, 'page_folders');
  const childFolders = await childFoldersQuery as PageFolder[];

  let childPagesQuery = knex('pages')
    .select('*')
    .where('page_folder_id', originalFolderId)
    .whereNull('deleted_at')
    .orderBy('order', 'asc');
  childPagesQuery = await applyTenantFilter(knex, childPagesQuery, 'pages');
  const childPages = await childPagesQuery as Page[];

  if (childFolders.length > 0) {
    for (const folder of childFolders) {
      const timestamp = Date.now() + Math.random();
      const newFolderSlug = `folder-${Math.floor(timestamp)}`;
      const insertData = await withTenantOnInsert({
        name: folder.name,
        slug: newFolderSlug,
        is_published: false,
        page_folder_id: newFolderId,
        order: folder.order,
        depth: folder.depth,
        settings: folder.settings || {},
      });
      const rows = await knex('page_folders').insert(insertData).returning('*') as PageFolder[];
      const duplicatedFolder = rows[0];
      if (!duplicatedFolder) {
        throw new Error('Failed to duplicate child folder: No page folder returned');
      }
      await duplicateFolderContents(knex, folder.id, duplicatedFolder.id);
    }
  }

  if (childPages.length > 0) {
    for (const page of childPages) {
      const timestamp = Date.now() + Math.random();
      const newPageSlug = page.is_index ? '' : `page-${Math.floor(timestamp)}`;
      const pageInsert = await withTenantOnInsert({
        name: page.name,
        slug: newPageSlug,
        is_published: false,
        page_folder_id: newFolderId,
        order: page.order,
        depth: page.depth,
        is_index: page.is_index,
        is_dynamic: page.is_dynamic,
        error_page: page.error_page,
        settings: page.settings || {},
      });
      const rows = await knex('pages').insert(pageInsert).returning('*') as Page[];
      const duplicatedPage = rows[0];
      if (!duplicatedPage) {
        throw new Error('Failed to duplicate child page: No page returned');
      }

      let layersQuery = knex('page_layers')
        .select('*')
        .where('page_id', page.id)
        .where('is_published', false)
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(1);
      layersQuery = await applyTenantFilter(knex, layersQuery, 'page_layers');
      const originalLayers = await layersQuery.first() as PageLayers | undefined;

      if (originalLayers) {
        const layerInsert = await withTenantOnInsert({
          page_id: duplicatedPage.id,
          layers: originalLayers.layers,
          is_published: false,
        });
        await knex('page_layers').insert(layerInsert);
      }
    }
  }
}
