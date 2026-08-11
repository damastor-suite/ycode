import type { Knex } from 'knex';

import { getDb, isMissingTableError } from '@/lib/platform/db';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { deleteTranslationsInBulk, markTranslationsIncomplete } from '@/lib/repositories/translationRepository';
import { generatePageLayersHash } from '@/lib/hash-utils';
import { extractLayerContentMap } from '@/lib/localisation-utils';
import type { Component, Layer, PageLayers } from '@/types';

type InsertRow = Record<string, unknown>;

type ComponentLayerRow = Pick<Component, 'id' | 'layers'>;

type CollectionFieldRow = {
  id: string;
  collection_id: string;
};

type CollectionValueRow = {
  field_id: string;
  value: unknown;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function applyTenantFilter(
  knex: Knex,
  query: Knex.QueryBuilder,
  tableName: string
): Promise<Knex.QueryBuilder> {
  return addTenantFilter(knex, query, tableName);
}

async function withTenantOnInsert<T extends InsertRow>(row: T): Promise<T> {
  const tenantId = await getTenantIdFromHeaders();
  if (!tenantId) return row;
  return { ...row, tenant_id: tenantId } as T;
}

async function withTenantOnInsertMany<T extends InsertRow>(rows: T[]): Promise<T[]> {
  const tenantId = await getTenantIdFromHeaders();
  if (!tenantId) return rows;
  return rows.map(row => ({ ...row, tenant_id: tenantId }) as T);
}

async function getLatestLayerRow(
  knex: Knex,
  pageId: string,
  isPublished?: boolean
): Promise<PageLayers | null> {
  let query = knex('page_layers')
    .select('*')
    .where('page_id', pageId)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc')
    .limit(1);

  if (isPublished !== undefined) {
    query.where('is_published', isPublished);
  }

  query = await applyTenantFilter(knex, query, 'page_layers');
  return (await query.first() as PageLayers | undefined) ?? null;
}

/**
 * Get layers by page_id with optional is_published filter
 */
export async function getLayersByPageId(
  pageId: string,
  isPublished?: boolean
): Promise<PageLayers | null> {
  const knex = await getDb();

  try {
    return await getLatestLayerRow(knex, pageId, isPublished);
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch layers: ${getErrorMessage(error)}`);
  }
}

/**
 * Get draft layers for a page
 */
export async function getDraftLayers(pageId: string): Promise<PageLayers | null> {
  const knex = await getDb();

  try {
    return await getLatestLayerRow(knex, pageId, false);
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch draft: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published layers for a page
 */
export async function getPublishedLayers(pageId: string): Promise<PageLayers | null> {
  const knex = await getDb();

  try {
    return await getLatestLayerRow(knex, pageId, true);
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch published layers: ${getErrorMessage(error)}`);
  }
}

/**
 * Create or update draft layers
 */
