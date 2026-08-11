import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getCallerInfo, requireManageMembers } from '@/lib/roles-server';
import { resolveRole, ASSIGNABLE_ROLES } from '@/lib/roles';
import { getDb } from '@/lib/platform/db';

interface AuthUserRow {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: string | null;
  createdAt: Date | string | null;
}

interface AuthAccountRow {
  userId: string;
  password: string | null;
}

interface VerificationRow {
  identifier: string | null;
  createdAt: Date | string | null;
}

function toIsoString(value: Date | string | null): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

/**
 * GET /ycode/api/auth/users
 *
 * List all users with their status (active or pending invite) and roles.
 */
export async function GET(request: NextRequest) {
  try {
    const db = await getDb();

    const caller = await getCallerInfo();

    const activeUsers: Array<{
      id: string;
      email: string;
      display_name: string | null;
      avatar_url: string | null;
      role: string;
      created_at: string;
      last_sign_in_at: string | null;
    }> = [];

    const pendingInvites: Array<{
      id: string;
      email: string;
      role: string;
      invited_at: string;
    }> = [];

    const users = await db<AuthUserRow>('user')
      .select('id', 'email', 'name', 'image', 'role', 'createdAt')
      .orderBy('createdAt', 'asc');
    const accounts = await db<AuthAccountRow>('account')
      .select('userId', 'password')
      .where('providerId', 'credential');
    const inviteRows = await db<VerificationRow>('verification')
      .select('identifier', 'createdAt')
      .whereLike('identifier', 'invite:%');

    const credentialUserIds = new Set(
      accounts.filter(account => account.password).map(account => account.userId)
    );
    const invitedAtByUserId = new Map(
      inviteRows
        .filter(row => row.identifier)
        .map(row => [row.identifier!.replace('invite:', ''), toIsoString(row.createdAt)])
    );

    for (const user of users) {
      const isPending = !credentialUserIds.has(user.id);
      const userRole = resolveRole(user.role);

      if (!isPending) {
        activeUsers.push({
          id: user.id,
          email: user.email,
          display_name: user.name,
          avatar_url: user.image,
          role: userRole,
          created_at: toIsoString(user.createdAt),
          last_sign_in_at: null,
        });
      } else {
        pendingInvites.push({
          id: user.id,
          email: user.email,
          role: userRole,
          invited_at: invitedAtByUserId.get(user.id) || toIsoString(user.createdAt),
        });
      }
    }

    return noCache({
      data: { activeUsers, pendingInvites, callerRole: caller?.role || null },
    });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache({ error: 'Failed to fetch users' }, 500);
  }
}

/**
 * PATCH /ycode/api/auth/users?id=...
 *
 * Change a user's role. Requires owner or admin.
 */
export async function PATCH(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;
    const caller = result;

    const { searchParams } = new URL(request.url);
    const targetId = searchParams.get('id');
    if (!targetId) {
      return noCache({ error: 'ID is required' }, 400);
    }

    const body = await request.json();
    const { role } = body;
    if (!role || !ASSIGNABLE_ROLES.includes(role)) {
      return noCache({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` }, 400);
    }

    if (role === 'admin' && caller.role !== 'owner') {
      return noCache({ error: 'Only the owner can assign the admin role' }, 403);
    }

    const db = await getDb();
    const target = await db<AuthUserRow>('user')
      .select('role')
      .where('id', targetId)
      .first();

    if (!target) {
      return noCache({ error: 'User not found' }, 404);
    }

    if (target.role === 'owner') {
      return noCache({ error: 'Cannot change the owner\'s role' }, 400);
    }

    await db('user')
      .where('id', targetId)
      .update({ role, updatedAt: new Date() });

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache({ error: 'Failed to update role' }, 500);
  }
}

/**
 * DELETE /ycode/api/auth/users?id=...
 *
 * Delete a user or cancel a pending invite. Requires owner or admin.
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;
    const caller = result;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('id');

    if (!userId) {
      return noCache({ error: 'User ID is required' }, 400);
    }

    if (userId === caller.userId) {
      return noCache({ error: 'Cannot remove yourself' }, 400);
    }

    const db = await getDb();
    const target = await db<AuthUserRow>('user')
      .select('role')
      .where('id', userId)
      .first();

    if (!target) {
      return noCache({ error: 'User not found' }, 404);
    }

    if (target.role === 'owner') {
      return noCache({ error: 'Cannot remove the owner' }, 400);
    }

    await db.transaction(async (trx) => {
      await trx('verification').where('identifier', `invite:${userId}`).del();
      await trx('user').where('id', userId).del();
    });

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[users] Unexpected error:', error);
    return noCache({ error: 'Failed to delete user' }, 500);
  }
}
