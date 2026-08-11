import { getSupabaseAdmin } from '@/lib/supabase-server';
import { applyTenantEq, resolveTenantId, stampTenantId, stampTenantIdMany } from '@/lib/tenant';
import { getKnexClient } from '@/lib/knex-client';
import { SUPABASE_IN_FILTER_CHUNK_SIZE } from '@/lib/supabase-constants';
import type { Collection, CreateCollectionData, UpdateCollectionData } from '@/types';
import { randomUUID } from 'crypto';

/**
 * Collection Repository
 *
 * Handles CRUD operations for collections (content types).
 * Uses Supabase/PostgreSQL via admin client.
 *
 * NOTE: Uses composite primary key (id, is_published) architecture.
 * All queries must specify is_published filter.
 */

export interface QueryFilters {
  is_published?: boolean;
  deleted?: boolean;
}

/**
 * Get all collections
 * @param filters - Optional filters (is_published, deleted)
 * @param filters.is_published - Get draft (false) or published (true) collections. Defaults to false (draft).
 */
export async function getAllCollections(filters?: QueryFilters): Promise<Collection[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const isPublished = filters?.is_published ?? false;

  let query = client
    .from('collections')
    .select(`
      *,
      collection_items!left(id, deleted_at, is_published)
    `)
    .eq('is_published', isPublished)
    .order('order', { ascending: true })
    .order('created_at', { ascending: false });

  // Apply deleted filter
  if (filters?.deleted === false) {
    query = query.is('deleted_at', null);
  } else if (filters?.deleted === true) {
    query = query.not('deleted_at', 'is', null);
  } else {
    // Default: exclude deleted
    query = query.is('deleted_at', null);
  }

  query = (await applyTenantEq(query)).query;

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch collections: ${error.message}`);
  }

  const draftIds = (data || []).map((c: any) => c.id);

  // When fetching draft collections, batch-check which ones have a published version
  const publishedIds = !isPublished && draftIds.length > 0
    ? await getPublishedCollectionIds(draftIds)
    : new Set<string>();

  // Process the data to add draft_items_count and has_published_version
  const collections = (data || []).map((collection: any) => {
    const items = collection.collection_items || [];
    const draft_items_count = items.filter((item: any) =>
      item.deleted_at === null && item.is_published === isPublished
    ).length;

    const { collection_items, ...collectionData } = collection;
    return {
      ...collectionData,
      draft_items_count,
      ...(!isPublished && { has_published_version: publishedIds.has(collection.id) }),
    };
  });

  return collections;
}

/**
 * Get raw collection rows for a publish flag in a single direct-DB (Knex) read.
 * Unlike getAllCollections, this skips item-count joins and published-version
 * lookups — intended for bulk publish flows that only need the base columns.
 * @param tenantId - Optional explicit tenant scope (required inside unstable_cache)
 */
export async function getCollectionsRaw(isPublished: boolean, tenantId?: string): Promise<Collection[]> {
  try {
    const knex = await getKnexClient();
    const resolvedTenantId = await resolveTenantId(tenantId);
    let query = knex('collections')
      .select('*')
      .where('is_published', isPublished)
      .whereNull('deleted_at');
    if (resolvedTenantId) {
      query = query.where('tenant_id', resolvedTenantId);
    }
    return await query;
  } catch {
    const client = await getSupabaseAdmin(tenantId);
    if (!client) throw new Error('Supabase client not configured');

    let query1 = client
      .from('collections')
      .select('*')
      .eq('is_published', isPublished)
      .is('deleted_at', null);
    query1 = (await applyTenantEq(query1, tenantId)).query;
    const { data, error } = await query1;

    if (error) throw new Error(`Failed to fetch collections: ${error.message}`);
    return data || [];
  }
}

/**
 * Batch-check which collection IDs have a published version.
 * Returns a Set of IDs that have is_published=true rows.
 */
export async function getPublishedCollectionIds(collectionIds: string[]): Promise<Set<string>> {
  if (collectionIds.length === 0) return new Set();

  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collections')
    .select('id')
    .in('id', collectionIds)
    .eq('is_published', true)
    .is('deleted_at', null);
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to check published collections: ${error.message}`);
  }

  return new Set((data || []).map(c => c.id));
}

