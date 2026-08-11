import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getAuthUser } from '@/lib/platform/auth';
import { getDb } from '@/lib/platform/db';

/**
 * DELETE /ycode/api/profile
 *
 * Delete user's profile and account
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const db = await getDb();
    await db.transaction(async (trx) => {
      await trx('verification').where('identifier', `invite:${auth.user.id}`).del();
      await trx('user').where('id', auth.user.id).del();
    });

    return noCache({
      data: {
        success: true,
        message: 'Profile deleted successfully',
      },
    });
  } catch (error) {
    console.error('Failed to delete profile:', error);
    return noCache({ error: 'Failed to delete profile' }, 500);
  }
}
