/**
 * Webflow Migration Service
 *
 * Orchestrates a one-click migration of a Webflow CMS site into YCode:
 * creates collections + fields from the Webflow schema, imports items as
 * drafts, resolves cross-collection references, and publishes the items
 * that are currently live on Webflow.
 *
 * On re-sync we skip schema creation and only reconcile items.
 */

import { randomUUID } from 'crypto';

import { getAppSettingValue, setAppSetting } from '@/lib/repositories/appSettingsRepository';
import { uploadFile } from '@/lib/file-upload';
import { slugify } from '@/lib/collection-utils';
import {
  createCollection,
  getCollectionById,
} from '@/lib/repositories/collectionRepository';
import {
  createField,
  getFieldsByCollectionId,
  updateField,
} from '@/lib/repositories/collectionFieldRepository';
import {
  createItemsBulk,
  getItemsByCollectionId,
  publishItem,
} from '@/lib/repositories/collectionItemRepository';
import {
  insertValuesBulk,
  getValuesByItemIds,
} from '@/lib/repositories/collectionItemValueRepository';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';

import {
  listCollectionsWithFields,
  listItems,
  listLiveItemIds,
  getSite,
} from './index';
import {
  getCmsFieldType,
  isMultiAssetType,
  resolveOptionLabel,
  transformFieldValue,
} from './field-mapping';
import type {
  CollectionMigrationResult,
  SyncResult,
  WebflowAsset,
  WebflowCollection,
  WebflowCollectionMapping,
  WebflowField,
  WebflowImport,
  WebflowItem,
} from './types';
import type { CollectionField, CollectionFieldData } from '@/types';

// =============================================================================
// Constants
// =============================================================================

export const APP_ID = 'webflow';

/** Hidden YCode field key that stores the Webflow item id for tracking. */
const HIDDEN_FIELD_KEY = 'webflow_id';

/** Concurrency cap for asset downloads from Webflow's CDN. */
const ASSET_CONCURRENCY = 5;

/** Bulk insert chunk size to stay well under Supabase row limits. */
const BULK_CHUNK_SIZE = 500;

// =============================================================================
// Token + Imports State
// =============================================================================

/** Get the stored Webflow token, throwing if not configured. */
export async function requireWebflowToken(): Promise<string> {
  const token = await getAppSettingValue<string>(APP_ID, 'api_token');
  if (!token) throw new Error('Webflow token not configured');
  return token;
}

export async function getImports(): Promise<WebflowImport[]> {
  return (await getAppSettingValue<WebflowImport[]>(APP_ID, 'imports')) ?? [];
}

export async function saveImports(imports: WebflowImport[]): Promise<void> {
  await setAppSetting(APP_ID, 'imports', imports);
}

export async function getImportById(importId: string): Promise<WebflowImport | null> {
  const imports = await getImports();
  return imports.find((i) => i.id === importId) ?? null;
}

export async function updateImport(
  importId: string,
  patch: Partial<WebflowImport>
): Promise<WebflowImport | null> {
  const imports = await getImports();
  const idx = imports.findIndex((i) => i.id === importId);
  if (idx === -1) return null;

  imports[idx] = { ...imports[idx], ...patch };
  await saveImports(imports);
  return imports[idx];
}

export async function removeImport(importId: string): Promise<boolean> {
  const imports = await getImports();
  const remaining = imports.filter((i) => i.id !== importId);
  if (remaining.length === imports.length) return false;
  await saveImports(remaining);
  return true;
}

// =============================================================================
// Schema Creation
// =============================================================================

/**
 * Build the `data` payload for a YCode field from a Webflow field. Carries
 * over `validations.options` for Option fields and flags multi-asset fields.
 */
function buildFieldData(wfField: WebflowField): CollectionFieldData {
  if (isMultiAssetType(wfField.type)) {
    return { multiple: true };
  }

  if (wfField.type === 'Option') {
    const wfOptions = wfField.validations?.options ?? [];
    return {
      options: wfOptions.map((o) => ({ id: o.id, name: o.name.trim() })),
    };
  }

  return {};
}

/**
 * Merge Webflow option choices into an existing YCode Option field. Adds new
 * choices and refreshes renamed labels, keeping existing options to avoid
 * orphaning item values that reference them.
 */
