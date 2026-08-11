import { randomUUID } from 'crypto';

import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb, isMissingTableError } from '@/lib/platform/db';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import type { CollectionField, CreateCollectionFieldData, UpdateCollectionFieldData } from '@/types';

/**
 * Collection Field Repository
 *
 * Handles CRUD operations for collection fields (schema definitions).
 * Uses Knex/PostgreSQL via the platform database port.
 *
 * NOTE: Uses composite primary key (id, is_published) architecture.
 * References parent collections using FK (collection_id).
 */

export interface FieldFilters {
  search?: string;
  excludeComputed?: boolean;
}

type CollectionFieldWithTenant = CollectionField & { tenant_id?: string | null };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function addTenantIdToRow(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tenantId = await getTenantIdFromHeaders();
  if (tenantId) {
    row.tenant_id = tenantId;
  }
  return row;
}

/**
 * Get all fields for all collections
 * @param is_published - Filter for draft (false) or published (true) fields. Defaults to false (draft).
 */
export async function getAllFields(
  is_published: boolean = false,
  tenantId?: string
): Promise<CollectionField[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_fields')
      .select('*')
      .where('is_published', is_published)
      .whereNull('deleted_at')
      .orderBy('collection_id', 'asc')
      .orderBy('order', 'asc');

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collection_fields');
    }

    return await query as CollectionField[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch all collection fields: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all fields for a collection with optional search filtering
 * @param collection_id - Collection UUID
 * @param is_published - Filter for draft (false) or published (true) fields. Defaults to false (draft).
 * @param filters - Optional search filters
 * @param tenantId - Optional tenant scope (ignored in single-tenant deployments)
 */
export async function getFieldsByCollectionId(
  collection_id: string,
  is_published: boolean = false,
  filters?: FieldFilters,
  tenantId?: string
): Promise<CollectionField[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_fields')
      .select('*')
      .where('collection_id', collection_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at')
      .orderBy('order', 'asc');

    if (filters?.excludeComputed) {
      query = query.andWhere('is_computed', false);
    }

    if (filters?.search?.trim()) {
      query = query.andWhereILike('name', `%${filters.search.trim()}%`);
    }

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collection_fields');
    }

    return await query as CollectionField[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch collection fields: ${getErrorMessage(error)}`);
  }
}

/**
 * Find fields by key across multiple collections in a single query.
 * Returns Map<collectionId, field> for quick lookup.
 */
export async function getFieldsByKeyAcrossCollections(
  key: string,
  collectionIds: string[]
): Promise<Map<string, CollectionField>> {
  const result = new Map<string, CollectionField>();
  if (collectionIds.length === 0) return result;

  const knex = await getDb();

  try {
    let query = knex('collection_fields')
      .select('*')
      .where('key', key)
      .whereIn('collection_id', collectionIds)
      .andWhere('is_published', false)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_fields');

    const data = await query as CollectionField[];
    data.forEach((field) => {
      result.set(field.collection_id, field);
    });

    return result;
  } catch (error) {
    if (isMissingTableError(error)) return result;
    throw new Error(`Failed to fetch fields by key: ${getErrorMessage(error)}`);
  }
}

/**
 * Get field by ID
 * @param id - Field UUID
 * @param isPublished - Get draft (false) or published (true) version. Defaults to false (draft).
 */
export async function getFieldById(id: string, isPublished: boolean = false): Promise<CollectionField | null> {
  const knex = await getDb();

  try {
    let query = knex('collection_fields')
      .select('*')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_fields');

    const data = await query.first();
    return data ? data as CollectionField : null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch collection field: ${getErrorMessage(error)}`);
  }
}

/**
 * Create a new field
 */
export async function createField(fieldData: CreateCollectionFieldData): Promise<CollectionField> {
  const knex = await getDb();
  const now = new Date().toISOString();
  const isPublished = fieldData.is_published ?? false;

  const row = await addTenantIdToRow({
    id: randomUUID(),
    ...fieldData,
    fillable: fieldData.fillable ?? true,
    key: fieldData.key ?? null,
    hidden: fieldData.hidden ?? false,
    is_computed: fieldData.is_computed ?? false,
    data: fieldData.data ?? {},
    is_published: isPublished,
    created_at: now,
    updated_at: now,
  });

  try {
    const [data] = await knex('collection_fields').insert(row).returning('*');
    return data as CollectionField;
  } catch (error) {
    throw new Error(`Failed to create collection field: ${getErrorMessage(error)}`);
  }
}

