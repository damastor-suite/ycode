/**
 * Storage Utilities
 *
 * Shared helpers for managing files in platform storage.
 */

import { SUPABASE_QUERY_LIMIT, SUPABASE_WRITE_BATCH_SIZE } from '@/lib/supabase-constants';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import { getStorage } from '@/lib/platform/storage';

/**
 * Delete files from Supabase Storage in batches.
 * Best-effort: logs errors but does not throw.
 */
export async function deleteStorageFiles(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;

  const storage = await getStorage();

  let deletedCount = 0;
  for (let i = 0; i < paths.length; i += SUPABASE_WRITE_BATCH_SIZE) {
    const batch = paths.slice(i, i + SUPABASE_WRITE_BATCH_SIZE);
    try {
      await storage.remove(batch);
      deletedCount += batch.length;
    } catch (error) {
      console.error(
        `Failed to delete ${batch.length} files from storage:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return deletedCount;
}

/**
 * Delete storage files only if their storage_path is no longer referenced
 * by any row in the given table (neither draft nor published).
 * Safe to call after deleting DB rows — verifies before removing files.
 */
export async function cleanupOrphanedStorageFiles(
  tableName: string,
  storagePaths: string[]
): Promise<number> {
  if (storagePaths.length === 0) return 0;

  const knex = await getDb();

  // Find which paths are still referenced by any row in the table
  let query = knex(tableName)
    .select('storage_path')
    .whereIn('storage_path', storagePaths)
    .limit(SUPABASE_QUERY_LIMIT);
  query = await addTenantFilter(knex, query, tableName);
  const existingRows = await query as Array<{ storage_path: string | null }>;

  const stillReferenced = new Set(
    existingRows.map(r => r.storage_path).filter((path): path is string => Boolean(path))
  );

  const orphanedPaths = storagePaths.filter(p => !stillReferenced.has(p));

  return deleteStorageFiles(orphanedPaths);
}
