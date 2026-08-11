import { getSupabaseAdmin } from '@/lib/supabase-server';
import { applyTenantEq, resolveTenantId, stampTenantId, stampTenantIdMany } from '@/lib/tenant';
import { SUPABASE_QUERY_LIMIT } from '@/lib/supabase-constants';
import { getKnexClient } from '@/lib/knex-client';
import type { CollectionField, CreateCollectionFieldData, UpdateCollectionFieldData } from '@/types';
import { randomUUID } from 'crypto';

/**
 * Collection Field Repository
 *
 * Handles CRUD operations for collection fields (schema definitions).
 * Uses Supabase/PostgreSQL via admin client.
 *
 * NOTE: Uses composite primary key (id, is_published) architecture.
 * References parent collections using FK (collection_id).
 */

export interface FieldFilters {
  search?: string;
  excludeComputed?: boolean;
}

/**
 * Get all fields for all collections
 * @param is_published - Filter for draft (false) or published (true) fields. Defaults to false (draft).
 */
export async function getAllFields(
  is_published: boolean = false,
  tenantId?: string
): Promise<CollectionField[]> {
  // Fast path: single direct-DB (Knex) read instead of paginated PostgREST.
  try {
    const knex = await getKnexClient();
    const resolvedTenantId = await resolveTenantId(tenantId);
    let query = knex('collection_fields')
      .select('*')
      .where('is_published', is_published)
      .whereNull('deleted_at')
      .orderBy('collection_id', 'asc')
      .orderBy('order', 'asc');
    if (resolvedTenantId) {
      query = query.where('tenant_id', resolvedTenantId);
    }
    return await query;
  } catch {
    // Fallback to paginated PostgREST reads below.
  }

  const client = await getSupabaseAdmin(tenantId);

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Use pagination to handle >1000 fields (Supabase default limit)
  const allFields: CollectionField[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query1 = client
      .from('collection_fields')
      .select('*')
      .eq('is_published', is_published)
      .is('deleted_at', null)
      .order('collection_id', { ascending: true })
      .order('order', { ascending: true })
      .range(offset, offset + SUPABASE_QUERY_LIMIT - 1);
    query1 = (await applyTenantEq(query1, tenantId)).query;
    const { data, error } = await query1;

    if (error) {
      throw new Error(`Failed to fetch all collection fields: ${error.message}`);
    }

    if (data && data.length > 0) {
      allFields.push(...data);
      offset += data.length;
      hasMore = data.length === SUPABASE_QUERY_LIMIT;
    } else {
      hasMore = false;
    }
  }

  return allFields;
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
  const client = await getSupabaseAdmin(tenantId);

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collection_fields')
    .select('*')
    .eq('collection_id', collection_id)
    .eq('is_published', is_published)
    .is('deleted_at', null)
    .order('order', { ascending: true });

  if (filters?.excludeComputed) {
    query = query.eq('is_computed', false);
  }

  if (filters?.search && filters.search.trim()) {
    const searchTerm = `%${filters.search.trim()}%`;
    query = query.ilike('name', searchTerm);
  }

  query = (await applyTenantEq(query, tenantId)).query;

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch collection fields: ${error.message}`);
  }

  return data || [];
}

/**
 * Find fields by key across multiple collections in a single query.
 * Returns Map<collectionId, field> for quick lookup.
 */
export async function getFieldsByKeyAcrossCollections(
  key: string,
  collectionIds: string[]
): Promise<Map<string, CollectionField>> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const result = new Map<string, CollectionField>();
  if (collectionIds.length === 0) return result;

  let query = client
    .from('collection_fields')
    .select('*')
    .eq('key', key)
    .in('collection_id', collectionIds)
    .eq('is_published', false)
    .is('deleted_at', null);
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch fields by key: ${error.message}`);
  }

  data?.forEach((field: CollectionField) => {
    result.set(field.collection_id, field);
  });

  return result;
}

/**
 * Get field by ID
 * @param id - Field UUID
 * @param isPublished - Get draft (false) or published (true) version. Defaults to false (draft).
 */
