import { randomBytes } from 'crypto';

import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
} from './knex-repository-utils';

/**
 * MCP OAuth Code Repository
 *
 * Stores short-lived authorization codes. Codes are single-use: consumeCode
 * deletes the row atomically so a replayed code is rejected.
 */

export interface McpOAuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface CreateCodeData {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string | null;
  user_id: string;
}

const CODE_COLUMNS = [
  'code',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'user_id',
  'expires_at',
  'created_at',
];

function generateCode(): string {
  return 'mcp_code_' + randomBytes(32).toString('hex');
}

export async function createCode(data: CreateCodeData): Promise<string> {
  const knex = await getDb();
  const code = generateCode();
  const row = await addTenantIdToRow(knex, 'mcp_oauth_codes', {
    code,
    client_id: data.client_id,
    redirect_uri: data.redirect_uri,
    code_challenge: data.code_challenge,
    code_challenge_method: data.code_challenge_method,
    scope: data.scope ?? null,
    user_id: data.user_id,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });

  try {
    await knex('mcp_oauth_codes').insert(row);
    return code;
  } catch (error) {
    throw new Error(
      `Failed to create OAuth code: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function consumeCode(code: string): Promise<McpOAuthCode | null> {
  const knex = await getDb();
  let query = knex('mcp_oauth_codes')
    .where('code', code)
    .del()
    .returning(CODE_COLUMNS);
  query = await applyTenantFilter(knex, query, 'mcp_oauth_codes');

  try {
    const [data] = await query;
    if (!data) {
      return null;
    }

    const row = normalizeRow(data) as McpOAuthCode;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }

    return row;
  } catch {
    return null;
  }
}

export async function cleanupExpired(): Promise<void> {
  try {
    const knex = await getDb();
    let query = knex('mcp_oauth_codes')
      .where('expires_at', '<', new Date().toISOString())
      .del();
    query = await applyTenantFilter(knex, query, 'mcp_oauth_codes');
    await query;
  } catch {
    // Best-effort cleanup.
  }
}
