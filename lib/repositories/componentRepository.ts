/**
 * Component Repository
 *
 * Data access layer for components (reusable layer trees) using Knex
 */

import type { Knex } from 'knex';

import { getDb, isMissingTableError } from '@/lib/platform/db';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { deleteTranslationsInBulk, markTranslationsIncomplete } from '@/lib/repositories/translationRepository';
import { generateComponentContentHash, generatePageLayersHash } from '@/lib/hash-utils';
import { extractLayerContentMap } from '@/lib/localisation-utils';
import { generateId } from '@/lib/utils';
import type { Component, ComponentVariant, Layer } from '@/types';

/**
 * Input data for creating a new component
 */
export interface CreateComponentData {
  name: string;
  layers: Layer[];
  variables?: any[]; // Component variables for exposed properties
  variants?: ComponentVariant[]; // Optional explicit variants; defaults to a single "Default"
}

type InsertRow = Record<string, unknown>;

type PageLayerEntityRow = {
  id: string;
  page_id: string;
  layers: Layer[] | null;
  is_published: boolean;
};

type NamedRow = {
  id: string;
  name: string;
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

/**
 * Build a variants array from a layers tree.
 */
function defaultVariantsFromLayers(layers: Layer[]): ComponentVariant[] {
  return [{ id: generateId('cmpvar'), name: 'Default', layers }];
}

/**
 * Get all components (draft by default, excludes soft deleted)
 */
export async function getAllComponents(isPublished: boolean = false): Promise<Component[]> {
  const knex = await getDb();

  try {
    let query = knex('components')
      .select('*')
      .where('is_published', isPublished)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    query = await applyTenantFilter(knex, query, 'components');
    return await query as Component[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch components: ${getErrorMessage(error)}`);
  }
}

/**
 * Get a single component by ID (draft by default, excludes soft deleted)
 */
export async function getComponentById(id: string, isPublished: boolean = false): Promise<Component | null> {
  const knex = await getDb();

  try {
    let query = knex('components')
      .select('*')
      .where('id', id)
      .where('is_published', isPublished)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'components');
    return (await query.first() as Component | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch component: ${getErrorMessage(error)}`);
  }
}

/**
 * Get multiple components by IDs (drafts by default, excludes soft deleted)
 */
export async function getComponentsByIds(
  ids: string[],
  isPublished: boolean = false
): Promise<Record<string, Component>> {
  if (ids.length === 0) {
    return {};
  }

  const knex = await getDb();

  try {
    let query = knex('components')
      .select('*')
      .whereIn('id', ids)
      .where('is_published', isPublished)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'components');
    const data = await query as Component[];

    const componentMap: Record<string, Component> = {};
    data.forEach(component => {
      componentMap[component.id] = component;
    });

    return componentMap;
  } catch (error) {
    if (isMissingTableError(error)) return {};
    throw new Error(`Failed to fetch components: ${getErrorMessage(error)}`);
  }
}

/**
 * Create a new component (draft by default)
 */
export async function createComponent(
  componentData: CreateComponentData
): Promise<Component> {
  const knex = await getDb();

  const variants: ComponentVariant[] = componentData.variants && componentData.variants.length > 0
    ? componentData.variants
    : defaultVariantsFromLayers(componentData.layers);
  const primaryLayers = variants[0]?.layers ?? componentData.layers;

  const contentHash = generateComponentContentHash({
    name: componentData.name,
    layers: primaryLayers,
    variables: componentData.variables,
    variants,
  });

  const insertData: Record<string, unknown> = {
    name: componentData.name,
    layers: primaryLayers,
    variants,
    content_hash: contentHash,
    is_published: false,
  };

  if (componentData.variables?.length) {
    insertData.variables = componentData.variables;
  }

  try {
    const rows = await knex('components')
      .insert(await withTenantOnInsert(insertData))
      .returning('*') as Component[];
    const data = rows[0];
    if (!data) throw new Error('No component returned');
    return data;
  } catch (error) {
    throw new Error(`Failed to create component: ${getErrorMessage(error)}`);
  }
}

/**
 * Update a component and recalculate content hash.
 */
