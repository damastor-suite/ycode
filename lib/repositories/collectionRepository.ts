import { randomUUID } from 'crypto';

import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb, isMissingTableError } from '@/lib/platform/db';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import type { Collection, CreateCollectionData, UpdateCollectionData } from '@/types';

/**
 * Collection Repository
 *
 * Handles CRUD operations for collections (content types).
 * Uses Knex/PostgreSQL via the platform database port.
 *
 * NOTE: Uses composite primary key (id, is_published) architecture.
 * All queries must specify is_published filter.
 */

export interface QueryFilters {
  is_published?: boolean;
  deleted?: boolean;
}

type CollectionWithTenant = Collection & { tenant_id?: string | null };

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

async function getCollectionIdsWithItemCounts(
  collectionIds: string[],
  isPublished: boolean
): Promise<Map<string, number>> {
  if (collectionIds.length === 0) {
    return new Map();
  }

  const knex = await getDb();
  let query = knex('collection_items')
    .select('collection_id')
    .count<{ collection_id: string; count: string | number }[]>({ count: '*' })
    .whereIn('collection_id', collectionIds)
    .andWhere('is_published', isPublished)
    .whereNull('deleted_at')
    .groupBy('collection_id');
  query = await addTenantFilter(knex, query, 'collection_items');

  const rows = await query;
  return new Map(rows.map((row) => [row.collection_id, Number(row.count) || 0]));
}

/**
 * Get all collections
 * @param filters - Optional filters (is_published, deleted)
 * @param filters.is_published - Get draft (false) or published (true) collections. Defaults to false (draft).
 */
export async function getAllCollections(filters?: QueryFilters): Promise<Collection[]> {
  const knex = await getDb();
  const isPublished = filters?.is_published ?? false;

  try {
    let query = knex('collections')
      .select('*')
      .where('is_published', isPublished)
      .orderBy('order', 'asc')
      .orderBy('created_at', 'desc');

    if (filters?.deleted === true) {
      query = query.whereNotNull('deleted_at');
    } else {
      query = query.whereNull('deleted_at');
    }

    query = await addTenantFilter(knex, query, 'collections');
    const data = await query as Collection[];
    const collectionIds = data.map((collection) => collection.id);

    const [itemCounts, publishedIds] = await Promise.all([
      getCollectionIdsWithItemCounts(collectionIds, isPublished),
      !isPublished && collectionIds.length > 0
        ? getPublishedCollectionIds(collectionIds)
        : Promise.resolve(new Set<string>()),
    ]);

    return data.map((collection) => ({
      ...collection,
      draft_items_count: itemCounts.get(collection.id) || 0,
      ...(!isPublished && { has_published_version: publishedIds.has(collection.id) }),
    }));
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch collections: ${getErrorMessage(error)}`);
  }
}

/**
 * Get raw collection rows for a publish flag in a single Knex read.
 * Unlike getAllCollections, this skips item-count joins and published-version
 * lookups — intended for bulk publish flows that only need the base columns.
 * @param tenantId - Optional explicit tenant scope (required inside unstable_cache)
 */
export async function getCollectionsRaw(isPublished: boolean, tenantId?: string): Promise<Collection[]> {
  const knex = await getDb();

  try {
    let query = knex('collections')
      .select('*')
      .where('is_published', isPublished)
      .whereNull('deleted_at');

    if (tenantId) {
      query = query.where('tenant_id', tenantId);
    } else {
      query = await addTenantFilter(knex, query, 'collections');
    }

    return await query as Collection[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch collections: ${getErrorMessage(error)}`);
  }
}

/**
 * Batch-check which collection IDs have a published version.
 * Returns a Set of IDs that have is_published=true rows.
 */
export async function getPublishedCollectionIds(collectionIds: string[]): Promise<Set<string>> {
  if (collectionIds.length === 0) return new Set();

  const knex = await getDb();

  try {
    let query = knex('collections')
      .select('id')
      .whereIn('id', collectionIds)
      .andWhere('is_published', true)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collections');

    const data = await query as Array<{ id: string }>;
    return new Set(data.map((collection) => collection.id));
  } catch (error) {
    if (isMissingTableError(error)) return new Set();
    throw new Error(`Failed to check published collections: ${getErrorMessage(error)}`);
  }
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
  const knex = await getDb();

  try {
    let query = knex('collections')
      .select('*')
      .where('id', id)
      .andWhere('is_published', isPublished);

    if (!includeDeleted) {
      query = query.whereNull('deleted_at');
    }

    query = await addTenantFilter(knex, query, 'collections');
    return (await query.first()) as Collection | null ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch collection: ${getErrorMessage(error)}`);
  }
}

/**
 * Get collection by name
 * @param name - Collection name
 * @param isPublished - Get draft (false) or published (true) version. Defaults to false (draft).
 */
export async function getCollectionByName(name: string, isPublished: boolean = false): Promise<Collection | null> {
  const knex = await getDb();

  try {
    let query = knex('collections')
      .select('*')
      .where('name', name)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collections');

    return (await query.first()) as Collection | null ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch collection: ${getErrorMessage(error)}`);
  }
}

/**
 * Create a new collection (draft by default)
 */
export async function createCollection(collectionData: CreateCollectionData): Promise<Collection> {
  const knex = await getDb();
  const now = new Date().toISOString();
  const isPublished = collectionData.is_published ?? false;

  const row = await addTenantIdToRow({
    id: randomUUID(),
    ...collectionData,
    order: collectionData.order ?? 0,
    is_published: isPublished,
    created_at: now,
    updated_at: now,
  });

  try {
    const [data] = await knex('collections').insert(row).returning('*');
    return data as Collection;
  } catch (error) {
    throw new Error(`Failed to create collection: ${getErrorMessage(error)}`);
  }
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
  const knex = await getDb();

  try {
    let query = knex('collections')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collections');

    const [data] = await query
      .update({
        ...collectionData,
        updated_at: new Date().toISOString(),
      })
      .returning('*');

    if (!data) {
      throw new Error('Collection not found');
    }

    return data as Collection;
  } catch (error) {
    throw new Error(`Failed to update collection: ${getErrorMessage(error)}`);
  }
}

