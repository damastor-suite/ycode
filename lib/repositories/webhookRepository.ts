import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
  parseCount,
  stripUndefined,
} from './knex-repository-utils';

/**
 * Webhook Repository
 *
 * Handles CRUD operations for webhooks and webhook delivery logs.
 */

export type WebhookEventType =
  | 'form.submitted'
  | 'site.published'
  | 'collection_item.created'
  | 'collection_item.updated'
  | 'collection_item.deleted'
  | 'page.created'
  | 'page.updated'
  | 'page.published'
  | 'page.deleted'
  | 'asset.uploaded'
  | 'asset.deleted';

export interface WebhookFilters {
  form_id?: string | null;
  collection_id?: string | null;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  events: WebhookEventType[];
  filters: WebhookFilters | null;
  enabled: boolean;
  last_triggered_at: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  response_status: number | null;
  response_body: string | null;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  duration_ms: number | null;
  created_at: string;
}

export interface CreateWebhookData {
  name: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  filters?: WebhookFilters | null;
}

export interface UpdateWebhookData {
  name?: string;
  url?: string;
  secret?: string | null;
  events?: WebhookEventType[];
  filters?: WebhookFilters | null;
  enabled?: boolean;
}

export interface CreateWebhookDeliveryData {
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status?: 'pending' | 'success' | 'failed';
  attempts?: number;
}

export interface UpdateWebhookDeliveryData {
  response_status?: number;
  response_body?: string;
  status?: 'pending' | 'success' | 'failed';
  attempts?: number;
  duration_ms?: number;
}