export async function getFieldById(id: string, isPublished: boolean = false): Promise<CollectionField | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collection_fields')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch collection field: ${error.message}`);
  }

  return data;
}

/**
 * Create a new field
 */
export async function createField(fieldData: CreateCollectionFieldData): Promise<CollectionField> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const id = randomUUID();
  const isPublished = fieldData.is_published ?? false;

  const { data, error } = await client
    .from('collection_fields')
    .insert(await stampTenantId({
      id,
      ...fieldData,
      fillable: fieldData.fillable ?? true,
      key: fieldData.key ?? null,
      hidden: fieldData.hidden ?? false,
      is_computed: fieldData.is_computed ?? false,
      data: fieldData.data ?? {},
      is_published: isPublished,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create collection field: ${error.message}`);
  }

  return data;
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
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collection_fields')
    .update({
      ...fieldData,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .select();
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.single();

  if (error) {
    throw new Error(`Failed to update collection field: ${error.message}`);
  }

  return data;
}

/**
 * Delete a field (soft delete)
 * Also soft-deletes all collection_item_values that reference this field
 * Only deletes the draft version by default.
 * @param id - Field UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function deleteField(id: string, isPublished: boolean = false): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const now = new Date().toISOString();

  // Soft delete the field
  let query = client
    .from('collection_fields')
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query = (await applyTenantEq(query)).query;
  const { error: fieldError } = await query;

  if (fieldError) {
    throw new Error(`Failed to delete collection field: ${fieldError.message}`);
  }

  // Soft delete all collection_item_values for this field (same published state)
  let query1 = client
    .from('collection_item_values')
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq('field_id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query1 = (await applyTenantEq(query1)).query;
  const { error: valuesError } = await query1;

  if (valuesError) {
    throw new Error(`Failed to delete field values: ${valuesError.message}`);
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
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Update order for each field
  const updates = [];
  for (let index = 0; index < field_ids.length; index++) {
    const field_id = field_ids[index];
    let updateQuery = client
      .from('collection_fields')
      .update({
        order: index,
        updated_at: new Date().toISOString(),
      })
      .eq('id', field_id)
      .eq('collection_id', collection_id)
      .eq('is_published', is_published)
      .is('deleted_at', null);
    updateQuery = (await applyTenantEq(updateQuery)).query;
    updates.push(updateQuery);
  }

  const results = await Promise.all(updates);

  // Check for errors
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    throw new Error(`Failed to reorder fields: ${errors[0].error?.message}`);
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
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Hard delete the field (CASCADE will delete values)
  let query = client
    .from('collection_fields')
    .delete()
    .eq('id', id)
    .eq('is_published', isPublished);
  query = (await applyTenantEq(query)).query;
  const { error } = await query;

  if (error) {
    throw new Error(`Failed to hard delete collection field: ${error.message}`);
  }
}

/**
 * Publish a field
 * Creates or updates the published version by copying the draft
 * Uses upsert with composite primary key for simplicity
 * @param id - Field UUID
 */
export async function publishField(id: string): Promise<CollectionField> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Get the draft version
  const draft = await getFieldById(id, false);
  if (!draft) {
    throw new Error('Draft field not found');
  }

  // Upsert published version (composite key handles insert/update automatically)
  const { data, error } = await client
    .from('collection_fields')
    .upsert(await stampTenantId({
      id: draft.id, // Same UUID
      name: draft.name,
      key: draft.key,
      type: draft.type,
      default: draft.default,
      fillable: draft.fillable,
      order: draft.order,
      collection_id: draft.collection_id,
      reference_collection_id: draft.reference_collection_id,
      hidden: draft.hidden,
      data: draft.data,
      is_published: true,
      created_at: draft.created_at,
      updated_at: new Date().toISOString(),
    }), {
      onConflict: 'id,is_published', // Composite primary key
    }).select()
    .single();

  if (error) {
    throw new Error(`Failed to publish field: ${error.message}`);
  }

  return data;

}
