import type { SupabaseConfig, SupabaseCredentials } from '@/types';

/**
 * Replace [YOUR-PASSWORD] placeholder with actual password
 *
 * @param connectionUrl - Connection URL with [YOUR-PASSWORD] placeholder
 * @param password - Actual database password
 * @returns Connection URL with password inserted
 */
function replacePasswordPlaceholder(connectionUrl: string, password: string): string {
  const encodedPassword = encodeURIComponent(password);
  return connectionUrl.replace('[YOUR-PASSWORD]', encodedPassword);
}

/**
 * Try to extract the Supabase project ID from the connection URL.
 *
 * Hosted Supabase uses usernames like `postgres.abc123`, so the project ref
 * is the part after the dot. Self-hosted instances won't have this format,
 * so extraction is best-effort.
 *
 * @returns Project ID or null if the format doesn't match
 */
function tryExtractProjectId(connectionUrl: string): string | null {
  // Pooler format: postgresql://postgres.abc123:...
  const poolerMatch = connectionUrl.match(/\/\/postgres\.([a-z0-9]+):/);
  if (poolerMatch?.[1]) return poolerMatch[1];

  // Direct format: postgresql://postgres:...@db.abc123.supabase.co:...
  const directMatch = connectionUrl.match(/@db\.([a-z0-9]+)\.supabase\.co[:/]/);
  if (directMatch?.[1]) return directMatch[1];

  return null;
}

/**
 * Parse Supabase Connection URL
 *
 * Parses a PostgreSQL connection string and extracts database connection details.
 * Works with both hosted Supabase pooler URLs and arbitrary Postgres connection strings
 * (e.g. self-hosted Supabase instances).
 *
 * The `supabaseUrl` parameter allows callers to provide an explicit Supabase API URL
 * instead of deriving it from the project ref. Required for self-hosted instances.
 *
 * @param connectionUrl - PostgreSQL connection string (with password already replaced)
 * @param supabaseUrl - Explicit Supabase API URL (for self-hosted instances)
 * @returns Parsed connection details
 */
export function parseConnectionUrl(connectionUrl: string, supabaseUrl?: string): {
  projectId: string;
  projectUrl: string;
  dbPassword: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
} {
  try {
    const url = new URL(connectionUrl);
    const dbHost = url.hostname;
    const dbPort = parseInt(url.port || '5432', 10);
    const dbName = url.pathname.slice(1);
    const dbUser = url.username;
    const dbPassword = decodeURIComponent(url.password);

    const projectId = tryExtractProjectId(connectionUrl);

    let projectUrl: string;

    if (supabaseUrl) {
      projectUrl = supabaseUrl.replace(/\/+$/, '');
    } else if (projectId) {
      projectUrl = `https://${projectId}.supabase.co`;
    } else {
      throw new Error(
        'Could not derive the Supabase API URL from the connection string.\n\n' +
        'For self-hosted Supabase instances, set the SUPABASE_URL environment variable ' +
        '(or provide the "Supabase API URL" in the setup wizard).\n\n' +
        'For hosted Supabase, the expected connection string format is:\n' +
        'postgresql://postgres.[PROJECT-ID]:[YOUR-PASSWORD]@aws-x-xx-xxxx-x.pooler.supabase.com:6543/postgres'
      );
    }

    return {
      projectId: projectId || 'self-hosted',
      projectUrl,
      dbPassword,
      dbHost,
      dbPort,
      dbName,
      dbUser,
    };
  } catch (error) {
    if (error instanceof Error && (
      error.message.includes('SUPABASE_URL') ||
      error.message.includes('Supabase API URL')
    )) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Invalid format';
    throw new Error(
      `Failed to parse SUPABASE_CONNECTION_URL: ${message}\n\n` +
      'Expected format:\n' +
      '  Hosted:      postgresql://postgres.[PROJECT-ID]:[YOUR-PASSWORD]@aws-x-xx-xxxx-x.pooler.supabase.com:6543/postgres\n' +
      '  Self-hosted: any valid PostgreSQL connection string + set SUPABASE_URL env var'
    );
  }
}

/**
 * Parse Supabase config and return full credentials
 *
 * @param config - SupabaseConfig with 4 core values + optional supabaseUrl
 * @returns Full SupabaseCredentials with derived properties
 */
export function parseSupabaseConfig(config: SupabaseConfig): SupabaseCredentials {
  if (!config.connectionUrl || !config.dbPassword || !config.anonKey || !config.serviceRoleKey) {
    throw new Error('Supabase config is missing required credentials');
  }

  const connectionUrlResolved = replacePasswordPlaceholder(config.connectionUrl, config.dbPassword);

  const { dbPassword: _, ...parsedUrl } = parseConnectionUrl(
    connectionUrlResolved,
    config.supabaseUrl,
  );

  return {
    anonKey: config.anonKey,
    serviceRoleKey: config.serviceRoleKey,
    connectionUrl: config.connectionUrl,
    dbPassword: config.dbPassword,
    ...parsedUrl,
  };
}

/**
 * Validate Supabase connection URL format
 *
 * @param connectionUrl - URL to validate (can have [YOUR-PASSWORD] placeholder)
 * @param password - Optional password to test with
 * @param supabaseUrl - Optional explicit Supabase API URL (for self-hosted)
 * @returns True if valid, throws error otherwise
 */
export function validateConnectionUrl(
  connectionUrl: string,
  password?: string,
  supabaseUrl?: string,
): boolean {
  const testUrl = password
    ? replacePasswordPlaceholder(connectionUrl, password)
    : connectionUrl.replace('[YOUR-PASSWORD]', 'dummy-password-for-validation');

  parseConnectionUrl(testUrl, supabaseUrl);
  return true;
}
