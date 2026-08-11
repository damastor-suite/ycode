import { NextRequest } from 'next/server';
import { getItemsWithValues } from '@/lib/repositories/collectionItemRepository';
import { getValueRowsForItems } from '@/lib/repositories/collectionItemValueRepository';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ValueRow = {
  item_id: string;
  field_id: string;
  value: string | null;
};

function groupValuesByItem(rows: ValueRow[]): Map<string, Array<{ field_id: string; value: string | null }>> {
  const valuesByItem = new Map<string, Array<{ field_id: string; value: string | null }>>();

  for (const row of rows) {
    const values = valuesByItem.get(row.item_id) ?? [];
    values.push({ field_id: row.field_id, value: row.value });
    valuesByItem.set(row.item_id, values);
  }

  return valuesByItem;
}

async function getPublishedItemIds(itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) {
    return new Set();
  }

  const db = await getDb();
  let query = db('collection_items')
    .select('id')
    .whereIn('id', itemIds)
    .where('is_published', true);
  query = await addTenantFilter(db, query, 'collection_items');

  const rows = await query as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * GET /ycode/api/collections/[id]/items/unpublished
 * Get all unpublished (changed) items for a collection
 * An item is unpublished if:
 * - It has draft values but no published values (new)
 * - Its draft values differ from published values (updated)
 * - It is soft-deleted AND has published values (deleted - needs removal from published)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const collectionId = id; // UUID string, no parsing needed

    // Get all items including deleted ones (no pagination for unpublished check)
    const { items } = await getItemsWithValues(
      collectionId,
      false, // is_published (draft items and values)
      { deleted: undefined } // filters (include all deleted states)
    );

    const itemIds = items.map((item) => item.id);
    const [draftRows, publishedRows, publishedItemIds] = await Promise.all([
      getValueRowsForItems(itemIds, false),
      getValueRowsForItems(itemIds, true),
      getPublishedItemIds(itemIds),
    ]);
    const draftValuesByItem = groupValuesByItem(draftRows);
    const publishedValuesByItem = groupValuesByItem(publishedRows);
    const unpublishedItems = [];

    // Check each item to see if it needs publishing
    for (const item of items) {
      // If item is deleted, check if it has published values
      if (item.deleted_at) {
        // Only show as "deleted" if there are published values to remove
        if ((publishedValuesByItem.get(item.id)?.length ?? 0) > 0) {
          unpublishedItems.push({ ...item, publish_status: 'deleted' });
        }
        // If no published values, skip this item (never published, so nothing to delete)
        continue;
      }

      // If item is not publishable, check if it has a published version that needs removal
      if (!item.is_publishable) {
        if (publishedItemIds.has(item.id)) {
          unpublishedItems.push({ ...item, publish_status: 'deleted' });
        }
        continue;
      }

      const draftValues = draftValuesByItem.get(item.id) ?? [];
      const publishedValues = publishedValuesByItem.get(item.id) ?? [];

      // If no published values, item is new
      if (publishedValues.length === 0) {
        unpublishedItems.push({ ...item, publish_status: 'new' });
        continue;
      }

      // Check if draft differs from published
      const isDifferent = hasChanges(draftValues, publishedValues);

      if (isDifferent) {
        unpublishedItems.push({ ...item, publish_status: 'updated' });
      }
    }

    return noCache({ data: unpublishedItems });
  } catch (error) {
    console.error('Error fetching unpublished collection items:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch unpublished items' },
      500
    );
  }
}

/**
 * Helper to check if draft values differ from published values
 */
function hasChanges(
  draftValues: Array<{ field_id: string; value: string | null }>,
  publishedValues: Array<{ field_id: string; value: string | null }>
): boolean {
  // Create maps for easy comparison
  const draftMap = new Map(draftValues.map(v => [v.field_id, v.value]));
  const publishedMap = new Map(publishedValues.map(v => [v.field_id, v.value]));

  // Check if number of fields differs
  if (draftMap.size !== publishedMap.size) {
    return true;
  }

  // Check if any draft value differs from published
  for (const [fieldId, draftValue] of draftMap) {
    const publishedValue = publishedMap.get(fieldId);

    // Field doesn't exist in published or value differs
    if (publishedValue === undefined || draftValue !== publishedValue) {
      return true;
    }
  }

  return false;
}
