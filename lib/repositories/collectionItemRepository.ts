import { randomUUID } from 'crypto';

import type { Knex } from 'knex';

import { buildStatusValue, findStatusFieldId } from '@/lib/collection-field-utils';
import { castValue } from '@/lib/collection-utils';
import { generateCollectionItemContentHash } from '@/lib/hash-utils';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb, isMissingTableError } from '@/lib/platform/db';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import {
  getValueRowsForItems,
  getValuesByFieldId,
  getValuesByItemId,
  getValuesByItemIds,
} from '@/lib/repositories/collectionItemValueRepository';
import type { CollectionField, CollectionItem, CollectionItemWithValues } from '@/types';

/**
 * Collection Item Repository
 *
 * Handles CRUD operations for collection items (EAV entities).
 * Items are the actual content entries in a collection.
 * Uses Knex/PostgreSQL via the platform database port.
 *
 * NOTE: Uses composite primary key (id, is_published) architecture.
 * References parent collections using FK (collection_id).
 */

export interface QueryFilters {
  deleted?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
  itemIds?: string[]; // Filter to specific item IDs (for multi-reference pagination)
}

export interface CreateCollectionItemData {
  collection_id: string; // UUID
  manual_order?: number;
  is_published?: boolean;
  is_publishable?: boolean;
  content_hash?: string;
}

export interface UpdateCollectionItemData {
  manual_order?: number;
  is_publishable?: boolean;
}

type CollectionItemWithTenant = CollectionItem & { tenant_id?: string | null };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function addTenantIdToRow(row: Record<string, unknown>, tenantId?: string | null): Promise<Record<string, unknown>> {
  const resolvedTenantId = tenantId ?? await getTenantIdFromHeaders();
  if (resolvedTenantId) {
    row.tenant_id = resolvedTenantId;
  }
  return row;
}

async function addSearchFilter(
  knex: Knex,
  query: Knex.QueryBuilder,
  isPublished: boolean,
  search?: string
): Promise<Knex.QueryBuilder> {
  if (!search?.trim()) return query;

  let valueSubquery = knex('collection_item_values')
    .select(knex.raw('1'))
    .whereRaw('collection_item_values.item_id = collection_items.id')
    .andWhere('collection_item_values.is_published', isPublished)
    .whereNull('collection_item_values.deleted_at')
    .andWhereILike('collection_item_values.value', `%${search.trim()}%`);
  valueSubquery = await addTenantFilter(knex, valueSubquery, 'collection_item_values');

  return query.whereExists(valueSubquery);
}

async function baseItemsByCollectionQuery(
  knex: Knex,
  collectionId: string,
  isPublished: boolean,
  filters?: QueryFilters
): Promise<Knex.QueryBuilder> {
  let query = knex('collection_items')
    .where('collection_id', collectionId)
    .andWhere('is_published', isPublished);

  if (isPublished) {
    query = query.andWhere('is_publishable', true);
  }

  if (filters?.itemIds) {
    query = query.whereIn('id', filters.itemIds);
  }

  if (filters && 'deleted' in filters) {
    if (filters.deleted === false) {
      query = query.whereNull('deleted_at');
    } else if (filters.deleted === true) {
      query = query.whereNotNull('deleted_at');
    }
  } else {
    query = query.whereNull('deleted_at');
  }

  query = await addSearchFilter(knex, query, isPublished, filters?.search);
  return addTenantFilter(knex, query, 'collection_items');
}

async function batchUpdateColumnById(
  knex: Knex,
  tableName: string,
  columnName: string,
  updates: Array<{ id: string; value: string | number }>,
  extraWhere: (query: Knex.QueryBuilder) => Knex.QueryBuilder
): Promise<void> {
  if (updates.length === 0) return;

  const caseBindings = updates.flatMap((update) => [update.id, update.value]);
  const caseExpression = knex.raw(
    `CASE ${updates.map(() => 'WHEN id = ? THEN ?').join(' ')} ELSE ?? END`,
    [...caseBindings, columnName]
  );

  let query = extraWhere(knex(tableName).whereIn('id', updates.map((update) => update.id)));
  query = await addTenantFilter(knex, query, tableName);
  await query.update({
    [columnName]: caseExpression,
    updated_at: new Date().toISOString(),
  });
}

async function batchUpdateContentHashes(
  itemHashes: Array<{ id: string; hash: string }>,
  isPublished: boolean
): Promise<void> {
  if (itemHashes.length === 0) return;

  const knex = await getDb();
  await batchUpdateColumnById(
    knex,
    'collection_items',
    'content_hash',
    itemHashes.map((item) => ({ id: item.id, value: item.hash })),
    (query) => query.andWhere('is_published', isPublished)
  );
}

/**
 * Get top N items per collection for multiple collections in one query
 * Uses window function (ROW_NUMBER() OVER PARTITION BY) for efficient batch loading
 * @param collectionIds - Array of collection UUIDs
 * @param is_published - Filter for draft (false) or published (true) items. Defaults to false (draft).
 * @param limit - Number of items per collection. Defaults to 10.
 */
