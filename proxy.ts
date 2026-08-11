import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';

/**
 * Public API routes that skip authentication.
 */
const PUBLIC_API_PREFIXES = [
  '/ycode/api/setup/',    // Setup wizard — needed before any user exists
  '/ycode/api/supabase/', // Legacy config endpoints during migration
  '/ycode/api/auth/',     // Auth callbacks and session checks
  '/ycode/api/v1/',       // Public API — has own API key auth
];

/**
 * Patterns for collection item endpoints that must be accessible on published pages
 * (load-more pagination, filter). Matched via regex since the collection ID is dynamic.
 */
const PUBLIC_COLLECTION_ITEM_SUFFIXES = ['/items/filter', '/items/load-more'];

const PUBLIC_API_EXACT = [
  '/ycode/api/revalidate', // Cache revalidation — has own secret token auth
  '/ycode/api/oauth/register', // RFC 7591 Dynamic Client Registration — anonymous
  '/ycode/api/oauth/token',    // OAuth token exchange — auth is via PKCE/refresh
];

/**
 * Returns false when env vars are not set (pre-setup or local dev without .env.local).
 * Legacy Supabase envs still count during migration so existing installs remain protected.
 */
function hasAuthDatabaseConfig(): boolean {
  return Boolean(
    process.env.DATABASE_URL
    || (process.env.SUPABASE_CONNECTION_URL && process.env.SUPABASE_DB_PASSWORD)
  );
}

function isPublicApiRoute(pathname: string, method: string): boolean {
  // POST to form-submissions is public (website visitors submitting forms)
  if (pathname === '/ycode/api/form-submissions' && method === 'POST') {
    return true;
  }

  if (PUBLIC_API_EXACT.includes(pathname)) return true;

  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;

  // Collection item endpoints for published pages (POST only — filter, load-more)
  if (method === 'POST' && pathname.startsWith('/ycode/api/collections/') &&
      PUBLIC_COLLECTION_ITEM_SUFFIXES.some(suffix => pathname.endsWith(suffix))) {
    return true;
  }

  return false;
}

/**
 * Verify Better Auth session for protected API routes.
 * Returns a 401 response if not authenticated, or null to continue.
 */
async function verifyApiAuth(request: NextRequest): Promise<NextResponse | null> {
  if (isPublicApiRoute(request.nextUrl.pathname, request.method)) {
    return null;
  }

  // If env vars aren't set (pre-setup or local dev without .env.local), let through.
  if (!hasAuthDatabaseConfig()) return null;

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    );
  }

  return NextResponse.next({ request });
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // MCP endpoints use their own token-based authentication — skip session auth.
  // Cloud overlay proxies MUST also exempt these paths to avoid login redirects.
  //   - `/ycode/mcp/<token>`: legacy URL-token endpoint (Cursor, Windsurf, etc.)
  //   - `/ycode/mcp`: OAuth Bearer-token endpoint (Claude.ai web, ChatGPT)
  if (pathname === '/ycode/mcp' || pathname.startsWith('/ycode/mcp/')) {
    const response = NextResponse.next();
    response.headers.set('x-pathname', pathname);
    return response;
  }

  // Debug escape hatch: skip auth on preview routes when explicitly enabled.
  const skipPreviewAuth = process.env.DISABLE_PREVIEW_AUTH === 'true'
    && pathname.startsWith('/ycode/preview');

  // Protect API and preview routes with auth. `/api/templates` lives outside the
  // `/ycode` tree (public site route group) but exposes destructive builder-only
  // operations (apply/export), so it must be gated here too.
  if (!skipPreviewAuth && (pathname.startsWith('/ycode/api') || pathname.startsWith('/ycode/preview') || pathname.startsWith('/api/templates'))) {
    const authResponse = await verifyApiAuth(request);
    if (authResponse) {
      if (authResponse.status === 401) {
        if (pathname.startsWith('/ycode/preview')) {
          return NextResponse.redirect(new URL('/ycode', request.url));
        }
        return authResponse;
      }
      // Authenticated — pass through
      authResponse.headers.set('x-pathname', pathname);
      return authResponse;
    }
  }

  const isPublicPage = !pathname.startsWith('/ycode')
    && !pathname.startsWith('/_next')
    && !pathname.startsWith('/api')
    && !pathname.startsWith('/dynamic');
  const hasPaginationParams = Array.from(request.nextUrl.searchParams.keys())
    .some((key) => key.startsWith('p_'));

  if (isPublicPage && hasPaginationParams) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = pathname === '/' ? '/dynamic' : `/dynamic${pathname}`;

    const rewriteResponse = NextResponse.rewrite(rewriteUrl);
    rewriteResponse.headers.set('x-pathname', pathname);
    return rewriteResponse;
  }

  // Create response
  const response = NextResponse.next();

  // Add pathname header for layout to determine dark mode
  response.headers.set('x-pathname', pathname);

  // Cache-Control for public pages is configured centrally via next.config.ts headers().

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