async function syncOptionFieldChoices(
  ycodeField: CollectionField,
  wfField: WebflowField
): Promise<void> {
  const wfOptions = wfField.validations?.options ?? [];
  if (wfOptions.length === 0) return;

  const existing = Array.isArray(ycodeField.data?.options)
    ? ycodeField.data.options
    : [];
  const existingById = new Map(existing.map((o) => [o.id, o]));

  const merged: { id: string; name: string }[] = [];
  let changed = false;

  for (const wfOption of wfOptions) {
    const trimmed = wfOption.name.trim();
    const prev = existingById.get(wfOption.id);
    if (!prev) {
      merged.push({ id: wfOption.id, name: trimmed });
      changed = true;
    } else {
      if (prev.name !== trimmed) changed = true;
      merged.push({ id: wfOption.id, name: trimmed });
    }
  }

  // Carry over any YCode-only options (added manually in YCode) so we don't
  // lose them on re-sync.
  for (const opt of existing) {
    if (!wfOptions.some((wf) => wf.id === opt.id)) {
      merged.push(opt);
    }
  }

  if (!changed) return;

  await updateField(ycodeField.id, {
    data: { ...(ycodeField.data ?? {}), options: merged },
  });
}

interface CollectionScaffold {
  webflowCollection: WebflowCollection;
  ycodeCollectionId: string;
  ycodeCollectionName: string;
  fieldIdMap: Record<string, string>;
  fieldSlugMap: Record<string, string>;
  recordIdFieldId: string;
}

/**
 * Idempotently ensure a YCode collection + field exists for every Webflow
 * collection / field in the site. Reuses existing mappings (from a prior
 * migration of the same site) when available; only creates what's new.
 *
 * - New Webflow collection → create YCode collection + fields + tracking field.
 * - Existing Webflow collection (mapping present) → reuse YCode collection,
 *   add any new fields that appeared in Webflow since last migration.
 * - Existing collection whose YCode counterpart was deleted → recorded as an
 *   error and skipped.
 */
