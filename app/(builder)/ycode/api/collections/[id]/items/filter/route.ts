import { NextRequest } from 'next/server';
import type { Knex } from 'knex';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import { getSettingByKey } from '@/lib/repositories/settingsRepository';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { getValuesByItemIds } from '@/lib/repositories/collectionItemValueRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { enrichItemsWithCountValues } from '@/lib/repositories/collectionCountRepository';
import { getAllPages } from '@/lib/repositories/pageRepository';
import { getAllPageFolders } from '@/lib/repositories/pageFolderRepository';
import { renderCollectionItemsToHtml, loadTranslationsForLocale } from '@/lib/page-fetcher';
import { noCache } from '@/lib/api-response';
import { compareDateFilter, isDateFieldType, isDatePreset, parseItemIdList, resolveDateFilterValue } from '@/lib/collection-field-utils';
import type { Layer, CollectionItem, CollectionItemWithValues } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface FilterCondition {
  fieldId: string;
  operator: string;
  value: string;
  value2?: string;
  fieldType?: string;
  // 'collection_field' (default, legacy) compares against a stored field value;
  // 'self' compares the item's own ID against a set of IDs.
  source?: 'collection_field' | 'self';
  // For source === 'self': also include the current dynamic page item's ID
  // in the comparison set at runtime.
  includesCurrentPageItem?: boolean;
  // 'current_page' binds the compare value to the current dynamic page item:
  // reference fields inject the page item's ID; scalar fields use the value of
  // `currentPageFieldId` on the page item.
  valueMode?: 'static' | 'current_page';
  currentPageFieldId?: string;
}

// PostgREST encodes .in() values into a URL query param.
// Conservative chunk size avoids hitting URL length limits (~8KB).
const IN_CHUNK_SIZE = 150;

// How many chunk queries to run at once. Chunks are independent, so issuing them
// concurrently overlaps the round-trips (the dominant cost on large collections)
// while the cap keeps us from opening an unbounded number of DB connections.
const CHUNK_CONCURRENCY = 6;

function escapeLikeValue(val: string): string {
  return val.replace(/[%_\\]/g, '\\$&');
}

/**
 * Run a query against collection_item_values in chunks to avoid
 * Supabase/PostgREST URL-length limits on .in() clauses.
 *
 * Chunks are issued in bounded-concurrency batches: each batch runs in parallel
 * (overlapping latency) and batches run sequentially (capping connections).
 *
 * @param build  - receives a chunk of item IDs; must return { data, error }
 * @param itemIds - full array of item IDs to query against
 */
async function chunkedQuery<T>(
  build: (chunk: string[]) => Promise<T[]>,
  itemIds: string[],
): Promise<T[]> {
  if (itemIds.length === 0) return [];
  if (itemIds.length <= IN_CHUNK_SIZE) {
    return build(itemIds);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < itemIds.length; i += IN_CHUNK_SIZE) {
    chunks.push(itemIds.slice(i, i + IN_CHUNK_SIZE));
  }

  const results: T[] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const settled = await Promise.all(batch.map(chunk => build(chunk)));
    for (const data of settled) {
      results.push(...data);
    }
  }
  return results;
}

async function getAllItemIdsForCollection(
  collectionId: string,
  isPublished: boolean,
): Promise<string[]> {
  const db = await getDb();
  let query = db('collection_items')
    .select('id')
    .where('collection_id', collectionId)
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('manual_order', 'asc')
    .orderBy('created_at', 'desc');

  if (isPublished) {
    query = query.where('is_publishable', true);
  }

  query = await addTenantFilter(db, query, 'collection_items');
  const rows = await query as Array<{ id: string }>;
  return rows.map(r => r.id);
}

