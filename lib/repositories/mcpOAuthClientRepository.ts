import { randomBytes } from 'crypto';

import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
} from './knex-repository-utils';

/**
 * MCP OAuth Client Repository
 *
 * Stores RFC 7591 Dynamic Client Registration entries.
 */

export interface McpOAuthClient {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface RegisterClientData {
  client_name: string;
  redirect_uris: string[];
}

const CLIENT_COLUMNS = ['id', 'client_id', 'client_name', 'redirect_uris', 'created_at'];

function generateClientId(): string {
  return 'mcp_client_' + randomBytes(24).toString('hex');
}

export async function registerClient(data: RegisterClientData): Promise<McpOAuthClient> {
  const knex = await getDb();
  const row = await addTenantIdToRow(knex, 'mcp_oauth_clients', {
    client_id: generateClientId(),
    client_name: data.client_name,
    redirect_uris: data.redirect_uris,
    created_at: new Date().toISOString(),
  });

  try {
    const [client] = await knex('mcp_oauth_clients')
      .insert(row)
      .returning(CLIENT_COLUMNS);

    return normalizeRow(client) as McpOAuthClient;
  } catch (error) {
    throw new Error(
      `Failed to register OAuth client: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getClient(clientId: string): Promise<McpOAuthClient | null> {
  const knex = await getDb();
  let query = knex('mcp_oauth_clients')
    .select(CLIENT_COLUMNS)
    .where('client_id', clientId);
  query = await applyTenantFilter(knex, query, 'mcp_oauth_clients');

  try {
    const client = await query.first();
    return client ? normalizeRow(client) as McpOAuthClient : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch OAuth client: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