/**
 * Update a field
 * @param id - Field UUID
 * @param fieldData - Data to update
 * @param isPublished - Which version to update: draft (false) or published (true). Defaults to false (draft).
 */
export async function updateField(
  id: string,
  fieldData: UpdateCollectionFieldData,
  isPublished: boolean = false
): Promise<CollectionField> {
  const knex = await getDb();

  try {
    let query = knex('collection_fields')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_fields');

    const [data] = await query
      .update({
        ...fieldData,
        updated_at: new Date().toISOString(),
      })
      .returning('*');

    if (!data) {
      throw new Error('Collection field not found');
    }

    return data as CollectionField;
  } catch (error) {
    throw new Error(`Failed to update collection field: ${getErrorMessage(error)}`);
  }
}

/**
 * Delete a field (soft delete)
 * Also soft-deletes all collection_item_values that reference this field
 * Only deletes the draft version by default.
 * @param id - Field UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function deleteField(id: string, isPublished: boolean = false): Promise<void> {
  const knex = await getDb();
  const now = new Date().toISOString();

  try {
    let fieldQuery = knex('collection_fields')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    fieldQuery = await addTenantFilter(knex, fieldQuery, 'collection_fields');
    await fieldQuery.update({ deleted_at: now, updated_at: now });

    let valuesQuery = knex('collection_item_values')
      .where('field_id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    valuesQuery = await addTenantFilter(knex, valuesQuery, 'collection_item_values');
    await valuesQuery.update({ deleted_at: now, updated_at: now });
  } catch (error) {
    throw new Error(`Failed to delete collection field: ${getErrorMessage(error)}`);
  }
}

/**
 * Reorder fields
 * @param collection_id - Collection UUID
 * @param is_published - Filter for draft (false) or published (true) fields. Defaults to false (draft).
 * @param field_ids - Array of field UUIDs in desired order
 */
export async function reorderFields(
  collection_id: string,
  is_published: boolean = false,
  field_ids: string[]
): Promise<void> {
  if (field_ids.length === 0) return;

  const knex = await getDb();
  const now = new Date().toISOString();
  const caseBindings = field_ids.flatMap((id, index) => [id, index]);
  const caseExpression = knex.raw(
    `CASE ${field_ids.map(() => 'WHEN id = ? THEN ?').join(' ')} ELSE "order" END`,
    caseBindings
  );

  try {
    let query = knex('collection_fields')
      .whereIn('id', field_ids)
      .andWhere('collection_id', collection_id)
      .andWhere('is_published', is_published)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collection_fields');

    await query.update({
      order: caseExpression,
      updated_at: now,
    });
  } catch (error) {
    throw new Error(`Failed to reorder fields: ${getErrorMessage(error)}`);
  }
}

/**
 * Hard delete a field
 * Permanently removes field and all associated collection_item_values via CASCADE
 * Used during publish to permanently remove soft-deleted fields
 * @param id - Field UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function hardDeleteField(id: string, isPublished: boolean = false): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('collection_fields')
      .where('id', id)
      .andWhere('is_published', isPublished);
    query = await addTenantFilter(knex, query, 'collection_fields');
    await query.del();
  } catch (error) {
    throw new Error(`Failed to hard delete collection field: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish a field
 * Creates or updates the published version by copying the draft
 * Uses upsert with composite primary key for simplicity
 * @param id - Field UUID
 */
export async function publishField(id: string): Promise<CollectionField> {
  const knex = await getDb();

  const draft = await getFieldById(id, false);
  if (!draft) {
    throw new Error('Draft field not found');
  }

  const now = new Date().toISOString();
  const row = await addTenantIdToRow({
    id: draft.id,
    name: draft.name,
    key: draft.key,
    type: draft.type,
    default: draft.default,
    fillable: draft.fillable,
    order: draft.order,
    collection_id: draft.collection_id,
    reference_collection_id: draft.reference_collection_id,
    hidden: draft.hidden,
    is_computed: draft.is_computed,
    data: draft.data,
    is_published: true,
    created_at: draft.created_at,
    updated_at: now,
  });

  const tenantId = (draft as CollectionFieldWithTenant).tenant_id;
  if (tenantId) {
    row.tenant_id = tenantId;
  }

  try {
    const [data] = await knex('collection_fields')
      .insert(row)
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
      ])
      .returning('*');

    return data as CollectionField;
  } catch (error) {
    throw new Error(`Failed to publish field: ${getErrorMessage(error)}`);
  }
}
