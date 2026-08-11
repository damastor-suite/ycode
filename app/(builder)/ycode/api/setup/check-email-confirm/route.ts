import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/setup/check-email-confirm
 *
 * Better Auth email/password sign-up does not require a Supabase email setting.
 */
export async function GET() {
  return noCache({ autoconfirm: true });
}
