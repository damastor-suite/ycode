import { noCache } from '@/lib/api-response';
import { getServerSession } from '@/lib/platform/auth';

/**
 * GET /ycode/api/auth/session
 *
 * Get current user session
 */
export async function GET() {
  try {
    const session = await getServerSession();

    return noCache({
      data: {
        session: session?.session || null,
        user: session?.user || null,
      },
    });
  } catch (error) {
    console.error('Session check failed:', error);

    return noCache(
      { error: 'Session check failed' },
      500
    );
  }
}