async function getIdsMatchingFilter(
  filter: FilterCondition,
  isPublished: boolean,
  allItemIds: string[],
  timezone: string,
): Promise<Set<string>> {
  const { fieldId, operator, value } = filter;
  const allSet = new Set(allItemIds);
  const isDateOnly = filter.fieldType === 'date_only';
  const db = await getDb();

  const selectIds = async (chunk: string[]): Promise<Knex.QueryBuilder> => {
    let query = db('collection_item_values')
      .select('item_id')
      .where('field_id', fieldId)
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .whereIn('item_id', chunk);
    query = await addTenantFilter(db, query, 'collection_item_values');
    return query;
  };

  const selectIdsAndValues = async (chunk: string[]): Promise<Knex.QueryBuilder> => {
    let query = db('collection_item_values')
      .select('item_id', 'value')
      .where('field_id', fieldId)
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .whereIn('item_id', chunk);
    query = await addTenantFilter(db, query, 'collection_item_values');
    return query;
  };

  const readRows = async <T,>(query: Knex.QueryBuilder): Promise<T[]> => await query as T[];
  const selectValueRows = async (chunk: string[]): Promise<Array<{ item_id: string; value: string | null }>> =>
    readRows(await selectIdsAndValues(chunk));
  const selectIdRowsLike = async (chunk: string[], pattern: string): Promise<Array<{ item_id: string }>> =>
    readRows((await selectIds(chunk)).whereILike('value', pattern));
  const selectIdRowsNotEmpty = async (chunk: string[]): Promise<Array<{ item_id: string }>> =>
    readRows((await selectIds(chunk)).whereNot('value', ''));
  const selectValueRowsNotEmpty = async (chunk: string[]): Promise<Array<{ item_id: string; value: string | null }>> =>
    readRows((await selectIdsAndValues(chunk)).whereNot('value', ''));

  switch (operator) {
    // --- Text positive ---
    case 'contains': {
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, `%${escapeLikeValue(value)}%`),
        allItemIds,
      );
      return new Set(data.map(d => d.item_id));
    }
    case 'is': {
      if (filter.fieldType === 'boolean') {
        const targetBool = value.toLowerCase() === 'true';
        const data = await chunkedQuery(selectValueRows, allItemIds);
        const result = new Set<string>();
        for (const row of data) {
          const raw = String(row.value ?? '').toLowerCase();
          const isTruthy = raw === 'true' || raw === '1' || raw === 'yes';
          if (isTruthy === targetBool) result.add(row.item_id);
        }
        return result;
      }
      if (isDateFieldType(filter.fieldType)) {
        const data = await chunkedQuery(
          selectValueRowsNotEmpty,
          allItemIds,
        );
        const result = new Set<string>();
        for (const row of data) {
          if (compareDateFilter(String(row.value), 'is', value, undefined, timezone, isDateOnly)) result.add(row.item_id);
        }
        return result;
      }
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, escapeLikeValue(value)),
        allItemIds,
      );
      return new Set(data.map(d => d.item_id));
    }
    case 'starts_with': {
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, `${escapeLikeValue(value)}%`),
        allItemIds,
      );
      return new Set(data.map(d => d.item_id));
    }
    case 'ends_with': {
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, `%${escapeLikeValue(value)}`),
        allItemIds,
      );
      return new Set(data.map(d => d.item_id));
    }

    // --- Text negative (complement) ---
    case 'does_not_contain': {
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, `%${escapeLikeValue(value)}%`),
        allItemIds,
      );
      const matchIds = new Set(data.map(d => d.item_id));
      return new Set([...allSet].filter(id => !matchIds.has(id)));
    }
    case 'is_not': {
      if (filter.fieldType === 'boolean') {
        const targetBool = value.toLowerCase() === 'true';
        const data = await chunkedQuery(selectValueRows, allItemIds);
        const result = new Set<string>();
        for (const row of data) {
          const raw = String(row.value ?? '').toLowerCase();
          const isTruthy = raw === 'true' || raw === '1' || raw === 'yes';
          if (isTruthy !== targetBool) result.add(row.item_id);
        }
        return result;
      }
      if (isDateFieldType(filter.fieldType)) {
        const data = await chunkedQuery(
          selectValueRowsNotEmpty,
          allItemIds,
        );
        const matchIds = new Set<string>();
        for (const row of data) {
          if (compareDateFilter(String(row.value), 'is', value, undefined, timezone, isDateOnly)) matchIds.add(row.item_id);
        }
        return new Set([...allSet].filter(id => !matchIds.has(id)));
      }
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, escapeLikeValue(value)),
        allItemIds,
      );
      const matchIds = new Set(data.map(d => d.item_id));
      return new Set([...allSet].filter(id => !matchIds.has(id)));
    }

    // --- Presence ---
    case 'is_empty':
    case 'is_not_present': {
      const data = await chunkedQuery(
        selectIdRowsNotEmpty,
        allItemIds,
      );
      const nonEmptyIds = new Set(data.map(d => d.item_id));
      return new Set([...allSet].filter(id => !nonEmptyIds.has(id)));
    }
    case 'is_not_empty':
    case 'is_present':
    case 'exists': {
      const data = await chunkedQuery(
        selectIdRowsNotEmpty,
        allItemIds,
      );
      return new Set(data.map(d => d.item_id));
    }
    case 'does_not_exist': {
      const data = await chunkedQuery(
        selectIdRowsNotEmpty,
        allItemIds,
      );
      const existIds = new Set(data.map(d => d.item_id));
      return new Set([...allSet].filter(id => !existIds.has(id)));
    }

    // --- Numeric ---
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const filterNum = parseFloat(value);
      if (isNaN(filterNum)) return new Set();
      const data = await chunkedQuery(
        selectValueRowsNotEmpty,
        allItemIds,
      );
      const result = new Set<string>();
      for (const row of data) {
        const num = parseFloat(String(row.value ?? ''));
        if (isNaN(num)) continue;
        if (operator === 'gt' && num > filterNum) result.add(row.item_id);
        else if (operator === 'gte' && num >= filterNum) result.add(row.item_id);
        else if (operator === 'lt' && num < filterNum) result.add(row.item_id);
        else if (operator === 'lte' && num <= filterNum) result.add(row.item_id);
      }
      return result;
    }

    // --- Date (day-aware: `YYYY-MM-DD` filter values span the full UTC day) ---
    case 'is_before': {
      const data = await chunkedQuery(
        selectValueRowsNotEmpty,
        allItemIds,
      );
      const result = new Set<string>();
      for (const row of data) {
        if (compareDateFilter(String(row.value), 'is_before', value, undefined, timezone, isDateOnly)) result.add(row.item_id);
      }
      return result;
    }
    case 'is_after': {
      const data = await chunkedQuery(
        selectValueRowsNotEmpty,
        allItemIds,
      );
      const result = new Set<string>();
      for (const row of data) {
        if (compareDateFilter(String(row.value), 'is_after', value, undefined, timezone, isDateOnly)) result.add(row.item_id);
      }
      return result;
    }
    case 'is_between': {
      const startRaw = value?.trim();
      const endRaw = (filter.value2 || '').trim();
      if (!startRaw && !endRaw) return new Set();

      const data = await chunkedQuery(
        selectValueRowsNotEmpty,
        allItemIds,
      );
      const result = new Set<string>();
      for (const row of data) {
        const storedValue = String(row.value);
        // Open-ended ranges fall back to the relevant single-bound operator.
        if (startRaw && endRaw) {
          if (compareDateFilter(storedValue, 'is_between', startRaw, endRaw, timezone, isDateOnly)) result.add(row.item_id);
        } else if (startRaw) {
          if (!compareDateFilter(storedValue, 'is_before', startRaw, undefined, timezone, isDateOnly)) result.add(row.item_id);
        } else if (endRaw) {
          if (!compareDateFilter(storedValue, 'is_after', endRaw, undefined, timezone, isDateOnly)) result.add(row.item_id);
        }
      }
      return result;
    }

    // --- Reference ---
    case 'is_one_of': {
      try {
        const allowedIds = JSON.parse(value || '[]');
        if (!Array.isArray(allowedIds)) return new Set();
        const data = await chunkedQuery(selectValueRows, allItemIds);
        const result = new Set<string>();
        for (const row of data) {
          const val = String(row.value ?? '');
          if (allowedIds.includes(val)) { result.add(row.item_id); continue; }
          try {
            const arr = JSON.parse(val);
            if (Array.isArray(arr) && arr.some((id: string) => allowedIds.includes(id))) {
              result.add(row.item_id);
            }
          } catch { /* not JSON */ }
        }
        return result;
      } catch { return new Set(); }
    }
    case 'is_not_one_of': {
      try {
        const excludedIds = JSON.parse(value || '[]');
        if (!Array.isArray(excludedIds)) return allSet;
        const data = await chunkedQuery(selectValueRows, allItemIds);
        const excludeSet = new Set<string>();
        for (const row of data) {
          const val = String(row.value ?? '');
          if (excludedIds.includes(val)) { excludeSet.add(row.item_id); continue; }
          try {
            const arr = JSON.parse(val);
            if (Array.isArray(arr) && arr.some((id: string) => excludedIds.includes(id))) {
              excludeSet.add(row.item_id);
            }
          } catch { /* not JSON */ }
        }
        return new Set([...allSet].filter(id => !excludeSet.has(id)));
      } catch { return allSet; }
    }

    // --- Multi-reference ---
    case 'has_items': {
      const data = await chunkedQuery(
        selectValueRowsNotEmpty,
        allItemIds,
      );
      const result = new Set<string>();
      for (const row of data) {
        try {
          const arr = JSON.parse(String(row.value));
          if (Array.isArray(arr) && arr.length > 0) result.add(row.item_id);
        } catch {
          if (row.value) result.add(row.item_id);
        }
      }
      return result;
    }
    case 'has_no_items': {
      const data = await chunkedQuery(selectValueRows, allItemIds);
      const hasItemsSet = new Set<string>();
      for (const row of data) {
        try {
          const arr = JSON.parse(String(row.value));
          if (Array.isArray(arr) && arr.length > 0) hasItemsSet.add(row.item_id);
        } catch {
          if (row.value) hasItemsSet.add(row.item_id);
        }
      }
      return new Set([...allSet].filter(id => !hasItemsSet.has(id)));
    }
    case 'contains_all_of': {
      try {
        const requiredIds = JSON.parse(value || '[]');
        if (!Array.isArray(requiredIds)) return new Set();
        const data = await chunkedQuery(selectValueRows, allItemIds);
        const result = new Set<string>();
        for (const row of data) {
          try {
            const arr = JSON.parse(String(row.value));
            if (Array.isArray(arr) && requiredIds.every((id: string) => arr.includes(id))) {
              result.add(row.item_id);
            }
          } catch { /* skip */ }
        }
        return result;
      } catch { return new Set(); }
    }
    case 'contains_exactly': {
      try {
        const requiredIds = JSON.parse(value || '[]');
        if (!Array.isArray(requiredIds)) return new Set();
        const data = await chunkedQuery(selectValueRows, allItemIds);
        const result = new Set<string>();
        for (const row of data) {
          try {
            const arr = JSON.parse(String(row.value));
            if (
              Array.isArray(arr) &&
              arr.length === requiredIds.length &&
              requiredIds.every((id: string) => arr.includes(id))
            ) {
              result.add(row.item_id);
            }
          } catch { /* skip */ }
        }
        return result;
      } catch { return new Set(); }
    }

    default: {
      const data = await chunkedQuery(
        chunk => selectIdRowsLike(chunk, `%${escapeLikeValue(value)}%`),
        allItemIds,
      );
      return new Set(data.map(d => d.item_id));
    }
  }
}

