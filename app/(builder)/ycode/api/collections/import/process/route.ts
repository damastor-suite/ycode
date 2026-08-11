import { NextRequest } from 'next/server';
import {
  getImportById,
  updateImportStatus,
  updateImportProgress,
  completeImport,
} from '@/lib/repositories/collectionImportRepository';
import { createItemsBulk, deleteItem, getMaxIdValue, getMaxManualOrder } from '@/lib/repositories/collectionItemRepository';
import { insertValuesBulk, insertValuesDirectPg, getValuesByFieldId } from '@/lib/repositories/collectionItemValueRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { generateUniqueSlug } from '@/lib/collection-utils';
import {
  convertValueForFieldType,
  SKIP_COLUMN,
  AUTO_FIELD_KEYS,
  truncateValue,
  getErrorMessage,
  isAssetFieldType,
  isValidUrl,
  extractRichTextImageUrls,
  replaceRichTextImageUrls,
} from '@/lib/csv-utils';
import { uploadFile } from '@/lib/file-upload';
import { findAssetsByFilenames } from '@/lib/repositories/assetRepository';
import { generateCollectionItemContentHash } from '@/lib/hash-utils';
import { noCache } from '@/lib/api-response';
import { getStorage } from '@/lib/platform/storage';
import { randomUUID } from 'crypto';
import type { CollectionField } from '@/types';

interface UploadedAsset {
  id: string;
  publicUrl: string;
}

/** Encode a URL that may contain unencoded characters like spaces. */
function sanitizeUrl(url: string): string {
  // Data URIs are already self-contained and can be huge — never re-parse them.
  if (url.startsWith('data:')) return url;
  try {
    return new URL(url).href;
  } catch {
    return encodeURI(url);
  }
}

/** Extract a decoded filename from a URL, or empty string if none found. */
function extractFilenameFromUrl(url: string): string {
  if (url.startsWith('data:')) return '';
  try {
    const segment = new URL(sanitizeUrl(url)).pathname.split('/').pop();
    if (segment && segment.includes('.')) {
      return decodeURIComponent(segment);
    }
  } catch { /* ignore */ }
  return '';
}

