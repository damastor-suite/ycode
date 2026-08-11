import { createHash, randomBytes } from 'crypto';

import { invalidateToken } from '@/lib/mcp/token-cache';
import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';

export interface McpToken {
  id: string;
  name: string;
  token_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  oauth_client_id: string | null;
  expires_at: string | null;
  user_id: string | null;
}

export interface McpTokenWithPlainToken extends McpToken {
  token: string;
}

export interface OAuthTokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}

export interface CreateOAuthTokenData {
  user_id: string;
  oauth_client_id: string;
  name: string;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
}

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_COLUMNS = [
  'id',
  'name',
  'token_prefix',
  'is_active',
  'last_used_at',
  'created_at',
  'updated_at',
  'oauth_client_id',
  'expires_at',
  'user_id',
];

function generateToken(): string {
  return 'ymc_' + randomBytes(24).toString('hex');
}

function generateRefreshToken(): string {
  return 'ymr_' + randomBytes(32).toString('hex');
}

function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

export async function getAllTokens(): Promise<McpToken[]> {
  const knex = await getDb();
  let query = knex('mcp_tokens')
    .select(TOKEN_COLUMNS)
    .orderBy('created_at', 'desc');
  query = await applyTenantFilter(knex, query, 'mcp_tokens');

  try {
    return normalizeRows(await query) as McpToken[];
  } catch (error) {
    throw new Error(
      `Failed to fetch MCP tokens: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createToken(name: string): Promise<McpTokenWithPlainToken> {
  const knex = await getDb();
  const token = generateToken();
  const now = new Date().toISOString();
  const row = await addTenantIdToRow(knex, 'mcp_tokens', {
    name,
    token,
    token_prefix: token.substring(0, 12),
    created_at: now,
    updated_at: now,
  });

  try {
    const [data] = await knex('mcp_tokens')
      .insert(row)
      .returning([...TOKEN_COLUMNS, 'token']);
    return normalizeRow(data) as McpTokenWithPlainToken;
  } catch (error) {
    throw new Error(
      `Failed to create MCP token: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function validateToken(token: string): Promise<McpToken | null> {
  const knex = await getDb();
  let query = knex('mcp_tokens')
    .select(TOKEN_COLUMNS)
    .where('token', token)
    .where('is_active', true);
  query = await applyTenantFilter(knex, query, 'mcp_tokens');

  try {
    const data = await query.first();
    if (!data) {
      return null;
    }

    const record = normalizeRow(data) as McpToken;
    if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
      return null;
    }

    let updateQuery = knex('mcp_tokens')
      .where('id', record.id)
      .update({ last_used_at: new Date().toISOString() });
    updateQuery = await applyTenantFilter(knex, updateQuery, 'mcp_tokens');
    await updateQuery;

    return record;
  } catch {
    return null;
  }
}

export async function deleteToken(id: string): Promise<void> {
  const knex = await getDb();
  let existingQuery = knex('mcp_tokens')
    .select('token')
    .where('id', id);
  existingQuery = await applyTenantFilter(knex, existingQuery, 'mcp_tokens');
  const existing = await existingQuery.first() as { token?: string } | undefined;

  let deleteQuery = knex('mcp_tokens')
    .where('id', id)
    .del();
  deleteQuery = await applyTenantFilter(knex, deleteQuery, 'mcp_tokens');

  try {
    await deleteQuery;
    if (existing?.token) {
      invalidateToken(existing.token);
    }
  } catch (error) {
    throw new Error(
      `Failed to delete MCP token: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getTokenById(id: string): Promise<McpToken | null> {
  const knex = await getDb();
  let query = knex('mcp_tokens')
    .select(TOKEN_COLUMNS)
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'mcp_tokens');

  try {
    const data = await query.first();
    return data ? normalizeRow(data) as McpToken : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch MCP token: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createOAuthToken(
  data: CreateOAuthTokenData
): Promise<OAuthTokenPair> {
  const knex = await getDb();
  const accessTtl = data.access_token_ttl_seconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTtl = data.refresh_token_ttl_seconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  const token = generateToken();
  const refreshToken = generateRefreshToken();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const row = await addTenantIdToRow(knex, 'mcp_tokens', {
    name: data.name,
    token,
    token_prefix: token.substring(0, 12),
    oauth_client_id: data.oauth_client_id,
    user_id: data.user_id,
    expires_at: new Date(now + accessTtl * 1000).toISOString(),
    refresh_token_hash: hashRefreshToken(refreshToken),
    refresh_expires_at: new Date(now + refreshTtl * 1000).toISOString(),
    created_at: createdAt,
    updated_at: createdAt,
  });

  try {
    await knex('mcp_tokens').insert(row);
    return {
      access_token: token,
      refresh_token: refreshToken,
      expires_in: accessTtl,
      refresh_expires_in: refreshTtl,
    };
  } catch (error) {
    throw new Error(
      `Failed to create OAuth MCP token: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function rotateRefreshToken(
  refreshToken: string,
  options?: { access_token_ttl_seconds?: number; refresh_token_ttl_seconds?: number }
): Promise<OAuthTokenPair | null> {
  const knex = await getDb();
  let query = knex('mcp_tokens')
    .select('id', 'name', 'token', 'oauth_client_id', 'user_id', 'refresh_expires_at', 'is_active')
    .where('refresh_token_hash', hashRefreshToken(refreshToken))
    .where('is_active', true);
  query = await applyTenantFilter(knex, query, 'mcp_tokens');

  try {
    const existing = await query.first() as {
      id: string;
      name: string;
      token: string | null;
      oauth_client_id: string | null;
      user_id: string | null;
      refresh_expires_at: string | Date | null;
      is_active: boolean;
    } | undefined;

    if (!existing) {
      return null;
    }

    const refreshExpiresAt = existing.refresh_expires_at instanceof Date
      ? existing.refresh_expires_at.toISOString()
      : existing.refresh_expires_at;

    if (!refreshExpiresAt || new Date(refreshExpiresAt).getTime() < Date.now()) {
      return null;
    }

    if (!existing.oauth_client_id || !existing.user_id) {
      return null;
    }

    let deleteQuery = knex('mcp_tokens')
      .where('id', existing.id)
      .del();
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'mcp_tokens');
    await deleteQuery;

    if (existing.token) {
      invalidateToken(existing.token);
    }

    return createOAuthToken({
      user_id: existing.user_id,
      oauth_client_id: existing.oauth_client_id,
      name: existing.name,
      access_token_ttl_seconds: options?.access_token_ttl_seconds,
      refresh_token_ttl_seconds: options?.refresh_token_ttl_seconds,
    });
  } catch {
    return null;
  }
}
