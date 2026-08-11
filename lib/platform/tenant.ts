/**
 * Tenant context for multi-site Postgres (shared tables + tenant_id).
 *
 * OSS: returns a default tenant id when sites.default exists, else null
 *      (queries skip tenant filter until default tenant is seeded).
 * Cloud: overlay replaces getTenantIdFromHeaders to read x-tenant-id.
 */

import { AsyncLocalStorage } from 'async_hooks';

export const tenantStore = new AsyncLocalStorage<string>();

/** Run an async function with an explicit tenant context. */
export function runWithTenantId<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(tenantId, fn);
}

/**
 * Get tenant ID from request headers or ALS.
 *
 * Base implementation: ALS first, then env DEFAULT_TENANT_ID, else null.
 * Overridden via path alias in multi-tenant cloud deployments.
 */
export async function getTenantIdFromHeaders(): Promise<string | null> {
  const fromStore = tenantStore.getStore();
  if (fromStore) {
    return fromStore;
  }

  const fromEnv = process.env.DEFAULT_TENANT_ID;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  return null;
}
