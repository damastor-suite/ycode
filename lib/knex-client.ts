import knex, { Knex } from 'knex';
import knexfileConfig from '../knexfile';

/**
 * Knex Client for Ycode
 *
 * Shared Postgres access for repositories and migrations.
 * Instance lives on globalThis so it survives Next.js HMR.
 */

const globalForKnex = globalThis as unknown as { __knexInstance?: Knex };

/**
 * Get or create knex instance
 */
export async function getKnexClient(): Promise<Knex> {
  if (globalForKnex.__knexInstance) {
    return globalForKnex.__knexInstance;
  }

  const environment = process.env.NODE_ENV || 'development';
  const config = knexfileConfig[environment];

  if (!config) {
    throw new Error(`No knex configuration found for environment: ${environment}`);
  }

  globalForKnex.__knexInstance = knex(config);

  return globalForKnex.__knexInstance;
}

/**
 * Close knex connection
 */
export async function closeKnexClient(): Promise<void> {
  if (globalForKnex.__knexInstance) {
    await globalForKnex.__knexInstance.destroy();
    globalForKnex.__knexInstance = undefined;
  }
}

/**
 * Test database connection using stored credentials
 */
export async function testKnexConnection(): Promise<boolean> {
  try {
    const client = await getKnexClient();
    await client.raw('SELECT 1');
    return true;
  } catch (error) {
    console.error('[testKnexConnection] Database connection test failed:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      code: (error as { code?: string })?.code,
      detail: (error as { detail?: string })?.detail,
    });

    try {
      await closeKnexClient();
    } catch (closeError) {
      console.error('[testKnexConnection] Error closing failed connection:', closeError);
    }

    return false;
  }
}

/**
 * Test database connection with a raw connection string (setup wizard).
 */
export async function testDatabaseUrlConnection(databaseUrl: string): Promise<{
  success: boolean;
  error?: string;
}> {
  let testClient: Knex | null = null;

  try {
    const isLocal =
      databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');

    testClient = knex({
      client: 'pg',
      connection: {
        connectionString: databaseUrl,
        ssl: isLocal || process.env.DATABASE_SSL === 'false'
          ? false
          : { rejectUnauthorized: false },
      },
      pool: { min: 0, max: 1 },
    });

    await testClient.raw('SELECT 1');
    return { success: true };
  } catch (error) {
    console.error('[testDatabaseUrlConnection] Database connection test failed:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      code: (error as { code?: string })?.code,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Database connection failed',
    };
  } finally {
    if (testClient) {
      try {
        await testClient.destroy();
      } catch (closeError) {
        console.error('[testDatabaseUrlConnection] Error closing test connection:', closeError);
      }
    }
  }
}

/**
 * @deprecated Use testDatabaseUrlConnection
 */
export async function testSupabaseDirectConnection(credentials: {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  ssl?: boolean;
}): Promise<{
  success: boolean;
  error?: string;
}> {
  const sslOff = credentials.ssl === false;
  const url = `postgresql://${encodeURIComponent(credentials.dbUser)}:${encodeURIComponent(credentials.dbPassword)}@${credentials.dbHost}:${credentials.dbPort}/${credentials.dbName}${sslOff ? '' : ''}`;
  return testDatabaseUrlConnection(url);
}
