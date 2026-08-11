/**
 * @deprecated Supabase has been removed.
 * Use authClient / platform auth helpers and createRealtimeChannel instead.
 */
const REMOVAL_MESSAGE = 'Supabase removed; use authClient / createRealtimeChannel';

export async function createRouteClient(): Promise<never> {
  throw new Error(REMOVAL_MESSAGE);
}
