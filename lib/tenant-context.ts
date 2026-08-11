import { AsyncLocalStorage } from 'async_hooks';

/**
 * Explicit tenant context for code running outside of a Next.js request
 * (e.g. fire-and-forget webhook processing where headers() is unavailable).
 */
export const tenantStore = new AsyncLocalStorage<string>();

/** Run an async function with an explicit tenant context. */
export function runWithTenantId<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStore.run(tenantId, fn);
}