export async function getAllWebhooks(): Promise<Webhook[]> {
  const knex = await getDb();
  let query = knex('webhooks')
    .select('*')
    .orderBy('created_at', 'desc');
  query = await applyTenantFilter(knex, query, 'webhooks');

  try {
    return (normalizeRows(await query) as Record<string, unknown>[]).map(mapWebhookFromDb);
  } catch (error) {
    throw new Error(
      `Failed to fetch webhooks: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getWebhookById(id: string): Promise<Webhook | null> {
  const knex = await getDb();
  let query = knex('webhooks')
    .select('*')
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'webhooks');

  try {
    const data = await query.first();
    return data ? mapWebhookFromDb(normalizeRow(data) as Record<string, unknown>) : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch webhook: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getWebhooksForEvent(eventType: WebhookEventType): Promise<Webhook[]> {
  const knex = await getDb();
  let query = knex('webhooks')
    .select('*')
    .where('enabled', true);
  query = await applyTenantFilter(knex, query, 'webhooks');

  try {
    return (normalizeRows(await query) as Record<string, unknown>[])
      .map(mapWebhookFromDb)
      .filter((webhook) => webhook.events.includes(eventType));
  } catch (error) {
    throw new Error(
      `Failed to fetch webhooks for event: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createWebhook(webhookData: CreateWebhookData): Promise<Webhook> {
  const knex = await getDb();
  const now = new Date().toISOString();
  const row = await addTenantIdToRow(knex, 'webhooks', {
    name: webhookData.name,
    url: webhookData.url,
    secret: webhookData.secret || null,
    events: webhookData.events,
    filters: webhookData.filters || null,
    enabled: true,
    failure_count: 0,
    created_at: now,
    updated_at: now,
  });

  try {
    const [data] = await knex('webhooks')
      .insert(row)
      .returning('*');
    return mapWebhookFromDb(normalizeRow(data) as Record<string, unknown>);
  } catch (error) {
    throw new Error(
      `Failed to create webhook: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateWebhook(id: string, updates: UpdateWebhookData): Promise<Webhook> {
  const knex = await getDb();
  const updateData = stripUndefined({
    name: updates.name,
    url: updates.url,
    secret: updates.secret,
    events: updates.events,
    filters: updates.filters,
    enabled: updates.enabled,
    updated_at: new Date().toISOString(),
  });
  let query = knex('webhooks')
    .where('id', id)
    .update(updateData)
    .returning('*');
  query = await applyTenantFilter(knex, query, 'webhooks');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Webhook not found');
    }
    return mapWebhookFromDb(normalizeRow(data) as Record<string, unknown>);
  } catch (error) {
    throw new Error(
      `Failed to update webhook: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteWebhook(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('webhooks')
    .where('id', id)
    .del();
  query = await applyTenantFilter(knex, query, 'webhooks');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete webhook: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function markWebhookTriggered(id: string, success: boolean): Promise<void> {
  if (!success) {
    await incrementWebhookFailureCount(id);
    return;
  }

  const knex = await getDb();
  let query = knex('webhooks')
    .where('id', id)
    .update({
      last_triggered_at: new Date().toISOString(),
      failure_count: 0,
      updated_at: new Date().toISOString(),
    });
  query = await applyTenantFilter(knex, query, 'webhooks');
  await query;
}

export async function incrementWebhookFailureCount(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('webhooks')
    .where('id', id)
    .update({
      failure_count: knex.raw('COALESCE(failure_count, 0) + 1'),
      updated_at: new Date().toISOString(),
    });
  query = await applyTenantFilter(knex, query, 'webhooks');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to increment webhook failure count: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createWebhookDelivery(
  deliveryData: CreateWebhookDeliveryData
): Promise<WebhookDelivery> {
  const knex = await getDb();
  const row = await addTenantIdToRow(knex, 'webhook_deliveries', {
    webhook_id: deliveryData.webhook_id,
    event_type: deliveryData.event_type,
    payload: deliveryData.payload,
    status: deliveryData.status || 'pending',
    attempts: deliveryData.attempts || 1,
    created_at: new Date().toISOString(),
  });

  try {
    const [data] = await knex('webhook_deliveries')
      .insert(row)
      .returning('*');
    return normalizeRow(data) as WebhookDelivery;
  } catch (error) {
    throw new Error(
      `Failed to create webhook delivery: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateWebhookDelivery(
  id: string,
  updates: UpdateWebhookDeliveryData
): Promise<void> {
  const knex = await getDb();
  let query = knex('webhook_deliveries')
    .where('id', id)
    .update(updates);
  query = await applyTenantFilter(knex, query, 'webhook_deliveries');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to update webhook delivery: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getWebhookDeliveries(
  webhookId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ deliveries: WebhookDelivery[]; total: number }> {
  const knex = await getDb();
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  let countQuery = knex('webhook_deliveries')
    .where('webhook_id', webhookId)
    .count<{ count: string | number }[]>({ count: '*' });
  countQuery = await applyTenantFilter(knex, countQuery, 'webhook_deliveries');

  let dataQuery = knex('webhook_deliveries')
    .select('*')
    .where('webhook_id', webhookId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset);
  dataQuery = await applyTenantFilter(knex, dataQuery, 'webhook_deliveries');

  try {
    const [countRow, rows] = await Promise.all([
      countQuery.first() as Promise<{ count?: string | number } | undefined>,
      dataQuery,
    ]);

    return {
      deliveries: normalizeRows(rows) as WebhookDelivery[],
      total: parseCount(countRow),
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch webhook deliveries: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteOldWebhookDeliveries(olderThanDays: number = 30): Promise<number> {
  const knex = await getDb();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  let query = knex('webhook_deliveries')
    .where('created_at', '<', cutoffDate.toISOString())
    .del()
    .returning('id');
  query = await applyTenantFilter(knex, query, 'webhook_deliveries');

  try {
    const rows = await query as Array<{ id: string }>;
    return rows.length;
  } catch (error) {
    throw new Error(
      `Failed to delete old webhook deliveries: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

function mapWebhookFromDb(data: Record<string, unknown>): Webhook {
  const events = Array.isArray(data.events)
    ? data.events as WebhookEventType[]
    : [];

  return {
    id: data.id as string,
    name: data.name as string,
    url: data.url as string,
    secret: data.secret as string | null,
    events,
    filters: (data.filters as WebhookFilters | null) || null,
    enabled: Boolean(data.enabled),
    last_triggered_at: data.last_triggered_at as string | null,
    failure_count: Number(data.failure_count || 0),
    created_at: data.created_at as string,
    updated_at: data.updated_at as string,
  };
}
