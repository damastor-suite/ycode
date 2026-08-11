import type { Page, PageFolder } from '@/types';
import { createHmac, randomUUID } from 'crypto';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getDbOrNull } from '@/lib/platform/db';

/**
 * Page Password Protection Utilities
 *
 * Handles password-based access control for pages and folders.
 * Uses session cookies to track which pages/folders have been unlocked.
 * Uses dynamic import for cookies() to avoid tainting the module as dynamic.
 */

/** Cookie name for page authentication - exported for use in API routes */
export const PAGE_AUTH_COOKIE_NAME = 'ycode_page_auth';

// Last-resort per-process secret. Resets on every process/deploy and differs
// between serverless instances, so cookies signed with it won't verify across
// requests. Only used when no stable secret is available.
const fallbackSecret = randomUUID();
let hasWarnedMissingSecret = false;

/**
 * Get the HMAC signing secret for auth cookies.
 *
 * Order of preference:
 *  1. PAGE_AUTH_SECRET — explicit, recommended.
 *  2. BETTER_AUTH_SECRET — stable application secret.
 *  3. A per-process random secret — last resort. Cookies won't verify across
 *     serverless instances or restarts, so password unlock appears to fail.
 */
function getSigningSecret(): string {
  const explicit = process.env.PAGE_AUTH_SECRET;
  if (explicit) return explicit;

  if (process.env.BETTER_AUTH_SECRET) {
    return createHmac('sha256', process.env.BETTER_AUTH_SECRET)
      .update('ycode-page-auth-v1')
      .digest('hex');
  }

  if (!hasWarnedMissingSecret && process.env.NODE_ENV === 'production') {
    console.warn('[page-auth] PAGE_AUTH_SECRET is not set. Page password protection is using a temporary secret that resets on each deploy and will not verify across serverless instances. Set PAGE_AUTH_SECRET (generate with: openssl rand -hex 32).');
    hasWarnedMissingSecret = true;
  }
  return fallbackSecret;
}

/**
 * Sign a value using HMAC-SHA256
 */
function signValue(value: string): string {
  const secret = getSigningSecret();
  const hmac = createHmac('sha256', secret);
  hmac.update(value);
  return hmac.digest('hex');
}

/**
 * Verify a signed value
 */
function verifySignature(value: string, signature: string): boolean {
  const expectedSignature = signValue(value);
  return signature === expectedSignature;
}

/**
 * Cookie payload structure
 */
interface PageAuthCookie {
  // Array of unlocked page IDs
  pages: string[];
  // Array of unlocked folder IDs
  folders: string[];
}

/**
 * Parse the auth cookie and verify signature
 */
export async function parseAuthCookie(): Promise<PageAuthCookie | null> {
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const cookie = cookieStore.get(PAGE_AUTH_COOKIE_NAME);

    if (!cookie?.value) {
      return null;
    }

    // Cookie format: base64(json).signature
    const parts = cookie.value.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [encodedPayload, signature] = parts;

    // Verify signature
    if (!verifySignature(encodedPayload, signature)) {
      return null;
    }

    // Decode and parse
    const jsonPayload = Buffer.from(encodedPayload, 'base64').toString('utf-8');
    const payload = JSON.parse(jsonPayload) as PageAuthCookie;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Build a signed cookie value
 */
export function buildAuthCookieValue(payload: PageAuthCookie): string {
  const jsonPayload = JSON.stringify(payload);
  const encodedPayload = Buffer.from(jsonPayload).toString('base64');
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

/**
 * Protection result from checking a page/folder
 */
export interface PasswordProtectionResult {
  /** Whether the page is password protected */
  isProtected: boolean;
  /** The password required (only set if protected) */
  password?: string;
  /** Whether protection comes from page or folder */
  protectedBy?: 'page' | 'folder';
  /** The ID of the page or folder that has the password */
  protectedById?: string;
  /** Whether the current session has unlocked this protection */
  isUnlocked: boolean;
}

/**
 * Get the effective password protection for a page
 * 
 * Priority:
 * 1. Page's own password (if enabled)
 * 2. Parent folder's password (traverse up, closest folder wins)
 * 
 * @param page - The page to check
 * @param folders - All folders for hierarchy lookup
 * @param authCookie - Current auth cookie payload (null if not set)
 */
export function getPasswordProtection(
  page: Page,
  folders: PageFolder[],
  authCookie: PageAuthCookie | null
): PasswordProtectionResult {
  // Check if page itself has password protection
  if (page.settings?.auth?.enabled && page.settings.auth.password) {
    const isUnlocked = authCookie?.pages?.includes(page.id) ?? false;
    return {
      isProtected: true,
      password: page.settings.auth.password,
      protectedBy: 'page',
      protectedById: page.id,
      isUnlocked,
    };
  }

  // Traverse folder hierarchy from page's parent folder up to root
  let currentFolderId = page.page_folder_id;
  
  while (currentFolderId) {
    const folder = folders.find(f => f.id === currentFolderId);
    if (!folder) break;

    if (folder.settings?.auth?.enabled && folder.settings.auth.password) {
      const isUnlocked = authCookie?.folders?.includes(folder.id) ?? false;
      return {
        isProtected: true,
        password: folder.settings.auth.password,
        protectedBy: 'folder',
        protectedById: folder.id,
        isUnlocked,
      };
    }

    // Move to parent folder
    currentFolderId = folder.page_folder_id;
  }

  // No password protection
  return {
    isProtected: false,
    isUnlocked: true,
  };
}

/**
 * Fetch folders for password protection checks.
 *
 * @param isPublished - If true, fetch published folders; if false, fetch draft folders (preview).
 * @returns Array of page folders
 */
export async function fetchFoldersForAuth(isPublished: boolean): Promise<PageFolder[]> {
  const db = await getDbOrNull();
  if (!db) return [];

  let query = db<PageFolder>('page_folders')
    .select('*')
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await addTenantFilter(db, query, 'page_folders');

  return query;
}
