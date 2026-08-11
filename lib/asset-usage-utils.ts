/**
 * Asset Usage Utilities
 *
 * Functions to find and count asset usage across pages, components, and CMS items
 */

import type { Knex } from 'knex';

import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import type { Layer } from '@/types';
import { ASSET_FIELD_TYPES, findDisplayField } from './collection-field-utils';

export interface AssetUsageEntry {
  id: string;
  name: string;
}

export interface CmsItemUsageEntry extends AssetUsageEntry {
  collectionId: string;
  collectionName: string;
}

export interface FieldDefaultUsageEntry extends AssetUsageEntry {
  collectionId: string;
  collectionName: string;
}

export interface AssetUsageResult {
  pages: AssetUsageEntry[];
  components: AssetUsageEntry[];
  cmsItems: CmsItemUsageEntry[];
  fieldDefaults: FieldDefaultUsageEntry[];
  total: number;
}

type DbClient = Awaited<ReturnType<typeof getDb>>;

async function scopedQuery<T>(
  db: DbClient,
  tableName: string,
  query: Knex.QueryBuilder
): Promise<T[]> {
  const scoped = await addTenantFilter(db, query, tableName);
  return await scoped as T[];
}

async function updateScoped(
  db: DbClient,
  tableName: string,
  query: Knex.QueryBuilder
): Promise<number> {
  const scoped = await addTenantFilter(db, query, tableName);
  return await scoped as number;
}

async function selectDraftRows<T>(
  db: DbClient,
  tableName: string,
  columns: string[]
): Promise<T[]> {
  return scopedQuery<T>(db, tableName, db(tableName)
    .select(...columns)
    .where('is_published', false)
    .whereNull('deleted_at'));
}

/**
 * Check if a variable contains an asset reference with the given ID
 */
function isAssetVarWithId(
  v: any,
  assetId: string
): boolean {
  return v?.type === 'asset' && v?.data?.asset_id === assetId;
}

/**
 * Check if a link variable contains an asset reference with the given ID
 */
function linkHasAssetId(link: any, assetId: string): boolean {
  return link?.asset?.id === assetId;
}

/**
 * Check if a CMS link field JSON value references an asset ID
 */
function collectionLinkValueHasAsset(jsonValue: string, assetId: string): boolean {
  if (!jsonValue || !jsonValue.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(jsonValue);
    return parsed?.type === 'asset' && parsed?.asset?.id === assetId;
  } catch {
    return false;
  }
}

/**
 * Null out asset reference in a CMS link field JSON value.
 * Returns the updated JSON string with asset.id set to null.
 */
function nullifyAssetInCollectionLinkValue(jsonValue: string): string {
  try {
    const parsed = JSON.parse(jsonValue);
    parsed.asset = { id: null };
    return JSON.stringify(parsed);
  } catch {
    return jsonValue;
  }
}

/**
 * Scan rich text content for asset references
 */
function richTextContainsAsset(content: any, assetId: string): boolean {
  if (!content || typeof content !== 'object') return false;

  // Check marks for richTextLink with asset
  if (Array.isArray(content.marks)) {
    for (const mark of content.marks) {
      if (mark.type === 'richTextLink' && mark.attrs?.asset?.id === assetId) {
        return true;
      }
    }
  }

  // Recurse into content arrays
  if (Array.isArray(content.content)) {
    for (const child of content.content) {
      if (richTextContainsAsset(child, assetId)) return true;
    }
  }
  if (Array.isArray(content)) {
    for (const child of content) {
      if (richTextContainsAsset(child, assetId)) return true;
    }
  }

  return false;
}

/**
 * Check if a layer contains a reference to a specific asset
 */
function layerContainsAsset(layer: Layer, assetId: string): boolean {
  // Image source
  if (isAssetVarWithId(layer.variables?.image?.src, assetId)) return true;

  // Video source and poster
  if (isAssetVarWithId(layer.variables?.video?.src, assetId)) return true;
  if (isAssetVarWithId(layer.variables?.video?.poster, assetId)) return true;

  // Audio source
  if (isAssetVarWithId(layer.variables?.audio?.src, assetId)) return true;

  // Icon source
  if (isAssetVarWithId(layer.variables?.icon?.src, assetId)) return true;

  // Direct asset link
  if (linkHasAssetId(layer.variables?.link, assetId)) return true;

  // Rich text links with asset type
  const textVar = layer.variables?.text;
  if (textVar?.type === 'dynamic_rich_text' && (textVar as any).data?.content) {
    if (richTextContainsAsset((textVar as any).data.content, assetId)) return true;
  }

  // Component variable overrides (image type)
  const imageOverrides = layer.componentOverrides?.image;
  if (imageOverrides) {
    for (const value of Object.values(imageOverrides)) {
      if (typeof value === 'string' && value === assetId) return true;
    }
  }

  return false;
}

