import { NextRequest } from 'next/server';
import { verifyPassword } from 'better-auth/crypto';
import { noCache } from '@/lib/api-response';
import { getAuthUser } from '@/lib/platform/auth';
import { getDb } from '@/lib/platform/db';

interface AccountRow {
  password: string | null;
}

/**
 * PUT /ycode/api/profile/email
 *
 * Update user's email address (requires password confirmation)
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || typeof email !== 'string') {
      return noCache({ error: 'Email is required' }, 400);
    }

    if (!password || typeof password !== 'string') {
      return noCache({ error: 'Password is required to change email' }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const db = await getDb();
    const account = await db<AccountRow>('account')
      .select('password')
      .where('userId', auth.user.id)
      .where('providerId', 'credential')
      .first();

    if (!account?.password || !await verifyPassword({ hash: account.password, password })) {
      return noCache({ error: 'Incorrect password' }, 400);
    }

    const [user] = await db('user')
      .where('id', auth.user.id)
      .update({
        email: email.trim().toLowerCase(),
        emailVerified: true,
        updatedAt: new Date(),
      })
      .returning(['id', 'email', 'name', 'image', 'role', 'createdAt', 'updatedAt']);

    return noCache({
      data: {
        user,
        message: 'Email updated successfully.',
      },
    });
  } catch (error) {
    console.error('Failed to update email:', error);
    return noCache({ error: 'Failed to update email' }, 500);
  }
}