async function ensureScaffolds(
  webflowCollections: WebflowCollection[],
  existingMappings: WebflowCollectionMapping[],
  _errors: string[]
): Promise<CollectionScaffold[]> {
  const mappingByWebflowId = new Map<string, WebflowCollectionMapping>(
    existingMappings.map((m) => [m.webflowCollectionId, m])
  );

  const scaffolds: CollectionScaffold[] = [];
  const wfToYcodeCollectionId = new Map<string, string>();

  // Pass 1 — ensure YCode collections exist, so pass 2 can wire reference
  // fields to the right YCode collection id.
  for (let i = 0; i < webflowCollections.length; i++) {
    const wf = webflowCollections[i];
    const existing = mappingByWebflowId.get(wf.id);

    // Reuse the existing YCode collection only if it's still present (and not
    // soft-deleted). If the user deleted the YCode collection after a previous
    // migration, drop the stale mapping and recreate the collection from
    // scratch so re-importing actually brings the collection back.
    const existingCollection = existing
      ? await getCollectionById(existing.ycodeCollectionId)
      : null;

    if (existing && existingCollection) {
      wfToYcodeCollectionId.set(wf.id, existingCollection.id);
      scaffolds.push({
        webflowCollection: wf,
        ycodeCollectionId: existingCollection.id,
        ycodeCollectionName: existingCollection.name,
        fieldIdMap: { ...existing.fieldIdMap },
        fieldSlugMap: { ...existing.fieldSlugMap },
        recordIdFieldId: existing.recordIdFieldId,
      });
    } else {
      const collection = await createCollection({
        name: wf.displayName,
        order: i,
        is_published: false,
      });
      wfToYcodeCollectionId.set(wf.id, collection.id);
      scaffolds.push({
        webflowCollection: wf,
        ycodeCollectionId: collection.id,
        ycodeCollectionName: collection.name,
        fieldIdMap: {},
        fieldSlugMap: {},
        recordIdFieldId: '',
      });
    }
  }

  // Pass 2 — ensure each Webflow field has a matching YCode field, and that
  // a hidden tracking field exists. Missing-by-slug matching lets us recover
  // the mapping if a Webflow field was renamed or the mapping was lost.
  //
  // Imported fields are created with `key: null` (just like user-created
  // fields) so they remain editable / deletable in the CMS UI — the YCode
  // builder gates field editing behind `field.key`, treating any keyed field
  // as a built-in / system field.
  for (const scaffold of scaffolds) {
    const wf = scaffold.webflowCollection;
    const ycodeFields = await getFieldsByCollectionId(scaffold.ycodeCollectionId);
    const ycodeFieldBySlug = new Map<string, CollectionField>();
    for (const f of ycodeFields) {
      // Index by both `key` (legacy imports + system fields) and slugified
      // `name` so we can recover mappings for newly-imported user-style fields.
      if (f.key) ycodeFieldBySlug.set(f.key, f);
      const nameSlug = slugify(f.name);
      if (nameSlug && !ycodeFieldBySlug.has(nameSlug)) {
        ycodeFieldBySlug.set(nameSlug, f);
      }
    }
    let order = ycodeFields.reduce((max, f) => Math.max(max, (f.order ?? 0) + 1), 0);

    for (const wfField of wf.fields ?? []) {
      const existingFieldId = scaffold.fieldIdMap[wfField.id];
      if (existingFieldId) {
        const existingField = ycodeFields.find((f) => f.id === existingFieldId);
        if (existingField) {
          // Backfill: earlier versions of this migration set `key: slug` on
          // every imported field, which made the YCode CMS treat them as
          // built-in fields and block editing. Clear the key so users can
          // edit / duplicate / delete them like any user-created field.
          if (existingField.key && existingField.id !== scaffold.recordIdFieldId) {
            await updateField(existingField.id, { key: null });
            existingField.key = null;
          }
          // Re-sync: keep YCode's option list in step with Webflow when
          // Webflow adds new choices to an Option field after migration.
          if (wfField.type === 'Option') {
            await syncOptionFieldChoices(existingField, wfField);
          }
        }
        continue;
      }

      // Try to recover the mapping by slug before creating a duplicate field.
      const slug = slugify(wfField.slug);
      const matched = ycodeFieldBySlug.get(slug);
      if (matched) {
        scaffold.fieldIdMap[wfField.id] = matched.id;
        scaffold.fieldSlugMap[wfField.slug] = matched.id;
        if (matched.key && matched.id !== scaffold.recordIdFieldId) {
          await updateField(matched.id, { key: null });
          matched.key = null;
        }
        if (wfField.type === 'Option') {
          await syncOptionFieldChoices(matched, wfField);
        }
        continue;
      }

      const cmsType = getCmsFieldType(wfField.type);
      const referenceCollectionId = (wfField.type === 'Reference' || wfField.type === 'MultiReference')
        ? wfToYcodeCollectionId.get(wfField.validations?.collectionId ?? '') ?? null
        : null;

      const field = await createField({
        name: wfField.displayName,
        type: cmsType,
        collection_id: scaffold.ycodeCollectionId,
        order: order++,
        reference_collection_id: referenceCollectionId,
        data: buildFieldData(wfField),
        is_published: false,
      });

      scaffold.fieldIdMap[wfField.id] = field.id;
      scaffold.fieldSlugMap[wfField.slug] = field.id;
      ycodeFieldBySlug.set(slug, field);
    }

    // Ensure the hidden tracking field exists. The mapping may have been
    // dropped by a manual edit, so we re-resolve by key as a fallback.
    if (!scaffold.recordIdFieldId) {
      const existingTracking = ycodeFieldBySlug.get(HIDDEN_FIELD_KEY);
      if (existingTracking) {
        scaffold.recordIdFieldId = existingTracking.id;
      } else {
        const trackingField = await createField({
          name: 'Webflow ID',
          key: HIDDEN_FIELD_KEY,
          type: 'text',
          collection_id: scaffold.ycodeCollectionId,
          order: order++,
          hidden: true,
          is_computed: true,
          fillable: false,
          is_published: false,
        });
        scaffold.recordIdFieldId = trackingField.id;
      }
    }
  }

  return scaffolds;
}

// =============================================================================
// Asset Handling
// =============================================================================

/** Fingerprint a Webflow asset payload for re-sync caching. */
function assetFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((a) => fingerprintSingle(a as WebflowAsset)).join(',');
  }
  return fingerprintSingle(value as WebflowAsset);
}

function fingerprintSingle(asset: WebflowAsset | null | undefined): string {
  if (!asset) return '';
  return `${asset.fileId ?? ''}|${asset.url ?? ''}`;
}

interface UploadAssetsContext {
  /** Map url -> YCode asset id for download deduplication within a sync run. */
  cache: Map<string, string>;
  isMultiple: boolean;
}

/**
 * Download Webflow asset(s) and upload them to YCode storage, returning
 * either a single asset id (single asset field) or a JSON array of ids
 * (multi-asset field).
 */
