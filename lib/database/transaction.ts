/**
 * Database Transaction Helpers — real Knex/Postgres transactions.
 */

import type { Knex } from 'knex';
import { getDb, withDbTransaction } from '@/lib/platform/db';

export interface Transaction {
  client: Knex | Knex.Transaction;
  isActive: boolean;
}

/**
 * Execute a function inside a real Postgres transaction.
 */
export async function withTransaction<T>(
  fn: (trx?: Knex.Transaction) => Promise<T>
): Promise<T> {
  return withDbTransaction(async (trx) => fn(trx));
}

/**
 * Execute multiple operations sequentially; stop on first error.
 */
export async function executeSequentially<T>(
  operations: Array<() => Promise<T>>
): Promise<T[]> {
  const results: T[] = [];
  for (const operation of operations) {
    results.push(await operation());
  }
  return results;
}

/**
 * Execute multiple operations in parallel.
 */
export async function executeParallel<T>(
  operations: Array<() => Promise<T>>
): Promise<T[]> {
  return Promise.all(operations.map((op) => op()));
}

/**
 * Ensure database client is available.
 */
export async function ensureClient(): Promise<Knex> {
  return getDb();
}
