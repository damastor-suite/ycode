import { NextRequest } from 'next/server';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { noCache } from '@/lib/api-response';
import { getAuthUser } from '@/lib/platform/auth';
import { getDb } from '@/lib/platform/db';

interface AccountRow {
  id: string;
  password: string | null;
}

/**
 * PUT /ycode/api/profile/password
 *
 * Update user's password (requires current password)
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || typeof currentPassword !== 'string') {
      return noCache({ error: 'Current password is required' }, 400);
    }

    if (!newPassword || typeof newPassword !== 'string') {
      return noCache({ error: 'New password is required' }, 400);
    }

    if (newPassword.length < 8) {
      return noCache({ error: 'New password must be at least 8 characters' }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const db = await getDb();
    const account = await db<AccountRow>('account')
      .select('id', 'password')
      .where('userId', auth.user.id)
      .where('providerId', 'credential')
      .first();

    if (!account?.password || !await verifyPassword({ hash: account.password, password: currentPassword })) {
      return noCache({ error: 'Current password is incorrect' }, 400);
    }

    await db('account')
      .where('id', account.id)
      .update({
        password: await hashPassword(newPassword),
        updatedAt: new Date(),
      });

    return noCache({
      data: {
        success: true,
        message: 'Password updated successfully',
      },
    });
  } catch (error) {
    console.error('Failed to update password:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return noCache({ error: `Failed to update password: ${message}` }, 500);
  }
}