/**
 * Recursively check if layers contain a reference to a specific asset
 */
function layersContainAsset(layers: Layer[], assetId: string): boolean {
  for (const layer of layers) {
    if (layerContainsAsset(layer, assetId)) return true;
    if (layer.children && layersContainAsset(layer.children, assetId)) return true;
  }
  return false;
}

/**
 * Check if page settings contain an asset reference
 */
function pageSettingsContainAsset(settings: any, assetId: string): boolean {
  // Check SEO image
  if (settings?.seo?.image === assetId) return true;
  return false;
}

/**
 * Parse a field default value into an array of asset IDs.
 * Returns the parsed array (cached) for multi-asset, or null if not a JSON array.
 */
function parseDefaultAssetIds(defaultVal: string): string[] | null {
  if (!defaultVal.startsWith('[')) return null;
  try {
    return JSON.parse(defaultVal) as string[];
  } catch {
    return null;
  }
}

/** Check if a field default value (single ID or JSON array) references a given asset */
function fieldDefaultReferencesAsset(defaultVal: string, assetId: string, parsedIds?: string[] | null): boolean {
  if (defaultVal === assetId) return true;
  const ids = parsedIds !== undefined ? parsedIds : parseDefaultAssetIds(defaultVal);
  return ids != null && ids.includes(assetId);
}

/** Fetch collection names by IDs and return a lookup map */
async function fetchCollectionNames(
  db: DbClient,
  collectionIds: string[]
): Promise<Record<string, string>> {
  if (collectionIds.length === 0) return {};

  const data = await scopedQuery<Array<{ id: string; name: string | null }>[number]>(db, 'collections', db('collections')
    .select('id', 'name')
    .whereIn('id', collectionIds)
    .where('is_published', false)
    .whereNull('deleted_at'));

  const map: Record<string, string> = {};
  data.forEach((c) => {
    map[c.id] = c.name ?? 'Unknown Collection';
  });
  return map;
}

interface AssetFieldDefault {
  id: string;
  name?: string;
  collection_id: string;
  default: string | null;
}

/** Fetch asset-type collection fields that have a non-null default value */
async function fetchAssetFieldsWithDefaults(
  db: DbClient,
  columns: string[] = ['id', 'name', 'collection_id', 'default']
): Promise<AssetFieldDefault[]> {
  return scopedQuery<AssetFieldDefault>(db, 'collection_fields', db('collection_fields')
    .select(...columns)
    .whereIn('type', ASSET_FIELD_TYPES)
    .where('is_published', false)
    .whereNull('deleted_at')
    .whereNotNull('default'));
}

/**
 * Get asset usage with names across pages, components, and CMS items
 */