export async function updateComponent(
  id: string,
  updates: Partial<Pick<Component, 'name' | 'layers' | 'variables' | 'variants'>>
): Promise<Component> {
  const knex = await getDb();

  const current = await getComponentById(id);
  if (!current) {
    throw new Error('Component not found');
  }

  const currentVariants: ComponentVariant[] = current.variants && current.variants.length > 0
    ? current.variants
    : defaultVariantsFromLayers(current.layers || []);

  let finalVariants: ComponentVariant[] = currentVariants;
  if (updates.variants !== undefined) {
    finalVariants = updates.variants.length > 0
      ? updates.variants
      : defaultVariantsFromLayers([]);
  } else if (updates.layers !== undefined) {
    finalVariants = currentVariants.map((v, i) => (i === 0 ? { ...v, layers: updates.layers! } : v));
  }
  const finalLayers = finalVariants[0]?.layers ?? (updates.layers ?? current.layers ?? []);

  const oldPrimaryLayers = current.layers || [];
  if (oldPrimaryLayers !== finalLayers) {
    const oldContentMap = extractLayerContentMap(oldPrimaryLayers, 'component', id);
    const newContentMap = extractLayerContentMap(finalLayers, 'component', id);

    const removedKeys = Object.keys(oldContentMap).filter(key => !(key in newContentMap));
    const changedKeys = Object.keys(newContentMap).filter(
      key => key in oldContentMap && oldContentMap[key] !== newContentMap[key]
    );

    if (removedKeys.length > 0) {
      await deleteTranslationsInBulk('component', id, removedKeys);
    }
    if (changedKeys.length > 0) {
      await markTranslationsIncomplete('component', id, changedKeys);
    }
  }

  const finalName = updates.name !== undefined ? updates.name : current.name;
  const finalVariables = updates.variables !== undefined ? updates.variables : current.variables;
  const contentHash = generateComponentContentHash({
    name: finalName,
    layers: finalLayers,
    variables: finalVariables,
    variants: finalVariants,
  });

  try {
    let query = knex('components')
      .where('id', id)
      .where('is_published', false)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'components');
    const rows = await query.update({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.variables !== undefined ? { variables: updates.variables } : {}),
      layers: finalLayers,
      variants: finalVariants,
      content_hash: contentHash,
      updated_at: new Date().toISOString(),
    }).returning('*') as Component[];
    const data = rows[0];
    if (!data) throw new Error('Component not found');
    return data;
  } catch (error) {
    throw new Error(`Failed to update component: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published component by ID
 */
export async function getPublishedComponentById(id: string): Promise<Component | null> {
  const knex = await getDb();

  try {
    let query = knex('components')
      .select('*')
      .where('id', id)
      .where('is_published', true);
    query = await applyTenantFilter(knex, query, 'components');
    return (await query.first() as Component | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch published component: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish a component (dual-record pattern like pages)
 */
export async function publishComponent(draftComponentId: string): Promise<Component> {
  const knex = await getDb();

  const draftComponent = await getComponentById(draftComponentId);
  if (!draftComponent) {
    throw new Error('Draft component not found');
  }

  try {
    const upsertData = await withTenantOnInsert({
      id: draftComponent.id,
      name: draftComponent.name,
      layers: draftComponent.layers,
      variants: draftComponent.variants,
      variables: draftComponent.variables,
      content_hash: draftComponent.content_hash,
      is_published: true,
      updated_at: new Date().toISOString(),
    });
    const rows = await knex('components')
      .insert(upsertData)
      .onConflict(['id', 'is_published'])
      .merge()
      .returning('*') as Component[];
    const data = rows[0];
    if (!data) throw new Error('No component returned');
    return data;
  } catch (error) {
    throw new Error(`Failed to publish component: ${getErrorMessage(error)}`);
  }
}

/**
 * Publish multiple components in batch
 */
export async function publishComponents(componentIds: string[]): Promise<{ count: number; changedComponentIds: string[] }> {
  if (componentIds.length === 0) {
    return { count: 0, changedComponentIds: [] };
  }

  const knex = await getDb();

  let draftQuery = knex('components')
    .select('*')
    .whereIn('id', componentIds)
    .where('is_published', false)
    .whereNull('deleted_at');
  draftQuery = await applyTenantFilter(knex, draftQuery, 'components');
  const draftComponents = await draftQuery as Component[];

  if (draftComponents.length === 0) {
    return { count: 0, changedComponentIds: [] };
  }

  let publishedQuery = knex('components')
    .select('id', 'content_hash')
    .whereIn('id', draftComponents.map(d => d.id))
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'components');
  const publishedComponents = await publishedQuery as Array<{ id: string; content_hash: string | null }>;

  const publishedHashById = new Map<string, string>();
  for (const pub of publishedComponents) {
    if (pub.content_hash) publishedHashById.set(pub.id, pub.content_hash);
  }

  const componentsToUpsert = await withTenantOnInsertMany(draftComponents
    .filter(draft => {
      const pubHash = publishedHashById.get(draft.id);
      return !pubHash || pubHash !== draft.content_hash;
    })
    .map(draft => ({
      id: draft.id,
      name: draft.name,
      layers: draft.layers,
      variants: draft.variants,
      variables: draft.variables,
      content_hash: draft.content_hash,
      is_published: true,
      updated_at: new Date().toISOString(),
    })));

  if (componentsToUpsert.length > 0) {
    try {
      await knex('components')
        .insert(componentsToUpsert)
        .onConflict(['id', 'is_published'])
        .merge();
    } catch (error) {
      throw new Error(`Failed to publish components: ${getErrorMessage(error)}`);
    }
  }

  return {
    count: componentsToUpsert.length,
    changedComponentIds: componentsToUpsert.map(c => c.id as string),
  };
}

/**
 * Get all unpublished components (excludes soft deleted)
 */
export async function getUnpublishedComponents(): Promise<Component[]> {
  const knex = await getDb();

  let draftQuery = knex('components')
    .select('*')
    .where('is_published', false)
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc');
  draftQuery = await applyTenantFilter(knex, draftQuery, 'components');
  const draftComponents = await draftQuery as Component[];

  if (draftComponents.length === 0) {
    return [];
  }

  const draftIds = draftComponents.map(c => c.id);
  let publishedQuery = knex('components')
    .select('*')
    .whereIn('id', draftIds)
    .where('is_published', true);
  publishedQuery = await applyTenantFilter(knex, publishedQuery, 'components');
  const publishedComponents = await publishedQuery as Component[];

  const publishedById = new Map<string, Component>();
  publishedComponents.forEach(c => publishedById.set(c.id, c));

  const unpublishedComponents: Component[] = [];

  for (const draftComponent of draftComponents) {
    const publishedComponent = publishedById.get(draftComponent.id);

    if (!publishedComponent) {
      unpublishedComponents.push(draftComponent);
      continue;
    }

    if (draftComponent.content_hash !== publishedComponent.content_hash) {
      unpublishedComponents.push(draftComponent);
    }
  }

  return unpublishedComponents;
}

/**
 * Hard-delete soft-deleted draft components and their published counterparts.
 */
export async function hardDeleteSoftDeletedComponents(): Promise<{ count: number }> {
  const knex = await getDb();

  try {
    let deletedQuery = knex('components')
      .select('id')
      .where('is_published', false)
      .whereNotNull('deleted_at');
    deletedQuery = await applyTenantFilter(knex, deletedQuery, 'components');
    const deletedDrafts = await deletedQuery as Array<{ id: string }>;

    if (deletedDrafts.length === 0) {
      return { count: 0 };
    }

    const ids = deletedDrafts.map(c => c.id);

    try {
      let pubQuery = knex('components')
        .whereIn('id', ids)
        .where('is_published', true);
      pubQuery = await applyTenantFilter(knex, pubQuery, 'components');
      await pubQuery.delete();
    } catch (pubError) {
      console.error('Failed to delete published components:', pubError);
    }

    let draftQuery = knex('components')
      .whereIn('id', ids)
      .where('is_published', false)
      .whereNotNull('deleted_at');
    draftQuery = await applyTenantFilter(knex, draftQuery, 'components');
    await draftQuery.delete();

    return { count: deletedDrafts.length };
  } catch (error) {
    throw new Error(`Failed to delete draft components: ${getErrorMessage(error)}`);
  }
}

/**
 * Get count of unpublished components
 */
export async function getUnpublishedComponentsCount(): Promise<number> {
  const components = await getUnpublishedComponents();
  return components.length;
}

/**
 * Affected entity info returned when deleting a component
 */
export interface AffectedEntity {
  type: 'page' | 'component';
  id: string;
  name: string;
  pageId?: string;
  previousLayers: Layer[];
  newLayers: Layer[];
}

/**
 * Result of soft deleting a component
 */
export interface SoftDeleteResult {
  component: Component;
  affectedEntities: AffectedEntity[];
}

/**
 * Find all pages and components that use a specific component
 */
export async function findEntitiesUsingComponent(componentId: string): Promise<AffectedEntity[]> {
  const knex = await getDb();
  const affectedEntities: AffectedEntity[] = [];

  let pageQuery = knex('page_layers')
    .select('id', 'page_id', 'layers', 'is_published')
    .whereNull('deleted_at')
    .where('is_published', false);
  pageQuery = await applyTenantFilter(knex, pageQuery, 'page_layers');
  const pageLayersRecords = await pageQuery as PageLayerEntityRow[];

  const pageIds = pageLayersRecords.map(r => r.page_id).filter(Boolean);
  let pageNames: Record<string, string> = {};
  if (pageIds.length > 0) {
    let namesQuery = knex('pages')
      .select('id', 'name')
      .whereIn('id', pageIds);
    namesQuery = await applyTenantFilter(knex, namesQuery, 'pages');
    const pages = await namesQuery as NamedRow[];
    pageNames = pages.reduce((acc, p) => ({ ...acc, [p.id]: p.name }), {});
  }

  for (const record of pageLayersRecords) {
    const recordLayers = record.layers || [];
    if (layersContainComponent(recordLayers, componentId)) {
      const newLayers = await detachComponentFromLayersRecursive(recordLayers, componentId);
      affectedEntities.push({
        type: 'page',
        id: record.id,
        pageId: record.page_id,
        name: pageNames[record.page_id] || 'Unknown Page',
        previousLayers: recordLayers,
        newLayers,
      });
    }
  }

  let componentQuery = knex('components')
    .select('id', 'name', 'layers')
    .whereNull('deleted_at')
    .where('is_published', false)
    .whereNot('id', componentId);
  componentQuery = await applyTenantFilter(knex, componentQuery, 'components');
  const componentRecords = await componentQuery as Array<Pick<Component, 'id' | 'name' | 'layers'>>;

  for (const record of componentRecords) {
    const recordLayers = record.layers || [];
    if (layersContainComponent(recordLayers, componentId)) {
      const newLayers = await detachComponentFromLayersRecursive(recordLayers, componentId);
      affectedEntities.push({
        type: 'component',
        id: record.id,
        name: record.name,
        previousLayers: recordLayers,
        newLayers,
      });
    }
  }

  return affectedEntities;
}

/**
 * Check if layers contain a reference to a specific component
 */
function layersContainComponent(layers: Layer[], componentId: string): boolean {
  for (const layer of layers) {
    if (layer.componentId === componentId) {
      return true;
    }
    if (layer.children && layersContainComponent(layer.children, componentId)) {
      return true;
    }
  }
  return false;
}

/**
 * Soft delete a component and detach it from all layers
 */
export async function softDeleteComponent(id: string): Promise<SoftDeleteResult> {
  const knex = await getDb();

  const component = await getComponentById(id, false);
  if (!component) {
    throw new Error('Component not found');
  }

  const affectedEntities = await findEntitiesUsingComponent(id);

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
      try {
        let updateQuery = knex('components')
          .where('id', entity.id)
          .where('is_published', false);
        updateQuery = await applyTenantFilter(knex, updateQuery, 'components');
        await updateQuery.update({
          layers: entity.newLayers,
          updated_at: new Date().toISOString(),
        });
      } catch (updateError) {
        console.error(`Failed to update component ${entity.id}:`, updateError);
      }
    }
  }

  const deletedAt = new Date().toISOString();
  try {
    let deleteQuery = knex('components').where('id', id);
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'components');
    await deleteQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });
  } catch (error) {
    throw new Error(`Failed to soft delete component: ${getErrorMessage(error)}`);
  }

  return {
    component: { ...component, deleted_at: deletedAt },
    affectedEntities,
  };
}

/**
 * Restore a soft-deleted component
 */
export async function restoreComponent(id: string): Promise<Component> {
  const knex = await getDb();

  try {
    let query = knex('components')
      .where('id', id)
      .where('is_published', false);
    query = await applyTenantFilter(knex, query, 'components');
    const rows = await query.update({ deleted_at: null, updated_at: new Date().toISOString() }).returning('*') as Component[];
    const data = rows[0];
    if (!data) throw new Error('Component not found');
    return data;
  } catch (error) {
    throw new Error(`Failed to restore component: ${getErrorMessage(error)}`);
  }
}

/**
 * Hard delete a component (permanent, use with caution)
 */
export async function deleteComponent(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('components').where('id', id);
    query = await applyTenantFilter(knex, query, 'components');
    await query.delete();
  } catch (error) {
    throw new Error(`Failed to delete component: ${getErrorMessage(error)}`);
  }
}

/**
 * Update a component's thumbnail URL (draft only)
 */
export async function updateComponentThumbnail(id: string, thumbnailUrl: string | null): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('components')
      .where('id', id)
      .where('is_published', false);
    query = await applyTenantFilter(knex, query, 'components');
    await query.update({ thumbnail_url: thumbnailUrl, updated_at: new Date().toISOString() });
  } catch (error) {
    throw new Error(`Failed to update component thumbnail: ${getErrorMessage(error)}`);
  }
}

/**
 * Detach component from layers - async wrapper that fetches component data
 */
async function detachComponentFromLayersRecursive(layers: Layer[], componentId: string): Promise<Layer[]> {
  const { detachComponentFromLayers } = await import('@/lib/component-utils');
  const component = await getComponentById(componentId);
  return detachComponentFromLayers(layers, componentId, component || undefined);
}
