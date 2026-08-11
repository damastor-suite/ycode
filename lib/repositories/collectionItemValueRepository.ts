import { randomUUID } from 'crypto';

import { addTenantFilter } from '@/lib/knex-helpers';
import { castValue, slugify, valueToString } from '@/lib/collection-utils';
import { generateCollectionItemContentHash } from '@/lib/hash-utils';
import { getDb, isMissingTableError } from '@/lib/platform/db';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { deleteTranslationsInBulk, markTranslationsIncomplete } from '@/lib/repositories/translationRepository';
import { isValidUUID } from '@/lib/utils';
import type { CollectionFieldType, CollectionItemValue } from '@/types';

/**
 * Collection Item Value Repository
 *
 * Handles CRUD operations for collection item values (EAV values).
 * Each value represents one field value for one item.
 * Uses Knex/PostgreSQL via the platform database port.
 *
 * NOTE: Uses composite primary key (id, is_published) architecture.
 * References items using FK (item_id).
 * References fields using FK (field_id).
 */

interface FieldTypeRow {
  id: string;
  type: CollectionFieldType;
}

interface FieldKeyRow extends FieldTypeRow {
  key: string | null;
}

type CollectionItemValueWithTenant = CollectionItemValue & { tenant_id?: string | null };

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

/** Update the content_hash on a collection_items row */
async function updateContentHash(itemId: string, isPublished: boolean, hash: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('collection_items')
      .where('id', itemId)
      .andWhere('is_published', isPublished);
    query = await addTenantFilter(knex, query, 'collection_items');

    await query.update({
      content_hash: hash,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    throw new Error(`Failed to update content_hash: ${getErrorMessage(error)}`);
  }
}

export interface CreateCollectionItemValueData {
  value: string | null;
  item_id: string; // UUID
  field_id: string; // UUID
  is_published?: boolean;
}

/**
 * Bulk insert values in a single query (for new items only, skips existence check)
 * @param values - Array of value records to insert
 */
export async function insertValuesBulk(
  values: Array<{ item_id: string; field_id: string; value: string | null; is_published?: boolean }>
): Promise<void> {
  if (values.length === 0) return;

  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const now = new Date().toISOString();
  const valuesToInsert = values.map((value) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      item_id: value.item_id,
      field_id: value.field_id,
      value: value.value,
      is_published: value.is_published ?? false,
      created_at: now,
      updated_at: now,
    };
    if (tenantId) row.tenant_id = tenantId;
    return row;
  });

  try {
    await knex('collection_item_values').insert(valuesToInsert);
  } catch (error) {
    throw new Error(`Failed to bulk insert values: ${getErrorMessage(error)}`);
  }
}

/**
 * Insert values via Knex (direct PG connection) with an extended timeout.
 * Used for oversized values that exceed PostgREST's statement timeout.
 * Sets tenant context when available so DB triggers can populate tenant_id.
 */
export async function insertValuesDirectPg(
  values: Array<{ item_id: string; field_id: string; value: string | null; is_published?: boolean }>
): Promise<void> {
  if (values.length === 0) return;

  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const now = new Date().toISOString();
  const rows = values.map((value) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      item_id: value.item_id,
      field_id: value.field_id,
      value: value.value,
      is_published: value.is_published ?? false,
      created_at: now,
      updated_at: now,
    };
    if (tenantId) row.tenant_id = tenantId;
    return row;
  });

  await knex.transaction(async (trx) => {
    await trx.raw("SET LOCAL statement_timeout = '60s'");
    if (tenantId) {
      await trx.raw('SELECT set_tenant_context(?::uuid)', [tenantId]);
    }
    await trx('collection_item_values').insert(rows);
  });
}

export interface UpdateCollectionItemValueData {
  value?: string | null;
}

/**
 * Get all values for multiple items in one query (batch operation)
 * @param item_ids - Array of item UUIDs
 * @param is_published - Filter for draft (false) or published (true) values. Defaults to false (draft).
 * @param knownFieldTypes - Optional pre-loaded field-id → type map to skip the extra lookup
 * @param fieldIds - Optional whitelist of field IDs to fetch
 */
