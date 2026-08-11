import { parseMultiReferenceValue } from '@/lib/collection-utils';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb, isMissingTableError } from '@/lib/platform/db';
import { getFieldById, getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import type { CollectionField, CollectionItemWithValues } from '@/types';

/**
 * Collection Count Repository
 *
 * Computes values for `count` fields by counting items in a child collection
 * that reference back via a configured reference / multi_reference field.
 * Every non-deleted item is counted (drafts, published, and items staged for
 * publish) so a freshly added relation shows up immediately in the builder
 * without waiting for a publish.
 *
 * The result is written into each parent item's `values[countFieldId]` as a
 * numeric string so the existing render / sort / filter pipelines can treat
 * it like a regular number field.
 */

interface CountConfigContext {
  /** Count field on the parent collection */
  countField: CollectionField;
  /** Source reference field on the child collection */
  sourceField: CollectionField;
}

async function loadCountFieldContexts(
  parentCollectionId: string,
  isPublished: boolean,
  parentFields?: CollectionField[],
  fieldsById?: Map<string, CollectionField>,
): Promise<CountConfigContext[]> {
  const fields = parentFields ?? await getFieldsByCollectionId(parentCollectionId, isPublished);
  const countFields = fields.filter((field) => field.type === 'count');
  if (countFields.length === 0) return [];

  const contexts: CountConfigContext[] = [];

  for (const countField of countFields) {
    const cfg = countField.data?.count;
    if (!cfg?.collectionId || !cfg?.fieldId) continue;

    // Source field metadata is published-version agnostic for our purposes —
    // we only need its type/reference_collection_id, which doesn't change
    // between draft and published. Looking up the draft version is enough.
    const sourceField = fieldsById?.get(cfg.fieldId) ?? await getFieldById(cfg.fieldId, false);
    if (!sourceField) continue;
    if (sourceField.collection_id !== cfg.collectionId) continue;
    if (sourceField.type !== 'reference' && sourceField.type !== 'multi_reference') continue;
    if (sourceField.reference_collection_id !== parentCollectionId) continue;

    contexts.push({ countField, sourceField });
  }

  return contexts;
}

/**
 * Look up reference values for the given source field and group counts by
 * the parent item id they point at. Counts every item — drafts, published,
 * and items staged for publish — so newly-added relations show up
 * immediately without waiting for a publish.
 */
async function buildCountMap(
  sourceField: CollectionField,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const knex = await getDb();

  try {
    let validItemsQuery = knex('collection_items')
      .select('id')
      .where('is_published', false)
      .whereNull('deleted_at');
    validItemsQuery = await addTenantFilter(knex, validItemsQuery, 'collection_items');

    let valuesQuery = knex('collection_item_values')
      .select('value')
      .where('field_id', sourceField.id)
      .andWhere('is_published', false)
      .whereNull('deleted_at')
      .whereIn('item_id', validItemsQuery);
    valuesQuery = await addTenantFilter(knex, valuesQuery, 'collection_item_values');

    const data = await valuesQuery as Array<{ value: string | null }>;

    for (const row of data) {
      if (!row.value) continue;

      if (sourceField.type === 'multi_reference') {
        const ids = parseMultiReferenceValue(row.value);
        for (const id of ids) {
          if (!id) continue;
          counts.set(id, (counts.get(id) || 0) + 1);
        }
      } else {
        counts.set(row.value, (counts.get(row.value) || 0) + 1);
      }
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.error(`[count] Failed to load reference values for field ${sourceField.id}:`, error);
    }
  }

  return counts;
}

/**
 * Inject `count` field values into the given parent collection items.
 * Mutates `items` in place so all callers (which typically just hand the
 * array to JSON serialization) automatically pick up the computed values.
 *
 * `isPublished` controls which version of the parent's count field schema we
 * load. Counts always reflect every non-deleted child item (drafts +
 * published + staged for publish) regardless of this flag.
 *
 * Pass `parentFields` / `fieldsById` to skip redundant field fetches when
 * the caller has already loaded fields (e.g. the batch items endpoint).
 *
 * Safe to call when the collection has no `count` fields - it short-circuits.
 */
export async function enrichItemsWithCountValues(
  items: CollectionItemWithValues[],
  parentCollectionId: string,
  isPublished: boolean = false,
  parentFields?: CollectionField[],
  fieldsById?: Map<string, CollectionField>,
): Promise<void> {
  if (items.length === 0) return;

  const contexts = await loadCountFieldContexts(
    parentCollectionId,
    isPublished,
    parentFields,
    fieldsById,
  );
  if (contexts.length === 0) return;

  for (const { countField, sourceField } of contexts) {
    const counts = await buildCountMap(sourceField);
    for (const item of items) {
      const n = counts.get(item.id) || 0;
      item.values[countField.id] = String(n);
    }
  }
}