export async function getTopItemsPerCollection(
  collectionIds: string[],
  is_published: boolean = false,
  limit: number = 10
): Promise<CollectionItem[]> {
  if (collectionIds.length === 0) {
    return [];
  }

  const knex = await getDb();

  try {
    let rankedQuery = knex('collection_items')
      .select(
        '*',
        knex.raw('ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY manual_order ASC, created_at DESC) as row_num')
      )
      .whereIn('collection_id', collectionIds)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');

    if (is_published) {
      rankedQuery = rankedQuery.andWhere('is_publishable', true);
    }

    rankedQuery = await addTenantFilter(knex, rankedQuery, 'collection_items');

    const rows = await knex
      .from(rankedQuery.as('ranked_items'))
      .select('*')
      .where('row_num', '<=', limit)
      .orderBy('collection_id', 'asc')
      .orderBy('manual_order', 'asc')
      .orderBy('created_at', 'desc') as Array<CollectionItem & { row_num?: number }>;

    return rows.map(({ row_num: _rowNum, ...row }) => row);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch items: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all items for a collection with pagination support
 * @param collection_id - Collection UUID
 * @param is_published - Filter for draft (false) or published (true) items. Defaults to false (draft).
 * @param filters - Optional query filters
 */
export async function getItemsByCollectionId(
  collection_id: string,
  is_published: boolean = false,
  filters?: QueryFilters
): Promise<{ items: CollectionItem[], total: number }> {
  if (filters?.itemIds && filters.itemIds.length === 0) {
    return { items: [], total: 0 };
  }

  const knex = await getDb();

  try {
    const baseQuery = await baseItemsByCollectionQuery(knex, collection_id, is_published, filters);

    const countResult = await baseQuery
      .clone()
      .clearSelect()
      .clearOrder()
      .count({ count: '*' })
      .first() as { count?: string | number } | undefined;

    let dataQuery = baseQuery
      .clone()
      .select('*')
      .orderBy('manual_order', 'asc')
      .orderBy('created_at', 'desc');

    if (filters?.limit !== undefined) {
      dataQuery = dataQuery.limit(filters.limit);
    }
    if (filters?.offset !== undefined) {
      dataQuery = dataQuery.offset(filters.offset);
    }

    const items = await dataQuery as CollectionItem[];
    return { items, total: Number(countResult?.count) || 0 };
  } catch (error) {
    if (isMissingTableError(error)) return { items: [], total: 0 };
    throw new Error(`Failed to fetch collection items: ${getErrorMessage(error)}`);
  }
}

/**
 * Fetch the published-counterpart content hash for a set of draft item IDs.
 * Backfills any rows missing a hash so subsequent calls are cheap. Exposed
 * so callers (e.g. the batch endpoint) can fetch once for many collections.
 */
export async function fetchPublishedHashMap(
  itemIds: string[],
): Promise<Map<string, string | null>> {
  const publishedHashMap = new Map<string, string | null>();
  if (itemIds.length === 0) return publishedHashMap;

  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .select('id', 'content_hash')
      .whereIn('id', itemIds)
      .andWhere('is_published', true)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_items');

    const publishedRows = await query as Array<{ id: string; content_hash: string | null }>;
    for (const row of publishedRows) {
      publishedHashMap.set(row.id, row.content_hash);
    }

    const itemsMissingHash = publishedRows.filter((row) => row.content_hash == null);
    if (itemsMissingHash.length > 0) {
      const valueRows = await getValueRowsForItems(itemsMissingHash.map((row) => row.id), true);
      const valuesByItem = new Map<string, Array<{ field_id: string; value: string | null }>>();

      for (const row of valueRows) {
        if (!valuesByItem.has(row.item_id)) valuesByItem.set(row.item_id, []);
        valuesByItem.get(row.item_id)!.push({ field_id: row.field_id, value: row.value });
      }

      const hashesToBackfill: Array<{ id: string; hash: string }> = [];
      for (const item of itemsMissingHash) {
        const values = valuesByItem.get(item.id) || [];
        if (values.length === 0) continue;

        const hash = generateCollectionItemContentHash(values);
        publishedHashMap.set(item.id, hash);
        hashesToBackfill.push({ id: item.id, hash });
      }

      await batchUpdateContentHashes(hashesToBackfill, true);
    }
  } catch (err) {
    console.error('Failed to fetch published items for status:', err);
  }

  return publishedHashMap;
}

/**
 * Enrich draft items with computed status values for the Status field.
 * Injects `{ is_publishable, is_published, is_modified }` JSON into each item's
 * values map under the status field's ID, matching the old project's format.
 *
 * Pass `publishedHashMap` (e.g. from a single batch fetch across collections)
 * to skip the per-call DB round-trip.
 */
export async function enrichItemsWithStatus(
  items: CollectionItemWithValues[],
  collectionId: string,
  statusFieldId: string | null,
  publishedHashMap?: Map<string, string | null>,
): Promise<void> {
  if (!statusFieldId || items.length === 0) return;

  const hashMap = publishedHashMap
    ?? await fetchPublishedHashMap(items.map((item) => item.id));

  for (const item of items) {
    const publishedHash = hashMap.get(item.id);
    const hasPublishedVersion = publishedHash !== undefined;
    const isModified = hasPublishedVersion
      && item.content_hash != null
      && publishedHash != null
      && item.content_hash !== publishedHash;

    item.values[statusFieldId] = buildStatusValue(item.is_publishable, hasPublishedVersion, isModified);
  }
}

/**
 * Enrich a single item with computed status.
 * Fetches fields internally — use when the caller doesn't already have them.
 */
export async function enrichSingleItemWithStatus(
  item: CollectionItemWithValues,
  collectionId: string,
): Promise<void> {
  const fields = await getFieldsByCollectionId(collectionId, false);
  await enrichItemsWithStatus([item], collectionId, findStatusFieldId(fields));
}

/**
 * Get every non-deleted item across all collections in one Knex read.
 * Intended for bulk publish flows that group items by collection in memory,
 * avoiding a per-collection round-trip.
 * @param tenantId - Optional explicit tenant scope (required inside unstable_cache)
 */
export async function getAllItemsRaw(
  is_published: boolean,
  tenantId?: string
): Promise<CollectionItem[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .select('*')
      .where('is_published', is_published)
      .whereNull('deleted_at');

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collection_items');
    }

    return await query as CollectionItem[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch collection items: ${getErrorMessage(error)}`);
  }
}

/**
 * Get ALL items for a collection (with pagination to handle >1000 items)
 * Use this for publishing and other operations that need all items
 * @param includeDeleted - If true, only returns deleted items. If false/undefined, excludes deleted items.
 */
export async function getAllItemsByCollectionId(
  collection_id: string,
  is_published: boolean = false,
  includeDeleted: boolean = false
): Promise<CollectionItem[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .select('*')
      .where('collection_id', collection_id)
      .andWhere('is_published', is_published)
      .orderBy('manual_order', 'asc')
      .orderBy('created_at', 'desc');

    if (is_published) {
      query = query.where('is_publishable', true);
    }

    query = includeDeleted
      ? query.whereNotNull('deleted_at')
      : query.whereNull('deleted_at');

    query = await addTenantFilter(knex, query, 'collection_items');
    return await query as CollectionItem[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch collection items: ${getErrorMessage(error)}`);
  }
}

