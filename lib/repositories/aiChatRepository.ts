import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type { AiChat, AiChatSummary, UpsertAiChatData } from '@/types';

/**
 * AI Chat Repository
 *
 * Data access layer for AI builder chat history. Chats are project-scoped and
 * team-visible.
 */

export async function getAllAiChatSummaries(tenantId?: string): Promise<AiChatSummary[]> {
  const knex = await getDb();
  let query = knex('ai_chats')
    .select('id', 'title', 'updated_at')
    .orderBy('updated_at', 'desc');
  query = await applyTenantFilter(knex, query, 'ai_chats', tenantId);

  try {
    return normalizeRows(await query) as AiChatSummary[];
  } catch (error) {
    throw new Error(
      `Failed to fetch AI chats: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAiChatById(id: string, tenantId?: string): Promise<AiChat | null> {
  const knex = await getDb();
  let query = knex('ai_chats')
    .select('*')
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'ai_chats', tenantId);

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as AiChat : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch AI chat: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function upsertAiChat(
  chatData: UpsertAiChatData,
  tenantId?: string
): Promise<void> {
  const knex = await getDb();
  const row = await addTenantIdToRow(knex, 'ai_chats', {
    id: chatData.id,
    title: chatData.title,
    messages: chatData.messages,
    updated_at: new Date().toISOString(),
  }, tenantId);
  const conflictColumns = await getConflictColumns(
    knex,
    'ai_chats',
    ['id'],
    (row as Record<string, unknown>).tenant_id as string | undefined
  );

  try {
    await knex('ai_chats')
      .insert(row)
      .onConflict(conflictColumns)
      .merge(['title', 'messages', 'updated_at']);
  } catch (error) {
    throw new Error(
      `Failed to save AI chat: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteAiChat(id: string, tenantId?: string): Promise<void> {
  const knex = await getDb();
  let query = knex('ai_chats')
    .where('id', id)
    .del();
  query = await applyTenantFilter(knex, query, 'ai_chats', tenantId);

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete AI chat: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
