import { NextResponse } from 'next/server';
import { getKnexClient } from '@/lib/knex-client';
import { getStorage } from '@/lib/platform/storage';
import { clearAllCache } from '@/lib/services/cacheService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/devtools/reset-db
 *
 * DANGEROUS: Deletes all tables in the public schema and empties storage buckets.
 * Authentication enforced by proxy.
 */
export async function POST() {
  try {
    console.log('[POST /ycode/api/devtools/reset-db] Starting database reset...');

    const knex = await getKnexClient();

    // Get all tables in the public schema
    const tables = await knex.raw(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `);

    console.log('[POST /ycode/api/devtools/reset-db] Found ' + tables.rows.length + ' tables');

    console.log('[POST /ycode/api/devtools/reset-db] Cleaning up known storage objects...');

    try {
      const storagePaths: string[] = [];
      const tableNames = new Set(tables.rows.map((row: { tablename: string }) => row.tablename));

      if (tableNames.has('assets')) {
        const assetRows = await knex('assets')
          .select('storage_path')
          .whereNotNull('storage_path') as Array<{ storage_path: string | null }>;
        storagePaths.push(...assetRows.map((row) => row.storage_path).filter(Boolean) as string[]);
      }

      if (tableNames.has('fonts')) {
        const fontRows = await knex('fonts')
          .select('storage_path')
          .whereNotNull('storage_path') as Array<{ storage_path: string | null }>;
        storagePaths.push(...fontRows.map((row) => row.storage_path).filter(Boolean) as string[]);
      }

      if (storagePaths.length > 0) {
        const storage = await getStorage();
        await storage.remove([...new Set(storagePaths)]);
        console.log(`[POST /ycode/api/devtools/reset-db] Removed ${storagePaths.length} storage object(s)`);
      }
    } catch (storageError) {
      console.log('[POST /ycode/api/devtools/reset-db] Storage cleanup error:', storageError);
    }

    await knex.raw(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
        LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);

    console.log('[POST /ycode/api/devtools/reset-db] All tables dropped successfully');

    // Purge CDN + data caches so the public site stops serving the dropped
    // content. No warming — there's nothing to render after a reset.
    try {
      await clearAllCache();
      console.log('[POST /ycode/api/devtools/reset-db] Cache invalidated');
    } catch (cacheError) {
      console.error('[POST /ycode/api/devtools/reset-db] Cache invalidation failed:', cacheError);
    }

    return NextResponse.json({
      data: { message: 'All public tables and storage buckets have been deleted' }
    });
  } catch (error) {
    console.error('[POST /ycode/api/devtools/reset-db] Unexpected error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reset database' },
      { status: 500 }
    );
  }
}