export async function getAssetUsage(assetId: string): Promise<AssetUsageResult> {
  const db = await getDb();

  const pageEntries: AssetUsageEntry[] = [];
  const componentEntries: AssetUsageEntry[] = [];
  const cmsItemEntries: CmsItemUsageEntry[] = [];

  // Track unique page IDs that use this asset
  const pageIdsWithAsset = new Set<string>();

  // Check page layers (draft versions)
  const pageLayersRecords = await selectDraftRows<Array<{ id: string; page_id: string; layers: Layer[] | null }>[number]>(
    db,
    'page_layers',
    ['id', 'page_id', 'layers']
  );

  for (const record of pageLayersRecords) {
    if (record.layers && layersContainAsset(record.layers, assetId)) {
      pageIdsWithAsset.add(record.page_id);
    }
  }

  // Check page settings for SEO images
  const pagesData = await selectDraftRows<Array<{ id: string; name: string | null; settings: any }>[number]>(
    db,
    'pages',
    ['id', 'name', 'settings']
  );

  for (const page of pagesData) {
    if (page.settings && pageSettingsContainAsset(page.settings, assetId)) {
      pageIdsWithAsset.add(page.id);
    }
  }

  // Build page entries with names
  const pageIds = Array.from(pageIdsWithAsset);
  const pagesWithAsset = pagesData.filter((p) => pageIds.includes(p.id));
  for (const pageId of pageIds) {
    const page = pagesWithAsset.find((p) => p.id === pageId);
    pageEntries.push({ id: pageId, name: page?.name ?? 'Unknown Page' });
  }

  // Check components (draft versions)
  const components = await selectDraftRows<Array<{ id: string; name: string | null; layers: Layer[] | null }>[number]>(
    db,
    'components',
    ['id', 'name', 'layers']
  );

  for (const component of components) {
    if (component.layers && layersContainAsset(component.layers, assetId)) {
      componentEntries.push({ id: component.id, name: component.name ?? 'Unknown Component' });
    }
  }

  // Check CMS collection item values (image/file fields)
  const imageFields = await scopedQuery<Array<{ id: string; collection_id: string }>[number]>(db, 'collection_fields', db('collection_fields')
    .select('id', 'collection_id')
    .whereIn('type', ['image', 'file'])
    .where('is_published', false)
    .whereNull('deleted_at'));

  if (imageFields.length > 0) {
    const fieldIds = imageFields.map((f) => f.id);

    const itemValues = await scopedQuery<Array<{ item_id: string }>[number]>(db, 'collection_item_values', db('collection_item_values')
      .select('item_id')
      .whereIn('field_id', fieldIds)
      .where('value', assetId)
      .where('is_published', false)
      .whereNull('deleted_at'));

    const uniqueItemIds = [...new Set(itemValues.map((v) => v.item_id))];
    if (uniqueItemIds.length > 0) {
      // Get items with collection_id
      const items = await scopedQuery<Array<{ id: string; collection_id: string }>[number]>(db, 'collection_items', db('collection_items')
        .select('id', 'collection_id')
        .whereIn('id', uniqueItemIds)
        .where('is_published', false)
        .whereNull('deleted_at'));

      const cmsCollectionIds = [...new Set(items.map((i) => i.collection_id))];

      // Get fields for display name (key=name, title, or first text field)
      const allFields = await scopedQuery<Array<{ id: string; key: string | null; type: string; fillable: boolean; collection_id: string }>[number]>(db, 'collection_fields', db('collection_fields')
        .select('id', 'key', 'type', 'fillable', 'collection_id')
        .whereIn('collection_id', cmsCollectionIds)
        .where('is_published', false)
        .whereNull('deleted_at'));

      // Find display field per collection
      const displayFieldByCollection: Record<string, { id: string }> = {};
      for (const collectionId of cmsCollectionIds) {
        const fields = allFields.filter((f) => f.collection_id === collectionId);
        const displayField = findDisplayField(fields as any);
        if (displayField) {
          displayFieldByCollection[collectionId] = { id: displayField.id };
        }
      }

      // Get values for display fields
      const displayFieldIds = Object.values(displayFieldByCollection).map((f) => f.id);
      const displayValues = displayFieldIds.length > 0
        ? await scopedQuery<Array<{ item_id: string; field_id: string; value: string | null }>[number]>(db, 'collection_item_values', db('collection_item_values')
          .select('item_id', 'field_id', 'value')
          .whereIn('item_id', uniqueItemIds)
          .whereIn('field_id', displayFieldIds)
          .where('is_published', false)
          .whereNull('deleted_at'))
        : [];

      const valueByItem: Record<string, string> = {};
      displayValues.forEach((row) => {
        valueByItem[`${row.item_id}:${row.field_id}`] = row.value ?? '';
      });

      for (const item of items) {
        const displayField = displayFieldByCollection[item.collection_id];
        const name =
          displayField && valueByItem[`${item.id}:${displayField.id}`]
            ? valueByItem[`${item.id}:${displayField.id}`]
            : 'Untitled';
        cmsItemEntries.push({ id: item.id, name, collectionId: item.collection_id, collectionName: '' });
      }
    }
  }

  // Check CMS link field values that embed an asset reference in JSON
  const linkFields = await scopedQuery<Array<{ id: string; collection_id: string }>[number]>(db, 'collection_fields', db('collection_fields')
    .select('id', 'collection_id')
    .where('type', 'link')
    .where('is_published', false)
    .whereNull('deleted_at'));

  if (linkFields.length > 0) {
    const linkFieldIds = linkFields.map((f) => f.id);

    // Fetch values that contain the asset ID substring (pre-filter)
    const linkItemValues = await scopedQuery<Array<{ item_id: string; value: string | null }>[number]>(db, 'collection_item_values', db('collection_item_values')
      .select('item_id', 'value')
      .whereIn('field_id', linkFieldIds)
      .whereLike('value', `%${assetId}%`)
      .where('is_published', false)
      .whereNull('deleted_at'));

    // Parse JSON and verify it's actually an asset link
    const linkItemIds = linkItemValues
      .filter((v) => v.value && collectionLinkValueHasAsset(v.value, assetId))
      .map((v) => v.item_id);

    const uniqueLinkItemIds = [...new Set(linkItemIds)].filter(
      (id) => !cmsItemEntries.some((e) => e.id === id)
    );

    if (uniqueLinkItemIds.length > 0) {
      const linkItems = await scopedQuery<Array<{ id: string; collection_id: string }>[number]>(db, 'collection_items', db('collection_items')
        .select('id', 'collection_id')
        .whereIn('id', uniqueLinkItemIds)
        .where('is_published', false)
        .whereNull('deleted_at'));

      const linkCollectionIds = [...new Set(linkItems.map((i) => i.collection_id))];

      // Get display fields for these collections
      const linkAllFields = await scopedQuery<Array<{ id: string; key: string | null; type: string; fillable: boolean; collection_id: string }>[number]>(db, 'collection_fields', db('collection_fields')
        .select('id', 'key', 'type', 'fillable', 'collection_id')
        .whereIn('collection_id', linkCollectionIds)
        .where('is_published', false)
        .whereNull('deleted_at'));

      const linkDisplayFieldByCollection: Record<string, { id: string }> = {};
      for (const collectionId of linkCollectionIds) {
        const fields = linkAllFields.filter((f) => f.collection_id === collectionId);
        const displayField = findDisplayField(fields as any);
        if (displayField) {
          linkDisplayFieldByCollection[collectionId] = { id: displayField.id };
        }
      }

      const linkDisplayFieldIds = Object.values(linkDisplayFieldByCollection).map((f) => f.id);
      const linkDisplayValues = linkDisplayFieldIds.length > 0
        ? await scopedQuery<Array<{ item_id: string; field_id: string; value: string | null }>[number]>(db, 'collection_item_values', db('collection_item_values')
          .select('item_id', 'field_id', 'value')
          .whereIn('item_id', uniqueLinkItemIds)
          .whereIn('field_id', linkDisplayFieldIds)
          .where('is_published', false)
          .whereNull('deleted_at'))
        : [];

      const linkValueByItem: Record<string, string> = {};
      linkDisplayValues.forEach((row) => {
        linkValueByItem[`${row.item_id}:${row.field_id}`] = row.value ?? '';
      });

      for (const item of linkItems) {
        const displayField = linkDisplayFieldByCollection[item.collection_id];
        const name =
          displayField && linkValueByItem[`${item.id}:${displayField.id}`]
            ? linkValueByItem[`${item.id}:${displayField.id}`]
            : 'Untitled';
        cmsItemEntries.push({ id: item.id, name, collectionId: item.collection_id, collectionName: '' });
      }
    }
  }

  // Check collection field defaults that reference this asset
  const fieldDefaultEntries: FieldDefaultUsageEntry[] = [];
  const assetFieldsWithDefaults = await fetchAssetFieldsWithDefaults(db);

  for (const field of assetFieldsWithDefaults) {
    const defaultVal = field.default as string;
    if (fieldDefaultReferencesAsset(defaultVal, assetId)) {
      fieldDefaultEntries.push({
        id: field.id,
        name: field.name ?? 'Unknown Field',
        collectionId: field.collection_id,
        collectionName: '',
      });
    }
  }

  // Resolve all collection names in a single query
  const allCollectionIds = [
    ...new Set([
      ...cmsItemEntries.map((e) => e.collectionId),
      ...fieldDefaultEntries.map((e) => e.collectionId),
    ]),
  ];
  const collectionNamesById = await fetchCollectionNames(db, allCollectionIds);

  for (const entry of cmsItemEntries) {
    entry.collectionName = collectionNamesById[entry.collectionId] ?? 'Unknown Collection';
  }
  for (const entry of fieldDefaultEntries) {
    entry.collectionName = collectionNamesById[entry.collectionId] ?? 'Unknown Collection';
  }

  return {
    pages: pageEntries,
    components: componentEntries,
    cmsItems: cmsItemEntries,
    fieldDefaults: fieldDefaultEntries,
    total: pageEntries.length + componentEntries.length + cmsItemEntries.length + fieldDefaultEntries.length,
  };
}

