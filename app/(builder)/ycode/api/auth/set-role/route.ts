import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getAuthUser } from '@/lib/platform/auth';
import { getDb } from '@/lib/platform/db';
import { ALL_ROLES, canManageMembers, resolveRole } from '@/lib/roles';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/auth/set-role
 *
 * Set a user's role in the Better Auth user table.
 * Requires the caller to be owner or admin.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, role } = body;

    if (!userId || !role) {
      return noCache({ error: 'userId and role are required' }, 400);
    }

    if (!ALL_ROLES.includes(role)) {
      return noCache({ error: `Invalid role. Must be one of: ${ALL_ROLES.join(', ')}` }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const db = await getDb();
    const callerRole = resolveRole(auth.user.role);
    const userCountRow = await db('user').count<{ count: string }[]>({ count: '*' }).first();
    const userCount = Number(userCountRow?.count || 0);
    const isFirstUserBootstrap = userCount === 1 && auth.user.id === userId && role === 'owner';

    if (!isFirstUserBootstrap) {
      if (!canManageMembers(callerRole)) {
        return noCache({ error: 'Insufficient permissions' }, 403);
      }

      if (role === 'owner' && callerRole !== 'owner') {
        return noCache({ error: 'Only the owner can assign the owner role' }, 403);
      }
    }

    await db('user')
      .where('id', userId)
      .update({
        role,
        updatedAt: new Date(),
      });

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[set-role] Unexpected error:', error);
    return noCache({ error: 'Failed to set role' }, 500);
  }
}