export async function upsertDraftLayers(
  pageId: string,
  layers: Layer[],
  additionalData?: Record<string, any>,
  existingDraft?: PageLayers | null,
): Promise<PageLayers> {
  const knex = await getDb();

  const resolvedDraft = existingDraft !== undefined
    ? existingDraft
    : await getDraftLayers(pageId);

  if (resolvedDraft && resolvedDraft.layers) {
    const oldContentMap = extractLayerContentMap(resolvedDraft.layers, 'page', pageId);
    const newContentMap = extractLayerContentMap(layers, 'page', pageId);
    const removedKeys = Object.keys(oldContentMap).filter(key => !(key in newContentMap));
    const changedKeys = Object.keys(newContentMap).filter(
      key => key in oldContentMap && oldContentMap[key] !== newContentMap[key]
    );

    if (removedKeys.length > 0) {
      await deleteTranslationsInBulk('page', pageId, removedKeys);
    }
    if (changedKeys.length > 0) {
      await markTranslationsIncomplete('page', pageId, changedKeys);
    }
  }

  const cssForHash = additionalData?.generated_css !== undefined
    ? (additionalData.generated_css as string) || null
    : resolvedDraft?.generated_css || null;

  const contentHash = generatePageLayersHash({
    layers,
    generated_css: cssForHash,
  });

  const updateData: Record<string, unknown> = {
    layers,
    content_hash: contentHash,
    updated_at: new Date().toISOString(),
  };

  if (additionalData) {
    Object.assign(updateData, additionalData);
  }

  try {
    if (resolvedDraft) {
      let query = knex('page_layers')
        .where('id', resolvedDraft.id)
        .where('is_published', false);
      query = await applyTenantFilter(knex, query, 'page_layers');
      const rows = await query.update(updateData).returning('*') as PageLayers[];
      const data = rows[0];
      if (!data) throw new Error('Draft not found');
      return data;
    }

    const insertData = await withTenantOnInsert({
      page_id: pageId,
      layers,
      content_hash: contentHash,
      is_published: false,
      ...(additionalData || {}),
    });
    const rows = await knex('page_layers').insert(insertData).returning('*') as PageLayers[];
    const data = rows[0];
    if (!data) throw new Error('No draft returned');
    return data;
  } catch (error) {
    throw new Error(`${resolvedDraft ? 'Failed to update draft' : 'Failed to create draft'}: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all draft layers (non-published)
 */
export async function getAllDraftLayers(): Promise<PageLayers[]> {
  const knex = await getDb();

  try {
    let query = knex('page_layers')
      .select('*')
      .where('is_published', false)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    query = await applyTenantFilter(knex, query, 'page_layers');
    return await query as PageLayers[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch draft layers: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all draft layers for multiple pages
 */
export async function getDraftLayersForPages(pageIds: string[]): Promise<PageLayers[]> {
  if (pageIds.length === 0) {
    return [];
  }

  const knex = await getDb();

  try {
    let query = knex('page_layers')
      .select('*')
      .whereIn('page_id', pageIds)
      .where('is_published', false)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    query = await applyTenantFilter(knex, query, 'page_layers');
    return await query as PageLayers[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch draft layers: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published layers by IDs
 */
export async function getPublishedLayersByIds(ids: string[]): Promise<PageLayers[]> {
  if (ids.length === 0) {
    return [];
  }

  const knex = await getDb();

  try {
    let query = knex('page_layers')
      .select('*')
      .whereIn('id', ids)
      .where('is_published', true)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_layers');
    return await query as PageLayers[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch published layers: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published layers by ID
 */
export async function getPublishedLayersById(id: string): Promise<PageLayers | null> {
  const knex = await getDb();

  try {
    let query = knex('page_layers')
      .select('*')
      .where('id', id)
      .where('is_published', true)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'page_layers');
    return (await query.first() as PageLayers | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch published layers: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish page layers
 */
export async function publishPageLayers(draftPageId: string, publishedPageId: string): Promise<PageLayers> {
  const knex = await getDb();
  const draftLayers = await getDraftLayers(draftPageId);

  if (!draftLayers) {
    throw new Error('No draft layers found to publish');
  }

  const existingPublished = await getPublishedLayersById(draftLayers.id);

  try {
    if (existingPublished) {
      const hasChanges = existingPublished.content_hash !== draftLayers.content_hash;

      if (hasChanges) {
        let query = knex('page_layers')
          .where('id', existingPublished.id)
          .where('is_published', true);
        query = await applyTenantFilter(knex, query, 'page_layers');
        const rows = await query.update({
          page_id: publishedPageId,
          layers: draftLayers.layers,
          generated_css: draftLayers.generated_css || null,
          content_hash: draftLayers.content_hash,
          updated_at: new Date().toISOString(),
        }).returning('*') as PageLayers[];
        const data = rows[0];
        if (!data) throw new Error('Published layers not found');
        return data;
      }

      return existingPublished;
    }

    const insertData = await withTenantOnInsert({
      id: draftLayers.id,
      page_id: publishedPageId,
      layers: draftLayers.layers,
      generated_css: draftLayers.generated_css || null,
      content_hash: draftLayers.content_hash,
      is_published: true,
    });
    const rows = await knex('page_layers').insert(insertData).returning('*') as PageLayers[];
    const data = rows[0];
    if (!data) throw new Error('No published layers returned');
    return data;
  } catch (error) {
    throw new Error(`${existingPublished ? 'Failed to update published layers' : 'Failed to create published layers'}: ${getErrorMessage(error)}`);
  }
}

/**
 * Batch publish page layers for multiple pages
 */
export async function batchPublishPageLayers(
  pageIds: string[],
  options: { force?: boolean } = {},
): Promise<{ count: number; changedPageIds: string[] }> {
  if (pageIds.length === 0) {
    return { count: 0, changedPageIds: [] };
  }

  const knex = await getDb();
  let pageIdsToPublish: string[];

  if (options.force) {
    pageIdsToPublish = pageIds;
  } else {
    let draftQuery = knex('page_layers')
      .select('id', 'page_id', 'content_hash')
      .whereIn('page_id', pageIds)
      .where('is_published', false)
      .whereNull('deleted_at');
    draftQuery = await applyTenantFilter(knex, draftQuery, 'page_layers');
    const draftHashes = await draftQuery as Array<{ id: string; page_id: string; content_hash: string | null }>;

    let publishedQuery = knex('page_layers')
      .select('id', 'content_hash')
      .whereIn('page_id', pageIds)
      .where('is_published', true)
      .whereNull('deleted_at');
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'page_layers');
    const publishedHashes = await publishedQuery as Array<{ id: string; content_hash: string | null }>;

    const publishedHashById = new Map<string, string | null>(
      publishedHashes.map(r => [r.id, r.content_hash]),
    );

    pageIdsToPublish = draftHashes
      .filter(d => {
        const pubHash = publishedHashById.get(d.id);
        return pubHash === undefined || pubHash !== d.content_hash;
      })
      .map(d => d.page_id);

    if (pageIdsToPublish.length === 0) {
      return { count: 0, changedPageIds: [] };
    }
  }

  const draftLayers = await getDraftLayersForPages(pageIdsToPublish);

  if (draftLayers.length === 0) {
    return { count: 0, changedPageIds: [] };
  }

  const now = new Date().toISOString();
  const rows = await withTenantOnInsertMany(draftLayers.map(draft => ({
    id: draft.id,
    page_id: draft.page_id,
    layers: draft.layers,
    generated_css: draft.generated_css || null,
    content_hash: draft.content_hash,
    is_published: true,
    updated_at: now,
  })));

  try {
    await knex('page_layers')
      .insert(rows)
      .onConflict(['id', 'is_published'])
      .merge();
  } catch (error) {
    throw new Error(`Failed to batch publish layers: ${getErrorMessage(error)}`);
  }

  return {
    count: rows.length,
    changedPageIds: [...new Set(rows.map(l => l.page_id as string))],
  };
}

/**
 * Get all layers entries for a page (for history)
 */
export async function getPageLayers(pageId: string): Promise<PageLayers[]> {
  const knex = await getDb();

  try {
    let query = knex('page_layers')
      .select('*')
      .where('page_id', pageId)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    query = await applyTenantFilter(knex, query, 'page_layers');
    return await query as PageLayers[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch layers: ${getErrorMessage(error)}`);
  }
}