async function uploadWebflowAssets(
  rawValue: unknown,
  ctx: UploadAssetsContext
): Promise<string | null> {
  const assets: WebflowAsset[] = [];

  if (Array.isArray(rawValue)) {
    for (const a of rawValue) {
      if (a && typeof a === 'object' && (a as WebflowAsset).url) {
        assets.push(a as WebflowAsset);
      }
    }
  } else if (rawValue && typeof rawValue === 'object' && (rawValue as WebflowAsset).url) {
    assets.push(rawValue as WebflowAsset);
  }

  if (assets.length === 0) return null;

  const targets = ctx.isMultiple ? assets : assets.slice(0, 1);
  const results: Array<{ index: number; assetId: string }> = [];
  const tasks: Array<{ asset: WebflowAsset; index: number }> = [];

  for (let i = 0; i < targets.length; i++) {
    const asset = targets[i];
    const cached = ctx.cache.get(asset.url);
    if (cached) {
      results.push({ index: i, assetId: cached });
    } else {
      tasks.push({ asset, index: i });
    }
  }

  for (let i = 0; i < tasks.length; i += ASSET_CONCURRENCY) {
    const batch = tasks.slice(i, i + ASSET_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ asset, index }) => {
        const res = await fetch(asset.url);
        if (!res.ok) return null;
        const buffer = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || 'application/octet-stream';
        const filename = asset.name
          || asset.fileName
          || asset.url.split('/').pop()?.split('?')[0]
          || 'webflow-asset';
        const file = new File([buffer], filename, { type: contentType });
        const uploaded = await uploadFile(file, 'webflow-migration');
        if (!uploaded) return null;
        ctx.cache.set(asset.url, uploaded.id);
        return { index, assetId: uploaded.id };
      })
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        results.push(outcome.value);
      }
    }
  }

  if (results.length === 0) return null;

  results.sort((a, b) => a.index - b.index);
  const ids = results.map((r) => r.assetId);
  return ctx.isMultiple ? JSON.stringify(ids) : ids[0];
}

// =============================================================================
// Item Build / Reconciliation Helpers
// =============================================================================

interface ItemBuildContext {
  scaffold: CollectionScaffold;
  /** Concurrent asset upload cache, shared across an entire collection import. */
  assetCache: Map<string, string>;
  /** Persisted fingerprints from a previous run, for re-sync skip-if-unchanged. */
  prevFingerprints: Map<string, string>;
  /** Updated fingerprints written back at the end of a sync. */
  newFingerprints: Map<string, string>;
}

interface BuiltItemValues {
  values: Record<string, string | null>;
  /** Whether this item has any reference / multi-reference values to resolve later. */
  hasReferences: boolean;
}

/**
 * Build the raw values map for a single Webflow item. References stay as raw
 * Webflow ids — pass 2 (`resolveReferences`) substitutes the YCode item ids.
 */
async function buildItemValues(
  item: WebflowItem,
  ctx: ItemBuildContext,
  existingItemValues?: Record<string, string>
): Promise<BuiltItemValues> {
  const { scaffold, assetCache, prevFingerprints, newFingerprints } = ctx;
  const result: Record<string, string | null> = {
    [scaffold.recordIdFieldId]: item.id,
  };
  let hasReferences = false;

  for (const wfField of scaffold.webflowCollection.fields ?? []) {
    const cmsFieldId = scaffold.fieldIdMap[wfField.id];
    if (!cmsFieldId) continue;

    const cmsType = getCmsFieldType(wfField.type);
    const raw = item.fieldData[wfField.slug];

    if (raw === undefined || raw === null) {
      result[cmsFieldId] = null;
      continue;
    }

    // Asset fields — download + re-upload, with fingerprint caching.
    if (wfField.type === 'Image' || wfField.type === 'MultiImage' || wfField.type === 'File') {
      const fpKey = `${item.id}:${wfField.id}`;
      const fp = assetFingerprint(raw);
      newFingerprints.set(fpKey, fp);

      const prevFp = prevFingerprints.get(fpKey);
      if (prevFp === fp && existingItemValues?.[cmsFieldId]) {
        result[cmsFieldId] = existingItemValues[cmsFieldId];
        continue;
      }

      result[cmsFieldId] = await uploadWebflowAssets(raw, {
        cache: assetCache,
        isMultiple: isMultiAssetType(wfField.type),
      });
      continue;
    }

    // Option fields — resolve id -> human-readable label.
    if (wfField.type === 'Option') {
      const label = typeof raw === 'string'
        ? resolveOptionLabel(raw, wfField.validations?.options)
        : raw;
      result[cmsFieldId] = transformFieldValue(label, wfField.type, cmsType);
      continue;
    }

    // Reference fields — keep raw Webflow id(s) for now, resolve in pass 2.
    if (wfField.type === 'Reference' || wfField.type === 'MultiReference') {
      hasReferences = true;
      result[cmsFieldId] = transformFieldValue(raw, wfField.type, cmsType);
      continue;
    }

    result[cmsFieldId] = transformFieldValue(raw, wfField.type, cmsType);
  }

  return { values: result, hasReferences };
}

