import { credentials } from '@/lib/credentials';
import { noCache } from '@/lib/api-response';
import { getDbOrNull } from '@/lib/platform/db';
import type { DatabaseConfig } from '@/types';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Check if at least one auth user exists (setup fully complete)
 */
async function hasAuthUsers(): Promise<boolean> {
  try {
    const db = await getDbOrNull();
    if (!db) return false;

    const row = await db('user').count<{ count: string }[]>({ count: '*' }).first();
    return Number(row?.count || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * GET /ycode/api/setup/status
 *
 * Check if the database is configured and detect environment.
 * Also returns is_setup_complete when config + migrations + admin user exist.
 */
export async function GET() {
  try {
    const config = await credentials.get<DatabaseConfig>('database_config');
    const isVercel = process.env.VERCEL === '1';

    // If no config, return not configured
    if (!config) {
      return noCache({
        is_configured: false,
        is_setup_complete: false,
        is_vercel: isVercel,
      });
    }

    // Check if setup is fully complete (has at least one auth user)
    const setupComplete = await hasAuthUsers();

    return noCache({
      is_configured: true,
      is_setup_complete: setupComplete,
      is_vercel: isVercel,
    });
  } catch (error) {
    console.error('Setup status check failed:', error);

    return noCache(
      { error: 'Failed to check setup status' },
      500
    );
  }
}