export interface AffectedPagesByResource {
  componentPageIds: string[];
  stylePageIds: string[];
  collectionPageIds: string[];
}

/**
 * Expand changed component/style IDs through the components table.
 */
async function expandThroughComponents(
  knex: Knex,
  componentIds: string[],
  styleIds: string[],
): Promise<string[]> {
  if (componentIds.length === 0 && styleIds.length === 0) return [];

  let query = knex('components')
    .select('id', 'layers')
    .where('is_published', false)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'components');
  const allComponents = await query as ComponentLayerRow[];

  if (allComponents.length === 0) return [];

  const componentTexts = allComponents.map(c => ({
    id: c.id,
    text: c.layers ? JSON.stringify(c.layers) : '',
  }));

  const expanded = new Set<string>();

  for (const sid of styleIds) {
    for (const comp of componentTexts) {
      if (comp.text.includes(sid)) {
        expanded.add(comp.id);
      }
    }
  }

  const frontier = new Set([...componentIds, ...expanded]);
  const visited = new Set(frontier);

  while (frontier.size > 0) {
    const nextFrontier = new Set<string>();

    for (const cid of frontier) {
      for (const comp of componentTexts) {
        if (comp.id === cid) continue;
        if (expanded.has(comp.id) && visited.has(comp.id)) continue;
        if (comp.text.includes(cid)) {
          expanded.add(comp.id);
          if (!visited.has(comp.id)) {
            visited.add(comp.id);
            nextFrontier.add(comp.id);
          }
        }
      }
    }

    frontier.clear();
    for (const id of nextFrontier) frontier.add(id);
  }

  return Array.from(expanded);
}

