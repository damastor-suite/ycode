import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /ycode/api/auth/callback
 *
 * Better Auth handles callbacks in the catch-all auth route.
 */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/ycode', request.url));
}