export async function getValuesByItemIds(
  item_ids: string[],
  is_published: boolean = false,
  knownFieldTypes?: Record<string, string>,
  fieldIds?: string[],
): Promise<Record<string, Record<string, any>>> {
  const safeItemIds = item_ids.filter(isValidUUID);
  const safeFieldIds = fieldIds?.filter(isValidUUID);

  if (safeItemIds.length === 0 || (safeFieldIds && safeFieldIds.length === 0)) {
    return {};
  }

  const knex = await getDb();
  const valuesByItem: Record<string, Record<string, any>> = {};

  try {
    let query = knex('collection_item_values')
      .select('item_id', 'field_id', 'value')
      .whereIn('item_id', safeItemIds)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');

    if (safeFieldIds) {
      query = query.whereIn('field_id', safeFieldIds);
    }

    query = await addTenantFilter(knex, query, 'collection_item_values');
    const allRows = await query as Array<{ item_id: string; field_id: string; value: string | null }>;

    const discoveredFieldIds = new Set<string>();
    if (!knownFieldTypes) {
      for (const row of allRows) {
        discoveredFieldIds.add(row.field_id);
      }
    }

    let fieldTypeMap = knownFieldTypes;
    if (!fieldTypeMap) {
      fieldTypeMap = {};
      if (discoveredFieldIds.size > 0) {
        let fieldsQuery = knex('collection_fields')
          .select('id', 'type')
          .whereIn('id', Array.from(discoveredFieldIds));
        fieldsQuery = await addTenantFilter(knex, fieldsQuery, 'collection_fields');

        const fields = await fieldsQuery as FieldTypeRow[];
        fields.forEach((field) => {
          fieldTypeMap![field.id] = field.type;
        });
      }
    }

    for (const row of allRows) {
      if (!valuesByItem[row.item_id]) {
        valuesByItem[row.item_id] = {};
      }
      valuesByItem[row.item_id][row.field_id] = castValue(
        row.value,
        (fieldTypeMap[row.field_id] || 'text') as CollectionFieldType
      );
    }

    return valuesByItem;
  } catch (error) {
    if (isMissingTableError(error)) return {};
    throw new Error(`Failed to fetch item values: ${getErrorMessage(error)}`);
  }
}

/** Raw value row needed when publishing/diffing item values. */
export interface PublishValueRow {
  id: string;
  item_id: string;
  field_id: string;
  value: string | null;
  created_at: string;
}

/**
 * Bulk-fetch full value rows for many items in a single direct-DB (Knex) query.
 * Avoids PostgREST's row cap and URL-size chunking, which forced per-batch
 * paginated reads during publish.
 */
