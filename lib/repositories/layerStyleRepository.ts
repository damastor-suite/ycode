/**
 * Layer Style Repository
 *
 * Data access layer for layer styles using Knex
 */

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';

import { getDb, isMissingTableError } from '@/lib/platform/db';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { detachStyleFromLayers, getStyleIds, updateLayersWithStyle } from '@/lib/layer-style-utils';
import {
  generateComponentContentHash,
  generateLayerStyleContentHash,
  generatePageLayersHash,
} from '@/lib/hash-utils';
import type { Component, ComponentVariant, Layer, LayerStyle } from '@/types';

/**
 * Input data for creating a new layer style
 */
export interface CreateLayerStyleData {
  name: string;
  classes: string;
  design?: LayerStyle['design'];
  group?: string;
}

/**
 * Affected entity when deleting a layer style
 */
export interface LayerStyleAffectedEntity {
  type: 'page' | 'component';
  id: string;
  name: string;
  pageId?: string; // For pages, this is the page.id (not page_layers.id)
  previousLayers: Layer[];
  newLayers: Layer[];
  previousVariants?: ComponentVariant[];
  newVariants?: ComponentVariant[];
}

/**
 * Result of soft delete operation
 */
export interface LayerStyleSoftDeleteResult {
  layerStyle: LayerStyle;
  affectedEntities: LayerStyleAffectedEntity[];
}

type InsertRow = Record<string, unknown>;

type PageLayerStyleRow = {
  id: string;
  page_id: string;
  layers: Layer[] | null;
  generated_css?: string | null;
  content_hash?: string | null;
};

type ComponentStyleRow = Pick<Component, 'id' | 'name' | 'layers' | 'variants' | 'variables' | 'content_hash'>;

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

/**
 * Get all layer styles (draft by default, excludes soft deleted)
 */
