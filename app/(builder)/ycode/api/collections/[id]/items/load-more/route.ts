import { NextRequest } from 'next/server';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import { getItemsByCollectionId } from '@/lib/repositories/collectionItemRepository';
import { getValuesByItemIds } from '@/lib/repositories/collectionItemValueRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { enrichItemsWithCountValues } from '@/lib/repositories/collectionCountRepository';
import { getAllPages } from '@/lib/repositories/pageRepository';
import { getAllPageFolders } from '@/lib/repositories/pageFolderRepository';
import { renderCollectionItemsToHtml, loadTranslationsForLocale } from '@/lib/page-fetcher';
import { noCache } from '@/lib/api-response';
import type { Layer, CollectionItem, CollectionItemWithValues } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const IN_CHUNK_SIZE = 150;

async function chunkedQuery<T>(
  build: (chunk: string[]) => Promise<T[]>,
  itemIds: string[],
): Promise<T[]> {
  if (itemIds.length === 0) return [];
  if (itemIds.length <= IN_CHUNK_SIZE) {
    return build(itemIds);
  }
  const results: T[] = [];
  for (let i = 0; i < itemIds.length; i += IN_CHUNK_SIZE) {
    const data = await build(itemIds.slice(i, i + IN_CHUNK_SIZE));
    results.push(...data);
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

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.item_id, row.value ?? '');
  }
  return map;
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

/**
 * POST /ycode/api/collections/[id]/items/load-more
 * Returns pre-rendered HTML for the next page of a collection. Mirrors the
 * SSR sort (`sortBy` / `sortOrder`) so offset-based paging stays consistent
 * — otherwise a date-sorted SSR list followed by a manual-order DB page
 * yields duplicates.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: collectionId } = await params;

    const body = await request.json();
    const {
      offset = 0,
      limit = 10,
      itemIds,
      layerTemplate,
      collectionLayerId,
      collectionLayer,
      sortBy,
      sortOrder = 'asc',
      published = true,
      localeCode,
      collectionLayerClasses,
      collectionLayerTag,
      isPreview = false,
      pageCollectionItemId,
      pageCollectionSortedItemIds,
      maxTotal,
      baseOffset = 0,
    } = body;

    if (!layerTemplate || !Array.isArray(layerTemplate)) {
      return noCache({ error: 'layerTemplate is required and must be an array' }, 400);
    }
    if (!collectionLayerId) {
      return noCache({ error: 'collectionLayerId is required' }, 400);
    }

    const pageOffset = Math.max(0, isNaN(offset) ? 0 : offset);
    const pageLimit = isNaN(limit) || limit < 1 ? 10 : Math.min(limit, 100);
    // Leading records the collection's `offset` skips. Applied AFTER the
    // `maxTotal` cap so it stays consistent with SSR (cap the pool, then skip
    // the first N). `pageOffset` from the client is relative to the resulting
    // post-offset window, so the effective offset into the pool is the sum.
    const baseOffsetNum = Math.max(0, isNaN(Number(baseOffset)) ? 0 : Number(baseOffset));

    // Pool of candidate ids: either the explicit list (multi-reference filter)
    // or every item in the collection. When SSR enforced a `maxTotal` cap
    // (from `collection.limit` with pagination enabled), clamp the pool so
    // `hasMore` and offset-based paging stop at the same boundary.
    let candidateIds = Array.isArray(itemIds) && itemIds.length > 0
      ? itemIds
      : await getAllItemIdsForCollection(collectionId, published);

    if (typeof maxTotal === 'number' && maxTotal > 0 && candidateIds.length > maxTotal) {
      candidateIds = candidateIds.slice(0, maxTotal);
    }

    // The paginated total excludes the offset-skipped leading records.
    const total = Math.max(0, candidateIds.length - baseOffsetNum);
    // Effective offset into the (sorted) candidate pool for this page window.
    const effectiveOffset = baseOffsetNum + pageOffset;

    let pageRawItems: CollectionItem[] = [];

    if (!sortBy || sortBy === 'none' || sortBy === 'manual') {
      const { items } = await getItemsByCollectionId(collectionId, published, {
        itemIds: candidateIds,
        limit: pageLimit,
        offset: effectiveOffset,
      });
      pageRawItems = items;
    } else if (sortBy === 'random') {
      // Random sort is unstable across requests; without a seed we can't
      // reliably page it, so fall back to manual order to avoid duplicates.
      const { items } = await getItemsByCollectionId(collectionId, published, {
        itemIds: candidateIds,
        limit: pageLimit,
        offset: effectiveOffset,
      });
      pageRawItems = items;
    } else {
      const sortValueByItem = await getFieldValuesForItems(sortBy, published, candidateIds);
      const sortedIds = [...candidateIds].sort((a, b) => {
        const aStr = String(sortValueByItem.get(a) || '');
        const bStr = String(sortValueByItem.get(b) || '');
        const aNum = aStr.trim() !== '' ? Number(aStr) : NaN;
        const bNum = bStr.trim() !== '' ? Number(bStr) : NaN;
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortOrder === 'desc' ? bNum - aNum : aNum - bNum;
        }
        return sortOrder === 'desc' ? bStr.localeCompare(aStr) : aStr.localeCompare(bStr);
      });
      const pageItemIds = sortedIds.slice(effectiveOffset, effectiveOffset + pageLimit);
      if (pageItemIds.length > 0) {
        const { items } = await getItemsByCollectionId(collectionId, published, {
          itemIds: pageItemIds,
        });
        pageRawItems = reorderItemsById(items, pageItemIds);
      }
    }

    const valuesByItem = await getValuesByItemIds(pageRawItems.map(i => i.id), published);
    const items: CollectionItemWithValues[] = pageRawItems.map(item => ({
      ...item,
      values: valuesByItem[item.id] || {},
    }));

    await enrichItemsWithCountValues(items, collectionId, published);

    const collectionItemSlugs: Record<string, string> = {};
    const collectionFields = await getFieldsByCollectionId(collectionId, published, { excludeComputed: true });
    const slugField = collectionFields.find(f => f.key === 'slug');
    if (slugField) {
      for (const item of items) {
        if (item.values[slugField.id]) {
          collectionItemSlugs[item.id] = item.values[slugField.id];
        }
      }
    }

    const [pages, folders] = await Promise.all([
      getAllPages(),
      getAllPageFolders(),
    ]);

    let locale = null;
    let translations: Awaited<ReturnType<typeof loadTranslationsForLocale>>['translations'] | undefined;
    if (localeCode) {
      const localeData = await loadTranslationsForLocale(localeCode, published);
      locale = localeData.locale;
      translations = localeData.translations;
    }

    const html = await renderCollectionItemsToHtml(
      items,
      layerTemplate as Layer[],
      collectionId,
      collectionLayerId,
      published,
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
        items,
        html,
        total,
        offset: pageOffset,
        limit: pageLimit,
        hasMore: pageOffset + items.length < total,
      }
    });
  } catch (error) {
    console.error('Error fetching collection items for load-more:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch items' },
      500
    );
  }
}
