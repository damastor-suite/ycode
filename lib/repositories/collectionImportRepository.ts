import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb, isMissingTableError } from '@/lib/platform/db';
import { getStorage } from '@/lib/platform/storage';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import type { CollectionImport, CollectionImportStatus } from '@/types';

/**
 * Collection Import Repository
 *
 * Handles CRUD operations for CSV import jobs.
 * Supports background processing with status tracking.
 */

export interface CreateImportData {
  collection_id: string;
  column_mapping: Record<string, string>;
  total_rows: number;
  csv_storage_path: string;
}

const STALE_IMPORT_HOURS = 2;

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

/**
 * Create a new import job
 */
export async function createImport(data: CreateImportData): Promise<CollectionImport> {
  const knex = await getDb();

  const row = await addTenantIdToRow({
    collection_id: data.collection_id,
    column_mapping: data.column_mapping,
    csv_data: { storage_path: data.csv_storage_path },
    total_rows: data.total_rows,
    status: 'pending',
    processed_rows: 0,
    failed_rows: 0,
    errors: [],
  });

  try {
    const [result] = await knex('collection_imports').insert(row).returning('*');
    return result as CollectionImport;
  } catch (error) {
    throw new Error(`Failed to create import: ${getErrorMessage(error)}`);
  }
}

/**
 * Get import by ID
 */
export async function getImportById(id: string): Promise<CollectionImport | null> {
  const knex = await getDb();

  try {
    let query = knex('collection_imports')
      .select('*')
      .where('id', id);
    query = await addTenantFilter(knex, query, 'collection_imports');

    const data = await query.first();
    return data ? data as CollectionImport : null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch import: ${getErrorMessage(error)}`);
  }
}

/**
 * Get pending or processing imports (for background processing)
 */
export async function getPendingImports(limit: number = 5): Promise<CollectionImport[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_imports')
      .select('*')
      .whereIn('status', ['pending', 'processing'])
      .orderBy('created_at', 'asc')
      .limit(limit);
    query = await addTenantFilter(knex, query, 'collection_imports');

    return await query as CollectionImport[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch pending imports: ${getErrorMessage(error)}`);
  }
}

/**
 * Update import status
 */
export async function updateImportStatus(
  id: string,
  status: CollectionImportStatus
): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('collection_imports').where('id', id);
    query = await addTenantFilter(knex, query, 'collection_imports');

    await query.update({
      status,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    throw new Error(`Failed to update import status: ${getErrorMessage(error)}`);
  }
}

/**
 * Update import progress
 */
export async function updateImportProgress(
  id: string,
  processedRows: number,
  failedRows: number,
  errors: string[] | null = null
): Promise<void> {
  const knex = await getDb();
  const updateData: Record<string, unknown> = {
    processed_rows: processedRows,
    failed_rows: failedRows,
    updated_at: new Date().toISOString(),
  };

  if (errors !== null) {
    updateData.errors = errors;
  }

  try {
    let query = knex('collection_imports').where('id', id);
    query = await addTenantFilter(knex, query, 'collection_imports');

    await query.update(updateData);
  } catch (error) {
    throw new Error(`Failed to update import progress: ${getErrorMessage(error)}`);
  }
}

/**
 * Mark import as completed
 */
export async function completeImport(
  id: string,
  processedRows: number,
  failedRows: number,
  errors: string[]
): Promise<void> {
  const knex = await getDb();
  const status: CollectionImportStatus = failedRows > 0 && processedRows === 0 ? 'failed' : 'completed';

  try {
    let query = knex('collection_imports').where('id', id);
    query = await addTenantFilter(knex, query, 'collection_imports');

    await query.update({
      status,
      processed_rows: processedRows,
      failed_rows: failedRows,
      errors: errors.length > 0 ? errors : null,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    throw new Error(`Failed to complete import: ${getErrorMessage(error)}`);
  }
}

/**
 * Delete import job
 */
export async function deleteImport(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('collection_imports').where('id', id);
    query = await addTenantFilter(knex, query, 'collection_imports');
    await query.del();
  } catch (error) {
    throw new Error(`Failed to delete import: ${getErrorMessage(error)}`);
  }
}

/**
 * Get imports for a collection
 */
export async function getImportsByCollectionId(collectionId: string): Promise<CollectionImport[]> {
  const knex = await getDb();

  try {
    let query = knex('collection_imports')
      .select('*')
      .where('collection_id', collectionId)
      .orderBy('created_at', 'desc');
    query = await addTenantFilter(knex, query, 'collection_imports');

    return await query as CollectionImport[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch imports: ${getErrorMessage(error)}`);
  }
}

/**
 * Clean up stale import jobs and their CSV files from storage.
 * Targets imports older than STALE_IMPORT_HOURS that are still pending/processing
 * (i.e. the user closed the page or the server crashed).
 */
export async function cleanupStaleImports(): Promise<void> {
  const knex = await getDb();
  const cutoff = new Date(Date.now() - STALE_IMPORT_HOURS * 60 * 60 * 1000).toISOString();

  try {
    let staleQuery = knex('collection_imports')
      .select('id', 'csv_data')
      .whereIn('status', ['pending', 'processing'])
      .andWhere('updated_at', '<', cutoff);
    staleQuery = await addTenantFilter(knex, staleQuery, 'collection_imports');

    const staleImports = await staleQuery as Array<Pick<CollectionImport, 'id' | 'csv_data'>>;
    if (staleImports.length === 0) return;

    const storagePaths: string[] = [];
    const importIds: string[] = [];

    for (const imp of staleImports) {
      importIds.push(imp.id);
      const csvData = imp.csv_data as { storage_path?: string } | null;
      if (csvData?.storage_path) {
        storagePaths.push(csvData.storage_path);
      }
    }

    if (storagePaths.length > 0) {
      try {
        const storage = await getStorage();
        await storage.remove(storagePaths);
      } catch {
        // best-effort cleanup
      }
    }

    let updateQuery = knex('collection_imports').whereIn('id', importIds);
    updateQuery = await addTenantFilter(knex, updateQuery, 'collection_imports');
    await updateQuery.update({
      status: 'failed' as CollectionImportStatus,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    if (isMissingTableError(error)) return;
    throw new Error(`Failed to cleanup stale imports: ${getErrorMessage(error)}`);
  }
}