// =============================================================================
// Items Pass: Drafts (Create / Update)
// =============================================================================

interface ImportItemsParams {
  scaffold: CollectionScaffold;
  webflowItems: WebflowItem[];
  prevFingerprints: Map<string, string>;
  newFingerprints: Map<string, string>;
  result: CollectionMigrationResult;
}

/**
 * Reconcile staged Webflow items into YCode drafts. Creates, updates, or
 * soft-deletes as needed. Returns a map of `webflowItemId -> ycodeItemId`
 * so pass 2 can resolve references locally without extra DB hits.
 */
async function importItemsAsDrafts(
  params: ImportItemsParams
): Promise<Map<string, string>> {
  const { scaffold, webflowItems, prevFingerprints, newFingerprints, result } = params;
  const assetCache = new Map<string, string>();

  // Load existing YCode items + their values so we can dirty-check.
  const { items: existingItems } = await getItemsByCollectionId(scaffold.ycodeCollectionId);
  const existingValues = existingItems.length > 0
    ? await getValuesByItemIds(existingItems.map((i) => i.id))
    : {};

  // webflowItemId -> ycodeItemId for items that already exist.
  const wfToCmsItem = new Map<string, string>();
  for (const item of existingItems) {
    const trackId = existingValues[item.id]?.[scaffold.recordIdFieldId];
    if (typeof trackId === 'string') {
      wfToCmsItem.set(trackId, item.id);
    }
  }

  const buildCtx: ItemBuildContext = {
    scaffold,
    assetCache,
    prevFingerprints,
    newFingerprints,
  };

  // Bulk inserts for new items.
  const newItemRecords: Array<{ id: string; collection_id: string; manual_order: number; is_published: boolean; is_publishable: boolean }> = [];
  const newValuesToInsert: Array<{ item_id: string; field_id: string; value: string | null }> = [];

  // Bulk upserts for existing items.
  const updates: Array<{ cmsItemId: string; values: Record<string, string | null> }> = [];

  for (let i = 0; i < webflowItems.length; i++) {
    const wfItem = webflowItems[i];
    const existingCmsItemId = wfToCmsItem.get(wfItem.id);

    if (existingCmsItemId) {
      const built = await buildItemValues(
        wfItem,
        buildCtx,
        existingValues[existingCmsItemId] as Record<string, string>
      );
      if (hasValueChanges(built.values, existingValues[existingCmsItemId])) {
        updates.push({ cmsItemId: existingCmsItemId, values: built.values });
      }
    } else {
      const cmsItemId = randomUUID();
      const built = await buildItemValues(wfItem, buildCtx);
      newItemRecords.push({
        id: cmsItemId,
        collection_id: scaffold.ycodeCollectionId,
        manual_order: i,
        is_published: false,
        is_publishable: true,
      });
      for (const [fieldId, value] of Object.entries(built.values)) {
        newValuesToInsert.push({ item_id: cmsItemId, field_id: fieldId, value });
      }
      wfToCmsItem.set(wfItem.id, cmsItemId);
      result.created++;
    }
  }

  if (newItemRecords.length > 0) {
    await createItemsBulk(newItemRecords);
    for (let i = 0; i < newValuesToInsert.length; i += BULK_CHUNK_SIZE) {
      await insertValuesBulk(newValuesToInsert.slice(i, i + BULK_CHUNK_SIZE));
    }
  }

  if (updates.length > 0) {
    await batchUpsertValues(updates);
    result.updated += updates.length;
  }

  // Soft-delete YCode items whose Webflow counterpart is gone.
  // An item is "gone" when it has a webflow_id (so it was previously synced)
  // but wasn't matched against any incoming item in this run.
  const seenWebflowIds = new Set(webflowItems.map((wi) => wi.id));
  const toDelete = existingItems
    .filter((item) => {
      const wfId = existingValues[item.id]?.[scaffold.recordIdFieldId];
      return typeof wfId === 'string' && wfId !== '' && !seenWebflowIds.has(wfId);
    })
    .map((item) => item.id);

  if (toDelete.length > 0) {
    await batchSoftDelete(toDelete);
    result.deleted += toDelete.length;
  }

  return wfToCmsItem;
}

/** Compare two value maps for any actual differences. */
function hasValueChanges(
  newValues: Record<string, string | null>,
  existing: Record<string, unknown> | undefined
): boolean {
  if (!existing) return true;
  for (const [fieldId, value] of Object.entries(newValues)) {
    const next = value ?? '';
    const prev = existing[fieldId];
    const prevStr = prev == null
      ? ''
      : typeof prev === 'object'
        ? JSON.stringify(prev)
        : String(prev);
    if (next !== prevStr) return true;
  }
  return false;
}

