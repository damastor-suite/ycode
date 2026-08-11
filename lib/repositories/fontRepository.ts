import { generateFontContentHash } from '@/lib/hash-utils';
import { getDb } from '@/lib/platform/db';
import { getStorage } from '@/lib/platform/storage';
import {
  addTenantIdToRow,
  applyTenantFilter,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type { Font, CreateFontData, UpdateFontData } from '@/types';

const WRITE_BATCH_SIZE = 100;

export async function getAllFonts(): Promise<Font[]> {
  return getFontsByPublishState(false, 'Failed to fetch fonts');
}

export async function getPublishedFonts(): Promise<Font[]> {
  return getFontsByPublishState(true, 'Failed to fetch published fonts');
}

export async function getFontById(id: string): Promise<Font | null> {
  const knex = await getDb();
  let query = knex('fonts')
    .select('*')
    .where('id', id)
    .where('is_published', false)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'fonts');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Font : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch font: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createFont(fontData: CreateFontData): Promise<Font> {
  const knex = await getDb();
  const contentHash = generateFontContentHash(fontData);
  const row = await addTenantIdToRow(knex, 'fonts', {
    name: fontData.name,
    family: fontData.family,
    type: fontData.type,
    variants: fontData.variants,
    weights: fontData.weights,
    category: fontData.category,
    axes: fontData.axes ?? null,
    kind: fontData.kind ?? null,
    url: fontData.url ?? null,
    storage_path: fontData.storage_path ?? null,
    file_hash: fontData.file_hash ?? null,
    content_hash: contentHash,
    is_published: false,
  });

  try {
    const [data] = await knex('fonts')
      .insert(row)
      .returning('*');
    return normalizeRow(data) as Font;
  } catch (error) {
    throw new Error(
      `Failed to create font: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateFont(id: string, fontData: UpdateFontData): Promise<Font> {
  const knex = await getDb();
  const existing = await getFontById(id);
  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (fontData.name !== undefined) updatePayload.name = fontData.name;
  if (fontData.family !== undefined) updatePayload.family = fontData.family;
  if (fontData.variants !== undefined) updatePayload.variants = fontData.variants;
  if (fontData.weights !== undefined) updatePayload.weights = fontData.weights;
  if (fontData.category !== undefined) updatePayload.category = fontData.category;

  if (existing) {
    updatePayload.content_hash = generateFontContentHash({
      name: fontData.name ?? existing.name,
      family: fontData.family ?? existing.family,
      type: existing.type,
      variants: fontData.variants ?? existing.variants,
      weights: fontData.weights ?? existing.weights,
      category: fontData.category ?? existing.category,
    });
  }

  let query = knex('fonts')
    .where('id', id)
    .where('is_published', false)
    .whereNull('deleted_at')
    .update(updatePayload)
    .returning('*');
  query = await applyTenantFilter(knex, query, 'fonts');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Font not found');
    }
    return normalizeRow(data) as Font;
  } catch (error) {
    throw new Error(
      `Failed to update font: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFont(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('fonts')
    .where('id', id)
    .where('is_published', false)
    .update({ deleted_at: new Date().toISOString() });
  query = await applyTenantFilter(knex, query, 'fonts');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete font: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getUnpublishedFonts(): Promise<Font[]> {
  const [draftFonts, publishedFonts] = await Promise.all([
    getFontsByPublishState(false, 'Failed to fetch draft fonts', true),
    getFontsByPublishState(true, 'Failed to fetch published fonts', true),
  ]);

  const publishedMap = new Map(publishedFonts.map(font => [font.id, font]));
  return draftFonts.filter((draft) => {
    const published = publishedMap.get(draft.id);
    if (!published) return true;
    if (draft.deleted_at) return true;
    return draft.content_hash !== published.content_hash;
  });
}

export async function publishFonts(): Promise<{ added: number; updated: number; deleted: number }> {
  const knex = await getDb();
  const stats = { added: 0, updated: 0, deleted: 0 };
  const [draftFonts, publishedFonts] = await Promise.all([
    getFontsByPublishState(false, 'Failed to fetch draft fonts', true),
    getFontsByPublishState(true, 'Failed to fetch published fonts', true),
  ]);

  const publishedMap = new Map(publishedFonts.map(font => [font.id, font]));
  const now = new Date().toISOString();
  const toUpsert: Record<string, unknown>[] = [];

  for (const draft of draftFonts) {
    if (draft.deleted_at) {
      if (publishedMap.has(draft.id)) {
        stats.deleted += 1;
      }
      continue;
    }

    const published = publishedMap.get(draft.id);
    if (!published) {
      stats.added += 1;
    } else if (draft.content_hash !== published.content_hash) {
      stats.updated += 1;
    } else {
      continue;
    }

    const record: Record<string, unknown> = {
      id: draft.id,
      name: draft.name,
      family: draft.family,
      type: draft.type,
      variants: draft.variants,
      weights: draft.weights,
      category: draft.category,
      axes: draft.axes ?? null,
      kind: draft.kind,
      url: draft.url,
      storage_path: draft.storage_path,
      file_hash: draft.file_hash,
      content_hash: draft.content_hash,
      is_published: true,
      created_at: draft.created_at,
      updated_at: now,
      deleted_at: null,
    };
    const tenantId = (draft as unknown as Record<string, unknown>).tenant_id;
    if (tenantId) record.tenant_id = tenantId;
    toUpsert.push(record);
  }

  if (toUpsert.length > 0) {
    const conflictColumns = await getConflictColumns(
      knex,
      'fonts',
      ['id', 'is_published'],
      toUpsert[0].tenant_id as string | undefined
    );

    for (let i = 0; i < toUpsert.length; i += WRITE_BATCH_SIZE) {
      await knex('fonts')
        .insert(toUpsert.slice(i, i + WRITE_BATCH_SIZE))
        .onConflict(conflictColumns)
        .merge([
          'name',
          'family',
          'type',
          'variants',
          'weights',
          'category',
          'axes',
          'kind',
          'url',
          'storage_path',
          'file_hash',
          'content_hash',
          'updated_at',
          'deleted_at',
        ]);
    }
  }

  const deletedDrafts = draftFonts.filter(font => font.deleted_at !== null);
  const deletedDraftIds = deletedDrafts.map(font => font.id);
  if (deletedDraftIds.length > 0) {
    let deletePublished = knex('fonts')
      .whereIn('id', deletedDraftIds)
      .where('is_published', true)
      .del();
    deletePublished = await applyTenantFilter(knex, deletePublished, 'fonts');
    await deletePublished;

    let deleteDraft = knex('fonts')
      .whereIn('id', deletedDraftIds)
      .where('is_published', false)
      .del();
    deleteDraft = await applyTenantFilter(knex, deleteDraft, 'fonts');
    await deleteDraft;
  }

  const activeDraftIds = new Set(draftFonts.filter(font => !font.deleted_at).map(font => font.id));
  const orphanedPublished = publishedFonts.filter(
    font => !activeDraftIds.has(font.id) && !deletedDraftIds.includes(font.id)
  );

  if (orphanedPublished.length > 0) {
    let deleteOrphans = knex('fonts')
      .whereIn('id', orphanedPublished.map(font => font.id))
      .where('is_published', true)
      .del();
    deleteOrphans = await applyTenantFilter(knex, deleteOrphans, 'fonts');
    await deleteOrphans;
    stats.deleted += orphanedPublished.length;
  }

  await cleanupOrphanedStorageFiles(
    [...deletedDrafts, ...orphanedPublished]
      .filter(font => font.storage_path)
      .map(font => font.storage_path as string)
  );

  return stats;
}

async function getFontsByPublishState(
  isPublished: boolean,
  errorMessage: string,
  includeDeleted = false
): Promise<Font[]> {
  const knex = await getDb();
  let query = knex('fonts')
    .select('*')
    .where('is_published', isPublished)
    .orderBy('created_at', 'asc');

  if (!includeDeleted) {
    query = query.whereNull('deleted_at');
  }

  query = await applyTenantFilter(knex, query, 'fonts');

  try {
    return normalizeRows(await query) as Font[];
  } catch (error) {
    throw new Error(
      `${errorMessage}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

async function cleanupOrphanedStorageFiles(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;

  const knex = await getDb();
  let query = knex('fonts')
    .select('storage_path')
    .whereIn('storage_path', storagePaths);
  query = await applyTenantFilter(knex, query, 'fonts');

  const existingRows = await query as Array<{ storage_path: string | null }>;
  const stillReferenced = new Set(existingRows.map(row => row.storage_path).filter(Boolean));
  const orphanedPaths = storagePaths.filter(path => !stillReferenced.has(path));

  if (orphanedPaths.length === 0) return;

  try {
    const storage = await getStorage();
    for (let i = 0; i < orphanedPaths.length; i += WRITE_BATCH_SIZE) {
      await storage.remove(orphanedPaths.slice(i, i + WRITE_BATCH_SIZE));
    }
  } catch (error) {
    console.error('Failed to delete orphaned font files:', error);
  }
}