/**
 * Get bulk asset usage for multiple assets
 * More efficient than calling getAssetUsage multiple times
 */
export async function getBulkAssetUsage(
  assetIds: string[]
): Promise<Record<string, AssetUsageResult>> {
  if (assetIds.length === 0) {
    return {};
  }

  const db = await getDb();

  // Initialize results
  const results: Record<string, AssetUsageResult> = {};
  for (const assetId of assetIds) {
    results[assetId] = { pages: [], components: [], cmsItems: [], fieldDefaults: [], total: 0 };
  }

  // Create a set for faster lookup
  const assetIdSet = new Set(assetIds);

  // Check page layers
  const pageLayersRecords = await selectDraftRows<Array<{ id: string; page_id: string; layers: Layer[] | null }>[number]>(
    db,
    'page_layers',
    ['id', 'page_id', 'layers']
  );

  // Track page IDs per asset
  const pageIdsByAsset: Record<string, Set<string>> = {};
  for (const assetId of assetIds) {
    pageIdsByAsset[assetId] = new Set();
  }

  for (const record of pageLayersRecords) {
    if (!record.layers) continue;

    for (const assetId of assetIds) {
      if (layersContainAsset(record.layers, assetId)) {
        pageIdsByAsset[assetId].add(record.page_id);
      }
    }
  }

  // Check page settings
  const pages = await selectDraftRows<Array<{ id: string; settings: any }>[number]>(
    db,
    'pages',
    ['id', 'settings']
  );

  for (const page of pages) {
    if (!page.settings) continue;

    for (const assetId of assetIds) {
      if (pageSettingsContainAsset(page.settings, assetId)) {
        pageIdsByAsset[assetId].add(page.id);
      }
    }
  }

  // Get page names
  const pageIds = [...new Set(assetIds.flatMap((id) => [...pageIdsByAsset[id]]))];
  let pageNamesById: Record<string, string> = {};
  if (pageIds.length > 0) {
    const pagesWithNames = await scopedQuery<Array<{ id: string; name: string | null }>[number]>(db, 'pages', db('pages')
      .select('id', 'name')
      .whereIn('id', pageIds)
      .where('is_published', false));
    pageNamesById = pagesWithNames.reduce((acc, p) => ({ ...acc, [p.id]: p.name ?? 'Unknown Page' }), {});
  }

  for (const assetId of assetIds) {
    results[assetId].pages = [...pageIdsByAsset[assetId]].map((id) => ({
      id,
      name: pageNamesById[id] ?? 'Unknown Page',
    }));
  }

  // Check components
  const components = await selectDraftRows<Array<{ id: string; name: string | null; layers: Layer[] | null }>[number]>(
    db,
    'components',
    ['id', 'name', 'layers']
  );

  for (const component of components) {
    if (!component.layers) continue;

    for (const assetId of assetIds) {
      if (layersContainAsset(component.layers, assetId)) {
        results[assetId].components.push({ id: component.id, name: component.name ?? 'Unknown Component' });
      }
    }
  }

  // Check CMS items
  let cmsCollectionIds: string[] = [];

  const imageFields = await scopedQuery<Array<{ id: string }>[number]>(db, 'collection_fields', db('collection_fields')
    .select('id')
    .whereIn('type', ['image', 'file'])
    .where('is_published', false)
    .whereNull('deleted_at'));

  if (imageFields.length > 0) {
    const fieldIds = imageFields.map((f) => f.id);

    const itemValues = await scopedQuery<Array<{ item_id: string; value: string | null }>[number]>(db, 'collection_item_values', db('collection_item_values')
      .select('item_id', 'value')
      .whereIn('field_id', fieldIds)
      .whereIn('value', assetIds)
      .where('is_published', false)
      .whereNull('deleted_at'));

    const itemIdsByAsset: Record<string, Set<string>> = {};
    for (const assetId of assetIds) {
      itemIdsByAsset[assetId] = new Set();
    }

    for (const v of itemValues) {
      if (v.value && assetIdSet.has(v.value)) {
        itemIdsByAsset[v.value].add(v.item_id);
      }
    }

    const uniqueItemIds = [...new Set(Object.values(itemIdsByAsset).flatMap((s) => [...s]))];
    const itemCollectionById: Record<string, string> = {};

    if (uniqueItemIds.length > 0) {
      const items = await scopedQuery<Array<{ id: string; collection_id: string }>[number]>(db, 'collection_items', db('collection_items')
        .select('id', 'collection_id')
        .whereIn('id', uniqueItemIds)
        .where('is_published', false)
        .whereNull('deleted_at'));

      items.forEach((i) => {
        itemCollectionById[i.id] = i.collection_id;
      });
    }

    for (const assetId of assetIds) {
      results[assetId].cmsItems = [...itemIdsByAsset[assetId]].map((id) => {
        const collectionId = itemCollectionById[id] ?? '';
        return { id, name: 'Untitled', collectionId, collectionName: '' };
      });
    }

    cmsCollectionIds = [...new Set(Object.values(itemCollectionById))];
  }

  // Check CMS link field values that embed asset references in JSON
  const linkFields = await scopedQuery<Array<{ id: string }>[number]>(db, 'collection_fields', db('collection_fields')
    .select('id')
    .where('type', 'link')
    .where('is_published', false)
    .whereNull('deleted_at'));

  if (linkFields.length > 0) {
    const linkFieldIds = linkFields.map((f) => f.id);

    // Fetch link values that contain any of the asset IDs (pre-filter with OR of LIKE patterns)
    // For bulk, we check each asset individually since LIKE doesn't support IN
    for (const assetId of assetIds) {
      const linkItemValues = await scopedQuery<Array<{ item_id: string; value: string | null }>[number]>(db, 'collection_item_values', db('collection_item_values')
        .select('item_id', 'value')
        .whereIn('field_id', linkFieldIds)
        .whereLike('value', `%${assetId}%`)
        .where('is_published', false)
        .whereNull('deleted_at'));

      for (const v of linkItemValues) {
        if (v.value && collectionLinkValueHasAsset(v.value, assetId)) {
          const alreadyTracked = results[assetId].cmsItems.some((e) => e.id === v.item_id);
          if (!alreadyTracked) {
            results[assetId].cmsItems.push({
              id: v.item_id,
              name: 'Untitled',
              collectionId: '',
              collectionName: '',
            });
          }
        }
      }
    }

    // Resolve collection IDs for newly added link CMS items
    const linkItemIds = new Set<string>();
    for (const assetId of assetIds) {
      for (const entry of results[assetId].cmsItems) {
        if (!entry.collectionId) linkItemIds.add(entry.id);
      }
    }

    if (linkItemIds.size > 0) {
      const linkItems = await scopedQuery<Array<{ id: string; collection_id: string }>[number]>(db, 'collection_items', db('collection_items')
        .select('id', 'collection_id')
        .whereIn('id', [...linkItemIds])
        .where('is_published', false)
        .whereNull('deleted_at'));

      const linkItemCollectionById: Record<string, string> = {};
      linkItems.forEach((i) => {
        linkItemCollectionById[i.id] = i.collection_id;
      });

      for (const assetId of assetIds) {
        for (const entry of results[assetId].cmsItems) {
          if (!entry.collectionId && linkItemCollectionById[entry.id]) {
            entry.collectionId = linkItemCollectionById[entry.id];
            cmsCollectionIds.push(entry.collectionId);
          }
        }
      }
    }
  }

  // Check collection field defaults
  const assetFieldsWithDefaults = await fetchAssetFieldsWithDefaults(db);

  for (const field of assetFieldsWithDefaults) {
    const defaultVal = field.default as string;
    const parsedIds = parseDefaultAssetIds(defaultVal);
    for (const assetId of assetIds) {
      if (fieldDefaultReferencesAsset(defaultVal, assetId, parsedIds)) {
        results[assetId].fieldDefaults.push({
          id: field.id,
          name: field.name ?? 'Unknown Field',
          collectionId: field.collection_id,
          collectionName: '',
        });
      }
    }
  }

  // Resolve all collection names in a single query
  const defaultCollectionIds = new Set<string>();
  for (const assetId of assetIds) {
    for (const entry of results[assetId].fieldDefaults) {
      defaultCollectionIds.add(entry.collectionId);
    }
  }
  const allCollectionIds = [...new Set([...cmsCollectionIds, ...defaultCollectionIds])];
  const collectionNamesById = await fetchCollectionNames(db, allCollectionIds);

  for (const assetId of assetIds) {
    for (const entry of results[assetId].cmsItems) {
      entry.collectionName = collectionNamesById[entry.collectionId] ?? 'Unknown Collection';
    }
    for (const entry of results[assetId].fieldDefaults) {
      entry.collectionName = collectionNamesById[entry.collectionId] ?? 'Unknown Collection';
    }
  }

  for (const assetId of assetIds) {
    const r = results[assetId];
    r.total = r.pages.length + r.components.length + r.cmsItems.length + r.fieldDefaults.length;
  }

  return results;
}