/**
 * Get collection by ID
 * @param id - Collection UUID
 * @param isPublished - Get draft (false) or published (true) version. Defaults to false (draft).
 * @param includeDeleted - Whether to include soft-deleted collections. Defaults to false.
 */
export async function getCollectionById(
  id: string,
  isPublished: boolean = false,
  includeDeleted: boolean = false
): Promise<Collection | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collections')
    .select('*')
    .eq('id', id)
    .eq('is_published', isPublished);

  // Filter out deleted unless explicitly requested
  if (!includeDeleted) {
    query = query.is('deleted_at', null);
  }

  query = (await applyTenantEq(query)).query;

  const { data, error } = await query.single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch collection: ${error.message}`);
  }

  return data;
}

/**
 * Get collection by name
 * @param name - Collection name
 * @param isPublished - Get draft (false) or published (true) version. Defaults to false (draft).
 */
export async function getCollectionByName(name: string, isPublished: boolean = false): Promise<Collection | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collections')
    .select('*')
    .eq('name', name)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch collection: ${error.message}`);
  }

  return data;
}

/**
 * Create a new collection (draft by default)
 */
export async function createCollection(collectionData: CreateCollectionData): Promise<Collection> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const id = randomUUID();
  const isPublished = collectionData.is_published ?? false;

  const { data, error } = await client
    .from('collections')
    .insert(await stampTenantId({
      id,
      ...collectionData,
      order: collectionData.order ?? 0,
      is_published: isPublished,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create collection: ${error.message}`);
  }

  return data;
}

/**
 * Update a collection
 * @param id - Collection UUID
 * @param collectionData - Data to update
 * @param isPublished - Which version to update: draft (false) or published (true). Defaults to false (draft).
 */
export async function updateCollection(
  id: string,
  collectionData: UpdateCollectionData,
  isPublished: boolean = false
): Promise<Collection> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  let query = client
    .from('collections')
    .update({
      ...collectionData,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null)
    .select();
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.single();

  if (error) {
    throw new Error(`Failed to update collection: ${error.message}`);
  }

  return data;
}

/**
 * Delete a collection (soft delete)
 * Also cascades soft delete to all related fields, items, and item values
 * @param id - Collection UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function deleteCollection(id: string, isPublished: boolean = false): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  const now = new Date().toISOString();

  // Soft delete the collection
  let query = client
    .from('collections')
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq('id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query = (await applyTenantEq(query)).query;
  const { error: collectionError } = await query;

  if (collectionError) {
    throw new Error(`Failed to delete collection: ${collectionError.message}`);
  }

  // Soft delete all related fields
  let query1 = client
    .from('collection_fields')
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq('collection_id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query1 = (await applyTenantEq(query1)).query;
  const { error: fieldsError } = await query1;

  if (fieldsError) {
    console.error('Error soft-deleting collection fields:', fieldsError);
  }

  // Soft delete all related items
  let query2 = client
    .from('collection_items')
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq('collection_id', id)
    .eq('is_published', isPublished)
    .is('deleted_at', null);
  query2 = (await applyTenantEq(query2)).query;
  const { error: itemsError } = await query2;

  if (itemsError) {
    console.error('Error soft-deleting collection items:', itemsError);
  }

  // Soft delete all item values (these are linked to items via FK)
  // We need to get all items first to delete their values
  let query3 = client
    .from('collection_items')
    .select('id')
    .eq('collection_id', id)
    .eq('is_published', isPublished);
  query3 = (await applyTenantEq(query3)).query;
  const { data: items } = await query3;

  if (items && items.length > 0) {
    const itemIds = items.map(item => item.id);

    // Chunk the id list so large `.in()` filters don't overflow the request URL
    // length limit (which returns 400 Bad Request).
    for (let i = 0; i < itemIds.length; i += SUPABASE_IN_FILTER_CHUNK_SIZE) {
      const idsChunk = itemIds.slice(i, i + SUPABASE_IN_FILTER_CHUNK_SIZE);
      let query4 = client
        .from('collection_item_values')
        .update({
          deleted_at: now,
          updated_at: now,
        })
        .in('item_id', idsChunk)
        .eq('is_published', isPublished)
        .is('deleted_at', null);
      query4 = (await applyTenantEq(query4)).query;
      const { error: valuesError } = await query4;

      if (valuesError) {
        console.error('Error soft-deleting collection item values:', valuesError);
      }
    }
  }
}

/**
 * Hard delete a collection and all its related data
 * This permanently removes the collection, fields, items, and item values
 * CASCADE constraints will handle the related data deletion
 * @param id - Collection UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function hardDeleteCollection(id: string, isPublished: boolean = false): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Hard delete the collection (CASCADE will delete all related data)
  let query = client
    .from('collections')
    .delete()
    .eq('id', id)
    .eq('is_published', isPublished);
  query = (await applyTenantEq(query)).query;
  const { error } = await query;

  if (error) {
    throw new Error(`Failed to hard delete collection: ${error.message}`);
  }
}

/**
 * Publish a collection
 * Creates or updates the published version by copying the draft
 * Uses upsert with composite primary key for simplicity
 * @param id - Collection UUID
 */
export async function publishCollection(id: string): Promise<Collection> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Get the draft version
  const draft = await getCollectionById(id, false);
  if (!draft) {
    throw new Error('Draft collection not found');
  }

  // Upsert published version (composite key handles insert/update automatically)
  const { data, error } = await client
    .from('collections')
    .upsert(await stampTenantId({
      id: draft.id, // Same UUID
      name: draft.name,
      sorting: draft.sorting,
      order: draft.order,
      is_published: true,
      created_at: draft.created_at,
      updated_at: new Date().toISOString(),
    }), {
      onConflict: 'id,is_published', // Composite primary key
    }).select()
    .single();

  if (error) {
    throw new Error(`Failed to publish collection: ${error.message}`);
  }

  return data;

}

/** Check if draft collection metadata differs from published */
function hasCollectionChanged(draft: Collection, published: Collection): boolean {
  return (
    draft.name !== published.name ||
    draft.order !== published.order
  );
}

/**
 * Get all unpublished collections.
 * A collection needs publishing if no published version exists or draft data differs.
 * Uses batch query instead of N+1.
 */
export async function getUnpublishedCollections(): Promise<Collection[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Get all draft collections
  const draftCollections = await getAllCollections({ is_published: false });

  if (draftCollections.length === 0) {
    return [];
  }

  // Batch fetch all published collections for comparison
  const draftIds = draftCollections.map(c => c.id);
  let query = client
    .from('collections')
    .select('*')
    .in('id', draftIds)
    .eq('is_published', true);
  query = (await applyTenantEq(query)).query;
  const { data: publishedCollections, error: publishedError } = await query;

  if (publishedError) {
    throw new Error(`Failed to fetch published collections: ${publishedError.message}`);
  }

  const publishedById = new Map<string, Collection>();
  (publishedCollections || []).forEach(c => publishedById.set(c.id, c));

  return draftCollections.filter(draft => {
    const published = publishedById.get(draft.id);
    if (!published) {
      return true; // Never published
    }
    return hasCollectionChanged(draft, published);
  });
}

/**
 * Reorder collections
 * Updates the order field for multiple collections
 * @param isPublished - Whether to update draft (false) or published (true) collections
 * @param collectionIds - Array of collection IDs in the desired order
 */
export async function reorderCollections(isPublished: boolean, collectionIds: string[]): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase client not configured');
  }

  // Update order for each collection
  const updates = [];
  for (let index = 0; index < collectionIds.length; index++) {
    const id = collectionIds[index];
    let updateQuery = client
      .from('collections')
      .update({
        order: index,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('is_published', isPublished)
      .is('deleted_at', null);
    updateQuery = (await applyTenantEq(updateQuery)).query;
    updates.push(updateQuery);
  }

  const results = await Promise.all(updates);

  // Check for errors
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    throw new Error(`Failed to reorder collections: ${errors[0].error?.message}`);
  }
}