// =============================================================================
// Items Pass 2: Resolve References
// =============================================================================

interface ReferenceResolveParams {
  scaffolds: CollectionScaffold[];
  /** webflowCollectionId -> Map<webflowItemId, ycodeItemId> from pass 1. */
  itemMaps: Map<string, Map<string, string>>;
}

/**
 * Walk each collection's reference fields and replace the raw Webflow item
 * ids stored in pass 1 with the matching YCode item ids. Single Reference
 * fields store a string, MultiReference fields store a JSON array.
 */
async function resolveReferences(params: ReferenceResolveParams): Promise<void> {
  const { scaffolds, itemMaps } = params;

  for (const scaffold of scaffolds) {
    const refFields = (scaffold.webflowCollection.fields ?? []).filter(
      (f) => f.type === 'Reference' || f.type === 'MultiReference'
    );
    if (refFields.length === 0) continue;

    const itemMap = itemMaps.get(scaffold.webflowCollection.id);
    if (!itemMap || itemMap.size === 0) continue;

    // Load all current YCode item values once to avoid per-item DB queries.
    const ycodeItemIds = Array.from(itemMap.values());
    const valuesByItem = await getValuesByItemIds(ycodeItemIds);

    const updates: Array<{ cmsItemId: string; values: Record<string, string | null> }> = [];

    for (const cmsItemId of ycodeItemIds) {
      const itemValues = valuesByItem[cmsItemId];
      if (!itemValues) continue;

      const patch: Record<string, string | null> = {};

      for (const wfField of refFields) {
        const cmsFieldId = scaffold.fieldIdMap[wfField.id];
        if (!cmsFieldId) continue;

        const targetCollectionId = wfField.validations?.collectionId;
        if (!targetCollectionId) continue;
        const targetItemMap = itemMaps.get(targetCollectionId);
        if (!targetItemMap) continue;

        const raw = itemValues[cmsFieldId];

        if (wfField.type === 'Reference') {
          if (typeof raw !== 'string' || !raw) {
            patch[cmsFieldId] = null;
            continue;
          }
          patch[cmsFieldId] = targetItemMap.get(raw) ?? null;
        } else {
          // MultiReference — value is JSON array of Webflow ids
          let ids: string[] = [];
          if (typeof raw === 'string') {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string');
            } catch {
              // Not JSON — skip
            }
          } else if (Array.isArray(raw)) {
            ids = raw.filter((v): v is string => typeof v === 'string');
          }

          const resolved = ids
            .map((wfId) => targetItemMap.get(wfId))
            .filter((id): id is string => !!id);
          patch[cmsFieldId] = resolved.length > 0 ? JSON.stringify(resolved) : null;
        }
      }

      if (Object.keys(patch).length > 0) {
        updates.push({ cmsItemId, values: patch });
      }
    }

    if (updates.length > 0) {
      await batchUpsertValues(updates);
    }
  }
}

// =============================================================================
// Items Pass 3: Publish Live Items
// =============================================================================

/**
 * For each Webflow item that's currently live on the site, publish the
 * corresponding YCode draft so both rows (`is_published` true + false)
 * exist in the database.
 */
async function publishLiveItems(
  token: string,
  scaffold: CollectionScaffold,
  itemMap: Map<string, string>,
  result: CollectionMigrationResult
): Promise<void> {
  const liveIds = await listLiveItemIds(token, scaffold.webflowCollection.id);
  for (const wfId of liveIds) {
    const cmsItemId = itemMap.get(wfId);
    if (!cmsItemId) continue;

    try {
      await publishItem(cmsItemId);
      result.published++;
    } catch (error) {
      result.errors.push(
        `Failed to publish item ${wfId}: ${error instanceof Error ? error.message : 'unknown'}`
      );
    }
  }
}

// =============================================================================
// Public Orchestration: Migrate + Re-sync
// =============================================================================

/**
 * Look up an import by Webflow site id.
 */
function findImportBySiteId(imports: WebflowImport[], siteId: string): WebflowImport | undefined {
  return imports.find((i) => i.siteId === siteId);
}

/**
 * Build the final `WebflowCollectionMapping[]` list from scaffolds.
 * Preserves any prior mappings that were skipped this run (e.g. because the
 * Webflow collection is gone) so we don't lose history.
 */