/**
 * Find components that render any of the given collections.
 */
async function findComponentsEmbeddingCollections(
  knex: Knex,
  collectionIds: string[],
): Promise<string[]> {
  if (collectionIds.length === 0) return [];

  let query = knex('components')
    .select('id', 'layers')
    .where('is_published', false)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'components');
  const allComponents = await query as ComponentLayerRow[];

  if (allComponents.length === 0) return [];

  const directIds: string[] = [];
  for (const comp of allComponents) {
    if (!comp.layers) continue;
    const text = JSON.stringify(comp.layers);
    for (const id of collectionIds) {
      if (text.includes(id)) { directIds.push(comp.id); break; }
    }
  }

  if (directIds.length === 0) return [];

  const transitive = await expandThroughComponents(knex, directIds, []);
  return [...new Set([...directIds, ...transitive])];
}

/**
 * Find pages affected by changed components, layer styles, and collections.
 */
export async function findAffectedPages(
  componentIds: string[],
  styleIds: string[],
  collectionIds: string[],
): Promise<AffectedPagesByResource> {
  const result: AffectedPagesByResource = {
    componentPageIds: [],
    stylePageIds: [],
    collectionPageIds: [],
  };

  const hasComponents = componentIds.length > 0;
  const hasStyles = styleIds.length > 0;
  const hasCollections = collectionIds.length > 0;

  if (!hasComponents && !hasStyles && !hasCollections) return result;

  const knex = await getDb();

  const expandedComponentIds = (hasComponents || hasStyles)
    ? await expandThroughComponents(knex, componentIds, styleIds)
    : [];
  const allComponentIds = [...new Set([...componentIds, ...expandedComponentIds])];
  const hasExpandedComponents = allComponentIds.length > 0;

  const collectionEmbeddingComponentIds = hasCollections
    ? await findComponentsEmbeddingCollections(knex, collectionIds)
    : [];
  const collectionMatchIds = new Set([...collectionIds, ...collectionEmbeddingComponentIds]);

  let layersQuery = knex('page_layers')
    .select('page_id', 'layers')
    .where('is_published', false)
    .whereNull('deleted_at');
  layersQuery = await applyTenantFilter(knex, layersQuery, 'page_layers');
  const allLayers = await layersQuery as Array<{ page_id: string; layers: Layer[] | null }>;

  const componentSet = new Set(allComponentIds);
  const styleSet = new Set(styleIds);
  const componentPages = new Set<string>();
  const stylePages = new Set<string>();
  const collectionPages = new Set<string>();

  for (const row of allLayers) {
    if (!row.layers) continue;
    const text = JSON.stringify(row.layers);

    if (hasExpandedComponents && !componentPages.has(row.page_id)) {
      for (const id of componentSet) {
        if (text.includes(id)) { componentPages.add(row.page_id); break; }
      }
    }
    if (hasStyles && !stylePages.has(row.page_id)) {
      for (const id of styleSet) {
        if (text.includes(id)) { stylePages.add(row.page_id); break; }
      }
    }
    if (hasCollections && !collectionPages.has(row.page_id)) {
      for (const id of collectionMatchIds) {
        if (text.includes(id)) { collectionPages.add(row.page_id); break; }
      }
    }
  }

  result.componentPageIds = Array.from(componentPages);
  result.stylePageIds = Array.from(stylePages);
  result.collectionPageIds = Array.from(collectionPages);

  if (hasCollections) {
    let pagesQuery = knex('pages')
      .select('id', 'settings')
      .where('is_published', false)
      .whereNull('deleted_at');
    pagesQuery = await applyTenantFilter(knex, pagesQuery, 'pages');
    const allPages = await pagesQuery as Array<{ id: string; settings: unknown }>;

    const collectionPageSet = new Set(result.collectionPageIds);
    for (const page of allPages) {
      if (!page.settings || collectionPageSet.has(page.id)) continue;
      const text = JSON.stringify(page.settings);
      for (const id of collectionIds) {
        if (text.includes(id)) { collectionPageSet.add(page.id); break; }
      }
    }
    result.collectionPageIds = Array.from(collectionPageSet);
  }

  return result;
}