// =============================================================================
// Asset Cleanup Functions
// =============================================================================

/**
 * Remove asset references from rich text content
 */
function removeAssetFromRichText(content: any, assetId: string): any {
  if (!content || typeof content !== 'object') return content;

  // Clone the content to avoid mutation
  const cloned = JSON.parse(JSON.stringify(content));

  const processNode = (node: any): any => {
    if (!node || typeof node !== 'object') return node;

    // Remove richTextLink marks with matching asset
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.filter((mark: any) => {
        if (mark.type === 'richTextLink' && mark.attrs?.asset?.id === assetId) {
          return false; // Remove this mark
        }
        return true;
      });
    }

    // Recurse into content arrays
    if (Array.isArray(node.content)) {
      node.content = node.content.map(processNode);
    }

    return node;
  };

  if (Array.isArray(cloned)) {
    return cloned.map(processNode);
  }

  return processNode(cloned);
}

/**
 * Remove asset references from a single layer
 * Returns a new layer object with asset references nullified
 */
function removeAssetFromLayer(layer: Layer, assetId: string): Layer {
  const newLayer = JSON.parse(JSON.stringify(layer)) as Layer;

  // Image source
  if (isAssetVarWithId(newLayer.variables?.image?.src, assetId)) {
    (newLayer.variables!.image!.src as any).data.asset_id = null;
  }

  // Video source
  if (isAssetVarWithId(newLayer.variables?.video?.src, assetId)) {
    (newLayer.variables!.video!.src as any).data.asset_id = null;
  }

  // Video poster
  if (isAssetVarWithId(newLayer.variables?.video?.poster, assetId)) {
    (newLayer.variables!.video!.poster as any).data.asset_id = null;
  }

  // Audio source
  if (isAssetVarWithId(newLayer.variables?.audio?.src, assetId)) {
    (newLayer.variables!.audio!.src as any).data.asset_id = null;
  }

  // Icon source
  if (isAssetVarWithId(newLayer.variables?.icon?.src, assetId)) {
    (newLayer.variables!.icon!.src as any).data.asset_id = null;
  }

  // Link asset
  if (linkHasAssetId(newLayer.variables?.link, assetId)) {
    newLayer.variables!.link!.asset = { id: null };
  }

  // Rich text content
  const textVar = newLayer.variables?.text;
  if (textVar?.type === 'dynamic_rich_text' && (textVar as any).data?.content) {
    (textVar as any).data.content = removeAssetFromRichText((textVar as any).data.content, assetId);
  }

  // Component variable overrides (image type)
  if (newLayer.componentOverrides?.image) {
    const imageOverrides = newLayer.componentOverrides.image as Record<string, string>;
    for (const [key, value] of Object.entries(imageOverrides)) {
      if (value === assetId) {
        delete imageOverrides[key];
      }
    }
  }

  return newLayer;
}

