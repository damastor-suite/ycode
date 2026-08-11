/**
 * @deprecated Supabase has been removed.
 * Use authClient for auth and createRealtimeChannel for live collaboration.
 */

const REMOVAL_MESSAGE = 'Supabase removed; use authClient / createRealtimeChannel';

export function resetBrowserClient(): void {
  // Compatibility no-op for legacy callers.
}

export async function createBrowserClient(): Promise<never> {
  throw new Error(REMOVAL_MESSAGE);
}

export async function createClient(): Promise<never> {
  throw new Error(REMOVAL_MESSAGE);
}