/**
 * Find collections whose PUBLISHED rich-text field values embed components.
 */
export async function findCollectionsEmbeddingComponents(
  componentIds: string[],
): Promise<string[]> {
  if (componentIds.length === 0) return [];

  const knex = await getDb();

  let fieldsQuery = knex('collection_fields')
    .select('id', 'collection_id')
    .where('type', 'rich_text')
    .where('is_published', true)
    .whereNull('deleted_at');
  fieldsQuery = await applyTenantFilter(knex, fieldsQuery, 'collection_fields');
  const richTextFields = await fieldsQuery as CollectionFieldRow[];

  if (richTextFields.length === 0) return [];

  const fieldToCollection = new Map<string, string>();
  for (const f of richTextFields) {
    fieldToCollection.set(f.id, f.collection_id);
  }
  const fieldIds = Array.from(fieldToCollection.keys());

  const expanded = await expandThroughComponents(knex, componentIds, []);
  const allComponentIds = [...new Set([...componentIds, ...expanded])];

  const { chunk } = await import('@/lib/utils');
  const collectionIds = new Set<string>();

  for (const idChunk of chunk(fieldIds, 500)) {
    let valuesQuery = knex('collection_item_values')
      .select('field_id', 'value')
      .where('is_published', true)
      .whereNull('deleted_at')
      .whereIn('field_id', idChunk);
    valuesQuery = await applyTenantFilter(knex, valuesQuery, 'collection_item_values');
    const values = await valuesQuery as CollectionValueRow[];

    for (const row of values) {
      if (!row.value) continue;
      const collectionId = fieldToCollection.get(row.field_id);
      if (!collectionId || collectionIds.has(collectionId)) continue;
      const text = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      if (!text.includes('richTextComponent')) continue;
      for (const id of allComponentIds) {
        if (text.includes(id)) { collectionIds.add(collectionId); break; }
      }
    }
  }

  return Array.from(collectionIds);
}

/** Parse a rich-text field value into a Tiptap node, tolerating JSON strings. */
function parseTiptapValue(value: unknown): unknown {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/** Recursively collect `richTextComponent` component IDs from a Tiptap node. */
function collectEmbeddedComponentIds(node: unknown, ids: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: string; attrs?: { componentId?: string }; content?: unknown[] };
  if (n.type === 'richTextComponent' && n.attrs?.componentId) {
    ids.add(n.attrs.componentId);
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) collectEmbeddedComponentIds(child, ids);
  }
}

/**
 * Map collections to the component IDs embedded in their rich-text field VALUES.
 */
export async function getEmbeddedComponentIdsForCollections(
  collectionIds: string[],
  isPublished: boolean = false,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (collectionIds.length === 0) return result;

  let knex: Knex;
  try {
    knex = await getDb();
  } catch {
    return result;
  }

  let fieldsQuery = knex('collection_fields')
    .select('id', 'collection_id')
    .where('type', 'rich_text')
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .whereIn('collection_id', collectionIds);
  fieldsQuery = await applyTenantFilter(knex, fieldsQuery, 'collection_fields');
  const richTextFields = await fieldsQuery as CollectionFieldRow[];

  if (richTextFields.length === 0) return result;

  const fieldToCollection = new Map<string, string>();
  for (const f of richTextFields) {
    fieldToCollection.set(f.id, f.collection_id);
  }
  const fieldIds = Array.from(fieldToCollection.keys());

  const { chunk } = await import('@/lib/utils');

  for (const idChunk of chunk(fieldIds, 500)) {
    let valuesQuery = knex('collection_item_values')
      .select('field_id', 'value')
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .whereIn('field_id', idChunk);
    valuesQuery = await applyTenantFilter(knex, valuesQuery, 'collection_item_values');
    const values = await valuesQuery as CollectionValueRow[];

    for (const row of values) {
      if (!row.value) continue;
      const collectionId = fieldToCollection.get(row.field_id);
      if (!collectionId) continue;
      const text = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      if (!text.includes('richTextComponent')) continue;
      const parsed = parseTiptapValue(row.value);
      if (!parsed) continue;
      const ids = result.get(collectionId) ?? new Set<string>();
      collectEmbeddedComponentIds(parsed, ids);
      if (ids.size > 0) result.set(collectionId, ids);
    }
  }

  return result;
}
