/**
 * Sync Utilities
 *
 * Shared logic for publishing (draft → published) and reverting (published → draft).
 * Both operations follow the same pattern with inverted is_published values.
 */

import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  getConflictColumns,
  resolveTenantIdForTable,
} from '@/lib/repositories/knex-repository-utils';
import { SUPABASE_QUERY_LIMIT, SUPABASE_WRITE_BATCH_SIZE } from '@/lib/supabase-constants';

/** Direction of the sync operation */
export type SyncDirection = 'publish' | 'revert';

/** Returns the source/target is_published flags for a given direction */
export function getSyncFlags(direction: SyncDirection) {
  return {
    source: direction === 'publish' ? false : true,
    target: direction === 'publish' ? true : false,
  } as const;
}

type DbRow = Record<string, unknown> & { id: string };

async function upsertRows(
  tableName: string,
  rows: DbRow[]
): Promise<void> {
  if (rows.length === 0) return;

  const knex = await getDb();
  const tenantId = await resolveTenantIdForTable(knex, tableName);
  const conflictColumns = await getConflictColumns(knex, tableName, ['id', 'is_published'], tenantId);
  const rowsWithTenant = await Promise.all(
    rows.map((row) => addTenantIdToRow(knex, tableName, row, tenantId ?? undefined))
  );

  for (let i = 0; i < rowsWithTenant.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batch = rowsWithTenant.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
    await knex(tableName)
      .insert(batch)
      .onConflict(conflictColumns)
      .merge();
  }
}

async function deleteRowsByIds(
  tableName: string,
  ids: string[],
  isPublished: boolean
): Promise<void> {
  if (ids.length === 0) return;

  const knex = await getDb();
  for (let i = 0; i < ids.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batch = ids.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
    let query = knex(tableName)
      .where('is_published', isPublished)
      .whereIn('id', batch)
      .del();
    query = await addTenantFilter(knex, query, tableName);
    await query;
  }
}

/**
 * Sync rows from source to target for a given table.
 * Copies all active (non-soft-deleted) rows from source side to target side
 * using upsert with the (id, is_published) composite key.
 *
 * @returns Number of rows synced
 */
export async function syncTableRows(
  tableName: string,
  direction: SyncDirection,
  options?: { ids?: string[]; excludeColumns?: string[] }
): Promise<number> {
  const knex = await getDb();
  const { source, target } = getSyncFlags(direction);

  let query = knex(tableName)
    .select('*')
    .where('is_published', source)
    .whereNull('deleted_at')
    .limit(SUPABASE_QUERY_LIMIT);

  if (options?.ids && options.ids.length > 0) {
    query = query.whereIn('id', options.ids);
  }

  query = await addTenantFilter(knex, query, tableName);
  const sourceRows = await query as DbRow[];

  if (sourceRows.length === 0) {
    return 0;
  }

  const now = new Date().toISOString();
  const exclude = new Set(options?.excludeColumns || []);
  const targetRows = sourceRows.map(row => {
    const mapped = { ...row, is_published: target, updated_at: now };
    for (const col of exclude) delete (mapped as Record<string, unknown>)[col];
    return mapped;
  });

  await upsertRows(tableName, targetRows);

  return targetRows.length;
}

export interface CleanupResult {
  deleted: number;
  preservedIds: string[];
  /** Values collected from orphaned rows for the columns specified in options.collectColumns */
  collected: Record<string, string[]>;
}

/**
 * Remove orphaned rows on the target side that have no counterpart on the source side.
 * For revert: deletes draft-only rows (never published).
 * For publish: deletes published-only rows (draft was deleted).
 *
 * @param options.preserveFilter - Protect orphan rows where column equals value; their IDs are returned in preservedIds.
 * @param options.excludeByColumn - Protect orphan rows where the given column's value is in the provided Set.
 * @param options.collectColumns - Column names to collect from orphaned rows before deletion (e.g. ['storage_path']).
 * @returns Deleted count, preserved orphan IDs, and collected column values
 */