/**
 * Build the set of IDs matched by a `source: 'self'` filter. Operates purely on
 * the input ID set — no DB roundtrip needed because the comparison is identity-based.
 */
function getSelfFilterMatches(
  filter: FilterCondition,
  candidateIds: string[],
  pageCollectionItemId?: string,
): Set<string> {
  const compareSet = new Set<string>(parseItemIdList(filter.value));
  if (filter.includesCurrentPageItem && pageCollectionItemId) {
    compareSet.add(pageCollectionItemId);
  }
  if (filter.operator === 'is_not_one_of') {
    return new Set(candidateIds.filter(id => !compareSet.has(id)));
  }
  return new Set(candidateIds.filter(id => compareSet.has(id)));
}

/**
 * Resolve a `valueMode: 'current_page'` filter into a concrete static filter by
 * binding its compare value to the current dynamic page item:
 *   - reference fields inject the page item's ID into the compared ID set
 *   - scalar fields read the page item's `currentPageFieldId` value
 * Mirrors the SSR resolution in `evaluateCondition`.
 */
async function resolveCurrentPageFilter(
  filter: FilterCondition,
  isPublished: boolean,
  pageCollectionItemId?: string,
): Promise<FilterCondition> {
  const isReferenceField = filter.fieldType === 'reference'
    || filter.fieldType === 'multi_reference'
    || ['is_one_of', 'is_not_one_of', 'contains_all_of', 'contains_exactly'].includes(filter.operator);
  if (isReferenceField) {
    const ids = parseItemIdList(filter.value);
    if (pageCollectionItemId && !ids.includes(pageCollectionItemId)) {
      ids.push(pageCollectionItemId);
    }
    // 'contains exactly' against a single injected page-item id can never match a real
    // multi-reference set — the "Current X" intent is "contains the current item".
    const operator = filter.operator === 'contains_exactly' ? 'contains_all_of' : filter.operator;
    return { ...filter, operator, value: JSON.stringify(ids) };
  }
  if (filter.currentPageFieldId && pageCollectionItemId) {
    const valueMap = await getFieldValuesForItems(filter.currentPageFieldId, isPublished, [pageCollectionItemId]);
    return { ...filter, value: valueMap.get(pageCollectionItemId) ?? '' };
  }
  return { ...filter, value: '' };
}

