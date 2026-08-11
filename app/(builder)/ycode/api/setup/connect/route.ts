import { NextRequest } from 'next/server';
import { credentials } from '@/lib/credentials';
import { testDatabaseUrlConnection } from '@/lib/knex-client';
import { noCache } from '@/lib/api-response';
import type { DatabaseConfig } from '@/types';

/**
 * POST /ycode/api/setup/connect
 *
 * Test and store database credentials.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { databaseUrl, database_url, authSecret, auth_secret } = body;
    const resolvedDatabaseUrl = databaseUrl || database_url;
    const resolvedAuthSecret = authSecret || auth_secret;

    // Validate required fields
    if (!resolvedDatabaseUrl || typeof resolvedDatabaseUrl !== 'string') {
      return noCache(
        { error: 'Missing required field: databaseUrl' },
        400
      );
    }

    const config: DatabaseConfig = {
      databaseUrl: resolvedDatabaseUrl,
      ...(resolvedAuthSecret ? { authSecret: resolvedAuthSecret } : {}),
    };

    // Test database connection
    const dbTestResult = await testDatabaseUrlConnection(resolvedDatabaseUrl);
    if (!dbTestResult.success) {
      return noCache(
        { error: `Database connection failed: ${dbTestResult.error || 'Unknown error'}` },
        400
      );
    }

    // Store credentials
    await credentials.set('database_config', config);

    return noCache({
      success: true,
      message: 'Database connected successfully',
    });
  } catch (error) {
    console.error('[Setup API] Connection failed:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Connection failed' },
      500
    );
  }
}