/**
 * Delete a collection (soft delete)
 * Also cascades soft delete to all related fields, items, and item values
 * @param id - Collection UUID
 * @param isPublished - Which version to delete: draft (false) or published (true). Defaults to false (draft).
 */
export async function deleteCollection(id: string, isPublished: boolean = false): Promise<void> {
  const knex = await getDb();
  const now = new Date().toISOString();

  try {
    let collectionQuery = knex('collections')
      .where('id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    collectionQuery = await addTenantFilter(knex, collectionQuery, 'collections');
    await collectionQuery.update({ deleted_at: now, updated_at: now });

    let fieldsQuery = knex('collection_fields')
      .where('collection_id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    fieldsQuery = await addTenantFilter(knex, fieldsQuery, 'collection_fields');
    await fieldsQuery.update({ deleted_at: now, updated_at: now });

    let itemsQuery = knex('collection_items')
      .select('id')
      .where('collection_id', id)
      .andWhere('is_published', isPublished);
    itemsQuery = await addTenantFilter(knex, itemsQuery, 'collection_items');
    const items = await itemsQuery as Array<{ id: string }>;
    const itemIds = items.map((item) => item.id);

    let softDeleteItemsQuery = knex('collection_items')
      .where('collection_id', id)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    softDeleteItemsQuery = await addTenantFilter(knex, softDeleteItemsQuery, 'collection_items');
    await softDeleteItemsQuery.update({ deleted_at: now, updated_at: now });

    if (itemIds.length > 0) {
      let valuesQuery = knex('collection_item_values')
        .whereIn('item_id', itemIds)
        .andWhere('is_published', isPublished)
        .whereNull('deleted_at');
      valuesQuery = await addTenantFilter(knex, valuesQuery, 'collection_item_values');
      await valuesQuery.update({ deleted_at: now, updated_at: now });
    }
  } catch (error) {
    throw new Error(`Failed to delete collection: ${getErrorMessage(error)}`);
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
  const knex = await getDb();

  try {
    let query = knex('collections')
      .where('id', id)
      .andWhere('is_published', isPublished);
    query = await addTenantFilter(knex, query, 'collections');
    await query.del();
  } catch (error) {
    throw new Error(`Failed to hard delete collection: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish a collection
 * Creates or updates the published version by copying the draft
 * Uses upsert with composite primary key for simplicity
 * @param id - Collection UUID
 */
export async function publishCollection(id: string): Promise<Collection> {
  const knex = await getDb();

  const draft = await getCollectionById(id, false);
  if (!draft) {
    throw new Error('Draft collection not found');
  }

  const now = new Date().toISOString();
  const row = await addTenantIdToRow({
    id: draft.id,
    name: draft.name,
    sorting: draft.sorting,
    order: draft.order,
    is_published: true,
    created_at: draft.created_at,
    updated_at: now,
  });

  const tenantId = (draft as CollectionWithTenant).tenant_id;
  if (tenantId) {
    row.tenant_id = tenantId;
  }

  try {
    const [data] = await knex('collections')
      .insert(row)
      .onConflict(['id', 'is_published'])
      .merge(['name', 'sorting', 'order', 'updated_at'])
      .returning('*');

    return data as Collection;
  } catch (error) {
    throw new Error(`Failed to publish collection: ${getErrorMessage(error)}`);
  }
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
  const knex = await getDb();
  const draftCollections = await getAllCollections({ is_published: false });

  if (draftCollections.length === 0) {
    return [];
  }

  try {
    const draftIds = draftCollections.map((collection) => collection.id);
    let query = knex('collections')
      .select('*')
      .whereIn('id', draftIds)
      .andWhere('is_published', true);
    query = await addTenantFilter(knex, query, 'collections');

    const publishedCollections = await query as Collection[];
    const publishedById = new Map<string, Collection>();
    publishedCollections.forEach((collection) => publishedById.set(collection.id, collection));

    return draftCollections.filter((draft) => {
      const published = publishedById.get(draft.id);
      if (!published) {
        return true;
      }
      return hasCollectionChanged(draft, published);
    });
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch published collections: ${getErrorMessage(error)}`);
  }
}

/**
 * Reorder collections
 * Updates the order field for multiple collections
 * @param isPublished - Whether to update draft (false) or published (true) collections
 * @param collectionIds - Array of collection IDs in the desired order
 */
export async function reorderCollections(isPublished: boolean, collectionIds: string[]): Promise<void> {
  if (collectionIds.length === 0) return;

  const knex = await getDb();
  const now = new Date().toISOString();
  const caseBindings = collectionIds.flatMap((id, index) => [id, index]);
  const caseExpression = knex.raw(
    `CASE ${collectionIds.map(() => 'WHEN id = ? THEN ?').join(' ')} ELSE "order" END`,
    caseBindings
  );

  try {
    let query = knex('collections')
      .whereIn('id', collectionIds)
      .andWhere('is_published', isPublished)
      .whereNull('deleted_at');
    query = await addTenantFilter(knex, query, 'collections');

    await query.update({
      order: caseExpression,
      updated_at: now,
    });
  } catch (error) {
    throw new Error(`Failed to reorder collections: ${getErrorMessage(error)}`);
  }
}
