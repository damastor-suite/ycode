/**
 * @deprecated Compatibility shim — use @/lib/platform/db and @/lib/platform/tenant.
 * Kept so cloud overlays and transitional imports keep resolving during migration.
 */

import { AsyncLocalStorage } from 'async_hooks';

export {
  tenantStore,
  runWithTenantId,
  getTenantIdFromHeaders,
} from '@/lib/platform/tenant';

export { getDb, getDbOrNull } from '@/lib/platform/db';

/**
 * Formerly returned a Supabase service-role client.
 * Now always returns null — callers must use getDb() / repositories on Knex.
 */
export async function getSupabaseAdmin(_tenantId?: string): Promise<null> {
  console.warn(
    '[getSupabaseAdmin] Deprecated: Supabase client removed. Use getDb() from @/lib/platform/db'
  );
  return null;
}

export async function getSupabaseConfig(): Promise<null> {
  return null;
}

export async function testSupabaseConnection(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'Supabase removed — use DATABASE_URL and testDatabaseUrlConnection' };
}

export async function executeSql(sql: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { getDb } = await import('@/lib/platform/db');
    const db = await getDb();
    await db.raw(sql);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'SQL execution failed',
    };
  }
}

// Re-export ALS type surface for overlays that imported AsyncLocalStorage via this module
export { AsyncLocalStorage };