async function getFilteredItemIds(
  collectionId: string,
  isPublished: boolean,
  filterGroups: FilterCondition[][],
  timezone: string,
  pageCollectionItemId?: string,
): Promise<{ matchingIds: string[]; total: number }> {
  const allItemIds = await getAllItemIdsForCollection(collectionId, isPublished);

  if (filterGroups.length === 0) {
    return { matchingIds: allItemIds, total: allItemIds.length };
  }

  // Each group's conditions are ANDed. Groups are ORed (union).
  const groupResults: Set<string>[] = [];

  for (const group of filterGroups) {
    let currentIds = new Set(allItemIds);

    for (let filter of group) {
      if (currentIds.size === 0) break;
      if (filter.source === 'self') {
        const matchingForFilter = getSelfFilterMatches(filter, [...currentIds], pageCollectionItemId);
        currentIds = new Set([...currentIds].filter(id => matchingForFilter.has(id)));
        continue;
      }
      if (filter.valueMode === 'current_page') {
        filter = await resolveCurrentPageFilter(filter, isPublished, pageCollectionItemId);
      }
      if (isDateFieldType(filter.fieldType) && isDatePreset(filter.value)) {
        const resolved = resolveDateFilterValue(filter.operator, filter.value, filter.value2, timezone);
        if (resolved) {
          filter = { ...filter, operator: resolved.operator, value: resolved.value, value2: resolved.value2 };
        }
      }
      const matchingForFilter = await getIdsMatchingFilter(filter, isPublished, [...currentIds], timezone);
      currentIds = new Set([...currentIds].filter(id => matchingForFilter.has(id)));
    }

    groupResults.push(currentIds);
  }

  // Union all group results (OR)
  const unionIds = new Set<string>();
  for (const groupIds of groupResults) {
    for (const id of groupIds) {
      unionIds.add(id);
    }
  }

  return { matchingIds: [...unionIds], total: unionIds.size };
}

