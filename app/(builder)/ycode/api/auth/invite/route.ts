import { randomBytes, randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getDb } from '@/lib/platform/db';
import { requireManageMembers } from '@/lib/roles-server';
import { ASSIGNABLE_ROLES } from '@/lib/roles';

interface AuthUserRow {
  id: string;
  email: string;
}

/**
 * POST /ycode/api/auth/invite
 *
 * Create a pending Better Auth user and invite token.
 * Requires owner or admin role.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireManageMembers();
    if ('status' in result) return result;
    const caller = result;

    const body = await request.json();
    const { email, role = 'designer', redirectTo } = body;

    if (!email) {
      return noCache({ error: 'Email is required' }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return noCache({ error: 'Invalid email format' }, 400);
    }

    const assignRole = ASSIGNABLE_ROLES.includes(role) ? role : 'designer';
    if (assignRole === 'admin' && caller.role !== 'owner') {
      return noCache({ error: 'Only the owner can assign the admin role' }, 403);
    }

    const db = await getDb();
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await db<AuthUserRow>('user')
      .select('id', 'email')
      .where('email', normalizedEmail)
      .first();

    const existingCredential = existingUser
      ? await db('account')
        .select('id')
        .where({ userId: existingUser.id, providerId: 'credential' })
        .whereNotNull('password')
        .first()
      : null;

    if (existingCredential) {
      return noCache({ error: 'A user with this email already exists' }, 400);
    }

    const userId = existingUser?.id || randomUUID();
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    const now = new Date();

    await db.transaction(async (trx) => {
      if (existingUser) {
        await trx('user')
          .where('id', existingUser.id)
          .update({
            role: assignRole,
            updatedAt: now,
          });
      } else {
        await trx('user').insert({
          id: userId,
          email: normalizedEmail,
          name: normalizedEmail.split('@')[0],
          emailVerified: false,
          role: assignRole,
          createdAt: now,
          updatedAt: now,
        });
      }

      await trx('verification').where('identifier', `invite:${userId}`).del();
      await trx('verification').insert({
        id: randomUUID(),
        identifier: `invite:${userId}`,
        value: token,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    });

    const inviteBase = redirectTo || `${new URL(request.url).origin}/ycode/accept-invite`;
    const invitationUrl = new URL(inviteBase);
    invitationUrl.searchParams.set('token', token);

    return noCache({
      data: {
        user: {
          id: userId,
          email: normalizedEmail,
        },
        role: assignRole,
        invitationUrl: invitationUrl.toString(),
        message: `Invitation created for ${normalizedEmail}`,
      },
    });
  } catch (error) {
    console.error('[invite] Unexpected error:', error);
    return noCache(
      { error: 'Failed to send invitation' },
      500
    );
  }
}