/**
 * Get item by ID
 * @param id - Item UUID
 * @param isPublished - Get draft (false) or published (true) version. Defaults to false (draft).
 */
export async function getItemById(
  id: string,
  isPublished: boolean = false,
  tenantId?: string
): Promise<CollectionItem | null> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .select('*')
      .where('id', id)
      .andWhere('is_published', isPublished);

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collection_items');
    }

    const data = await query.first();
    return data ? data as CollectionItem : null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch collection item: ${getErrorMessage(error)}`);
  }
}

/**
 * Batch fetch items by IDs
 * @param ids - Array of item UUIDs
 * @param isPublished - Get draft (false) or published (true) items
 * @returns Array of items found
 */
export async function getItemsByIds(
  ids: string[],
  isPublished: boolean = false,
  tenantId?: string
): Promise<CollectionItem[]> {
  if (ids.length === 0) {
    return [];
  }

  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .select('*')
      .whereIn('id', ids)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collection_items');
    }

    return await query as CollectionItem[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch collection items: ${getErrorMessage(error)}`);
  }
}

/**
 * Get item with all field values joined
 * Returns item with values as { field_id: value } object
 * @param id - Item UUID
 * @param is_published - Get draft (false) or published (true) values. Defaults to false (draft).
 */
export async function getItemWithValues(
  id: string,
  is_published: boolean = false,
  tenantId?: string
): Promise<CollectionItemWithValues | null> {
  const item = await getItemById(id, is_published, tenantId);
  if (!item) return null;

  const knex = await getDb();

  try {
    let valuesQuery = knex('collection_item_values')
      .select('value', 'field_id')
      .where('item_id', id)
      .andWhere('is_published', is_published);

    if (!item.deleted_at) {
      valuesQuery = valuesQuery.whereNull('deleted_at');
    }

    if (tenantId) {
      valuesQuery = valuesQuery.where('tenant_id', tenantId);
    } else {
      valuesQuery = await addTenantFilter(knex, valuesQuery, 'collection_item_values');
    }

    const valuesData = await valuesQuery as Array<{ value: string | null; field_id: string }>;
    const fieldIds = Array.from(new Set(valuesData.map((row) => row.field_id)));

    let fieldTypeMap: Record<string, string> = {};
    if (fieldIds.length > 0) {
      let fieldsQuery = knex('collection_fields')
        .select('id', 'type')
        .whereIn('id', fieldIds);
      if (tenantId) {
        fieldsQuery = fieldsQuery.where('tenant_id', tenantId);
      } else {
        fieldsQuery = await addTenantFilter(knex, fieldsQuery, 'collection_fields');
      }

      const fields = await fieldsQuery as Array<{ id: string; type: string }>;
      fieldTypeMap = Object.fromEntries(fields.map((field) => [field.id, field.type]));
    }

    const values: Record<string, any> = {};
    valuesData.forEach((row) => {
      if (row.field_id) {
        values[row.field_id] = castValue(row.value, (fieldTypeMap[row.field_id] || 'text') as CollectionField['type']);
      }
    });

    return {
      ...item,
      values,
    };
  } catch (error) {
    if (isMissingTableError(error)) return { ...item, values: {} };
    throw new Error(`Failed to fetch item values: ${getErrorMessage(error)}`);
  }
}

/**
 * Find item IDs in a collection where a specific field value matches a target value.
 * Used for inverse reference resolution: given a parent item ID, find all items
 * in the child collection whose reference field points to that parent.
 * Handles both single reference (exact match) and multi_reference (JSON array contains).
 */
