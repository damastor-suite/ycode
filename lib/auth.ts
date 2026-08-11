/**
 * Better Auth server instance — email/password builder auth.
 */

import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

function getAuthSecret(): string {
  const secret =
    process.env.BETTER_AUTH_SECRET
    || process.env.PAGE_AUTH_SECRET
    || process.env.SUPABASE_SECRET_KEY;
  if (!secret) {
    // Allow module load during build; runtime routes still need a real secret
    return 'dev-only-insecure-secret-change-me';
  }
  return secret;
}

function getDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const connectionUrl = process.env.SUPABASE_CONNECTION_URL;
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  if (connectionUrl && dbPassword) {
    return connectionUrl.replace('[YOUR-PASSWORD]', encodeURIComponent(dbPassword));
  }
  return undefined;
}

function createPool(): Pool | undefined {
  const url = getDatabaseUrl();
  if (!url) return undefined;

  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  return new Pool({
    connectionString: url,
    ssl: isLocal || process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
    max: process.env.VERCEL === '1' ? 1 : 5,
  });
}

const pool = createPool();

export const auth = betterAuth({
  database: pool || new Pool({ connectionString: 'postgresql://invalid' }),
  secret: getAuthSecret(),
  baseURL: process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL,
  basePath: '/ycode/api/auth',
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'editor',
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
});

export type Auth = typeof auth;