export async function getAllStyles(isPublished: boolean = false): Promise<LayerStyle[]> {
  const knex = await getDb();

  try {
    let query = knex('layer_styles')
      .select('*')
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    query = await applyTenantFilter(knex, query, 'layer_styles');
    return await query as LayerStyle[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch layer styles: ${getErrorMessage(error)}`);
  }
}

/**
 * Get a single layer style by ID (draft by default, excludes soft deleted)
 */
export async function getStyleById(id: string, isPublished: boolean = false): Promise<LayerStyle | null> {
  const knex = await getDb();

  try {
    let query = knex('layer_styles')
      .select('*')
      .where('id', id)
      .where('is_published', isPublished)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'layer_styles');
    return (await query.first() as LayerStyle | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Get a layer style by ID including soft deleted (for restoration)
 */
export async function getStyleByIdIncludingDeleted(id: string, isPublished: boolean = false): Promise<LayerStyle | null> {
  const knex = await getDb();

  try {
    let query = knex('layer_styles')
      .select('*')
      .where('id', id)
      .where('is_published', isPublished);
    query = await applyTenantFilter(knex, query, 'layer_styles');
    return (await query.first() as LayerStyle | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Create a new layer style (draft by default)
 */
export async function createStyle(
  styleData: CreateLayerStyleData
): Promise<LayerStyle> {
  const knex = await getDb();
  const contentHash = generateLayerStyleContentHash({
    name: styleData.name,
    classes: styleData.classes,
    design: styleData.design,
  });

  try {
    const rows = await knex('layer_styles')
      .insert(await withTenantOnInsert({
        name: styleData.name,
        classes: styleData.classes,
        design: styleData.design,
        group: styleData.group,
        content_hash: contentHash,
        is_published: false,
      }))
      .returning('*') as LayerStyle[];
    const data = rows[0];
    if (!data) throw new Error('No layer style returned');
    return data;
  } catch (error) {
    throw new Error(`Failed to create layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Create many layer styles in a single round-trip (draft versions).
 */
export async function createStyles(
  stylesData: CreateLayerStyleData[]
): Promise<LayerStyle[]> {
  if (stylesData.length === 0) {
    return [];
  }

  const knex = await getDb();
  const rows = await withTenantOnInsertMany(stylesData.map(styleData => ({
    id: randomUUID(),
    name: styleData.name,
    classes: styleData.classes,
    design: styleData.design,
    group: styleData.group,
    content_hash: generateLayerStyleContentHash({
      name: styleData.name,
      classes: styleData.classes,
      design: styleData.design,
    }),
    is_published: false,
  })));

  try {
    const data = await knex('layer_styles').insert(rows).returning('*') as LayerStyle[];
    const byId = new Map<string, LayerStyle>(data.map(d => [d.id, d]));
    return rows
      .map(r => byId.get(r.id as string))
      .filter((s): s is LayerStyle => Boolean(s));
  } catch (error) {
    throw new Error(`Failed to create layer styles: ${getErrorMessage(error)}`);
  }
}

/**
 * Update a layer style and recalculate content hash
 */
export async function updateStyle(
  id: string,
  updates: Partial<Pick<LayerStyle, 'name' | 'classes' | 'design'>>
): Promise<LayerStyle> {
  const knex = await getDb();

  const current = await getStyleById(id);
  if (!current) {
    throw new Error('Layer style not found');
  }

  const finalData = {
    name: updates.name !== undefined ? updates.name : current.name,
    classes: updates.classes !== undefined ? updates.classes : current.classes,
    design: updates.design !== undefined ? updates.design : current.design,
  };

  const contentHash = generateLayerStyleContentHash(finalData);

  try {
    let query = knex('layer_styles')
      .where('id', id)
      .where('is_published', false)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'layer_styles');
    const rows = await query.update({
      ...updates,
      content_hash: contentHash,
      updated_at: new Date().toISOString(),
    }).returning('*') as LayerStyle[];
    const data = rows[0];
    if (!data) throw new Error('Layer style not found');
    return data;
  } catch (error) {
    throw new Error(`Failed to update layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published layer style by ID
 */
export async function getPublishedStyleById(id: string): Promise<LayerStyle | null> {
  const knex = await getDb();

  try {
    let query = knex('layer_styles')
      .select('*')
      .where('id', id)
      .where('is_published', true);
    query = await applyTenantFilter(knex, query, 'layer_styles');
    return (await query.first() as LayerStyle | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch published layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish a layer style (dual-record pattern like pages and components)
 */
export async function publishLayerStyle(draftStyleId: string): Promise<LayerStyle> {
  const knex = await getDb();

  const draftStyle = await getStyleById(draftStyleId);
  if (!draftStyle) {
    throw new Error('Draft layer style not found');
  }

  try {
    const rows = await knex('layer_styles')
      .insert(await withTenantOnInsert({
        id: draftStyle.id,
        name: draftStyle.name,
        classes: draftStyle.classes,
        design: draftStyle.design,
        group: draftStyle.group,
        content_hash: draftStyle.content_hash,
        is_published: true,
        updated_at: new Date().toISOString(),
      }))
      .onConflict(['id', 'is_published'])
      .merge()
      .returning('*') as LayerStyle[];
    const data = rows[0];
    if (!data) throw new Error('No layer style returned');
    return data;
  } catch (error) {
    throw new Error(`Failed to publish layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish multiple layer styles in batch
 */
export async function publishLayerStyles(styleIds: string[]): Promise<{ count: number; changedStyleIds: string[] }> {
  if (styleIds.length === 0) {
    return { count: 0, changedStyleIds: [] };
  }

  const knex = await getDb();

  let draftQuery = knex('layer_styles')
    .select('*')
    .whereIn('id', styleIds)
    .where('is_published', false)
    .whereNull('deleted_at');
  draftQuery = await applyTenantFilter(knex, draftQuery, 'layer_styles');
  const draftStyles = await draftQuery as LayerStyle[];

  if (draftStyles.length === 0) {
    return { count: 0, changedStyleIds: [] };
  }

  let publishedQuery = knex('layer_styles')
    .select('id', 'content_hash')
    .whereIn('id', draftStyles.map(d => d.id))
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'layer_styles');
  const publishedStyles = await publishedQuery as Array<{ id: string; content_hash: string | null }>;

  const publishedHashById = new Map<string, string>();
  for (const pub of publishedStyles) {
    if (pub.content_hash) publishedHashById.set(pub.id, pub.content_hash);
  }

  const stylesToUpsert = await withTenantOnInsertMany(draftStyles
    .filter(draft => {
      const pubHash = publishedHashById.get(draft.id);
      return !pubHash || pubHash !== draft.content_hash;
    })
    .map(draft => ({
      id: draft.id,
      name: draft.name,
      classes: draft.classes,
      design: draft.design,
      group: draft.group,
      content_hash: draft.content_hash,
      is_published: true,
      updated_at: new Date().toISOString(),
    })));

  if (stylesToUpsert.length > 0) {
    try {
      await knex('layer_styles')
        .insert(stylesToUpsert)
        .onConflict(['id', 'is_published'])
        .merge();
    } catch (error) {
      throw new Error(`Failed to publish layer styles: ${getErrorMessage(error)}`);
    }
  }

  return {
    count: stylesToUpsert.length,
    changedStyleIds: stylesToUpsert.map(s => s.id as string),
  };
}

/**
 * Get all unpublished layer styles
 */
export async function getUnpublishedLayerStyles(): Promise<LayerStyle[]> {
  const knex = await getDb();

  let draftQuery = knex('layer_styles')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc');
  draftQuery = await applyTenantFilter(knex, draftQuery, 'layer_styles');
  const draftStyles = await draftQuery as LayerStyle[];

  if (draftStyles.length === 0) {
    return [];
  }

  const draftIds = draftStyles.map(s => s.id);
  let publishedQuery = knex('layer_styles')
    .select('*')
    .whereIn('id', draftIds)
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'layer_styles');
  const publishedStyles = await publishedQuery as LayerStyle[];

  const publishedById = new Map<string, LayerStyle>();
  publishedStyles.forEach(s => publishedById.set(s.id, s));

  const unpublishedStyles: LayerStyle[] = [];

  for (const draftStyle of draftStyles) {
    const publishedStyle = publishedById.get(draftStyle.id);

    if (!publishedStyle) {
      unpublishedStyles.push(draftStyle);
      continue;
    }

    if (draftStyle.content_hash !== publishedStyle.content_hash) {
      unpublishedStyles.push(draftStyle);
    }
  }

  return unpublishedStyles;
}

/**
 * Hard-delete soft-deleted draft layer styles and their published counterparts.
 */
export async function hardDeleteSoftDeletedLayerStyles(): Promise<{ count: number }> {
  const knex = await getDb();

  try {
    let deletedQuery = knex('layer_styles')
      .select('id')
      .where('is_published', false)
      .whereNotNull('deleted_at');
    deletedQuery = await applyTenantFilter(knex, deletedQuery, 'layer_styles');
    const deletedDrafts = await deletedQuery as Array<{ id: string }>;

    if (deletedDrafts.length === 0) {
      return { count: 0 };
    }

    const ids = deletedDrafts.map(s => s.id);

    try {
      let pubQuery = knex('layer_styles')
        .whereIn('id', ids)
        .where('is_published', true);
      pubQuery = await applyTenantFilter(knex, pubQuery, 'layer_styles');
      await pubQuery.delete();
    } catch (pubError) {
      console.error('Failed to delete published layer styles:', pubError);
    }

    let draftQuery = knex('layer_styles')
      .whereIn('id', ids)
      .where('is_published', false)
      .whereNotNull('deleted_at');
    draftQuery = await applyTenantFilter(knex, draftQuery, 'layer_styles');
    await draftQuery.delete();

    return { count: deletedDrafts.length };
  } catch (error) {
    throw new Error(`Failed to delete draft layer styles: ${getErrorMessage(error)}`);
  }
}

/**
 * Get count of unpublished layer styles
 */
export async function getUnpublishedLayerStylesCount(): Promise<number> {
  const styles = await getUnpublishedLayerStyles();
  return styles.length;
}

/**
 * Check if layers contain a reference to a specific layer style
 */
function layersContainStyle(layers: Layer[], styleId: string): boolean {
  for (const layer of layers) {
    if (getStyleIds(layer).includes(styleId)) {
      return true;
    }
    if (layer.children && layersContainStyle(layer.children, styleId)) {
      return true;
    }
  }
  return false;
}

/**
 * Find all entities (pages and components) using a layer style
 */
export async function findEntitiesUsingLayerStyle(styleId: string): Promise<LayerStyleAffectedEntity[]> {
  const knex = await getDb();
  const affectedEntities: LayerStyleAffectedEntity[] = [];

  let stylesQuery = knex('layer_styles')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at');
  stylesQuery = await applyTenantFilter(knex, stylesQuery, 'layer_styles');
  const allDraftStyles = await stylesQuery as LayerStyle[];
  const stylesById = new Map<string, LayerStyle>(allDraftStyles.map(s => [s.id, s]));

  let pageLayersQuery = knex('page_layers')
    .select('id', 'page_id', 'layers')
    .where('is_published', false)
    .whereNull('deleted_at');
  pageLayersQuery = await applyTenantFilter(knex, pageLayersQuery, 'page_layers');
  const pageLayersRecords = await pageLayersQuery as PageLayerStyleRow[];

  const affectedPageLayerIds = pageLayersRecords
    .filter(record => layersContainStyle(record.layers || [], styleId))
    .map(record => record.page_id);

  if (affectedPageLayerIds.length > 0) {
    let pagesQuery = knex('pages')
      .select('id', 'name')
      .whereIn('id', affectedPageLayerIds)
      .where('is_published', false)
      .whereNull('deleted_at');
    pagesQuery = await applyTenantFilter(knex, pagesQuery, 'pages');
    const pages = await pagesQuery as Array<{ id: string; name: string }>;
    const pageMap = new Map(pages.map(p => [p.id, p.name]));

    for (const record of pageLayersRecords) {
      if (layersContainStyle(record.layers || [], styleId)) {
        const newLayers = detachStyleFromLayers(record.layers || [], styleId, stylesById);
        affectedEntities.push({
          type: 'page',
          id: record.id,
          name: pageMap.get(record.page_id) || 'Unknown Page',
          pageId: record.page_id,
          previousLayers: record.layers || [],
          newLayers,
        });
      }
    }
  }

  let componentQuery = knex('components')
    .select('id', 'name', 'layers', 'variants')
    .where('is_published', false)
    .whereNull('deleted_at');
  componentQuery = await applyTenantFilter(knex, componentQuery, 'components');
  const componentRecords = await componentQuery as Array<Pick<Component, 'id' | 'name' | 'layers' | 'variants'>>;

  for (const record of componentRecords) {
    const variants = record.variants as ComponentVariant[] | undefined;
    const primaryLayers = record.layers || [];

    const hasStyleInPrimary = layersContainStyle(primaryLayers, styleId);
    const hasStyleInVariants = Array.isArray(variants) && variants.some(v => layersContainStyle(v.layers ?? [], styleId));

    if (hasStyleInPrimary || hasStyleInVariants) {
      const newLayers = detachStyleFromLayers(primaryLayers, styleId, stylesById);
      let newVariants: ComponentVariant[] | undefined;
      if (Array.isArray(variants) && variants.length > 0) {
        newVariants = variants.map((v, i) => ({
          ...v,
          layers: i === 0 ? newLayers : detachStyleFromLayers(v.layers ?? [], styleId, stylesById),
        }));
      }
      affectedEntities.push({
        type: 'component',
        id: record.id,
        name: record.name,
        previousLayers: primaryLayers,
        newLayers,
        previousVariants: variants || undefined,
        newVariants,
      });
    }
  }

  return affectedEntities;
}

/**
 * Soft delete a layer style and detach it from all layers
 */
export async function softDeleteStyle(id: string): Promise<LayerStyleSoftDeleteResult> {
  const knex = await getDb();

  const layerStyle = await getStyleById(id, false);
  if (!layerStyle) {
    throw new Error('Layer style not found');
  }

  const affectedEntities = await findEntitiesUsingLayerStyle(id);

  for (const entity of affectedEntities) {
    if (entity.type === 'page') {
      let existingQuery = knex('page_layers')
        .select('generated_css')
        .where('id', entity.id)
        .where('is_published', false);
      existingQuery = await applyTenantFilter(knex, existingQuery, 'page_layers');
      const existing = await existingQuery.first() as { generated_css?: string | null } | undefined;

      const contentHash = generatePageLayersHash({
        layers: entity.newLayers,
        generated_css: existing?.generated_css || null,
      });

      try {
        let updateQuery = knex('page_layers')
          .where('id', entity.id)
          .where('is_published', false);
        updateQuery = await applyTenantFilter(knex, updateQuery, 'page_layers');
        await updateQuery.update({
          layers: entity.newLayers,
          content_hash: contentHash,
          updated_at: new Date().toISOString(),
        });
      } catch (updateError) {
        console.error(`Failed to update page_layers ${entity.id}:`, updateError);
      }
    } else if (entity.type === 'component') {
      const contentHash = generateComponentContentHash({
        name: entity.name,
        layers: entity.newLayers,
        variables: undefined,
        variants: entity.newVariants,
      });

      try {
        let updateQuery = knex('components')
          .where('id', entity.id)
          .where('is_published', false);
        updateQuery = await applyTenantFilter(knex, updateQuery, 'components');
        await updateQuery.update({
          layers: entity.newLayers,
          ...(entity.newVariants ? { variants: entity.newVariants } : {}),
          content_hash: contentHash,
          updated_at: new Date().toISOString(),
        });
      } catch (updateError) {
        console.error(`Failed to update component ${entity.id}:`, updateError);
      }
    }
  }

  const deletedAt = new Date().toISOString();
  try {
    let deleteQuery = knex('layer_styles').where('id', id);
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'layer_styles');
    await deleteQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });
  } catch (error) {
    throw new Error(`Failed to soft delete layer style: ${getErrorMessage(error)}`);
  }

  return {
    layerStyle: { ...layerStyle, deleted_at: deletedAt },
    affectedEntities,
  };
}