export async function getValueRowsForItems(
  itemIds: string[],
  isPublished: boolean,
  tenantId?: string,
): Promise<PublishValueRow[]> {
  if (itemIds.length === 0) return [];

  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .select('id', 'item_id', 'field_id', 'value', 'created_at')
      .whereIn('item_id', itemIds)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collection_item_values');
    }

    return await query as PublishValueRow[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch item values: ${getErrorMessage(error)}`);
  }
}

/**
 * Load all values for the given field IDs with pagination.
 * Returns Map<fieldId, Map<itemId, value>> — much lighter than loading all
 * fields when only a few are needed (e.g. resolving airtable_id lookups).
 */
export async function getValueMapByFieldIds(
  fieldIds: string[]
): Promise<Map<string, Map<string, string>>> {
  const result = new Map<string, Map<string, string>>();
  if (fieldIds.length === 0) return result;

  for (const fid of fieldIds) {
    result.set(fid, new Map());
  }

  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .select('item_id', 'field_id', 'value')
      .whereIn('field_id', fieldIds)
      .andWhere('is_published', false)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    const data = await query as Array<{ item_id: string; field_id: string; value: string | null }>;
    data.forEach((row) => {
      if (row.value) {
        result.get(row.field_id)?.set(row.item_id, row.value);
      }
    });

    return result;
  } catch (error) {
    if (isMissingTableError(error)) return result;
    throw new Error(`Failed to fetch field values: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all values for an item
 * @param item_id - Item UUID
 * @param is_published - Filter for draft (false) or published (true) values. Defaults to false (draft).
 */
export async function getValuesByItemId(
  item_id: string,
  is_published: boolean = false
): Promise<CollectionItemValue[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .select('*')
      .where('item_id', item_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    return await query as CollectionItemValue[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch item values: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all values for a field
 * @param field_id - Field UUID
 * @param is_published - Filter for draft (false) or published (true) values. Defaults to false (draft).
 */
export async function getValuesByFieldId(
  field_id: string,
  is_published: boolean = false
): Promise<CollectionItemValue[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .select('*')
      .where('field_id', field_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    return await query as CollectionItemValue[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch field values: ${getErrorMessage(error)}`);
  }
}

/**
 * Get a specific value
 * @param item_id - Item UUID
 * @param field_id - Field UUID
 * @param is_published - Draft (false) or published (true) value. Defaults to false (draft).
 */
export async function getValue(
  item_id: string,
  field_id: string,
  is_published: boolean = false
): Promise<CollectionItemValue | null> {
  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .select('*')
      .where('item_id', item_id)
      .andWhere('field_id', field_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    const data = await query.first();
    return data ? data as CollectionItemValue : null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch value: ${getErrorMessage(error)}`);
  }
}

/**
 * Set a value (upsert)
 * @param item_id - Item UUID
 * @param field_id - Field UUID
 * @param value - Value to set
 * @param is_published - Draft (false) or published (true) value. Defaults to false (draft).
 */
export async function setValue(
  item_id: string,
  field_id: string,
  value: string | null,
  is_published: boolean = false
): Promise<CollectionItemValue> {
  const [result] = await setValues(item_id, { [field_id]: value }, is_published);
  if (!result) {
    throw new Error('Failed to set value');
  }
  return result;
}

/**
 * Set multiple values for an item (batch upsert)
 * @param item_id - Item UUID
 * @param values - Object mapping field_id (UUID) to value string
 * @param is_published - Draft (false) or published (true) values. Defaults to false (draft).
 */
export async function setValues(
  item_id: string,
  values: Record<string, string | null>,
  is_published: boolean = false
): Promise<CollectionItemValue[]> {
  const entries = Object.entries(values);
  if (entries.length === 0) return [];

  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const now = new Date().toISOString();
  const rows = entries.map(([field_id, value]) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      item_id,
      field_id,
      value,
      is_published,
      created_at: now,
      updated_at: now,
    };
    if (tenantId) row.tenant_id = tenantId;
    return row;
  });

  try {
    const data = await knex('collection_item_values')
      .insert(rows)
      .onConflict(knex.raw('(item_id, field_id, is_published) WHERE deleted_at IS NULL'))
      .merge(['value', 'updated_at'])
      .returning('*');

    return data as CollectionItemValue[];
  } catch (error) {
    throw new Error(`Failed to set item values: ${getErrorMessage(error)}`);
  }
}

/**
 * Set multiple values by field ID
 * Convenience method that validates field IDs and applies type casting
 * @param item_id - Item UUID
 * @param collection_id - Collection UUID
 * @param values - Object mapping field_id (UUID) to value
 * @param fieldType - Field type mapping (for casting)
 * @param is_published - Draft (false) or published (true) values. Defaults to false (draft).
 *                       Fields are fetched with the same is_published status.
 */
export async function setValuesByFieldName(
  item_id: string,
  collection_id: string,
  values: Record<string, any>,
  fieldType: Record<string, CollectionFieldType>,
  is_published: boolean = false
): Promise<CollectionItemValue[]> {
  const knex = await getDb();

  let currentValuesMap: Record<string, string | null> = {};
  if (!is_published) {
    const currentValues = await getValuesByItemId(item_id, false);
    currentValuesMap = currentValues.reduce((acc, val) => {
      acc[val.field_id] = val.value;
      return acc;
    }, {} as Record<string, string | null>);
  }

  let fieldsQuery = knex('collection_fields')
    .select('id', 'type', 'key')
    .where('collection_id', collection_id)
    .andWhere('is_published', is_published)
    .whereNull('deleted_at');
  fieldsQuery = await addTenantFilter(knex, fieldsQuery, 'collection_fields');

  let fields: FieldKeyRow[];
  try {
    fields = await fieldsQuery as FieldKeyRow[];
  } catch (error) {
    if (isMissingTableError(error)) fields = [];
    else throw new Error(`Failed to fetch fields: ${getErrorMessage(error)}`);
  }

  const fieldMap: Record<string, CollectionFieldType> = {};
  const fieldKeyMap: Record<string, string> = {};
  fields.forEach((field) => {
    fieldMap[field.id] = field.type;
    if (field.key) {
      fieldKeyMap[field.id] = field.key;
    }
  });

  const valuesToSet: Record<string, string | null> = {};

  for (const [fieldId, value] of Object.entries(values)) {
    const type = fieldMap[fieldId] || fieldType[fieldId] || 'text';
    let stringValue = valueToString(value, type);
    if (stringValue && fieldKeyMap[fieldId] === 'slug') {
      stringValue = slugify(stringValue);
    }
    valuesToSet[fieldId] = stringValue;
  }

  const updatedAtFieldId = Object.keys(fieldKeyMap).find((id) => fieldKeyMap[id] === 'updated_at');
  const autoBumpedUpdatedAt = updatedAtFieldId && !(updatedAtFieldId in valuesToSet);
  if (autoBumpedUpdatedAt) {
    valuesToSet[updatedAtFieldId] = new Date().toISOString();
  }

  if (!is_published) {
    const changedKeys: string[] = [];
    const removedKeys: string[] = [];

    for (const [fieldId, newValue] of Object.entries(valuesToSet)) {
      if (autoBumpedUpdatedAt && fieldId === updatedAtFieldId) continue;

      const oldValue = currentValuesMap[fieldId];
      const contentKey = fieldId in fieldKeyMap
        ? `field:key:${fieldKeyMap[fieldId]}`
        : `field:id:${fieldId}`;

      if (newValue !== oldValue && newValue !== null && newValue !== '') {
        changedKeys.push(contentKey);
      } else if (newValue === null || newValue === '') {
        if (oldValue !== null && oldValue !== undefined && oldValue !== '') {
          removedKeys.push(contentKey);
        }
      }
    }

    if (removedKeys.length > 0) {
      await deleteTranslationsInBulk('cms', item_id, removedKeys);
    }

    if (changedKeys.length > 0) {
      await markTranslationsIncomplete('cms', item_id, changedKeys);
    }
  }

  const results = await setValues(item_id, valuesToSet, is_published);

  const allValues = await getValuesByItemId(item_id, is_published);
  const hash = generateCollectionItemContentHash(allValues.map((v) => ({ field_id: v.field_id, value: v.value })));
  await updateContentHash(item_id, is_published, hash);

  return results;
}

/**
 * Delete a value
 * @param item_id - Item UUID
 * @param field_id - Field UUID
 * @param is_published - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function deleteValue(
  item_id: string,
  field_id: string,
  is_published: boolean = false
): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .where('item_id', item_id)
      .andWhere('field_id', field_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    await query.update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    throw new Error(`Failed to delete value: ${getErrorMessage(error)}`);
  }
}

/**
 * Soft-delete every stored value for a field whose value exactly matches
 * `value`. Used when an option is removed from an option-type field so item
 * values storing that option name are cleared from both draft and published
 * rows.
 * @returns Number of rows soft-deleted
 */
export async function clearValuesForField(
  field_id: string,
  value: string
): Promise<number> {
  const knex = await getDb();
  const now = new Date().toISOString();

  try {
    let query = knex('collection_item_values')
      .where('field_id', field_id)
      .andWhere('value', value)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    const data = await query
      .update({ deleted_at: now, updated_at: now })
      .returning('id') as Array<{ id: string }>;

    return data.length;
  } catch (error) {
    throw new Error(`Failed to clear values: ${getErrorMessage(error)}`);
  }
}

/**
 * Replace stored values for a field where the value exactly matches `old_value`.
 * Used to propagate option renames in option-type fields to all draft and
 * published item values storing the previous option name.
 * @returns Number of rows updated
 */
export async function renameValuesForField(
  field_id: string,
  old_value: string,
  new_value: string
): Promise<number> {
  if (old_value === new_value) return 0;

  const knex = await getDb();

  try {
    let query = knex('collection_item_values')
      .where('field_id', field_id)
      .andWhere('value', old_value)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_item_values');

    const data = await query
      .update({
        value: new_value,
        updated_at: new Date().toISOString(),
      })
      .returning('id') as Array<{ id: string }>;

    return data.length;
  } catch (error) {
    throw new Error(`Failed to rename values: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish values for an item
 * Copies all draft values to published values for the same item
 * Uses batch upsert for efficiency
 * @param item_id - Item UUID to publish
 * @returns Number of values published
 */
export async function publishValues(item_id: string): Promise<number> {
  const knex = await getDb();
  const draftValues = await getValuesByItemId(item_id, false);

  if (draftValues.length === 0) {
    return 0;
  }

  const now = new Date().toISOString();
  const tenantId = await getTenantIdFromHeaders();
  const valuesToUpsert = draftValues.map((value) => {
    const row: Record<string, unknown> = {
      id: value.id,
      item_id: value.item_id,
      field_id: value.field_id,
      value: value.value,
      is_published: true,
      created_at: value.created_at,
      updated_at: now,
    };

    const valueTenantId = (value as CollectionItemValueWithTenant).tenant_id ?? tenantId;
    if (valueTenantId) row.tenant_id = valueTenantId;
    return row;
  });

  try {
    await knex('collection_item_values')
      .insert(valuesToUpsert)
      .onConflict(['id', 'is_published'])
      .merge(['item_id', 'field_id', 'value', 'updated_at']);
  } catch (error) {
    throw new Error(`Failed to publish values: ${getErrorMessage(error)}`);
  }

  const hash = generateCollectionItemContentHash(draftValues.map((v) => ({ field_id: v.field_id, value: v.value })));
  await updateContentHash(item_id, true, hash);

  try {
    const { collectItemValueAssetIds } = await import('@/lib/collection-asset-utils');
    const assetRepositoryPath = '@/lib/repositories/assetRepository';
    const { publishAssets } = await import(assetRepositoryPath) as {
      publishAssets: (assetIds: string[]) => Promise<unknown>;
    };
    const assetIds = collectItemValueAssetIds(draftValues);
    if (assetIds.length > 0) {
      await publishAssets(assetIds);
    }
  } catch {
    // Non-fatal: asset publishing failure should not roll back value publishing
  }

  return draftValues.length;
}

/**
 * Cast a value to its proper type
 * Helper function to convert text values to typed values
 */
export function castValueByType(value: string | null, type: CollectionFieldType): any {
  return castValue(value, type);
}