export async function cleanupOrphanedRows(
  tableName: string,
  direction: SyncDirection,
  options?: {
    preserveFilter?: { column: string; value: unknown };
    excludeByColumn?: { column: string; ids: Set<string> };
    collectColumns?: string[];
  }
): Promise<CleanupResult> {
  const knex = await getDb();
  const { source, target } = getSyncFlags(direction);

  // Get all source IDs
  let sourceQuery = knex(tableName)
    .select('id')
    .where('is_published', source)
    .whereNull('deleted_at')
    .limit(SUPABASE_QUERY_LIMIT);
  sourceQuery = await addTenantFilter(knex, sourceQuery, tableName);
  const sourceRows = await sourceQuery as Array<{ id: string }>;

  const sourceIds = new Set(sourceRows.map(r => r.id));

  // Get all target rows
  let targetQuery = knex(tableName)
    .select('*')
    .where('is_published', target)
    .limit(SUPABASE_QUERY_LIMIT);
  targetQuery = await addTenantFilter(knex, targetQuery, tableName);
  const targetRows = await targetQuery as DbRow[];

  const orphanedIds: string[] = [];
  const preservedIds: string[] = [];
  const collected: Record<string, string[]> = {};
  const { preserveFilter, excludeByColumn, collectColumns } = options || {};

  if (collectColumns) {
    for (const col of collectColumns) collected[col] = [];
  }

  for (const row of targetRows) {
    const r = row as Record<string, unknown>;
    const id = r.id as string;

    if (sourceIds.has(id)) continue;

    if (excludeByColumn && excludeByColumn.ids.has(r[excludeByColumn.column] as string)) {
      continue;
    }

    if (preserveFilter && r[preserveFilter.column] === preserveFilter.value) {
      preservedIds.push(id);
    } else {
      orphanedIds.push(id);
      if (collectColumns) {
        for (const col of collectColumns) {
          const val = r[col];
          if (typeof val === 'string' && val) collected[col].push(val);
        }
      }
    }
  }

  if (orphanedIds.length === 0) {
    return { deleted: 0, preservedIds, collected };
  }

  await deleteRowsByIds(tableName, orphanedIds, target);

  return { deleted: orphanedIds.length, preservedIds, collected };
}

/**
 * Sync rows filtered by a parent foreign key instead of by row ID.
 * Used for tables like page_layers and collection_item_values
 * where we sync based on a parent entity.
 *
 * @param parentColumn - The FK column to filter on (e.g. 'page_id', 'item_id')
 * @param parentIds - The parent IDs to sync for
 * @returns Number of rows synced
 */
export async function syncTableRowsByParent(
  tableName: string,
  direction: SyncDirection,
  parentColumn: string,
  parentIds: string[]
): Promise<number> {
  if (parentIds.length === 0) return 0;

  const knex = await getDb();
  const { source, target } = getSyncFlags(direction);
  const now = new Date().toISOString();
  let totalSynced = 0;

  for (let i = 0; i < parentIds.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batchIds = parentIds.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);

    let query = knex(tableName)
      .select('*')
      .where('is_published', source)
      .whereNull('deleted_at')
      .whereIn(parentColumn, batchIds);
    query = await addTenantFilter(knex, query, tableName);
    const sourceRows = await query as DbRow[];

    if (sourceRows.length === 0) continue;

    const targetRows = sourceRows.map(row => ({
      ...row,
      is_published: target,
      updated_at: now,
    }));

    await upsertRows(tableName, targetRows);

    totalSynced += targetRows.length;
  }

  return totalSynced;
}

/**
 * Remove orphaned child rows on the target side by parent FK.
 * Used after syncTableRowsByParent to clean up children whose parents were removed.
 */
export async function cleanupOrphanedChildRows(
  tableName: string,
  direction: SyncDirection,
  parentColumn: string,
  parentTable: string
): Promise<number> {
  const knex = await getDb();
  const { source, target } = getSyncFlags(direction);

  // Get all source parent IDs (active parents)
  let parentQuery = knex(parentTable)
    .select('id')
    .where('is_published', source)
    .whereNull('deleted_at')
    .limit(SUPABASE_QUERY_LIMIT);
  parentQuery = await addTenantFilter(knex, parentQuery, parentTable);
  const sourceParents = await parentQuery as Array<{ id: string }>;

  const sourceParentIds = new Set(sourceParents.map(r => r.id));

  // Get target child rows and find ones with orphaned parents
  let childQuery = knex(tableName)
    .select('*')
    .where('is_published', target)
    .limit(SUPABASE_QUERY_LIMIT);
  childQuery = await addTenantFilter(knex, childQuery, tableName);
  const targetChildren = await childQuery as DbRow[];

  const orphanedIds = targetChildren
    .filter(row => !sourceParentIds.has((row as Record<string, unknown>)[parentColumn] as string))
    .map(row => (row as Record<string, unknown>).id as string);

  if (orphanedIds.length === 0) return 0;

  await deleteRowsByIds(tableName, orphanedIds, target);

  return orphanedIds.length;
}

/**
 * Count soft-deleted draft rows that still have a published counterpart.
 * Works for any table with (id, is_published, deleted_at) columns.
 */
export async function getDeletedDraftCount(tableName: string): Promise<number> {
  const knex = await getDb();
  let draftQuery = knex(tableName)
    .select('id')
    .where('is_published', false)
    .whereNotNull('deleted_at')
    .limit(SUPABASE_QUERY_LIMIT);
  draftQuery = await addTenantFilter(knex, draftQuery, tableName);
  const deletedDrafts = await draftQuery as Array<{ id: string }>;

  if (deletedDrafts.length === 0) return 0;

  let countQuery = knex(tableName)
    .count<{ count: string | number }[]>({ count: '*' })
    .whereIn('id', deletedDrafts.map(d => d.id))
    .where('is_published', true);
  countQuery = await addTenantFilter(knex, countQuery, tableName);
  const [row] = await countQuery;

  return Number(row?.count ?? 0);
}
