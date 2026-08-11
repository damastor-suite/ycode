import type { Knex } from 'knex';

import { STORAGE_FOLDERS } from '@/lib/asset-constants';
import { generateAssetContentHash } from '@/lib/hash-utils';
import { getDb } from '@/lib/platform/db';
import { getStorage } from '@/lib/platform/storage';
import {
  addTenantIdToRow,
  applyTenantFilter,
  chunkArray,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
  parseCount,
} from './knex-repository-utils';
import type { Asset } from '@/types';

const WRITE_BATCH_SIZE = 100;
const IN_FILTER_CHUNK_SIZE = 100;

export interface CreateAssetData {
  filename: string;
  source: string;
  storage_path?: string | null;
  public_url?: string | null;
  file_size: number;
  mime_type: string;
  width?: number;
  height?: number;
  asset_folder_id?: string | null;
  content?: string | null;
  is_published?: boolean;
}

export interface PaginatedAssetsResult {
  assets: Asset[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface GetAssetsOptions {
  folderId?: string | null;
  folderIds?: string[];
  search?: string;
  page?: number;
  limit?: number;
}

export interface UpdateAssetData {
  filename?: string;
  asset_folder_id?: string | null;
  content?: string | null;
}

export async function getAssetsPaginated(
  options: GetAssetsOptions = {}
): Promise<PaginatedAssetsResult> {
  const knex = await getDb();
  const {
    folderId,
    folderIds,
    search,
    page = 1,
    limit = 50,
  } = options;
  const offset = (page - 1) * limit;

  let query = knex('assets')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at');

  query = applyAssetFolderFilters(query, folderId, folderIds);

  if (search && search.trim()) {
    query = query.whereRaw('filename ILIKE ?', [`%${search.trim()}%`]);
  }

  query = await applyTenantFilter(knex, query, 'assets');

  try {
    const countRow = await query.clone()
      .clearSelect()
      .clearOrder()
      .count<{ count: string | number }[]>({ count: '*' })
      .first();

    const assets = normalizeRows(await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(limit)
      .offset(offset)) as Asset[];
    const total = parseCount(countRow);

    return {
      assets,
      total,
      page,
      limit,
      hasMore: offset + limit < total,
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch assets: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAllAssets(folderId?: string | null): Promise<Asset[]> {
  const knex = await getDb();
  let query = knex('assets')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'asc');

  if (folderId !== undefined) {
    query = folderId === null
      ? query.whereNull('asset_folder_id')
      : query.where('asset_folder_id', folderId);
  }

  query = await applyTenantFilter(knex, query, 'assets');

  try {
    return normalizeRows(await query) as Asset[];
  } catch (error) {
    throw new Error(
      `Failed to fetch assets: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAssetById(
  id: string,
  isPublished: boolean = false,
  tenantId?: string
): Promise<Asset | null> {
  const knex = await getDb();
  let query = knex('assets')
    .select('*')
    .where('id', id)
    .where('is_published', isPublished);

  if (!isPublished) {
    query = query.whereNull('deleted_at');
  }

  query = await applyTenantFilter(knex, query, 'assets', tenantId);

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Asset : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch asset: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAssetForProxy(
  id: string
): Promise<Pick<Asset, 'id' | 'filename' | 'storage_path' | 'mime_type'> | null> {
  const knex = await getDb();
  let query = knex('assets')
    .select('id', 'filename', 'storage_path', 'mime_type')
    .where('id', id)
    .whereNull('deleted_at')
    .limit(1);
  query = await applyTenantFilter(knex, query, 'assets');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Pick<Asset, 'id' | 'filename' | 'storage_path' | 'mime_type'> : null;
  } catch {
    return null;
  }
}

export async function getAssetsByIds(
  ids: string[],
  isPublished: boolean = false,
  tenantId?: string
): Promise<Record<string, Asset>> {
  if (ids.length === 0) {
    return {};
  }

  const assets = await getAssetsByIdsList(ids, isPublished, tenantId);
  const assetMap: Record<string, Asset> = {};
  for (const asset of assets) {
    assetMap[asset.id] = asset;
  }
  return assetMap;
}

export async function findAssetsByFilenames(
  filenames: string[]
): Promise<Record<string, Pick<Asset, 'id' | 'public_url'>>> {
  if (filenames.length === 0) return {};

  const knex = await getDb();
  const unique = [...new Set(filenames)];
  let query = knex('assets')
    .select('id', 'filename', 'public_url')
    .whereIn('filename', unique)
    .where('is_published', false)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'assets');

  const data = await query as Array<Pick<Asset, 'id' | 'filename' | 'public_url'>>;
  const map: Record<string, Pick<Asset, 'id' | 'public_url'>> = {};
  for (const asset of data) {
    if (!map[asset.filename]) {
      map[asset.filename] = { id: asset.id, public_url: asset.public_url };
    }
  }
  return map;
}

export async function createAsset(assetData: CreateAssetData): Promise<Asset> {
  const knex = await getDb();
  const contentHash = generateAssetContentHash({
    filename: assetData.filename,
    storage_path: assetData.storage_path ?? null,
    public_url: assetData.public_url ?? null,
    file_size: assetData.file_size,
    mime_type: assetData.mime_type,
    width: assetData.width ?? null,
    height: assetData.height ?? null,
    asset_folder_id: assetData.asset_folder_id ?? null,
    content: assetData.content ?? null,
    source: assetData.source,
  });
  const row = await addTenantIdToRow(knex, 'assets', {
    ...assetData,
    storage_path: assetData.storage_path ?? null,
    public_url: assetData.public_url ?? null,
    width: assetData.width ?? null,
    height: assetData.height ?? null,
    asset_folder_id: assetData.asset_folder_id ?? null,
    content: assetData.content ?? null,
    content_hash: contentHash,
    is_published: false,
    updated_at: new Date().toISOString(),
  });

  try {
    const [data] = await knex('assets')
      .insert(row)
      .returning('*');
    return normalizeRow(data) as Asset;
  } catch (error) {
    throw new Error(
      `Failed to create asset: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateAsset(id: string, assetData: UpdateAssetData): Promise<Asset> {
  const knex = await getDb();
  let updateQuery = knex('assets')
    .where('id', id)
    .where('is_published', false)
    .whereNull('deleted_at')
    .update({
      ...assetData,
      updated_at: new Date().toISOString(),
    })
    .returning('*');
  updateQuery = await applyTenantFilter(knex, updateQuery, 'assets');

  try {
    const [data] = await updateQuery;
    if (!data) {
      throw new Error('Asset not found');
    }

    const asset = normalizeRow(data) as Asset;
    const contentHash = generateAssetContentHash({
      filename: asset.filename,
      storage_path: asset.storage_path,
      public_url: asset.public_url,
      file_size: asset.file_size,
      mime_type: asset.mime_type,
      width: asset.width,
      height: asset.height,
      asset_folder_id: asset.asset_folder_id,
      content: asset.content,
      source: asset.source,
    });

    let hashQuery = knex('assets')
      .where('id', id)
      .where('is_published', false)
      .update({ content_hash: contentHash })
      .returning('*');
    hashQuery = await applyTenantFilter(knex, hashQuery, 'assets');
    const [updated] = await hashQuery;

    if (!updated) {
      throw new Error('Asset hash update failed');
    }

    return normalizeRow(updated) as Asset;
  } catch (error) {
    throw new Error(
      `Failed to update asset: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteAsset(id: string): Promise<void> {
  const knex = await getDb();
  const draftAsset = await getAssetById(id, false);
  if (!draftAsset) {
    throw new Error('Asset not found');
  }

  const publishedAsset = await getAssetById(id, true);
  if (!publishedAsset && draftAsset.storage_path) {
    try {
      const storage = await getStorage();
      await storage.remove([draftAsset.storage_path]);
    } catch (error) {
      console.error('Failed to delete file from storage:', error);
    }
  }

  let query = knex('assets')
    .where('id', id)
    .where('is_published', false)
    .whereNull('deleted_at')
    .update({ deleted_at: new Date().toISOString() });
  query = await applyTenantFilter(knex, query, 'assets');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete asset record: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function bulkDeleteAssets(ids: string[]): Promise<{ success: string[]; failed: string[] }> {
  if (ids.length === 0) {
    return { success: [], failed: [] };
  }

  const knex = await getDb();
  const draftAssets = await getAssetsByIdsList(ids, false);
  const publishedAssets = await getAssetsByIdsList(ids, true);
  const publishedIds = new Set(publishedAssets.map(asset => asset.id));
  const storagePaths = draftAssets
    .filter(asset => asset.storage_path && !publishedIds.has(asset.id))
    .map(asset => asset.storage_path as string);

  await removeStoragePaths(storagePaths);

  for (const idChunk of chunkArray(ids, WRITE_BATCH_SIZE)) {
    let deleteQuery = knex('assets')
      .whereIn('id', idChunk)
      .where('is_published', false)
      .whereNull('deleted_at')
      .update({ deleted_at: new Date().toISOString() });
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'assets');
    await deleteQuery;
  }

  return { success: ids, failed: [] };
}

export async function bulkUpdateAssets(
  ids: string[],
  updates: UpdateAssetData
): Promise<{ success: string[]; failed: string[] }> {
  if (ids.length === 0) {
    return { success: [], failed: [] };
  }

  const knex = await getDb();
  const now = new Date().toISOString();

  for (const idChunk of chunkArray(ids, WRITE_BATCH_SIZE)) {
    let updateQuery = knex('assets')
      .whereIn('id', idChunk)
      .where('is_published', false)
      .whereNull('deleted_at')
      .update({
        ...updates,
        updated_at: now,
      });
    updateQuery = await applyTenantFilter(knex, updateQuery, 'assets');
    await updateQuery;

    const updatedAssets = await getAssetsByIdsList(idChunk, false);
    await updateAssetContentHashes(knex, updatedAssets);
  }

  return { success: ids, failed: [] };
}

export async function uploadFile(file: File): Promise<{ path: string; url: string }> {
  const sanitizedName = sanitizeFilename(file.name);
  const storagePath = `${STORAGE_FOLDERS.WEBSITE}/${Date.now()}-${sanitizedName}`;
  const storage = await getStorage();
  const data = await storage.upload(storagePath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
  });

  return {
    path: data.path,
    url: storage.getPublicUrl(data.path),
  };
}

export async function getUnpublishedAssets(): Promise<Asset[]> {
  const knex = await getDb();
  let draftQuery = knex('assets')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc');
  draftQuery = await applyTenantFilter(knex, draftQuery, 'assets');
  const draftAssets = normalizeRows(await draftQuery) as Asset[];

  if (draftAssets.length === 0) {
    return [];
  }

  let publishedQuery = knex('assets')
    .select('id', 'content_hash')
    .whereIn('id', draftAssets.map(asset => asset.id))
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'assets');
  const publishedAssets = await publishedQuery as Array<{ id: string; content_hash: string | null }>;
  const publishedHashById = new Map(publishedAssets.map(asset => [asset.id, asset.content_hash]));

  return draftAssets.filter((draft) => {
    if (!publishedHashById.has(draft.id)) {
      return true;
    }
    return draft.content_hash !== publishedHashById.get(draft.id);
  });
}

export async function getDeletedDraftAssets(): Promise<Asset[]> {
  const knex = await getDb();
  let query = knex('assets')
    .select('*')
    .where('is_published', false)
    .whereNotNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'assets');

  try {
    return normalizeRows(await query) as Asset[];
  } catch (error) {
    throw new Error(
      `Failed to fetch deleted draft assets: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function publishAssets(assetIds: string[]): Promise<{ count: number }> {
  if (assetIds.length === 0) {
    return { count: 0 };
  }

  const knex = await getDb();
  const draftAssets = await getAssetsByIdsList(assetIds, false);
  if (draftAssets.length === 0) {
    return { count: 0 };
  }

  let publishedQuery = knex('assets')
    .select('id', 'content_hash')
    .whereIn('id', assetIds)
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'assets');
  const publishedAssets = await publishedQuery as Array<{ id: string; content_hash: string | null }>;
  const publishedHashById = new Map(publishedAssets.map(asset => [asset.id, asset.content_hash]));

  const recordsToUpsert: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  for (const draft of draftAssets) {
    if (publishedHashById.has(draft.id) && draft.content_hash === publishedHashById.get(draft.id)) {
      continue;
    }

    const record: Record<string, unknown> = {
      id: draft.id,
      source: draft.source,
      filename: draft.filename,
      storage_path: draft.storage_path,
      public_url: draft.public_url,
      file_size: draft.file_size,
      mime_type: draft.mime_type,
      width: draft.width,
      height: draft.height,
      asset_folder_id: draft.asset_folder_id,
      content: draft.content,
      content_hash: draft.content_hash,
      is_published: true,
      created_at: draft.created_at,
      updated_at: now,
      deleted_at: null,
    };
    const tenantId = (draft as unknown as Record<string, unknown>).tenant_id;
    if (tenantId) record.tenant_id = tenantId;
    recordsToUpsert.push(record);
  }

  if (recordsToUpsert.length > 0) {
    const conflictColumns = await getConflictColumns(
      knex,
      'assets',
      ['id', 'is_published'],
      recordsToUpsert[0].tenant_id as string | undefined
    );

    for (const recordChunk of chunkArray(recordsToUpsert, WRITE_BATCH_SIZE)) {
      await knex('assets')
        .insert(recordChunk)
        .onConflict(conflictColumns)
        .merge([
          'source',
          'filename',
          'storage_path',
          'public_url',
          'file_size',
          'mime_type',
          'width',
          'height',
          'asset_folder_id',
          'content',
          'content_hash',
          'updated_at',
          'deleted_at',
        ]);
    }
  }

  return { count: recordsToUpsert.length };
}

export async function hardDeleteSoftDeletedAssets(): Promise<{ count: number }> {
  const knex = await getDb();
  const deletedDrafts = await getDeletedDraftAssets();
  if (deletedDrafts.length === 0) {
    return { count: 0 };
  }

  const ids = deletedDrafts.map(asset => asset.id);
  for (const idChunk of chunkArray(ids, WRITE_BATCH_SIZE)) {
    let deletePublished = knex('assets')
      .whereIn('id', idChunk)
      .where('is_published', true)
      .del();
    deletePublished = await applyTenantFilter(knex, deletePublished, 'assets');
    await deletePublished;

    let deleteDraft = knex('assets')
      .whereIn('id', idChunk)
      .where('is_published', false)
      .whereNotNull('deleted_at')
      .del();
    deleteDraft = await applyTenantFilter(knex, deleteDraft, 'assets');
    await deleteDraft;
  }

  await cleanupOrphanedStorageFiles(
    deletedDrafts
      .filter(asset => asset.storage_path)
      .map(asset => asset.storage_path as string)
  );

  return { count: deletedDrafts.length };
}

function applyAssetFolderFilters(
  query: Knex.QueryBuilder,
  folderId?: string | null,
  folderIds?: string[]
): Knex.QueryBuilder {
  if (folderIds && folderIds.length > 0) {
    const actualFolderIds = folderIds.filter(id => id !== 'root');
    const includesRoot = folderIds.includes('root');

    if (includesRoot && actualFolderIds.length > 0) {
      return query.where((builder: Knex.QueryBuilder) => {
        builder.whereNull('asset_folder_id').orWhereIn('asset_folder_id', actualFolderIds);
      });
    }
    if (includesRoot) {
      return query.whereNull('asset_folder_id');
    }
    return query.whereIn('asset_folder_id', actualFolderIds);
  }

  if (folderId !== undefined) {
    return folderId === null
      ? query.whereNull('asset_folder_id')
      : query.where('asset_folder_id', folderId);
  }

  return query;
}

async function getAssetsByIdsList(
  ids: string[],
  isPublished: boolean,
  tenantId?: string
): Promise<Asset[]> {
  if (ids.length === 0) {
    return [];
  }

  const knex = await getDb();
  const assets: Asset[] = [];
  for (const idChunk of chunkArray(ids, IN_FILTER_CHUNK_SIZE)) {
    let query = knex('assets')
      .select('*')
      .whereIn('id', idChunk)
      .where('is_published', isPublished);

    if (!isPublished) {
      query = query.whereNull('deleted_at');
    }

    query = await applyTenantFilter(knex, query, 'assets', tenantId);
    assets.push(...normalizeRows(await query) as Asset[]);
  }
  return assets;
}

async function updateAssetContentHashes(
  knex: Awaited<ReturnType<typeof getDb>>,
  assets: Asset[]
): Promise<void> {
  if (assets.length === 0) {
    return;
  }

  const hashRecords = assets.map(asset => ({
    id: asset.id,
    content_hash: generateAssetContentHash({
      filename: asset.filename,
      storage_path: asset.storage_path,
      public_url: asset.public_url,
      file_size: asset.file_size,
      mime_type: asset.mime_type,
      width: asset.width,
      height: asset.height,
      asset_folder_id: asset.asset_folder_id,
      content: asset.content,
      source: asset.source,
    }),
  }));
  const caseSql = hashRecords.map(() => 'WHEN id = ? THEN ?').join(' ');
  const bindings = hashRecords.flatMap(record => [record.id, record.content_hash]);
  const idBindings = hashRecords.map(record => record.id);

  let query = knex('assets')
    .whereIn('id', idBindings)
    .where('is_published', false)
    .update({
      content_hash: knex.raw(`CASE ${caseSql} END`, bindings),
    });
  query = await applyTenantFilter(knex, query, 'assets');
  await query;
}

async function cleanupOrphanedStorageFiles(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;

  const knex = await getDb();
  let query = knex('assets')
    .select('storage_path')
    .whereIn('storage_path', storagePaths);
  query = await applyTenantFilter(knex, query, 'assets');
  const existingRows = await query as Array<{ storage_path: string | null }>;
  const stillReferenced = new Set(existingRows.map(row => row.storage_path).filter(Boolean));
  const orphanedPaths = storagePaths.filter(path => !stillReferenced.has(path));
  await removeStoragePaths(orphanedPaths);
}

async function removeStoragePaths(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;

  try {
    const storage = await getStorage();
    for (const pathChunk of chunkArray(storagePaths, WRITE_BATCH_SIZE)) {
      await storage.remove(pathChunk);
    }
  } catch (error) {
    console.error('Failed to delete some files from storage:', error);
  }
}

function sanitizeFilename(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const name = lastDot > 0 ? filename.substring(0, lastDot) : filename;
  const ext = lastDot > 0 ? filename.substring(lastDot) : '';
  const sanitized = name
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .toLowerCase();

  return sanitized + ext.toLowerCase();
}