function reorderItemsById(items: CollectionItem[], idOrder: string[]): CollectionItem[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const ordered: CollectionItem[] = [];
  for (const id of idOrder) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  return ordered;
}

async function getFieldValuesForItems(
  fieldId: string,
  isPublished: boolean,
  itemIds: string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const db = await getDb();

  const rows = await chunkedQuery<{ item_id: string; value: string | null }>(
    async (chunk) => {
      let query = db('collection_item_values')
        .select('item_id', 'value')
        .where('field_id', fieldId)
        .where('is_published', isPublished)
        .whereNull('deleted_at')
        .whereIn('item_id', chunk);
      query = await addTenantFilter(db, query, 'collection_item_values');
      return await query as Array<{ item_id: string; value: string | null }>;
    },
    itemIds,
  );

  const valueMap = new Map<string, string>();
  for (const row of rows) {
    valueMap.set(row.item_id, row.value ?? '');
  }
  return valueMap;
}

/**
 * POST /ycode/api/collections/[id]/items/filter
 *
 * Body (JSON):
 * - layerTemplate: Layer[]
 * - collectionLayerId: string
 * - filterGroups: Array<Array<{ fieldId, operator, value, value2? }>>
 *     Groups are ORed; conditions within a group are ANDed.
 * - sortBy?: string
 * - sortOrder?: 'asc' | 'desc'
 * - limit?: number
 * - offset?: number
 * - localeCode?: string
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: collectionId } = await params;
    const body = await request.json();
    const {
      layerTemplate,
      collectionLayerId,
      collectionLayer,
      filterGroups = [],
      sortBy,
      sortOrder = 'asc',
      limit,
      offset = 0,
      maxTotal,
      baseOffset = 0,
      localeCode,
      collectionLayerClasses,
      collectionLayerTag,
      published: isPublished = true,
      isPreview = false,
      pageCollectionItemId,
      pageCollectionSortedItemIds,
    } = body;

    if (!layerTemplate || !Array.isArray(layerTemplate)) {
      return noCache({ error: 'layerTemplate is required and must be an array' }, 400);
    }
    if (!collectionLayerId) {
      return noCache({ error: 'collectionLayerId is required' }, 400);
    }

    // Collection fields, page/folder maps, and translations are needed only for
    // rendering and don't depend on the timezone or which items match. Fetch them
    // concurrently with the timezone lookup and the (slower) filter resolution so
    // they're off the critical path.
    const metadataPromise = Promise.all([
      getFieldsByCollectionId(collectionId, isPublished, { excludeComputed: true }),
      getAllPages(),
      getAllPageFolders(),
      localeCode ? loadTranslationsForLocale(localeCode, isPublished) : Promise.resolve(null),
    ]);
    // Register a no-op rejection handler so bailing out early (empty result) or
    // an error in filtering doesn't surface as an unhandled promise rejection.
    metadataPromise.catch(() => {});

    const timezone = (await getSettingByKey('timezone') as string | null) || 'UTC';

    const { matchingIds, total: filteredTotal } = await getFilteredItemIds(
      collectionId,
      isPublished,
      filterGroups,
      timezone,
      pageCollectionItemId,
    );

    const pageOffset = Math.max(0, offset || 0);
    // Leading records the collection's `offset` skips before pagination. The
    // client's `offset` is relative to the post-offset window, so the real
    // offset into the (capped) matching set is the sum. Applied after the
    // `maxTotal` cap to mirror SSR (cap the pool, then skip the first N).
    const baseOffsetNum = Math.max(0, isNaN(Number(baseOffset)) ? 0 : Number(baseOffset));

    // `maxTotal` (the collection's display limit when pagination is enabled)
    // caps the total just like SSR, so a client-side reconcile reports the same
    // "Showing X of Y" and stops load_more/paging at the same boundary instead
    // of exposing the raw filtered count.
    const cappedTotal = typeof maxTotal === 'number' && maxTotal > 0
      ? Math.min(filteredTotal, maxTotal)
      : filteredTotal;
    // The offset skips leading records, so the paginated total excludes them.
    const displayTotal = Math.max(0, cappedTotal - baseOffsetNum);
    const effectiveOffset = baseOffsetNum + pageOffset;

    if (matchingIds.length === 0 || pageOffset >= displayTotal) {
      return noCache({
        data: { html: '', total: displayTotal, count: 0, offset: pageOffset, hasMore: false, itemIds: [] },
      });
    }

    // Never serve items past the cap: shrink the page window to what's left
    // below `displayTotal`.
    const requestedLimit = limit && limit > 0 ? limit : displayTotal;
    const pageLimit = Math.min(requestedLimit, displayTotal - pageOffset);
    let pageRawItems: CollectionItem[] = [];
    let pageItemIds: string[] = [];

    if (!sortBy || sortBy === 'none' || sortBy === 'manual') {
      // Let DB do ordering and pagination for cheap paths.
      const { items } = await getItemsByCollectionId(collectionId, isPublished, {
        itemIds: matchingIds,
        limit: pageLimit,
        offset: effectiveOffset,
      });
      pageRawItems = items;
      pageItemIds = items.map(item => item.id);
    } else if (sortBy === 'random') {
      const randomizedIds = [...matchingIds].sort(() => Math.random() - 0.5);
      pageItemIds = randomizedIds.slice(effectiveOffset, effectiveOffset + pageLimit);
      if (pageItemIds.length > 0) {
        const { items } = await getItemsByCollectionId(collectionId, isPublished, {
          itemIds: pageItemIds,
        });
        pageRawItems = reorderItemsById(items, pageItemIds);
      }
    } else {
      // For field-based sort, sort IDs using just the sort field values first,
      // then hydrate only the requested page window.
      const sortValueByItem = await getFieldValuesForItems(sortBy, isPublished, matchingIds);
      const sortedIds = [...matchingIds].sort((a, b) => {
        const aStr = String(sortValueByItem.get(a) || '');
        const bStr = String(sortValueByItem.get(b) || '');
        const aNum = aStr.trim() !== '' ? Number(aStr) : NaN;
        const bNum = bStr.trim() !== '' ? Number(bStr) : NaN;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortOrder === 'desc' ? bNum - aNum : aNum - bNum;
        }
        return sortOrder === 'desc'
          ? bStr.localeCompare(aStr)
          : aStr.localeCompare(bStr);
      });
      pageItemIds = sortedIds.slice(effectiveOffset, effectiveOffset + pageLimit);
      if (pageItemIds.length > 0) {
        const { items } = await getItemsByCollectionId(collectionId, isPublished, {
          itemIds: pageItemIds,
        });
        pageRawItems = reorderItemsById(items, pageItemIds);
      }
    }

    const valuesByItem = await getValuesByItemIds(
      pageRawItems.map(i => i.id),
      isPublished,
    );
    const paginatedItems: CollectionItemWithValues[] = pageRawItems.map(item => ({
      ...item,
      values: valuesByItem[item.id] || {},
    }));

    // Inject computed count field values so layers bound to a count field
    // render the live number in the filtered HTML.
    await enrichItemsWithCountValues(paginatedItems, collectionId, isPublished);

    const hasMore = pageOffset + paginatedItems.length < displayTotal;

    const [collectionFields, pages, folders, localeData] = await metadataPromise;

    const slugField = collectionFields.find(f => f.key === 'slug');
    const collectionItemSlugs: Record<string, string> = {};
    if (slugField) {
      for (const item of paginatedItems) {
        if (item.values[slugField.id]) {
          collectionItemSlugs[item.id] = item.values[slugField.id];
        }
      }
    }

    const locale = localeData?.locale ?? null;
    const translations = localeData?.translations;

    const html = await renderCollectionItemsToHtml(
      paginatedItems,
      layerTemplate as Layer[],
      collectionId,
      collectionLayerId,
      isPublished,
      pages,
      folders,
      collectionItemSlugs,
      locale,
      translations,
      undefined,
      collectionLayerClasses,
      collectionLayerTag,
      {
        isPreview: Boolean(isPreview),
        pageCollectionItemId,
        pageCollectionSortedItemIds: Array.isArray(pageCollectionSortedItemIds)
          ? pageCollectionSortedItemIds
          : undefined,
      },
      collectionLayer as Omit<Layer, 'children'> | undefined,
    );

    return noCache({
      data: {
        html,
        total: displayTotal,
        count: paginatedItems.length,
        offset: pageOffset,
        hasMore,
        itemIds: paginatedItems.map(item => item.id),
      },
    });
  } catch (error) {
    console.error('Error filtering collection items:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to filter items' },
      500,
    );
  }
}
