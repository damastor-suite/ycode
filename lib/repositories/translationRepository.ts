import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  chunkArray,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type { Translation, CreateTranslationData, UpdateTranslationData } from '@/types';

type TranslationDiffRow = Pick<
  Translation,
  'id' | 'content_value' | 'is_completed' | 'deleted_at'
>;

const PAGE_SIZE = 1000;
const IN_CHUNK_SIZE = 300;
const SLUG_CONTENT_KEYS = ['slug', 'field:key:slug'];
const NON_CMS_SOURCE_TYPES = ['page', 'folder', 'component'];

export async function getAllTranslationRows<T = Translation>(
  isPublished: boolean,
  columns: string[] = ['*'],
  tenantId?: string
): Promise<T[]> {
  const knex = await getDb();
  let query = knex('translations')
    .select(columns)
    .where('is_published', isPublished);
  query = await applyTenantFilter(knex, query, 'translations', tenantId);

  return normalizeRows(await query) as T[];
}

export async function getTranslationsByLocale(
  localeId: string,
  isPublished: boolean = false,
  tenantId?: string
): Promise<Translation[]> {
  const knex = await getDb();
  let query = knex('translations')
    .select('*')
    .where('locale_id', localeId)
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc');
  query = await applyTenantFilter(knex, query, 'translations', tenantId);

  try {
    return normalizeRows(await query) as Translation[];
  } catch (error) {
    throw new Error(
      `Failed to fetch translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getLocaleScaffoldTranslations(
  localeId: string,
  isPublished: boolean,
  tenantId?: string
): Promise<Translation[]> {
  const knex = await getDb();
  const results: Translation[] = [];

  try {
    let nonCmsQuery = knex('translations')
      .select('*')
      .where('locale_id', localeId)
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .whereIn('source_type', NON_CMS_SOURCE_TYPES)
      .orderBy('created_at', 'asc');
    nonCmsQuery = await applyTenantFilter(knex, nonCmsQuery, 'translations', tenantId);
    results.push(...normalizeRows(await nonCmsQuery) as Translation[]);

    let cmsSlugQuery = knex('translations')
      .select('*')
      .where('locale_id', localeId)
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .where('source_type', 'cms')
      .whereIn('content_key', SLUG_CONTENT_KEYS)
      .orderBy('created_at', 'asc');
    cmsSlugQuery = await applyTenantFilter(knex, cmsSlugQuery, 'translations', tenantId);
    results.push(...normalizeRows(await cmsSlugQuery) as Translation[]);

    return results;
  } catch (error) {
    throw new Error(
      `Failed to fetch translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getCmsTranslationsForItems(
  localeId: string,
  isPublished: boolean,
  itemIds: string[],
  tenantId?: string
): Promise<Translation[]> {
  if (itemIds.length === 0) return [];

  const knex = await getDb();
  const results: Translation[] = [];

  try {
    for (const itemIdChunk of chunkArray(itemIds, IN_CHUNK_SIZE)) {
      let query = knex('translations')
        .select('*')
        .where('locale_id', localeId)
        .where('is_published', isPublished)
        .whereNull('deleted_at')
        .where('source_type', 'cms')
        .whereIn('source_id', itemIdChunk);
      query = await applyTenantFilter(knex, query, 'translations', tenantId);
      results.push(...normalizeRows(await query) as Translation[]);
    }

    return results;
  } catch (error) {
    throw new Error(
      `Failed to fetch CMS translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getSlugTranslationsByLocale(
  localeId: string,
  isPublished: boolean,
  tenantId?: string
): Promise<Translation[]> {
  const knex = await getDb();
  let query = knex('translations')
    .select('*')
    .where('locale_id', localeId)
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .whereIn('content_key', SLUG_CONTENT_KEYS)
    .orderBy('created_at', 'asc');
  query = await applyTenantFilter(knex, query, 'translations', tenantId);

  try {
    return normalizeRows(await query) as Translation[];
  } catch (error) {
    throw new Error(
      `Failed to fetch slug translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getTranslationsBySource(
  sourceType: string,
  sourceId: string,
  isPublished: boolean = false
): Promise<Translation[]> {
  const knex = await getDb();
  let query = knex('translations')
    .select('*')
    .where('source_type', sourceType)
    .where('source_id', sourceId)
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('created_at', 'asc');
  query = await applyTenantFilter(knex, query, 'translations');

  try {
    return normalizeRows(await query) as Translation[];
  } catch (error) {
    throw new Error(
      `Failed to fetch translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getTranslationById(
  id: string,
  isPublished: boolean = false
): Promise<Translation | null> {
  const knex = await getDb();
  let query = knex('translations')
    .select('*')
    .where('id', id)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'translations');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Translation : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch translation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getTranslationByKey(
  localeId: string,
  sourceType: string,
  sourceId: string,
  contentKey: string,
  isPublished: boolean = false
): Promise<Translation | null> {
  const knex = await getDb();
  let query = knex('translations')
    .select('*')
    .where('locale_id', localeId)
    .where('source_type', sourceType)
    .where('source_id', sourceId)
    .where('content_key', contentKey)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'translations');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Translation : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch translation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createTranslation(
  translationData: CreateTranslationData
): Promise<Translation> {
  const knex = await getDb();
  const row = await buildTranslationRow(knex, translationData);
  const conflictColumns = await getConflictColumns(
    knex,
    'translations',
    ['locale_id', 'source_type', 'source_id', 'content_key', 'is_published'],
    (row as Record<string, unknown>).tenant_id as string | undefined
  );

  try {
    const [data] = await knex('translations')
      .insert(row)
      .onConflict(conflictColumns)
      .merge([
        'content_type',
        'content_value',
        'is_completed',
        'deleted_at',
        'updated_at',
      ])
      .returning('*');

    return normalizeRow(data) as Translation;
  } catch (error) {
    throw new Error(
      `Failed to create translation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateTranslation(
  id: string,
  updates: UpdateTranslationData
): Promise<Translation> {
  const knex = await getDb();
  let query = knex('translations')
    .where('id', id)
    .where('is_published', false)
    .update({
      ...updates,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .returning('*');
  query = await applyTenantFilter(knex, query, 'translations');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Translation not found');
    }
    return normalizeRow(data) as Translation;
  } catch (error) {
    throw new Error(
      `Failed to update translation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteTranslation(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('translations')
    .where('id', id)
    .where('is_published', false)
    .update({ deleted_at: new Date().toISOString() });
  query = await applyTenantFilter(knex, query, 'translations');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete translation: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteTranslationsInBulk(
  sourceType: string,
  sourceIds: string | string[],
  contentKeys?: string[]
): Promise<void> {
  const sourceIdArray = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  if (sourceIdArray.length === 0) return;
  if (contentKeys !== undefined && contentKeys.length === 0) return;

  const knex = await getDb();
  let query = knex('translations')
    .where('source_type', sourceType)
    .whereIn('source_id', sourceIdArray)
    .where('is_published', false)
    .update({ deleted_at: new Date().toISOString() });

  if (contentKeys !== undefined) {
    query = query.whereIn('content_key', contentKeys);
  }

  query = await applyTenantFilter(knex, query, 'translations');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function markTranslationsIncomplete(
  sourceType: string,
  sourceId: string,
  contentKeys: string[]
): Promise<void> {
  if (contentKeys.length === 0) {
    return;
  }

  const knex = await getDb();
  let query = knex('translations')
    .where('source_type', sourceType)
    .where('source_id', sourceId)
    .whereIn('content_key', contentKeys)
    .where('is_published', false)
    .whereNull('deleted_at')
    .update({
      is_completed: false,
      updated_at: new Date().toISOString(),
    });
  query = await applyTenantFilter(knex, query, 'translations');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to mark translations as incomplete: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function upsertTranslations(
  translations: CreateTranslationData[]
): Promise<Translation[]> {
  if (translations.length === 0) {
    return [];
  }

  const knex = await getDb();
  const rows = await Promise.all(translations.map((translation) => buildTranslationRow(knex, translation)));
  const conflictColumns = await getConflictColumns(
    knex,
    'translations',
    ['locale_id', 'source_type', 'source_id', 'content_key', 'is_published'],
    (rows[0] as Record<string, unknown>).tenant_id as string | undefined
  );

  try {
    const result: Translation[] = [];
    for (const rowChunk of chunkArray(rows, PAGE_SIZE)) {
      const data = await knex('translations')
        .insert(rowChunk)
        .onConflict(conflictColumns)
        .merge([
          'content_type',
          'content_value',
          'is_completed',
          'deleted_at',
          'updated_at',
        ])
        .returning('*');
      result.push(...normalizeRows(data) as Translation[]);
    }

    return result;
  } catch (error) {
    throw new Error(
      `Failed to upsert translations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getUnpublishedTranslationsCount(): Promise<number> {
  const cols = ['id', 'content_value', 'is_completed', 'deleted_at'];
  const [draftRows, publishedRows] = await Promise.all([
    getAllTranslationRows<TranslationDiffRow>(false, cols),
    getAllTranslationRows<TranslationDiffRow>(true, cols),
  ]);

  if (draftRows.length === 0) {
    return 0;
  }

  const publishedById = new Map<string, TranslationDiffRow>();
  for (const translation of publishedRows) {
    publishedById.set(translation.id, translation);
  }

  let count = 0;
  for (const draft of draftRows) {
    const published = publishedById.get(draft.id);

    if (!published || published.deleted_at) {
      if (!draft.deleted_at) count += 1;
      continue;
    }

    if (draft.deleted_at) {
      count += 1;
      continue;
    }

    if (
      draft.content_value !== published.content_value ||
      draft.is_completed !== published.is_completed
    ) {
      count += 1;
    }
  }

  return count;
}

async function buildTranslationRow(
  knex: Awaited<ReturnType<typeof getDb>>,
  translationData: CreateTranslationData
): Promise<Record<string, unknown>> {
  return addTenantIdToRow(knex, 'translations', {
    locale_id: translationData.locale_id,
    source_type: translationData.source_type,
    source_id: translationData.source_id,
    content_key: translationData.content_key,
    content_type: translationData.content_type,
    content_value: translationData.content_value,
    is_completed: translationData.is_completed ?? false,
    is_published: false,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  });
}