/** Download a file from a URL and upload it to the asset manager. */
async function downloadAndUploadAsset(url: string): Promise<UploadedAsset | null> {
  try {
    const response = await fetch(sanitizeUrl(url), {
      headers: { 'User-Agent': 'Ycode-CSV-Import/1.0' },
    });

    if (!response.ok) {
      console.error(`Failed to fetch asset from URL: ${url}, status: ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    let filename = extractFilenameFromUrl(url);
    if (!filename) {
      const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
      filename = `imported-${Date.now()}.${ext}`;
    }

    // Use arrayBuffer directly — avoids the extra blob→File copy
    const buffer = await response.arrayBuffer();
    const file = new File([buffer], filename, { type: contentType });
    const asset = await uploadFile(file, 'csv-import');

    if (!asset) {
      console.error(`Failed to upload asset from URL: ${url}`);
      return null;
    }

    return { id: asset.id, publicUrl: asset.public_url || url };
  } catch (error) {
    console.error(`Error downloading/uploading asset from URL: ${url}`, error);
    return null;
  }
}

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;
interface PreparedValue {
  item_id: string;
  field_id: string;
  value: string | null;
  is_published: boolean;
}

interface PendingAssetValue {
  index: number; // Index in the values array
  url: string;
  fieldType: string;
}

interface PreparedRow {
  rowNumber: number;
  itemId: string;
  item: { id: string; collection_id: string; manual_order: number; is_published: boolean; content_hash?: string };
  values: PreparedValue[];
  pendingAssets: PendingAssetValue[];
}

/**
 * Prepare a single CSV row into item + values, collecting conversion warnings.
 * Pure data transformation — no DB calls.
 * Asset fields are marked as pending for async download/upload.
 */
function prepareRow(
  row: Record<string, string>,
  rowNumber: number,
  collectionId: string,
  columnMapping: Record<string, string>,
  fieldMap: Map<string, CollectionField>,
  autoFields: { idField?: CollectionField; createdAtField?: CollectionField; updatedAtField?: CollectionField },
  slugContext: { slugField?: CollectionField; nameField?: CollectionField; usedSlugs: Set<string> },
  currentMaxId: number,
  manualOrder: number,
  now: string,
  warnings: string[]
): { prepared: PreparedRow; newMaxId: number } {
  const itemId = randomUUID();
  let maxId = currentMaxId;

  const values: PreparedValue[] = [];
  const pendingAssets: PendingAssetValue[] = [];

  // Auto-generated fields
  if (autoFields.idField) {
    maxId++;
    values.push({ item_id: itemId, field_id: autoFields.idField.id, value: String(maxId), is_published: false });
  }
  if (autoFields.createdAtField) {
    values.push({ item_id: itemId, field_id: autoFields.createdAtField.id, value: now, is_published: false });
  }
  if (autoFields.updatedAtField) {
    values.push({ item_id: itemId, field_id: autoFields.updatedAtField.id, value: now, is_published: false });
  }

  // Map CSV columns to field values
  for (const [csvColumn, fieldId] of Object.entries(columnMapping)) {
    if (!fieldId || fieldId === '' || fieldId === SKIP_COLUMN) continue;

    const field = fieldMap.get(fieldId);
    if (!field) continue;

    const rawValue = row[csvColumn] || '';
    const trimmedValue = rawValue.trim();

    // Handle asset fields (image, video, audio, document)
    if (isAssetFieldType(field.type) && trimmedValue && isValidUrl(trimmedValue)) {
      // Mark as pending asset to be downloaded
      const valueIndex = values.length;
      values.push({ item_id: itemId, field_id: fieldId, value: null, is_published: false });
      pendingAssets.push({
        index: valueIndex,
        url: trimmedValue,
        fieldType: field.type,
      });
      continue;
    }

    // Regular field conversion
    const convertedValue = convertValueForFieldType(rawValue, field.type);

    if (convertedValue !== null) {
      values.push({ item_id: itemId, field_id: fieldId, value: convertedValue, is_published: false });
    } else if (trimmedValue !== '') {
      // Non-empty value could not be converted — warn the user
      warnings.push(
        `Row ${rowNumber}, column "${csvColumn}": value "${truncateValue(rawValue)}" is not a valid ${field.type} for field "${field.name}", skipped`
      );
    }
  }

  // Ensure the slug is always populated. When the slug column isn't mapped (or
  // its cell is empty) derive a unique slug from the name field so items remain
  // routable instead of ending up with an empty slug.
  if (slugContext.slugField) {
    const slugFieldId = slugContext.slugField.id;
    const slugValue = values.find(v => v.field_id === slugFieldId);
    const hasSlug = !!slugValue?.value && slugValue.value.trim() !== '';

    if (hasSlug) {
      slugContext.usedSlugs.add(slugValue!.value!.trim());
    } else {
      const nameValue = slugContext.nameField
        ? values.find(v => v.field_id === slugContext.nameField!.id)?.value ?? ''
        : '';
      const generatedSlug = generateUniqueSlug(nameValue, slugContext.usedSlugs);

      if (slugValue) {
        slugValue.value = generatedSlug;
      } else {
        values.push({ item_id: itemId, field_id: slugFieldId, value: generatedSlug, is_published: false });
      }
    }
  }

  return {
    prepared: {
      rowNumber,
      itemId,
      item: { id: itemId, collection_id: collectionId, manual_order: manualOrder, is_published: false },
      values,
      pendingAssets,
    },
    newMaxId: maxId,
  };
}

/**
 * Load a batch of rows from a JSON file in storage.
 * Used when rows are too large for the request body — the client uploads
 * each batch as a small JSON file instead of sending the full CSV.
 */
async function loadBatchFromStorage(
  batchPath: string,
): Promise<Record<string, string>[]> {
  const storage = await getStorage();
  if (!storage.getObject) {
    throw new Error('Storage not configured');
  }

  const object = await storage.getObject(batchPath);
  if (!object) {
    console.error('Failed to download batch from storage:', batchPath);
    throw new Error('Failed to read batch file from storage');
  }

  const text = object.body.toString('utf-8');
  console.warn(`[csv-import] Downloaded batch from storage: ${(text.length / 1024).toFixed(0)}KB`);
  const rows = JSON.parse(text) as Record<string, string>[];

  try {
    await storage.remove([batchPath]);
  } catch { /* best-effort cleanup */ }

  return rows;
}

/**
 * POST /ycode/api/collections/import/process
 * Process the next batch of rows for an import job.
 *
 * Row delivery methods (in order of preference):
 *  1. rows[] in body — for batches that fit under Vercel's 4.5MB body limit
 *  2. batchStoragePath in body — client uploaded the batch as a JSON file to storage
 *
 * Body:
 *  - importId: string - The import job to process
 *  - rows?: Record<string, string>[] - Batch of CSV rows (small batches)
 *  - batchStoragePath?: string - Path to a batch JSON file in storage (large rows)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { importId, rows: clientRows, batchStoragePath } = body as {
      importId?: string;
      rows?: Record<string, string>[];
      batchStoragePath?: string;
    };

    if (!importId) {
      return noCache({ error: 'importId is required' }, 400);
    }

    let importJob = await getImportById(importId);
    if (!importJob) {
      return noCache({ error: 'Import job not found' }, 404);
    }

    // Skip if already completed or failed
    if (importJob.status === 'completed' || importJob.status === 'failed') {
      return noCache({
        data: {
          importId: importJob.id,
          status: importJob.status,
          message: 'Import already finished'
        }
      });
    }

    // Mark as processing
    if (importJob.status === 'pending') {
      await updateImportStatus(importJob.id, 'processing');
    }

    // Re-fetch to get the latest processed_rows value (prevents race conditions)
    const freshImportJob = await getImportById(importJob.id);
    if (!freshImportJob || freshImportJob.status === 'completed' || freshImportJob.status === 'failed') {
      return noCache({
        data: {
          importId: importJob.id,
          status: freshImportJob?.status || 'unknown',
          message: 'Import state changed'
        }
      });
    }
    importJob = freshImportJob;

    const startIndex = importJob.processed_rows + importJob.failed_rows;
    const csvMeta = importJob.csv_data as { storage_path?: string } | null;

    // Resolve rows: body → batch file in storage
    let rowsToProcess: Record<string, string>[];
    let isStorageFallback = false;

    if (clientRows && Array.isArray(clientRows) && clientRows.length > 0) {
      rowsToProcess = clientRows;
      console.warn(`[csv-import] Client body: ${clientRows.length} rows, startIndex=${startIndex}`);
    } else if (batchStoragePath) {
      console.warn(`[csv-import] Batch from storage: ${batchStoragePath}, startIndex=${startIndex}`);
      rowsToProcess = await loadBatchFromStorage(batchStoragePath);
      isStorageFallback = true;
    } else {
      rowsToProcess = [];
    }

    if (rowsToProcess.length === 0) {
      const errors = importJob.errors || [];
      await completeImport(importJob.id, importJob.processed_rows, importJob.failed_rows, errors);
      return noCache({
        data: {
          importId: importJob.id,
          status: 'completed',
          totalRows: importJob.total_rows,
          processedRows: importJob.processed_rows,
          failedRows: importJob.failed_rows,
          isComplete: true,
          errors: errors.slice(-10),
        }
      });
    }

    // Get collection fields (1 query, reused for all rows)
    const fields = await getFieldsByCollectionId(importJob.collection_id, false);
    const fieldMap = new Map(fields.map(f => [f.id, f]));

    // Find auto-generated fields
    const autoFields = {
      idField: fields.find(f => f.key === AUTO_FIELD_KEYS[0]),
      createdAtField: fields.find(f => f.key === AUTO_FIELD_KEYS[1]),
      updatedAtField: fields.find(f => f.key === AUTO_FIELD_KEYS[2]),
    };

    // Slug fallback: seed already-used slugs so auto-generated ones stay unique
    // across batches (each collection has its own slug field, so filtering by
    // field_id effectively scopes to this collection).
    const slugField = fields.find(f => f.key === 'slug');
    const nameField = fields.find(f => f.key === 'name');
    const usedSlugs = new Set<string>();
    if (slugField) {
      const existingSlugValues = await getValuesByFieldId(slugField.id, false);
      for (const v of existingSlugValues) {
        if (v.value) usedSlugs.add(v.value.trim());
      }
    }
    const slugContext = { slugField, nameField, usedSlugs };

    // Get max ID and max manual_order in parallel (2 queries)
    const [currentMaxIdResult, currentMaxOrderResult] = await Promise.all([
      getMaxIdValue(importJob.collection_id, false),
      getMaxManualOrder(importJob.collection_id, false),
    ]);
    let currentMaxId = currentMaxIdResult;
    const manualOrderOffset = currentMaxOrderResult + 1;

    const errors: string[] = [...(importJob.errors || [])];
    let processedCount = importJob.processed_rows;
    let failedCount = importJob.failed_rows;

    // --- Phase 1: Prepare all rows in memory (no DB calls) ---
    const now = new Date().toISOString();
    const preparedRows: PreparedRow[] = [];

    for (let i = 0; i < rowsToProcess.length; i++) {
      const row = rowsToProcess[i];
      const rowNumber = startIndex + i + 1;

      try {
        const { prepared, newMaxId } = prepareRow(
          row, rowNumber, importJob.collection_id,
          importJob.column_mapping, fieldMap, autoFields, slugContext,
          currentMaxId, manualOrderOffset + i, now, errors
        );
        currentMaxId = newMaxId;
        preparedRows.push(prepared);
      } catch (error) {
        failedCount++;
        errors.push(`Row ${rowNumber}: failed to prepare — ${getErrorMessage(error)}`);
      }
    }

    // --- Phase 1.5 & 1.6: Collect ALL asset URLs (asset fields + rich-text images) ---
    const allPendingAssets: Array<{ row: PreparedRow; asset: PendingAssetValue }> = [];
    for (const row of preparedRows) {
      for (const asset of row.pendingAssets) {
        allPendingAssets.push({ row, asset });
      }
    }

    const richTextFields = new Set(
      fields.filter(f => f.type === 'rich_text').map(f => f.id)
    );
    const richTextImageUrls = new Set<string>();
    if (richTextFields.size > 0) {
      for (const row of preparedRows) {
        for (const val of row.values) {
          if (!val.value || !richTextFields.has(val.field_id)) continue;
          for (const ref of extractRichTextImageUrls(val.value)) {
            richTextImageUrls.add(ref.src);
          }
        }
      }
    }

    const allUniqueUrls = new Set([
      ...allPendingAssets.map(a => a.asset.url),
      ...richTextImageUrls,
    ]);

    if (allUniqueUrls.size > 0) {
      console.warn(`[csv-import] Processing ${allUniqueUrls.size} unique asset URLs`);

      const urlToFilename = new Map<string, string>();
      const filenamesToCheck: string[] = [];
      for (const url of allUniqueUrls) {
        const filename = extractFilenameFromUrl(url);
        if (filename) {
          urlToFilename.set(url, filename);
          filenamesToCheck.push(filename);
        }
      }

      const existingAssets = await findAssetsByFilenames(filenamesToCheck);

      const urlToUploadedAsset = new Map<string, UploadedAsset>();
      const urlsToDownload: string[] = [];

      for (const url of allUniqueUrls) {
        const filename = urlToFilename.get(url);
        const existing = filename ? existingAssets[filename] : null;
        if (existing) {
          urlToUploadedAsset.set(url, { id: existing.id, publicUrl: existing.public_url || url });
        } else {
          urlsToDownload.push(url);
        }
      }

      const ASSET_CONCURRENCY = isStorageFallback ? 5 : 20;
      for (let i = 0; i < urlsToDownload.length; i += ASSET_CONCURRENCY) {
        const batch = urlsToDownload.slice(i, i + ASSET_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (url) => {
            const uploaded = await downloadAndUploadAsset(url);
            return { url, uploaded };
          })
        );
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.uploaded) {
            urlToUploadedAsset.set(result.value.url, result.value.uploaded);
          }
        }
      }

      for (const { row, asset } of allPendingAssets) {
        const uploaded = urlToUploadedAsset.get(asset.url);
        if (uploaded) {
          row.values[asset.index].value = uploaded.id;
        } else {
          errors.push(
            `Row ${row.rowNumber}: failed to import ${asset.fieldType} from URL "${truncateValue(asset.url)}", skipped`
          );
        }
      }

      if (richTextImageUrls.size > 0) {
        const rtUrlToAsset = new Map<string, { assetId: string; publicUrl: string }>();
        for (const url of richTextImageUrls) {
          const uploaded = urlToUploadedAsset.get(url);
          if (uploaded) {
            rtUrlToAsset.set(url, { assetId: uploaded.id, publicUrl: uploaded.publicUrl });
          }
        }
        if (rtUrlToAsset.size > 0) {
          for (const row of preparedRows) {
            for (const val of row.values) {
              if (!val.value || !richTextFields.has(val.field_id)) continue;
              val.value = replaceRichTextImageUrls(val.value, rtUrlToAsset);
            }
          }
        }
      }
    }

    // --- Phase 2: Compute content hashes and bulk insert ---
    // Set content_hash on each item before insert (avoids N update queries after)
    for (const row of preparedRows) {
      row.item.content_hash = generateCollectionItemContentHash(
        row.values.map(v => ({ field_id: v.field_id, value: v.value }))
      );
    }

    if (preparedRows.length > 0) {
      await createItemsBulk(preparedRows.map(r => r.item));

      const LARGE_VALUE_THRESHOLD = 500_000;

      // Separate rows with large values (need Knex direct PG) from normal ones
      const normalRows: PreparedRow[] = [];
      const largeRows: PreparedRow[] = [];

      for (const row of preparedRows) {
        if (row.values.some(v => (v.value?.length ?? 0) > LARGE_VALUE_THRESHOLD)) {
          largeRows.push(row);
        } else {
          normalRows.push(row);
        }
      }

      // Bulk insert all normal values in one call
      if (normalRows.length > 0) {
        const allValues = normalRows.flatMap(r => r.values);
        try {
          if (allValues.length > 0) {
            await insertValuesBulk(allValues);
          }
          processedCount += normalRows.length;
        } catch (error) {
          // Fallback: insert per row to identify which one failed
          for (const row of normalRows) {
            try {
              if (row.values.length > 0) {
                await insertValuesBulk(row.values);
              }
              processedCount++;
            } catch (rowError) {
              failedCount++;
              errors.push(`Row ${row.rowNumber}: DB insert failed — ${getErrorMessage(rowError)}`);
              try { await deleteItem(row.itemId); } catch { /* best-effort */ }
            }
          }
        }
      }

      // Large rows use direct PG with extended timeout
      for (const row of largeRows) {
        try {
          if (row.values.length > 0) {
            await insertValuesDirectPg(row.values);
          }
          processedCount++;
        } catch (error) {
          failedCount++;
          errors.push(`Row ${row.rowNumber}: DB insert failed — ${getErrorMessage(error)}`);
          try { await deleteItem(row.itemId); } catch { /* best-effort */ }
        }
      }
    }

    // Cap stored errors to prevent huge payloads
    if (errors.length > 100) {
      errors.splice(50, errors.length - 100);
      if (!errors.includes('...some errors omitted...')) {
        errors.splice(50, 0, '...some errors omitted...');
      }
    }

    // Update progress
    await updateImportProgress(importJob.id, processedCount, failedCount, errors);

    // Check if complete
    const isComplete = processedCount + failedCount >= importJob.total_rows;

    if (isComplete) {
      await completeImport(importJob.id, processedCount, failedCount, errors);

      // Clean up the CSV file from storage
      if (csvMeta?.storage_path) {
        try {
          const storage = await getStorage();
          await storage.remove([csvMeta.storage_path]);
        } catch { /* best-effort cleanup */ }
      }
    }

    return noCache({
      data: {
        importId: importJob.id,
        status: isComplete ? 'completed' : 'processing',
        totalRows: importJob.total_rows,
        processedRows: processedCount,
        failedRows: failedCount,
        isComplete,
        errors: errors.slice(-10), // Return last 10 errors for display
      }
    });
  } catch (error) {
    console.error('Error processing import:', error);
    return noCache(
      { error: getErrorMessage(error) },
      500
    );
  }
}
