import { batchUpdateColumn } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type { AssetFolder, CreateAssetFolderData, UpdateAssetFolderData } from '@/types';

const WRITE_BATCH_SIZE = 100;

export async function getAllAssetFolders(isPublished = false): Promise<AssetFolder[]> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .select('*')
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('order', 'asc');
  query = await applyTenantFilter(knex, query, 'asset_folders');

  try {
    return normalizeRows(await query) as AssetFolder[];
  } catch (error) {
    throw new Error(
      `Failed to fetch asset folders: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAssetFolderById(
  id: string,
  isPublished = false
): Promise<AssetFolder | null> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .select('*')
    .where('id', id)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'asset_folders');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as AssetFolder : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch asset folder: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getChildFolders(
  parentId: string | null,
  isPublished = false
): Promise<AssetFolder[]> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .select('*')
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('order', 'asc');

  query = parentId === null
    ? query.whereNull('asset_folder_id')
    : query.where('asset_folder_id', parentId);
  query = await applyTenantFilter(knex, query, 'asset_folders');

  try {
    return normalizeRows(await query) as AssetFolder[];
  } catch (error) {
    throw new Error(
      `Failed to fetch child folders: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createAssetFolder(folderData: CreateAssetFolderData): Promise<AssetFolder> {
  const knex = await getDb();
  const row = await addTenantIdToRow(knex, 'asset_folders', {
    ...folderData,
    is_published: folderData.is_published ?? false,
  });

  try {
    const [data] = await knex('asset_folders')
      .insert(row)
      .returning('*');
    return normalizeRow(data) as AssetFolder;
  } catch (error) {
    throw new Error(
      `Failed to create asset folder: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateAssetFolder(
  id: string,
  updates: UpdateAssetFolderData
): Promise<AssetFolder> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .where('id', id)
    .where('is_published', false)
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .returning('*');
  query = await applyTenantFilter(knex, query, 'asset_folders');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Folder not found');
    }
    return normalizeRow(data) as AssetFolder;
  } catch (error) {
    throw new Error(
      `Failed to update asset folder: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteAssetFolder(id: string): Promise<void> {
  const knex = await getDb();
  const folderToDelete = await getAssetFolderById(id, false);
  if (!folderToDelete) {
    throw new Error('Folder not found');
  }

  const deletedAt = new Date().toISOString();
  const descendantFolderIds = await getDescendantFolderIds(id);
  const allFolderIds = [id, ...descendantFolderIds];

  try {
    let assetsQuery = knex('assets')
      .whereIn('asset_folder_id', allFolderIds)
      .where('is_published', false)
      .whereNull('deleted_at')
      .update({ deleted_at: deletedAt });
    assetsQuery = await applyTenantFilter(knex, assetsQuery, 'assets');
    await assetsQuery;

    let foldersQuery = knex('asset_folders')
      .whereIn('id', allFolderIds)
      .where('is_published', false)
      .whereNull('deleted_at')
      .update({ deleted_at: deletedAt });
    foldersQuery = await applyTenantFilter(knex, foldersQuery, 'asset_folders');
    await foldersQuery;
  } catch (error) {
    throw new Error(
      `Failed to delete folders: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function reorderFolders(updates: Array<{ id: string; order: number }>): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const knex = await getDb();
  await batchUpdateColumn(
    knex,
    'asset_folders',
    'order',
    updates.map(update => ({ id: update.id, value: update.order })),
    {
      extraWhereClause: 'AND is_published = false AND deleted_at IS NULL',
      castType: 'integer',
    }
  );
}

export async function getUnpublishedAssetFolders(): Promise<AssetFolder[]> {
  const knex = await getDb();
  let draftQuery = knex('asset_folders')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('depth', 'asc')
    .orderBy('order', 'asc');
  draftQuery = await applyTenantFilter(knex, draftQuery, 'asset_folders');

  try {
    const draftFolders = normalizeRows(await draftQuery) as AssetFolder[];
    if (draftFolders.length === 0) {
      return [];
    }

    let publishedQuery = knex('asset_folders')
      .select('*')
      .whereIn('id', draftFolders.map(folder => folder.id))
      .where('is_published', true);
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'asset_folders');
    const publishedFolders = normalizeRows(await publishedQuery) as AssetFolder[];
    const publishedById = new Map(publishedFolders.map(folder => [folder.id, folder]));

    return draftFolders.filter((draft) => {
      const published = publishedById.get(draft.id);
      return !published || hasAssetFolderChanged(draft, published);
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch draft asset folders: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getDeletedDraftAssetFolders(): Promise<AssetFolder[]> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .select('*')
    .where('is_published', false)
    .whereNotNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'asset_folders');

  try {
    return normalizeRows(await query) as AssetFolder[];
  } catch (error) {
    throw new Error(
      `Failed to fetch deleted draft asset folders: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function publishAssetFolders(folderIds: string[]): Promise<{ count: number }> {
  if (folderIds.length === 0) {
    return { count: 0 };
  }

  const knex = await getDb();
  const draftFolders = await getDraftFoldersByIds(folderIds);
  if (draftFolders.length === 0) {
    return { count: 0 };
  }
  draftFolders.sort((a, b) => a.depth - b.depth);

  let publishedQuery = knex('asset_folders')
    .select('*')
    .whereIn('id', folderIds)
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'asset_folders');
  const publishedFolders = normalizeRows(await publishedQuery) as AssetFolder[];
  const publishedById = new Map(publishedFolders.map(folder => [folder.id, folder]));

  const now = new Date().toISOString();
  const recordsToUpsert: Record<string, unknown>[] = [];
  for (const draft of draftFolders) {
    const existing = publishedById.get(draft.id);
    if (existing && !hasAssetFolderChanged(draft, existing)) {
      continue;
    }

    const record: Record<string, unknown> = {
      id: draft.id,
      name: draft.name,
      asset_folder_id: draft.asset_folder_id,
      depth: draft.depth,
      order: draft.order,
      is_published: true,
      created_at: draft.created_at,
      updated_at: now,
      deleted_at: null,
    };
    const tenantId = (draft as unknown as Record<string, unknown>).tenant_id;
    if (tenantId) record.tenant_id = tenantId;
    recordsToUpsert.push(record);
  }

  recordsToUpsert.sort((a, b) => Number(a.depth) - Number(b.depth));

  if (recordsToUpsert.length > 0) {
    const conflictColumns = await getConflictColumns(
      knex,
      'asset_folders',
      ['id', 'is_published'],
      recordsToUpsert[0].tenant_id as string | undefined
    );

    for (let i = 0; i < recordsToUpsert.length; i += WRITE_BATCH_SIZE) {
      await knex('asset_folders')
        .insert(recordsToUpsert.slice(i, i + WRITE_BATCH_SIZE))
        .onConflict(conflictColumns)
        .merge(['name', 'asset_folder_id', 'depth', 'order', 'updated_at', 'deleted_at']);
    }
  }

  return { count: recordsToUpsert.length };
}

export async function hardDeleteSoftDeletedAssetFolders(): Promise<{ count: number }> {
  const knex = await getDb();
  const deletedDrafts = await getDeletedDraftAssetFolders();
  if (deletedDrafts.length === 0) {
    return { count: 0 };
  }

  const ids = deletedDrafts.map(folder => folder.id);

  for (let i = 0; i < ids.length; i += WRITE_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + WRITE_BATCH_SIZE);

    let clearPublishedAssets = knex('assets')
      .whereIn('asset_folder_id', batchIds)
      .where('is_published', true)
      .update({ asset_folder_id: null });
    clearPublishedAssets = await applyTenantFilter(knex, clearPublishedAssets, 'assets');
    await clearPublishedAssets;

    let clearDraftAssets = knex('assets')
      .whereIn('asset_folder_id', batchIds)
      .where('is_published', false)
      .update({ asset_folder_id: null });
    clearDraftAssets = await applyTenantFilter(knex, clearDraftAssets, 'assets');
    await clearDraftAssets;

    let clearPublishedFolders = knex('asset_folders')
      .whereIn('asset_folder_id', batchIds)
      .where('is_published', true)
      .update({ asset_folder_id: null });
    clearPublishedFolders = await applyTenantFilter(knex, clearPublishedFolders, 'asset_folders');
    await clearPublishedFolders;

    let clearDraftFolders = knex('asset_folders')
      .whereIn('asset_folder_id', batchIds)
      .where('is_published', false)
      .update({ asset_folder_id: null });
    clearDraftFolders = await applyTenantFilter(knex, clearDraftFolders, 'asset_folders');
    await clearDraftFolders;
  }

  for (let i = 0; i < ids.length; i += WRITE_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + WRITE_BATCH_SIZE);

    let deletePublished = knex('asset_folders')
      .whereIn('id', batchIds)
      .where('is_published', true)
      .del();
    deletePublished = await applyTenantFilter(knex, deletePublished, 'asset_folders');
    await deletePublished;

    let deleteDraft = knex('asset_folders')
      .whereIn('id', batchIds)
      .where('is_published', false)
      .whereNotNull('deleted_at')
      .del();
    deleteDraft = await applyTenantFilter(knex, deleteDraft, 'asset_folders');
    await deleteDraft;
  }

  return { count: deletedDrafts.length };
}

async function getDescendantFolderIds(folderId: string): Promise<string[]> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .select('id', 'asset_folder_id')
    .where('is_published', false)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'asset_folders');
  const allFolders = await query as Array<{ id: string; asset_folder_id: string | null }>;

  const foldersByParent = new Map<string, string[]>();
  for (const folder of allFolders) {
    const parentId = folder.asset_folder_id || 'root';
    const children = foldersByParent.get(parentId) ?? [];
    children.push(folder.id);
    foldersByParent.set(parentId, children);
  }

  const collectDescendants = (parentId: string): string[] => {
    const children = foldersByParent.get(parentId) ?? [];
    return children.flatMap(childId => [childId, ...collectDescendants(childId)]);
  };

  return collectDescendants(folderId);
}

async function getDraftFoldersByIds(folderIds: string[]): Promise<AssetFolder[]> {
  const knex = await getDb();
  let query = knex('asset_folders')
    .select('*')
    .whereIn('id', folderIds)
    .where('is_published', false)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'asset_folders');
  return normalizeRows(await query) as AssetFolder[];
}

function hasAssetFolderChanged(draft: AssetFolder, published: AssetFolder): boolean {
  return (
    draft.name !== published.name ||
    draft.asset_folder_id !== published.asset_folder_id ||
    draft.depth !== published.depth ||
    draft.order !== published.order
  );
}
