import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { hashPassword } from 'better-auth/crypto';
import { noCache } from '@/lib/api-response';
import { getDb } from '@/lib/platform/db';

interface VerificationRow {
  identifier: string | null;
  expiresAt: Date | string;
}

interface AuthUserRow {
  id: string;
  email: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, password } = body;

    if (!token || typeof token !== 'string') {
      return noCache({ error: 'Invite token is required' }, 400);
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return noCache({ error: 'Password must be at least 8 characters' }, 400);
    }

    const db = await getDb();
    const verification = await db<VerificationRow>('verification')
      .select('identifier', 'expiresAt')
      .where('value', token)
      .whereLike('identifier', 'invite:%')
      .first();

    if (!verification?.identifier) {
      return noCache({ error: 'Invalid or expired invitation link' }, 400);
    }

    if (new Date(verification.expiresAt).getTime() < Date.now()) {
      await db('verification').where('value', token).del();
      return noCache({ error: 'Invalid or expired invitation link' }, 400);
    }

    const userId = verification.identifier.replace('invite:', '');
    const user = await db<AuthUserRow>('user')
      .select('id', 'email')
      .where('id', userId)
      .first();

    if (!user) {
      return noCache({ error: 'Invited user not found' }, 404);
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();

    await db.transaction(async (trx) => {
      const existingAccount = await trx('account')
        .select('id')
        .where({ userId, providerId: 'credential' })
        .first();

      if (existingAccount) {
        await trx('account')
          .where('id', existingAccount.id)
          .update({
            accountId: userId,
            password: passwordHash,
            updatedAt: now,
          });
      } else {
        await trx('account').insert({
          id: randomUUID(),
          accountId: userId,
          providerId: 'credential',
          userId,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        });
      }

      await trx('user')
        .where('id', userId)
        .update({
          emailVerified: true,
          updatedAt: now,
        });
      await trx('verification').where('value', token).del();
    });

    return noCache({
      data: {
        email: user.email,
        success: true,
      },
    });
  } catch (error) {
    console.error('[accept-invite] Unexpected error:', error);
    return noCache({ error: 'Failed to accept invitation' }, 500);
  }
}
