/**
 * Settings Repository — Knex data access
 */

import { getDb, isMissingTableError } from '@/lib/platform/db';
import { addTenantFilter } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import type { Setting } from '@/types';

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<Setting[]> {
  const knex = await getDb();

  try {
    let query = knex('settings').select('*').orderBy('key', 'asc');
    query = await addTenantFilter(knex, query, 'settings');
    return await query;
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(
      `Failed to fetch settings: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get a setting by key
 */
export async function getSettingByKey<T = Setting['value']>(key: string, _tenantId?: string): Promise<T | null> {
  const knex = await getDb();

  try {
    let query = knex('settings').select('value').where('key', key);
    query = await addTenantFilter(knex, query, 'settings');
    const row = await query.first();
    return (row?.value ?? null) as T | null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(
      `Failed to fetch setting: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get multiple settings by keys in a single query
 */
export async function getSettingsByKeys(keys: string[]): Promise<Record<string, Setting['value']>> {
  if (keys.length === 0) {
    return {};
  }

  const knex = await getDb();

  try {
    let query = knex('settings').select('key', 'value').whereIn('key', keys);
    query = await addTenantFilter(knex, query, 'settings');
    const data = await query;

    const result: Record<string, Setting['value']> = {};
    for (const setting of data) {
      result[setting.key] = setting.value;
    }
    return result;
  } catch (error) {
    if (isMissingTableError(error)) return {};
    throw new Error(
      `Failed to fetch settings: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Set a setting value (insert or update)
 */
export async function setSetting(key: string, value: unknown): Promise<Setting> {
  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const now = new Date().toISOString();

  const row: Record<string, unknown> = {
    key,
    value,
    updated_at: now,
  };
  if (tenantId) {
    row.tenant_id = tenantId;
  }

  const mergeCols = ['value', 'updated_at'];
  // Prefer simple key conflict for OSS without tenant unique index
  try {
    const insertQuery = knex('settings').insert(row);
    const upsertQuery = tenantId
      ? insertQuery.onConflict(['tenant_id', 'key'])
      : insertQuery.onConflict('key');
    const [data] = await upsertQuery.merge(mergeCols).returning('*');
    return data;
  } catch (error) {
    // Fallback: update-then-insert if composite conflict unsupported
    let existing = knex('settings').where('key', key);
    existing = await addTenantFilter(knex, existing, 'settings');
    const found = await existing.first();
    if (found) {
      const [data] = await knex('settings')
        .where('id', found.id)
        .update({ value, updated_at: now })
        .returning('*');
      return data;
    }
    const [data] = await knex('settings').insert(row).returning('*');
    return data;
  }
}

/**
 * Set multiple settings at once (batch upsert)
 */
export async function setSettings(settings: Record<string, unknown>): Promise<number> {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return 0;
  }

  const knex = await getDb();
  const tenantId = await getTenantIdFromHeaders();
  const toUpsert: [string, unknown][] = [];
  const toDelete: string[] = [];

  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      toDelete.push(key);
    } else {
      toUpsert.push([key, value]);
    }
  }

  if (toDelete.length > 0) {
    let del = knex('settings').whereIn('key', toDelete);
    del = await addTenantFilter(knex, del, 'settings');
    await del.del();
  }

  if (toUpsert.length > 0) {
    const now = new Date().toISOString();
    const records = toUpsert.map(([key, value]) => {
      const r: Record<string, unknown> = { key, value, updated_at: now };
      if (tenantId) r.tenant_id = tenantId;
      return r;
    });

    try {
      const insertQuery = knex('settings').insert(records);
      const upsertQuery = tenantId
        ? insertQuery.onConflict(['tenant_id', 'key'])
        : insertQuery.onConflict('key');
      await upsertQuery.merge(['value', 'updated_at']);
    } catch {
      for (const [key, value] of toUpsert) {
        await setSetting(key, value);
      }
    }
  }

  return entries.length;
}
