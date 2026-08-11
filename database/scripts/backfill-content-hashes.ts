/**
 * Backfill Content Hashes Script
 * 
 * This script calculates and stores content_hash for all existing entities:
 * - Pages (metadata hash)
 * - PageLayers (layers + CSS hash)
 * - Components (name + layers hash)
 * - LayerStyles (name + classes + design hash)
 * - Assets (all mutable fields hash)
 * - CollectionItems (EAV values hash)
 * 
 * Run this after the content_hash migrations have been applied.
 * 
 * Usage: npx tsx database/scripts/backfill-content-hashes.ts
 */

import type { Knex } from 'knex';

import {
  generatePageMetadataHash,
  generatePageLayersHash,
  generateComponentContentHash,
  generateLayerStyleContentHash,
  generateAssetContentHash,
  generateCollectionItemContentHash,
} from '../../lib/hash-utils';
import { getDb } from '../../lib/platform/db';

const PAGE_SIZE = 1000;
type DbRow = Record<string, unknown>;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function asBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

/**
 * Fetch all rows matching a query using pagination.
 */
async function fetchAllPaginated(
  db: Knex,
  table: string,
  applyFilters: (query: Knex.QueryBuilder) => Knex.QueryBuilder,
): Promise<DbRow[]> {
  const allRows: DbRow[] = [];
  let offset = 0;

  while (true) {
    const data = await applyFilters(db(table).select('*'))
      .limit(PAGE_SIZE)
      .offset(offset);

    if (data.length === 0) break;

    allRows.push(...data);

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allRows;
}

async function backfillPageHashes(db: Knex) {
  console.log('Backfilling page content hashes...');

  const pages = await fetchAllPaginated(db, 'pages', (q) =>
    q.whereNull('deleted_at').whereNull('content_hash')
  );

  if (pages.length === 0) {
    console.log('  No pages need backfilling');
    return;
  }

  let updated = 0;

  for (const page of pages) {
    try {
      const hash = generatePageMetadataHash({
        name: asString(page.name),
        slug: asString(page.slug),
        settings: page.settings || {},
        is_index: asBoolean(page.is_index),
        is_dynamic: asBoolean(page.is_dynamic),
        error_page: asNullableNumber(page.error_page),
      });

      await db('pages')
        .where({ id: asString(page.id) })
        .update({ content_hash: hash });
      updated++;
    } catch (error) {
      console.error(`  Error processing page ${asString(page.id)}:`, error);
    }
  }

  console.log(`  Updated ${updated} of ${pages.length} pages`);
}

async function backfillPageLayersHashes(db: Knex) {
  console.log('Backfilling page_layers content hashes...');

  const pageLayersRecords = await fetchAllPaginated(db, 'page_layers', (q) =>
    q.whereNull('deleted_at').whereNull('content_hash')
  );

  if (pageLayersRecords.length === 0) {
    console.log('  No page_layers need backfilling');
    return;
  }

  let updated = 0;

  for (const record of pageLayersRecords) {
    try {
      const hash = generatePageLayersHash({
        layers: record.layers || [],
        generated_css: record.generated_css || null,
      });

      await db('page_layers')
        .where({ id: asString(record.id) })
        .update({ content_hash: hash });
      updated++;
    } catch (error) {
      console.error(`  Error processing page_layers ${asString(record.id)}:`, error);
    }
  }

  console.log(`  Updated ${updated} of ${pageLayersRecords.length} page_layers records`);
}

async function backfillComponentHashes(db: Knex) {
  console.log('Backfilling component content hashes...');

  const components = await fetchAllPaginated(db, 'components', (q) =>
    q.whereNull('content_hash')
  );

  if (components.length === 0) {
    console.log('  No components need backfilling');
    return;
  }

  let updated = 0;

  for (const component of components) {
    try {
      const hash = generateComponentContentHash({
        name: asString(component.name),
        layers: component.layers || [],
      });

      await db('components')
        .where({ id: asString(component.id) })
        .update({ content_hash: hash });
      updated++;
    } catch (error) {
      console.error(`  Error processing component ${asString(component.id)}:`, error);
    }
  }

  console.log(`  Updated ${updated} of ${components.length} components`);
}

async function backfillLayerStyleHashes(db: Knex) {
  console.log('Backfilling layer_styles content hashes...');

  const styles = await fetchAllPaginated(db, 'layer_styles', (q) =>
    q.whereNull('content_hash')
  );

  if (styles.length === 0) {
    console.log('  No layer_styles need backfilling');
    return;
  }

  let updated = 0;

  for (const style of styles) {
    try {
      const hash = generateLayerStyleContentHash({
        name: asString(style.name),
        classes: asString(style.classes),
        design: style.design || {},
      });

      await db('layer_styles')
        .where({ id: asString(style.id) })
        .update({ content_hash: hash });
      updated++;
    } catch (error) {
      console.error(`  Error processing layer_style ${asString(style.id)}:`, error);
    }
  }

  console.log(`  Updated ${updated} of ${styles.length} layer_styles`);
}

async function backfillAssetHashes(db: Knex) {
  console.log('Backfilling asset content hashes...');

  const assets = await fetchAllPaginated(db, 'assets', (q) =>
    q.whereNull('content_hash').whereNull('deleted_at')
  );

  if (assets.length === 0) {
    console.log('  No assets need backfilling');
    return;
  }

  let updated = 0;

  for (const asset of assets) {
    try {
      const hash = generateAssetContentHash({
        filename: asString(asset.filename),
        storage_path: asNullableString(asset.storage_path),
        public_url: asNullableString(asset.public_url),
        file_size: asNumber(asset.file_size),
        mime_type: asString(asset.mime_type),
        width: asNullableNumber(asset.width),
        height: asNullableNumber(asset.height),
        asset_folder_id: asNullableString(asset.asset_folder_id),
        content: asNullableString(asset.content),
        source: asString(asset.source),
      });

      await db('assets')
        .where({
          id: asString(asset.id),
          is_published: asBoolean(asset.is_published),
        })
        .update({ content_hash: hash });
      updated++;
    } catch (error) {
      console.error(`  Error processing asset ${asString(asset.id)}:`, error);
    }
  }

  console.log(`  Updated ${updated} of ${assets.length} assets`);
}

async function backfillCollectionItemHashes(db: Knex) {
  console.log('Backfilling collection_items content hashes...');

  const items = await fetchAllPaginated(db, 'collection_items', (q) =>
    q.whereNull('deleted_at').whereNull('content_hash')
  );

  if (items.length === 0) {
    console.log('  No collection items need backfilling');
    return;
  }

  // Batch-fetch all values for these items
  const itemIds = items.map((item) => asString(item.id));

  // Fetch values in chunks to avoid oversized IN predicates.
  const CHUNK_SIZE = 200;
  const allValues: DbRow[] = [];
  for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + CHUNK_SIZE);
    const data = await db('collection_item_values')
      .select('item_id', 'field_id', 'value', 'is_published')
      .whereIn('item_id', chunk)
      .whereNull('deleted_at');

    allValues.push(...data);
  }

  // Group values by (item_id, is_published)
  const valuesMap = new Map<string, Array<{ field_id: string; value: string | null }>>();
  for (const row of allValues) {
    const key = `${asString(row.item_id)}:${asBoolean(row.is_published)}`;
    if (!valuesMap.has(key)) valuesMap.set(key, []);
    valuesMap.get(key)!.push({
      field_id: asString(row.field_id),
      value: asNullableString(row.value),
    });
  }

  let updated = 0;
  for (const item of items) {
    try {
      const key = `${asString(item.id)}:${asBoolean(item.is_published)}`;
      const values = valuesMap.get(key) || [];
      const hash = generateCollectionItemContentHash(values);

      await db('collection_items')
        .where({
          id: asString(item.id),
          is_published: asBoolean(item.is_published),
        })
        .update({ content_hash: hash });
      updated++;
    } catch (error) {
      console.error(`  Error processing collection_item ${asString(item.id)}:`, error);
    }
  }

  console.log(`  Updated ${updated} of ${items.length} collection items`);
}

async function main() {
  console.log('Starting content hash backfill...\n');

  try {
    const db = await getDb();

    await backfillPageHashes(db);
    await backfillPageLayersHashes(db);
    await backfillComponentHashes(db);
    await backfillLayerStyleHashes(db);
    await backfillAssetHashes(db);
    await backfillCollectionItemHashes(db);

    console.log('\n✅ Content hash backfill completed successfully');
  } catch (error) {
    console.error('\n❌ Backfill failed:', error);
    process.exit(1);
  }
}

// Run the script
main();
