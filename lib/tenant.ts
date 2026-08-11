/**
 * Tenant scoping helpers for shared-DB (multi-website) deployments.
 *
 * Opensource: resolveTenantId() returns null → no filters applied.
 * Cloud: overlay getTenantIdFromHeaders() reads x-tenant-id; background
 * jobs use runWithTenantId() which populates tenantStore.
 */

import { tenantStore } from '@/lib/tenant-context';

/**
 * Resolve active tenant id: explicit arg → ALS store → request headers.
 * Header lookup is dynamic to avoid pulling server-only modules into unit tests.
 */
export async function resolveTenantId(
  explicit?: string | null
): Promise<string | null> {
  if (explicit) {
    return explicit;
  }

  const fromStore = tenantStore.getStore();
  if (fromStore) {
    return fromStore;
  }

  try {
    const { getTenantIdFromHeaders } = await import('@/lib/supabase-server');
    return getTenantIdFromHeaders();
  } catch {
    return null;
  }
}

/**
 * Apply .eq('tenant_id', id) on a Supabase query builder when tenant context exists.
 *
 * Returns a boxed `{ query }` so the PostgREST thenable is not adopted by
 * async/Promise resolution (which would execute the query early).
 */
export async function applyTenantEq<T extends { eq: (column: string, value: string) => T }>(
  query: T,
  explicit?: string | null
): Promise<{ query: T }> {
  const tenantId = await resolveTenantId(explicit);
  if (!tenantId) {
    return { query };
  }
  return { query: query.eq('tenant_id', tenantId) };
}

/**
 * Stamp tenant_id onto insert/upsert payloads when tenant context exists.
 */
export async function stampTenantId<T extends Record<string, unknown>>(
  data: T,
  explicit?: string | null
): Promise<T & { tenant_id?: string }> {
  const tenantId = await resolveTenantId(explicit);
  if (!tenantId) {
    return data;
  }
  return { ...data, tenant_id: tenantId };
}

/**
 * Stamp tenant_id onto an array of insert/upsert rows.
 */
export async function stampTenantIdMany<T extends Record<string, unknown>>(
  rows: T[],
  explicit?: string | null
): Promise<Array<T & { tenant_id?: string }>> {
  const tenantId = await resolveTenantId(explicit);
  if (!tenantId) {
    return rows;
  }
  return rows.map((row) => ({ ...row, tenant_id: tenantId }));
}

/**
 * Storage path prefix for a tenant (`tenants/{id}/`) or empty in single-tenant mode.
 */
export function getTenantStoragePrefix(tenantId?: string | null): string {
  if (!tenantId) {
    return '';
  }
  return `tenants/${tenantId}/`;
}

/**
 * Delete all rows for a tenant from the given tables (children-first order).
 * No-op tables without tenant_id column. Used instead of TRUNCATE in shared DB.
 */
export async function deleteTenantRows(
  trx: {
    schema: { hasTable: (t: string) => Promise<boolean>; hasColumn: (t: string, c: string) => Promise<boolean> };
    (table: string): { where: (col: string, val: string) => { del: () => Promise<unknown> } };
  },
  tables: string[],
  tenantId: string
): Promise<void> {
  for (const table of tables) {
    const exists = await trx.schema.hasTable(table);
    if (!exists) continue;

    const hasTenantId = await trx.schema.hasColumn(table, 'tenant_id');
    if (!hasTenantId) continue;

    await trx(table).where('tenant_id', tenantId).del();
  }
}
