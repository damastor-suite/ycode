/**
 * Database port — Knex is the only data access layer (no PostgREST).
 */

import 'server-only';

import type { Knex } from 'knex';
import { getKnexClient, closeKnexClient, testKnexConnection } from '@/lib/knex-client';

export type DbClient = Knex;

/**
 * Get the shared Knex database client.
 * @throws if database is not configured
 */
export async function getDb(): Promise<DbClient> {
  try {
    return await getKnexClient();
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Database not configured: ${error.message}`
        : 'Database not configured'
    );
  }
}

/**
 * Get Knex client or null when not configured (setup / soft-fail paths).
 */
export async function getDbOrNull(): Promise<DbClient | null> {
  try {
    return await getKnexClient();
  } catch {
    return null;
  }
}

export { closeKnexClient, testKnexConnection };

/**
 * Run work inside a real Postgres transaction.
 */
export async function withDbTransaction<T>(
  fn: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  const db = await getDb();
  return db.transaction(fn);
}

/** Postgres undefined_table */
export const PG_UNDEFINED_TABLE = '42P01';

export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === PG_UNDEFINED_TABLE;
}
