import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { getAuthUser } from '@/lib/platform/auth';
import { getDb } from '@/lib/platform/db';

/**
 * PUT /ycode/api/profile/name
 *
 * Update user's display name
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string') {
      return noCache({ error: 'Name is required' }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    const db = await getDb();
    const [user] = await db('user')
      .where('id', auth.user.id)
      .update({
        name: name.trim(),
        updatedAt: new Date(),
      })
      .returning(['id', 'email', 'name', 'image', 'role', 'createdAt', 'updatedAt']);

    return noCache({
      data: {
        user,
      },
    });
  } catch (error) {
    console.error('Failed to update name:', error);
    return noCache({ error: 'Failed to update name' }, 500);
  }
}