/**
 * Restore a soft-deleted layer style
 */
export async function restoreLayerStyle(id: string): Promise<LayerStyle> {
  const knex = await getDb();

  try {
    let query = knex('layer_styles')
      .where('id', id)
      .where('is_published', false);
    query = await applyTenantFilter(knex, query, 'layer_styles');
    const rows = await query.update({ deleted_at: null, updated_at: new Date().toISOString() }).returning('*') as LayerStyle[];
    const data = rows[0];
    if (!data) throw new Error('Layer style not found');
    return data;
  } catch (error) {
    throw new Error(`Failed to restore layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Hard delete a layer style (permanent, use with caution)
 * @deprecated Use softDeleteStyle instead for undo/redo support
 */
export async function deleteStyle(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('layer_styles').where('id', id);
    query = await applyTenantFilter(knex, query, 'layer_styles');
    await query.delete();
  } catch (error) {
    throw new Error(`Failed to delete layer style: ${getErrorMessage(error)}`);
  }
}

/**
 * Recursively check whether any layer in the tree references one of the given style IDs.
 */
function layersReferenceAnyStyle(layers: Layer[], styleIds: Set<string>): boolean {
  for (const layer of layers) {
    if (getStyleIds(layer).some(id => styleIds.has(id))) return true;
    if (layer.textStyles) {
      for (const ts of Object.values(layer.textStyles)) {
        const tsStyleId = (ts as { styleId?: string })?.styleId;
        if (tsStyleId && styleIds.has(tsStyleId)) return true;
      }
    }
    if (Array.isArray(layer.children) && layer.children.length > 0) {
      if (layersReferenceAnyStyle(layer.children, styleIds)) return true;
    }
  }
  return false;
}

/**
 * Propagate updated layer style values into draft layers of every referencing page/component.
 */
export async function syncLayerStyleChangesToDrafts(
  styleIds: string[],
): Promise<{ affectedPageIds: string[]; affectedComponentIds: string[] }> {
  if (styleIds.length === 0) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  let knex: Knex;
  try {
    knex = await getDb();
  } catch {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  let stylesQuery = knex('layer_styles')
    .select('id', 'classes', 'design')
    .whereIn('id', styleIds)
    .where('is_published', true)
    .whereNull('deleted_at');
  stylesQuery = await applyTenantFilter(knex, stylesQuery, 'layer_styles');
  const styles = await stylesQuery as LayerStyle[];

  if (styles.length === 0) {
    return { affectedPageIds: [], affectedComponentIds: [] };
  }

  const styleIdSet = new Set(styles.map(s => s.id));

  let allStylesQuery = knex('layer_styles')
    .select('id', 'classes', 'design')
    .where('is_published', true)
    .whereNull('deleted_at');
  allStylesQuery = await applyTenantFilter(knex, allStylesQuery, 'layer_styles');
  const allStyles = await allStylesQuery as LayerStyle[];

  const stylesById = new Map<string, LayerStyle>();
  for (const s of allStyles) stylesById.set(s.id, s);
  for (const s of styles) stylesById.set(s.id, s);

  let pageLayersQuery = knex('page_layers')
    .select('id', 'page_id', 'layers', 'generated_css', 'content_hash')
    .where('is_published', false)
    .whereNull('deleted_at');
  pageLayersQuery = await applyTenantFilter(knex, pageLayersQuery, 'page_layers');
  const pageLayersRecords = await pageLayersQuery as PageLayerStyleRow[];

  const affectedPageIds: string[] = [];
  const now = new Date().toISOString();

  for (const record of pageLayersRecords) {
    if (!Array.isArray(record.layers)) continue;
    if (!layersReferenceAnyStyle(record.layers, styleIdSet)) continue;

    let layers = record.layers;
    for (const style of styles) {
      layers = updateLayersWithStyle(layers, style.id, stylesById);
    }

    const newHash = generatePageLayersHash({
      layers,
      generated_css: record.generated_css || null,
    });

    if (newHash !== record.content_hash) {
      affectedPageIds.push(record.page_id);
      let updateQuery = knex('page_layers')
        .where('id', record.id)
        .where('is_published', false);
      updateQuery = await applyTenantFilter(knex, updateQuery, 'page_layers');
      await updateQuery.update({ layers, content_hash: newHash, updated_at: now });
    }
  }

  let componentQuery = knex('components')
    .select('id', 'name', 'layers', 'variants', 'variables', 'content_hash')
    .where('is_published', false)
    .whereNull('deleted_at');
  componentQuery = await applyTenantFilter(knex, componentQuery, 'components');
  const componentRecords = await componentQuery as ComponentStyleRow[];

  const affectedComponentIds: string[] = [];

  for (const record of componentRecords) {
    if (!Array.isArray(record.layers)) continue;

    const variantsList = Array.isArray(record.variants) ? (record.variants as ComponentVariant[]) : [];
    const primaryReferences = layersReferenceAnyStyle(record.layers, styleIdSet);
    const variantReferences = variantsList.some(
      v => Array.isArray(v.layers) && layersReferenceAnyStyle(v.layers as Layer[], styleIdSet),
    );
    if (!primaryReferences && !variantReferences) continue;

    let layers = record.layers;
    for (const style of styles) {
      layers = updateLayersWithStyle(layers, style.id, stylesById);
    }

    let variants: ComponentVariant[] | undefined = record.variants as ComponentVariant[] | undefined;
    if (Array.isArray(variants) && variants.length > 0) {
      variants = variants.map((v, i) => {
        if (i === 0) return { ...v, layers };
        let variantLayers = v.layers as Layer[] ?? [];
        for (const style of styles) {
          variantLayers = updateLayersWithStyle(variantLayers, style.id, stylesById);
        }
        return { ...v, layers: variantLayers };
      });
    }

    const newHash = generateComponentContentHash({
      name: record.name,
      layers,
      variables: record.variables,
      variants,
    });

    if (newHash !== record.content_hash) {
      affectedComponentIds.push(record.id);
      let updateQuery = knex('components')
        .where('id', record.id)
        .where('is_published', false);
      updateQuery = await applyTenantFilter(knex, updateQuery, 'components');
      await updateQuery.update({
        layers,
        ...(variants ? { variants } : {}),
        content_hash: newHash,
        updated_at: now,
      });
    }
  }

  return { affectedPageIds, affectedComponentIds };
}
