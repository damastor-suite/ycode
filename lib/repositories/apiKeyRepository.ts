import { createHash, randomBytes } from 'crypto';

import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';

/**
 * API Key Repository
 *
 * Handles CRUD operations for API keys used in the public v1 API.
 * Keys are stored as SHA-256 hashes for security.
 */

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyWithPlainKey extends ApiKey {
  api_key: string;
}

const API_KEY_COLUMNS = 'id, name, key_prefix, last_used_at, created_at, updated_at';

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}

export async function getAllApiKeys(): Promise<ApiKey[]> {
  const knex = await getDb();
  let query = knex('api_keys')
    .select(knex.raw(API_KEY_COLUMNS))
    .orderBy('created_at', 'desc');
  query = await applyTenantFilter(knex, query, 'api_keys');

  try {
    return normalizeRows(await query) as ApiKey[];
  } catch (error) {
    throw new Error(
      `Failed to fetch API keys: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createApiKey(name: string): Promise<ApiKeyWithPlainKey> {
  const knex = await getDb();
  const apiKey = generateApiKey();
  const now = new Date().toISOString();
  const row = await addTenantIdToRow(knex, 'api_keys', {
    name,
    key_hash: hashApiKey(apiKey),
    key_prefix: apiKey.substring(0, 8),
    created_at: now,
    updated_at: now,
  });

  try {
    const [data] = await knex('api_keys')
      .insert(row)
      .returning(['id', 'name', 'key_prefix', 'last_used_at', 'created_at', 'updated_at']);

    return {
      ...normalizeRow(data) as ApiKey,
      api_key: apiKey,
    };
  } catch (error) {
    throw new Error(
      `Failed to create API key: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteApiKey(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('api_keys').where('id', id).del();
  query = await applyTenantFilter(knex, query, 'api_keys');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete API key: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function validateApiKey(apiKey: string): Promise<ApiKey | null> {
  const knex = await getDb();
  let query = knex('api_keys')
    .select(['id', 'name', 'key_prefix', 'last_used_at', 'created_at', 'updated_at'])
    .where('key_hash', hashApiKey(apiKey));
  query = await applyTenantFilter(knex, query, 'api_keys');

  try {
    const data = await query.first();
    if (!data) {
      return null;
    }

    const key = normalizeRow(data) as ApiKey;
    void (async () => {
      try {
        let update = knex('api_keys')
          .where('id', key.id)
          .update({ last_used_at: new Date().toISOString() });
        update = await applyTenantFilter(knex, update, 'api_keys');
        await update;
      } catch (error) {
        console.error('Failed to update last_used_at:', error);
      }
    })();

    return key;
  } catch {
    return null;
  }
}

export async function getApiKeyById(id: string): Promise<ApiKey | null> {
  const knex = await getDb();
  let query = knex('api_keys')
    .select(['id', 'name', 'key_prefix', 'last_used_at', 'created_at', 'updated_at'])
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'api_keys');

  try {
    const data = await query.first();
    return data ? normalizeRow(data) as ApiKey : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch API key: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