function buildCollectionMappings(
  scaffolds: CollectionScaffold[],
  prior: WebflowCollectionMapping[]
): WebflowCollectionMapping[] {
  const seen = new Set(scaffolds.map((s) => s.webflowCollection.id));
  const fresh: WebflowCollectionMapping[] = scaffolds.map((scaffold) => ({
    webflowCollectionId: scaffold.webflowCollection.id,
    webflowCollectionName: scaffold.webflowCollection.displayName,
    webflowSlug: scaffold.webflowCollection.slug,
    ycodeCollectionId: scaffold.ycodeCollectionId,
    ycodeCollectionName: scaffold.ycodeCollectionName,
    recordIdFieldId: scaffold.recordIdFieldId,
    fieldIdMap: scaffold.fieldIdMap,
    fieldSlugMap: scaffold.fieldSlugMap,
    referenceFieldIds: (scaffold.webflowCollection.fields ?? [])
      .filter((f) => f.type === 'Reference' || f.type === 'MultiReference')
      .map((f) => f.id),
  }));
  // Keep mappings for prior collections we didn't touch so re-running migration
  // doesn't lose history (e.g. a temporarily-archived Webflow collection).
  const carried = prior.filter((m) => !seen.has(m.webflowCollectionId));
  return [...fresh, ...carried];
}

/**
 * Core sync loop — runs items / references / publish passes against an
 * already-built set of scaffolds. Shared between fresh migration and re-sync.
 */