export async function getItemIdsByFieldValue(
  collectionId: string,
  fieldId: string,
  targetValue: string,
  isPublished: boolean = false
): Promise<string[]> {
  const knex = await getDb();

  try {
    let valuesQuery = knex('collection_item_values')
      .select('item_id')
      .where('field_id', fieldId)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at')
      .andWhere((builder) => {
        builder
          .where('value', targetValue)
          .orWhere('value', 'like', `%"${targetValue}"%`);
      });
    valuesQuery = await addTenantFilter(knex, valuesQuery, 'collection_item_values');

    const values = await valuesQuery as Array<{ item_id: string }>;
    const candidateIds = Array.from(new Set(values.map((value) => value.item_id)));
    if (candidateIds.length === 0) return [];

    let itemsQuery = knex('collection_items')
      .select('id')
      .where('collection_id', collectionId)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at')
      .whereIn('id', candidateIds);
    itemsQuery = await addTenantFilter(knex, itemsQuery, 'collection_items');

    const validItems = await itemsQuery as Array<{ id: string }>;
    return validItems.map((item) => item.id);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to query inverse references: ${getErrorMessage(error)}`);
  }
}

/**
 * Sort + paginate items by a field value at the DB level using a LEFT JOIN.
 * Avoids fetching every item for the collection: only the requested page
 * is materialized with full values. Items with no value for the sort field
 * appear last (ASC) or first (DESC) so the relative ordering matches what
 * a client-side sort would produce.
 *
 * Pass `knownFieldTypes` to skip the extra `collection_fields` lookup when
 * the caller has already loaded the field schema.
 */
export async function getItemsSortedByField(
  collection_id: string,
  sortFieldId: string,
  sortOrder: 'asc' | 'desc' = 'asc',
  is_published: boolean = false,
  limit: number = 25,
  offset: number = 0,
  search?: string,
  knownFieldTypes?: Record<string, string>,
): Promise<{ items: CollectionItemWithValues[], total: number }> {
  const knex = await getDb();
  const safeSortOrder = sortOrder === 'desc' ? 'DESC' : 'ASC';
  const nullsPosition = safeSortOrder === 'ASC' ? 'NULLS LAST' : 'NULLS FIRST';

  try {
    let searchItemIds: string[] | null = null;
    if (search?.trim()) {
      let matchRowsQuery = knex('collection_item_values')
        .distinct('item_id')
        .where('is_published', is_published)
        .whereNull('deleted_at')
        .andWhereILike('value', `%${search.trim()}%`);
      matchRowsQuery = await addTenantFilter(knex, matchRowsQuery, 'collection_item_values');

      const matchRows = await matchRowsQuery as Array<{ item_id: string }>;
      if (matchRows.length === 0) return { items: [], total: 0 };
      searchItemIds = matchRows.map((row) => row.item_id);
    }

    let itemBase = knex('collection_items')
      .select('*')
      .where('collection_id', collection_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');

    if (is_published) {
      itemBase = itemBase.andWhere('is_publishable', true);
    }
    if (searchItemIds) {
      itemBase = itemBase.whereIn('id', searchItemIds);
    }
    itemBase = await addTenantFilter(knex, itemBase, 'collection_items');

    let sortValues = knex('collection_item_values')
      .select('item_id', 'value')
      .where('is_published', is_published)
      .andWhere('field_id', sortFieldId)
      .whereNull('deleted_at');
    sortValues = await addTenantFilter(knex, sortValues, 'collection_item_values');

    const baseQuery = knex
      .from(itemBase.as('ci'))
      .leftJoin(sortValues.as('civ'), 'civ.item_id', 'ci.id');

    const countResult = await baseQuery
      .clone()
      .count<{ count: string | number }[]>({ count: 'ci.id' })
      .first();

    const rows = await baseQuery
      .clone()
      .select('ci.*')
      .orderByRaw(`civ.value ${safeSortOrder} ${nullsPosition}`)
      .orderBy('ci.manual_order', 'asc')
      .limit(limit)
      .offset(offset) as CollectionItem[];

    const total = Number(countResult?.count) || 0;
    if (rows.length === 0) {
      return { items: [], total };
    }

    const valuesByItem = await getValuesByItemIds(rows.map((row) => row.id), is_published, knownFieldTypes);
    const items = rows.map((row) => ({
      ...row,
      values: valuesByItem[row.id] || {},
    }));

    return { items, total };
  } catch (error) {
    if (isMissingTableError(error)) return { items: [], total: 0 };
    throw new Error(`Failed to fetch sorted collection items: ${getErrorMessage(error)}`);
  }
}

/**
 * Batch fetch items with their values by arbitrary IDs (cross-collection).
 * Returns a map keyed by item ID for O(1) lookups.
 * Uses 2 queries total regardless of item count.
 */
export async function getItemsWithValuesByIds(
  ids: string[],
  is_published: boolean = false
): Promise<Record<string, CollectionItemWithValues>> {
  if (ids.length === 0) return {};

  const items = await getItemsByIds(ids, is_published);
  if (items.length === 0) return {};

  const valuesByItem = await getValuesByItemIds(items.map((item) => item.id), is_published);

  const result: Record<string, CollectionItemWithValues> = {};
  for (const item of items) {
    result[item.id] = { ...item, values: valuesByItem[item.id] || {} };
  }
  return result;
}

/**
 * Batch fetch slug values for arbitrary item IDs across collections.
 * Returns a map keyed by item ID. Only items whose owning collection has a
 * `slug` field with a non-empty value are included.
 */
export async function getSlugsByItemIds(
  ids: string[],
  is_published: boolean = false
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};

  const itemsByIds = await getItemsWithValuesByIds(ids, is_published);
  const itemList = Object.values(itemsByIds);
  if (itemList.length === 0) return {};

  const refCollectionIds = Array.from(new Set(itemList.map((item) => item.collection_id)));
  const fieldsByCollection = new Map<string, CollectionField[]>();
  await Promise.all(
    refCollectionIds.map(async (collId) => {
      const fields = await getFieldsByCollectionId(collId, is_published);
      fieldsByCollection.set(collId, fields);
    })
  );

  const slugs: Record<string, string> = {};
  for (const item of itemList) {
    const fields = fieldsByCollection.get(item.collection_id);
    const slugField = fields?.find((field) => field.key === 'slug');
    const slugValue = slugField ? item.values[slugField.id] : undefined;
    if (slugValue) {
      slugs[item.id] = String(slugValue);
    }
  }
  return slugs;
}

/**
 * Get multiple items with their values
 * @param collection_id - Collection UUID
 * @param is_published - Filter for draft (false) or published (true) items and values. Defaults to false (draft).
 * @param filters - Optional query filters
 */
export async function getItemsWithValues(
  collection_id: string,
  is_published: boolean = false,
  filters?: QueryFilters,
  knownFieldTypes?: Record<string, string>,
): Promise<{ items: CollectionItemWithValues[], total: number }> {
  const { items, total } = await getItemsByCollectionId(collection_id, is_published, filters);

  if (items.length === 0) {
    return { items: [], total };
  }

  const valuesByItem = await getValuesByItemIds(
    items.map((item) => item.id),
    is_published,
    knownFieldTypes
  );

  const itemsWithValues = items.map((item) => ({
    ...item,
    values: valuesByItem[item.id] || {},
  }));

  return { items: itemsWithValues, total };
}

/**
 * Get top N items with values for multiple collections in 2 queries
 * Uses optimized batch queries with PARTITION BY and WHERE IN.
 * Note: does NOT return accurate totals — callers should use collection.draft_items_count
 * or getItemsByCollectionId (which returns exact count) for accurate pagination.
 * @param collectionIds - Array of collection UUIDs
 * @param is_published - Filter for draft (false) or published (true). Defaults to false (draft).
 * @param limit - Number of items per collection. Defaults to 25.
 */
export async function getTopItemsWithValuesPerCollection(
  collectionIds: string[],
  is_published: boolean = false,
  limit: number = 25
): Promise<Record<string, { items: CollectionItemWithValues[] }>> {
  if (collectionIds.length === 0) {
    return {};
  }

  const items = await getTopItemsPerCollection(collectionIds, is_published, limit);

  const result: Record<string, { items: CollectionItemWithValues[] }> = {};
  collectionIds.forEach((id) => {
    result[id] = { items: [] };
  });

  if (items.length === 0) {
    return result;
  }

  const valuesByItem = await getValuesByItemIds(items.map((item) => item.id), is_published);
  const itemsWithValues = items.map((item) => ({
    ...item,
    values: valuesByItem[item.id] || {},
  }));

  itemsWithValues.forEach((item) => {
    if (!result[item.collection_id]) {
      result[item.collection_id] = { items: [] };
    }
    result[item.collection_id].items.push(item);
  });

  return result;
}

/**
 * Get the highest manual_order value for items in a collection.
 */
export async function getMaxManualOrder(
  collectionId: string,
  isPublished: boolean = false
): Promise<number> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .select('manual_order')
      .where('collection_id', collectionId)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at')
      .orderBy('manual_order', 'desc')
      .limit(1);
    query = await addTenantFilter(knex, query, 'collection_items');

    const data = await query.first() as { manual_order?: number } | undefined;
    return data?.manual_order ?? -1;
  } catch {
    return -1;
  }
}

/**
 * Get the maximum ID value for the ID field in a collection
 * @param collection_id - Collection UUID
 * @param is_published - Filter for draft (false) or published (true) values. Defaults to false (draft).
 * @returns The maximum numeric ID value, or 0 if no IDs exist
 */
export async function getMaxIdValue(
  collection_id: string,
  is_published: boolean = false
): Promise<number> {
  const fields = await getFieldsByCollectionId(collection_id, is_published);
  const idField = fields.find((field) => field.key === 'id');

  if (!idField) {
    return 0;
  }

  const idValues = await getValuesByFieldId(idField.id, is_published);

  let maxId = 0;
  for (const value of idValues) {
    if (value.value) {
      const numericId = parseInt(value.value, 10);
      if (!isNaN(numericId) && numericId > maxId) {
        maxId = numericId;
      }
    }
  }

  return maxId;
}

/**
 * Bulk create items in a single INSERT
 * @param items - Array of items to create (id is auto-generated if not provided)
 */
export async function createItemsBulk(
  items: Array<CreateCollectionItemData & { id?: string }>
): Promise<CollectionItem[]> {
  if (items.length === 0) return [];

  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const now = new Date().toISOString();
  const itemsToInsert = items.map((item) => {
    const row: Record<string, unknown> = {
      id: item.id || randomUUID(),
      collection_id: item.collection_id,
      manual_order: item.manual_order ?? 0,
      is_published: item.is_published ?? false,
      is_publishable: item.is_publishable ?? true,
      content_hash: item.content_hash ?? null,
      created_at: now,
      updated_at: now,
    };
    if (tenantId) row.tenant_id = tenantId;
    return row;
  });

  try {
    const data = await knex('collection_items').insert(itemsToInsert).returning('*');
    return data as CollectionItem[];
  } catch (error) {
    throw new Error(`Failed to bulk create items: ${getErrorMessage(error)}`);
  }
}

/**
 * Create a new item
 */
export async function createItem(itemData: CreateCollectionItemData): Promise<CollectionItem> {
  const knex = await getDb();
  const now = new Date().toISOString();
  const isPublished = itemData.is_published ?? false;

  const row = await addTenantIdToRow({
    id: randomUUID(),
    ...itemData,
    manual_order: itemData.manual_order ?? 0,
    is_published: isPublished,
    is_publishable: itemData.is_publishable ?? true,
    created_at: now,
    updated_at: now,
  });

  try {
    const [data] = await knex('collection_items').insert(row).returning('*');
    return data as CollectionItem;
  } catch (error) {
    throw new Error(`Failed to create collection item: ${getErrorMessage(error)}`);
  }
}

/**
 * Update an item
 * @param id - Item UUID
 * @param itemData - Data to update
 * @param isPublished - Which version to update: draft (false) or published (true). Defaults to false (draft).
 */
export async function updateItem(
  id: string,
  itemData: UpdateCollectionItemData,
  isPublished: boolean = false
): Promise<CollectionItem> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_items');

    const [data] = await query
      .update({
        ...itemData,
        updated_at: new Date().toISOString(),
      })
      .returning('*');

    if (!data) {
      throw new Error('Collection item not found');
    }

    return data as CollectionItem;
  } catch (error) {
    throw new Error(`Failed to update collection item: ${getErrorMessage(error)}`);
  }
}

/**
 * Delete an item (soft delete)
 * Sets deleted_at timestamp to mark item as deleted in draft
 * Also soft deletes all associated draft collection_item_values
 * Only deletes the draft version by default.
 * @param id - Item UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function deleteItem(id: string, isPublished: boolean = false): Promise<void> {
  const knex = await getDb();
  const now = new Date().toISOString();

  try {
    let itemQuery = knex('collection_items')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    itemQuery = await addTenantFilter(knex, itemQuery, 'collection_items');
    await itemQuery.update({ deleted_at: now, updated_at: now });

    let valuesQuery = knex('collection_item_values')
      .where('item_id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    valuesQuery = await addTenantFilter(knex, valuesQuery, 'collection_item_values');
    await valuesQuery.update({ deleted_at: now, updated_at: now });
  } catch (error) {
    throw new Error(`Failed to delete collection item: ${getErrorMessage(error)}`);
  }
}

/**
 * Hard delete an item
 * Permanently removes item and all associated collection_item_values via CASCADE
 * Used during publish to permanently remove soft-deleted items
 * @param id - Item UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function hardDeleteItem(id: string, isPublished: boolean = false): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .where('id', id)
      .andWhere('is_published', isPublished);
    query = await addTenantFilter(knex, query, 'collection_items');
    await query.del();
  } catch (error) {
    throw new Error(`Failed to hard delete collection item: ${getErrorMessage(error)}`);
  }
}

/**
 * Duplicate a collection item with its draft values
 * Creates a copy of the item with a new ID and modified values
 * @param itemId - UUID of the item to duplicate
 * @param isPublished - Whether to duplicate draft (false) or published (true) version. Defaults to false (draft).
 */
export async function duplicateItem(
  itemId: string,
  isPublished: boolean = false
): Promise<CollectionItemWithValues> {
  const originalItem = await getItemWithValues(itemId, isPublished);
  if (!originalItem) {
    throw new Error('Item not found');
  }

  const fields = await getFieldsByCollectionId(originalItem.collection_id, isPublished);
  const idField = fields.find((field) => field.key === 'id');
  const nameField = fields.find((field) => field.key === 'name');
  const slugField = fields.find((field) => field.key === 'slug');
  const createdAtField = fields.find((field) => field.key === 'created_at');
  const updatedAtField = fields.find((field) => field.key === 'updated_at');

  const { items: allItems } = await getItemsWithValues(
    originalItem.collection_id,
    isPublished,
    undefined
  );

  const newValues = { ...originalItem.values };

  if (idField && newValues[idField.id]) {
    let highestId = 0;
    allItems.forEach((item) => {
      const val = item.values[idField.id];
      if (val) {
        const num = parseInt(String(val), 10);
        if (!isNaN(num)) highestId = Math.max(highestId, num);
      }
    });
    newValues[idField.id] = String(highestId + 1);
  }

  const now = new Date().toISOString();
  if (createdAtField) newValues[createdAtField.id] = now;
  if (updatedAtField) newValues[updatedAtField.id] = now;

  if (nameField && newValues[nameField.id]) {
    newValues[nameField.id] = `${newValues[nameField.id]} (Copy)`;
  }

  if (slugField) {
    const originalSlug = newValues[slugField.id] ? String(newValues[slugField.id]).trim() : '';
    const baseSlug = originalSlug || 'copy';
    const baseSlugClean = baseSlug.replace(/-\d+$/, '');

    const existingSlugs = new Set(
      allItems
        .map((item) => item.values[slugField.id])
        .filter((slug): slug is string => !!slug && typeof slug === 'string')
    );

    let newSlug = `${baseSlugClean}-copy`;
    if (existingSlugs.has(newSlug)) {
      let n = 1;
      while (existingSlugs.has(`${baseSlugClean}-copy-${n}`)) n++;
      newSlug = `${baseSlugClean}-copy-${n}`;
    }
    newValues[slugField.id] = newSlug;
  }

  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const newId = randomUUID();
  const newItemRow: Record<string, unknown> = {
    id: newId,
    collection_id: originalItem.collection_id,
    manual_order: originalItem.manual_order,
    is_published: isPublished,
    is_publishable: originalItem.is_publishable,
    created_at: now,
    updated_at: now,
  };
  const originalTenantId = (originalItem as CollectionItemWithTenant).tenant_id ?? tenantId;
  if (originalTenantId) newItemRow.tenant_id = originalTenantId;

  try {
    const [newItem] = await knex('collection_items').insert(newItemRow).returning('*') as CollectionItem[];

    const validFieldIds = new Set(fields.map((field) => field.id));
    const valuesToInsert = Object.entries(newValues)
      .filter(([fieldId]) => validFieldIds.has(fieldId))
      .map(([fieldId, value]) => {
        const row: Record<string, unknown> = {
          id: randomUUID(),
          item_id: newItem.id,
          field_id: fieldId,
          value,
          is_published: isPublished,
          created_at: now,
          updated_at: now,
        };
        if (originalTenantId) row.tenant_id = originalTenantId;
        return row;
      });

    if (valuesToInsert.length > 0) {
      try {
        await knex('collection_item_values').insert(valuesToInsert);
      } catch (error) {
        console.error('Failed to duplicate values:', error);
      }
    }

    return {
      ...newItem,
      values: newValues,
    };
  } catch (error) {
    throw new Error(`Failed to create duplicate item: ${getErrorMessage(error)}`);
  }
}

/**
 * Search items by field values
 * @param collection_id - Collection UUID
 * @param is_published - Filter for draft (false) or published (true) items and values. Defaults to false (draft).
 * @param query - Search query string
 */
export async function searchItems(
  collection_id: string,
  is_published: boolean = false,
  query: string
): Promise<{ items: CollectionItemWithValues[], total: number }> {
  if (!query || query.trim() === '') {
    return getItemsWithValues(collection_id, is_published, undefined);
  }

  return getItemsWithValues(collection_id, is_published, { search: query });
}

/**
 * Publish an item
 * Creates or updates the published version by copying the draft
 * Uses upsert with composite primary key for simplicity
 * @param id - Item UUID
 */
export async function publishItem(id: string): Promise<CollectionItem> {
  const knex = await getDb();

  const draft = await getItemById(id, false);
  if (!draft) {
    throw new Error('Draft item not found');
  }

  const now = new Date().toISOString();
  const row = await addTenantIdToRow({
    id: draft.id,
    collection_id: draft.collection_id,
    manual_order: draft.manual_order,
    is_publishable: draft.is_publishable,
    is_published: true,
    created_at: draft.created_at,
    updated_at: now,
  });

  const tenantId = (draft as CollectionItemWithTenant).tenant_id;
  if (tenantId) row.tenant_id = tenantId;

  try {
    const [data] = await knex('collection_items')
      .insert(row)
      .onConflict(['id', 'is_published'])
      .merge(['collection_id', 'manual_order', 'is_publishable', 'updated_at'])
      .returning('*');

    return data as CollectionItem;
  } catch (error) {
    throw new Error(`Failed to publish item: ${getErrorMessage(error)}`);
  }
}

/**
 * Get total count of collection items needing publishing across all collections.
 * Checks both metadata (manual_order) and value changes.
 */
export async function getTotalPublishableItemsCount(): Promise<number> {
  const knex = await getDb();

  try {
    let collectionsQuery = knex('collections')
      .select('id')
      .where('is_published', false)
      .whereNull('deleted_at');
    collectionsQuery = await addTenantFilter(knex, collectionsQuery, 'collections');

    const collections = await collectionsQuery as Array<{ id: string }>;
    if (collections.length === 0) {
      return 0;
    }

    const collectionIds = collections.map((collection) => collection.id);
    const fetchAllItems = async (isPublished: boolean): Promise<Array<{ id: string; manual_order: number }>> => {
      let query = knex('collection_items')
        .select('id', 'manual_order')
        .whereIn('collection_id', collectionIds)
        .andWhere('is_published', isPublished)
        .orderBy('id', 'asc');

      if (!isPublished) {
        query = query.andWhere('is_publishable', true).whereNull('deleted_at');
      }

      query = await addTenantFilter(knex, query, 'collection_items');
      return await query as Array<{ id: string; manual_order: number }>;
    };

    const [draftItems, publishedItems] = await Promise.all([
      fetchAllItems(false),
      fetchAllItems(true),
    ]);

    const publishedMap = new Map<string, number>();
    for (const pub of publishedItems) {
      publishedMap.set(pub.id, pub.manual_order);
    }

    let count = 0;
    const matchingOrderItemIds: string[] = [];

    for (const draft of draftItems) {
      const pubOrder = publishedMap.get(draft.id);
      if (pubOrder === undefined || draft.manual_order !== pubOrder) {
        count++;
      } else {
        matchingOrderItemIds.push(draft.id);
      }
    }

    if (matchingOrderItemIds.length > 0) {
      const valueChanges = await countItemsWithValueChanges(matchingOrderItemIds);
      count += valueChanges;
    }

    return count;
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw new Error(`Failed to count publishable items: ${getErrorMessage(error)}`);
  }
}

/**
 * Count items whose draft values differ from published. Reads all values via
 * the direct-DB (Knex) path in two queries.
 */
async function countItemsWithValueChanges(itemIds: string[]): Promise<number> {
  if (itemIds.length === 0) return 0;

  let draftValueRows: Awaited<ReturnType<typeof getValueRowsForItems>> = [];
  let publishedValueRows: Awaited<ReturnType<typeof getValueRowsForItems>> = [];

  try {
    [draftValueRows, publishedValueRows] = await Promise.all([
      getValueRowsForItems(itemIds, false),
      getValueRowsForItems(itemIds, true),
    ]);
  } catch {
    return 0;
  }

  const groupByItem = (
    rows: Array<{ item_id: string; field_id: string; value: string | null }>,
  ): Map<string, Map<string, string | null>> => {
    const map = new Map<string, Map<string, string | null>>();
    for (const v of rows) {
      if (!map.has(v.item_id)) map.set(v.item_id, new Map());
      map.get(v.item_id)!.set(v.field_id, v.value);
    }
    return map;
  };

  const draftValsByItem = groupByItem(draftValueRows);
  const pubValsByItem = groupByItem(publishedValueRows);

  let changedCount = 0;
  for (const itemId of itemIds) {
    const draftVals = draftValsByItem.get(itemId) || new Map();
    const pubVals = pubValsByItem.get(itemId) || new Map();

    if (draftVals.size !== pubVals.size) {
      changedCount++;
      continue;
    }

    let hasChange = false;
    for (const [fieldId, draftValue] of draftVals) {
      if (!pubVals.has(fieldId) || draftValue !== pubVals.get(fieldId)) {
        hasChange = true;
        break;
      }
    }

    if (hasChange) {
      changedCount++;
    }
  }

  return changedCount;
}

/**
 * Unpublish a single item: deletes its published row and values (CASCADE).
 * Also sets is_publishable = false on the draft row.
 */
export async function unpublishSingleItem(itemId: string): Promise<void> {
  const knex = await getDb();

  let deleteQuery = knex('collection_items')
    .where('id', itemId)
    .andWhere('is_published', true);
  deleteQuery = await addTenantFilter(knex, deleteQuery, 'collection_items');
  await deleteQuery.del();

  let updateQuery = knex('collection_items')
    .where('id', itemId)
    .andWhere('is_published', false);
  updateQuery = await addTenantFilter(knex, updateQuery, 'collection_items');
  await updateQuery.update({ is_publishable: false, updated_at: new Date().toISOString() });
}

/**
 * Stage a single item for publish: removes published version if it exists,
 * then sets is_publishable = true on the draft row.
 * @returns true if a published version was removed (caller should clear cache)
 */
export async function stageSingleItem(itemId: string): Promise<boolean> {
  const knex = await getDb();

  let publishedQuery = knex('collection_items')
    .select('id')
    .where('id', itemId)
    .andWhere('is_published', true);
  publishedQuery = await addTenantFilter(knex, publishedQuery, 'collection_items');

  const published = await publishedQuery.first();
  const hadPublished = !!published;

  if (hadPublished) {
    let deleteQuery = knex('collection_items')
      .where('id', itemId)
      .andWhere('is_published', true);
    deleteQuery = await addTenantFilter(knex, deleteQuery, 'collection_items');
    await deleteQuery.del();
  }

  let updateQuery = knex('collection_items')
    .where('id', itemId)
    .andWhere('is_published', false);
  updateQuery = await addTenantFilter(knex, updateQuery, 'collection_items');
  await updateQuery.update({ is_publishable: true, updated_at: new Date().toISOString() });

  return hadPublished;
}

/**
 * Publish a single item immediately: upserts a published item row
 * and copies draft values to published. Sets is_publishable = true.
 */
export async function publishSingleItem(itemId: string): Promise<void> {
  const knex = await getDb();

  const draftItem = await getItemById(itemId, false);
  if (!draftItem || draftItem.deleted_at) {
    throw new Error('Draft item not found');
  }

  const now = new Date().toISOString();
  const tenantId = (draftItem as CollectionItemWithTenant).tenant_id ?? await getTenantIdFromHeaders();

  if (!draftItem.is_publishable) {
    let draftUpdate = knex('collection_items')
      .where('id', itemId)
      .andWhere('is_published', false);
    draftUpdate = await addTenantFilter(knex, draftUpdate, 'collection_items');
    await draftUpdate.update({ is_publishable: true, updated_at: now });
  }

  const draftFields = await getFieldsByCollectionId(draftItem.collection_id, false);
  if (draftFields.length > 0) {
    const fieldsToUpsert = draftFields.map((field) => {
      const row: Record<string, unknown> = {
        id: field.id,
        name: field.name,
        key: field.key,
        type: field.type,
        default: field.default,
        fillable: field.fillable,
        order: field.order,
        collection_id: field.collection_id,
        reference_collection_id: field.reference_collection_id,
        hidden: field.hidden,
        is_computed: field.is_computed,
        data: field.data,
        is_published: true,
        created_at: field.created_at,
        updated_at: now,
      };
      if (tenantId) row.tenant_id = tenantId;
      return row;
    });

    await knex('collection_fields')
      .insert(fieldsToUpsert)
      .onConflict(['id', 'is_published'])
      .merge([
        'name',
        'key',
        'type',
        'default',
        'fillable',
        'order',
        'collection_id',
        'reference_collection_id',
        'hidden',
        'is_computed',
        'data',
        'updated_at',
      ]);
  }

  const itemRow: Record<string, unknown> = {
    id: draftItem.id,
    collection_id: draftItem.collection_id,
    manual_order: draftItem.manual_order,
    is_publishable: true,
    is_published: true,
    content_hash: draftItem.content_hash,
    created_at: draftItem.created_at,
    updated_at: now,
  };
  if (tenantId) itemRow.tenant_id = tenantId;

  await knex('collection_items')
    .insert(itemRow)
    .onConflict(['id', 'is_published'])
    .merge(['collection_id', 'manual_order', 'is_publishable', 'content_hash', 'updated_at']);

  const { publishValues } = await import('@/lib/repositories/collectionItemValueRepository');
  await publishValues(itemId);
}