/**
 * Recursively remove asset references from layers
 * Returns new layers array with asset references nullified
 */
function removeAssetFromLayers(layers: Layer[], assetId: string): Layer[] {
  return layers.map((layer) => {
    const newLayer = removeAssetFromLayer(layer, assetId);

    if (newLayer.children && newLayer.children.length > 0) {
      newLayer.children = removeAssetFromLayers(newLayer.children, assetId);
    }

    return newLayer;
  });
}

export interface AffectedPageEntity {
  pageId: string;
  previousLayers: Layer[];
  newLayers: Layer[];
}

export interface AffectedComponentEntity {
  componentId: string;
  previousLayers: Layer[];
  newLayers: Layer[];
}

export interface AssetCleanupResult {
  pagesUpdated: number;
  componentsUpdated: number;
  cmsItemsUpdated: number;
  fieldDefaultsUpdated: number;
  affectedPages: AffectedPageEntity[];
  affectedComponents: AffectedComponentEntity[];
}

/**
 * Clean up all references to an asset before deletion
 * Updates pages, components, and CMS items to remove the asset reference
 * Returns affected entities with before/after states for version tracking
 */
export async function cleanupAssetReferences(assetId: string): Promise<AssetCleanupResult> {
  const db = await getDb();

  let pagesUpdated = 0;
  let componentsUpdated = 0;
  let cmsItemsUpdated = 0;
  const affectedPages: AffectedPageEntity[] = [];
  const affectedComponents: AffectedComponentEntity[] = [];

  // 1. Update page layers (draft versions)
  const pageLayersRecords = await selectDraftRows<Array<{ id: string; page_id: string; layers: Layer[] | null }>[number]>(
    db,
    'page_layers',
    ['id', 'page_id', 'layers']
  );

  const pageLayersToUpdate: Array<{ id: string; pageId: string; previousLayers: Layer[]; newLayers: Layer[] }> = [];

  for (const record of pageLayersRecords) {
    if (record.layers && layersContainAsset(record.layers, assetId)) {
      const cleanedLayers = removeAssetFromLayers(record.layers, assetId);
      pageLayersToUpdate.push({
        id: record.id,
        pageId: record.page_id,
        previousLayers: record.layers,
        newLayers: cleanedLayers,
      });
    }
  }

  // Batch update page layers
  if (pageLayersToUpdate.length > 0) {
    for (const { id, pageId, previousLayers, newLayers } of pageLayersToUpdate) {
      const updateQuery = db('page_layers')
        .update({ layers: newLayers, updated_at: new Date().toISOString() })
        .where('id', id)
        .where('is_published', false);

      try {
        await updateScoped(db, 'page_layers', updateQuery);
        pagesUpdated++;
        affectedPages.push({ pageId, previousLayers, newLayers });
      } catch (error) {
        console.error(`Failed to update page_layers ${id}:`, error);
      }
    }
  }

  // 2. Update page settings (SEO images)
  const pagesData = await selectDraftRows<Array<{ id: string; settings: any }>[number]>(
    db,
    'pages',
    ['id', 'settings']
  );

  const pagesToUpdate: Array<{ id: string; settings: any }> = [];

  for (const page of pagesData) {
    if (pageSettingsContainAsset(page.settings, assetId)) {
      const newSettings = JSON.parse(JSON.stringify(page.settings));
      if (newSettings.seo?.image === assetId) {
        newSettings.seo.image = null;
      }
      pagesToUpdate.push({ id: page.id, settings: newSettings });
    }
  }

  // Batch update pages
  if (pagesToUpdate.length > 0) {
    for (const { id, settings } of pagesToUpdate) {
      const updateQuery = db('pages')
        .update({ settings, updated_at: new Date().toISOString() })
        .where('id', id)
        .where('is_published', false);

      try {
        await updateScoped(db, 'pages', updateQuery);
      } catch (error) {
        console.error(`Failed to update page ${id}:`, error);
      }
      // Note: page settings changes don't need layer version tracking
    }
  }

  // 3. Update components (draft versions)
  const components = await selectDraftRows<Array<{ id: string; layers: Layer[] | null }>[number]>(
    db,
    'components',
    ['id', 'layers']
  );

  const componentsToUpdate: Array<{ id: string; previousLayers: Layer[]; newLayers: Layer[] }> = [];

  for (const component of components) {
    if (component.layers && layersContainAsset(component.layers, assetId)) {
      const cleanedLayers = removeAssetFromLayers(component.layers, assetId);
      componentsToUpdate.push({
        id: component.id,
        previousLayers: component.layers,
        newLayers: cleanedLayers,
      });
    }
  }

  // Batch update components
  if (componentsToUpdate.length > 0) {
    for (const { id, previousLayers, newLayers } of componentsToUpdate) {
      const updateQuery = db('components')
        .update({ layers: newLayers, updated_at: new Date().toISOString() })
        .where('id', id)
        .where('is_published', false);

      try {
        await updateScoped(db, 'components', updateQuery);
        componentsUpdated++;
        affectedComponents.push({ componentId: id, previousLayers, newLayers });
      } catch (error) {
        console.error(`Failed to update component ${id}:`, error);
      }
    }
  }

  // 4. Update CMS collection item values (nullify asset references)
  const imageFields = await scopedQuery<Array<{ id: string }>[number]>(db, 'collection_fields', db('collection_fields')
    .select('id')
    .whereIn('type', ['image', 'file'])
    .where('is_published', false)
    .whereNull('deleted_at'));

  if (imageFields.length > 0) {
    const fieldIds = imageFields.map((f) => f.id);

    // Update all values that reference this asset to null
    const updateValuesQuery = db('collection_item_values')
      .update({ value: null, updated_at: new Date().toISOString() })
      .whereIn('field_id', fieldIds)
      .where('value', assetId)
      .where('is_published', false)
      .whereNull('deleted_at')
      .returning('id');

    try {
      const updatedValues = await scopedQuery<Array<{ id: string }>[number]>(db, 'collection_item_values', updateValuesQuery);
      cmsItemsUpdated = updatedValues.length;
    } catch (updateError) {
      console.error('Failed to update CMS values:', updateError);
    }
  }

  // 5. Update CMS link field values that embed asset references in JSON
  const linkFields = await scopedQuery<Array<{ id: string }>[number]>(db, 'collection_fields', db('collection_fields')
    .select('id')
    .where('type', 'link')
    .where('is_published', false)
    .whereNull('deleted_at'));

  if (linkFields.length > 0) {
    const linkFieldIds = linkFields.map((f) => f.id);

    try {
      const linkItemValues = await scopedQuery<Array<{ id: string; value: string | null }>[number]>(db, 'collection_item_values', db('collection_item_values')
        .select('id', 'value')
        .whereIn('field_id', linkFieldIds)
        .whereLike('value', `%${assetId}%`)
        .where('is_published', false)
        .whereNull('deleted_at'));

      for (const row of linkItemValues) {
        if (!row.value || !collectionLinkValueHasAsset(row.value, assetId)) continue;

        const cleanedValue = nullifyAssetInCollectionLinkValue(row.value);
        const updateQuery = db('collection_item_values')
          .update({ value: cleanedValue, updated_at: new Date().toISOString() })
          .where('id', row.id)
          .where('is_published', false);

        try {
          await updateScoped(db, 'collection_item_values', updateQuery);
          cmsItemsUpdated++;
        } catch (updateError) {
          console.error(`Failed to update link field value ${row.id}:`, updateError);
        }
      }
    } catch (linkValuesError) {
      console.error('Failed to fetch link field values:', linkValuesError);
    }
  }

  // 6. Update collection field defaults that reference this asset
  let fieldDefaultsUpdated = 0;
  const assetFieldsWithDefaults = await fetchAssetFieldsWithDefaults(db, ['id', 'default']);

  for (const field of assetFieldsWithDefaults) {
    const defaultVal = field.default as string;
    const parsedIds = parseDefaultAssetIds(defaultVal);

    if (!fieldDefaultReferencesAsset(defaultVal, assetId, parsedIds)) continue;

    // Compute new default: null for single-asset, filtered array for multi-asset
    let newDefault: string | null = null;
    if (parsedIds) {
      const filtered = parsedIds.filter((id) => id !== assetId);
      newDefault = filtered.length > 0 ? JSON.stringify(filtered) : null;
    }

    const updateQuery = db('collection_fields')
      .update({ default: newDefault, updated_at: new Date().toISOString() })
      .where('id', field.id)
      .where('is_published', false);

    try {
      await updateScoped(db, 'collection_fields', updateQuery);
      fieldDefaultsUpdated++;
    } catch (updateError) {
      console.error(`Failed to update field default ${field.id}:`, updateError);
    }
  }

  return {
    pagesUpdated,
    componentsUpdated,
    cmsItemsUpdated,
    fieldDefaultsUpdated,
    affectedPages,
    affectedComponents,
  };
}