async function runItemsSync(
  token: string,
  scaffolds: CollectionScaffold[],
  prevFingerprints: Map<string, string>,
  newFingerprints: Map<string, string>,
  result: SyncResult
): Promise<void> {
  const itemMaps = new Map<string, Map<string, string>>();
  const collectionResults = new Map<string, CollectionMigrationResult>();

  // Pass 1 — import items as drafts.
  for (const scaffold of scaffolds) {
    const collectionResult: CollectionMigrationResult = {
      webflowCollectionId: scaffold.webflowCollection.id,
      webflowCollectionName: scaffold.webflowCollection.displayName,
      ycodeCollectionId: scaffold.ycodeCollectionId,
      created: 0,
      updated: 0,
      deleted: 0,
      published: 0,
      errors: [],
    };
    collectionResults.set(scaffold.webflowCollection.id, collectionResult);

    try {
      const webflowItems = await listItems(token, scaffold.webflowCollection.id);
      const itemMap = await importItemsAsDrafts({
        scaffold,
        webflowItems,
        prevFingerprints,
        newFingerprints,
        result: collectionResult,
      });
      itemMaps.set(scaffold.webflowCollection.id, itemMap);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      collectionResult.errors.push(`Item import failed: ${message}`);
      result.errors.push(`[${scaffold.webflowCollection.displayName}] ${message}`);
    }
  }

  // Pass 2 — resolve references now that all collections have their items.
  try {
    await resolveReferences({ scaffolds, itemMaps });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Reference resolution failed: ${message}`);
  }

  // Pass 3 — publish items currently live in Webflow.
  for (const scaffold of scaffolds) {
    const collectionResult = collectionResults.get(scaffold.webflowCollection.id);
    const itemMap = itemMaps.get(scaffold.webflowCollection.id);
    if (!collectionResult || !itemMap) continue;
    try {
      await publishLiveItems(token, scaffold, itemMap, collectionResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      collectionResult.errors.push(`Publish pass failed: ${message}`);
    }
  }

  result.collections = Array.from(collectionResults.values());
}

/**
 * Idempotent migration / re-sync of a Webflow site into YCode.
 *
 * - First run: creates the YCode collections + fields and imports items.
 * - Subsequent runs against the same site: reuse the existing YCode
 *   collections, add any new collections / fields that appeared in Webflow,
 *   and reconcile items.
 *
 * Always returns the (created or updated) `WebflowImport` and a `SyncResult`
 * summarising the work done per collection.
 */
export async function runMigration(
  siteId: string
): Promise<{ import: WebflowImport; result: SyncResult }> {
  const token = await requireWebflowToken();

  const allImports = await getImports();
  const existing = findImportBySiteId(allImports, siteId);

  // Fetch site + schema in parallel; we always need both whether this is a
  // fresh import or a re-run.
  const [site, webflowCollections] = await Promise.all([
    getSite(token, siteId),
    listCollectionsWithFields(token, siteId),
  ]);

  // Find or create the import record. Reusing the same id on re-run keeps the
  // UI's import list stable.
  let importRecord: WebflowImport;
  if (existing) {
    importRecord = {
      ...existing,
      siteName: site.displayName,
      syncStatus: 'syncing',
      syncError: null,
    };
    await saveImports(allImports.map((i) => (i.id === existing.id ? importRecord : i)));
  } else {
    importRecord = {
      id: randomUUID(),
      siteId: site.id,
      siteName: site.displayName,
      collectionMappings: [],
      lastSyncedAt: null,
      syncStatus: 'syncing',
      syncError: null,
      assetFingerprints: {},
    };
    await saveImports([...allImports, importRecord]);
  }

  try {
    const result: SyncResult = {
      collections: [],
      syncedAt: new Date().toISOString(),
      errors: [],
    };

    // Build / augment the scaffolds — creates new YCode collections + fields
    // only for things that don't already exist in the import mapping.
    const scaffolds = await ensureScaffolds(
      webflowCollections,
      importRecord.collectionMappings,
      result.errors
    );

    const prevFingerprints = new Map(
      Object.entries(importRecord.assetFingerprints ?? {})
    );
    const newFingerprints = new Map<string, string>();

    await runItemsSync(token, scaffolds, prevFingerprints, newFingerprints, result);

    const finalImport: WebflowImport = {
      ...importRecord,
      collectionMappings: buildCollectionMappings(scaffolds, importRecord.collectionMappings),
      lastSyncedAt: result.syncedAt,
      syncStatus: 'idle',
      syncError: null,
      assetFingerprints: {
        ...(importRecord.assetFingerprints ?? {}),
        ...Object.fromEntries(newFingerprints),
      },
    };

    const refreshed = await getImports();
    await saveImports(
      refreshed.map((i) => (i.id === finalImport.id ? finalImport : i))
    );

    return { import: finalImport, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await updateImport(importRecord.id, { syncStatus: 'error', syncError: message });
    throw error;
  }
}

/**
 * Re-sync an existing import by id. Delegates to `runMigration` (which is
 * idempotent on `siteId`) so schema additions in Webflow are picked up too.
 */
export async function runResync(importId: string): Promise<SyncResult> {
  const importRecord = await getImportById(importId);
  if (!importRecord) throw new Error('Webflow import not found');

  const { result } = await runMigration(importRecord.siteId);
  return result;
}

// =============================================================================
// Bulk DB Helpers
// =============================================================================

/**
 * Bulk upsert values via raw SQL. Supabase's `.upsert()` can't target the
 * partial unique index that excludes soft-deleted rows, so we drop into
 * Knex for the ON CONFLICT clause — same approach used by the Airtable sync.
 */
async function batchUpsertValues(
  items: Array<{ cmsItemId: string; values: Record<string, string | null> }>
): Promise<void> {
  if (items.length === 0) return;

  const { getKnexClient } = await import('@/lib/knex-client');
  const { getTenantIdFromHeaders } = await import('@/lib/supabase-server');
  const knex = await getKnexClient();
  const tenantId = await getTenantIdFromHeaders();

  const now = new Date().toISOString();
  const rows = items.flatMap(({ cmsItemId, values }) =>
    Object.entries(values).map(([fieldId, value]) => ({
      id: randomUUID(),
      item_id: cmsItemId,
      field_id: fieldId,
      value,
      is_published: false,
      created_at: now,
      updated_at: now,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    }))
  );

  const cols = tenantId
    ? 'id, item_id, field_id, value, is_published, created_at, updated_at, tenant_id'
    : 'id, item_id, field_id, value, is_published, created_at, updated_at';
  const placeholders = tenantId
    ? '(?, ?, ?, ?, ?, ?, ?, ?)'
    : '(?, ?, ?, ?, ?, ?, ?)';

  for (let i = 0; i < rows.length; i += BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_CHUNK_SIZE);
    const params = tenantId
      ? chunk.flatMap((r) => [r.id, r.item_id, r.field_id, r.value, r.is_published, r.created_at, r.updated_at, tenantId])
      : chunk.flatMap((r) => [r.id, r.item_id, r.field_id, r.value, r.is_published, r.created_at, r.updated_at]);

    await knex.raw(
      `INSERT INTO collection_item_values (${cols})
       VALUES ${chunk.map(() => placeholders).join(', ')}
       ON CONFLICT (item_id, field_id, is_published) WHERE deleted_at IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      params
    );
  }
}

/** Soft-delete a batch of YCode items. */
async function batchSoftDelete(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;

  const now = new Date().toISOString();
  const db = await getDb();
  let query = db('collection_items')
    .update({ deleted_at: now, updated_at: now })
    .whereIn('id', itemIds)
    .where('is_published', false);
  query = await addTenantFilter(db, query, 'collection_items');
  await query;
}
