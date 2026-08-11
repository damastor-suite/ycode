import type { Knex } from 'knex';
import path from 'path';
import { credentials } from './lib/credentials.ts';
import type { DatabaseConfig } from './types/index.ts';

/**
 * Knex Configuration for Ycode Postgres Migrations
 *
 * Connects via DATABASE_URL (or legacy Supabase connection env during migration).
 */

async function getConnectionString(): Promise<string> {
  const config = await credentials.get<DatabaseConfig>('database_config');

  if (!config?.databaseUrl) {
    throw new Error('Database not configured. Please run setup first.');
  }

  return config.databaseUrl;
}

function shouldUseSsl(connectionString: string): boolean | { rejectUnauthorized: boolean } {
  // Local docker / localhost — no SSL
  if (
    connectionString.includes('localhost')
    || connectionString.includes('127.0.0.1')
    || process.env.DATABASE_SSL === 'false'
  ) {
    return false;
  }
  return { rejectUnauthorized: false };
}

const createConfig = (): Knex.Config => {
  const isVercel = process.env.VERCEL === '1';

  return {
    client: 'pg',
    connection: async () => {
      const connectionString = await getConnectionString();
      return {
        connectionString,
        ssl: shouldUseSsl(connectionString),
      };
    },
    migrations: {
      directory: path.join(process.cwd(), 'database/migrations'),
      extension: 'ts',
      tableName: 'migrations',
    },
    pool: isVercel ? {
      min: 0,
      max: 1,
      acquireTimeoutMillis: 10000,
      createTimeoutMillis: 10000,
      idleTimeoutMillis: 1000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 200,
    } : {
      min: 0,
      max: 3,
      idleTimeoutMillis: 30000,
    },
  };
};

const config: { [key: string]: Knex.Config } = {
  development: createConfig(),
  production: createConfig(),
};

export default config;
