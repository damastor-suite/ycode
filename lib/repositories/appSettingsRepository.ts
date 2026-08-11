import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';

/**
 * App Settings Repository
 *
 * Generic key-value store for app integration settings.
 */

export interface AppSetting {
  id: string;
  app_id: string;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export async function getAppSettings(appId: string): Promise<AppSetting[]> {
  const knex = await getDb();
  let query = knex('app_settings')
    .select('*')
    .where('app_id', appId)
    .orderBy('key', 'asc');
  query = await applyTenantFilter(knex, query, 'app_settings');

  try {
    return normalizeRows(await query) as AppSetting[];
  } catch (error) {
    throw new Error(
      `Failed to fetch app settings: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAppSetting(
  appId: string,
  key: string
): Promise<AppSetting | null> {
  const knex = await getDb();
  let query = knex('app_settings')
    .select('*')
    .where('app_id', appId)
    .where('key', key);
  query = await applyTenantFilter(knex, query, 'app_settings');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as AppSetting : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch app setting: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getAppSettingValue<T = unknown>(
  appId: string,
  key: string
): Promise<T | null> {
  const setting = await getAppSetting(appId, key);
  return setting ? (setting.value as T) : null;
}

export async function hasAppSetting(
  appId: string,
  key: string
): Promise<boolean> {
  return await getAppSetting(appId, key) !== null;
}

export async function getConnectedAppIds(): Promise<string[]> {
  const knex = await getDb();
  let query = knex('app_settings')
    .distinct('app_id')
    .orderBy('app_id', 'asc');
  query = await applyTenantFilter(knex, query, 'app_settings');

  try {
    const rows = await query as Array<{ app_id: string }>;
    return rows.map((row) => row.app_id);
  } catch (error) {
    throw new Error(
      `Failed to fetch connected apps: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function setAppSetting(
  appId: string,
  key: string,
  value: unknown
): Promise<AppSetting> {
  const knex = await getDb();
  const now = new Date().toISOString();
  const row = await addTenantIdToRow(knex, 'app_settings', {
    app_id: appId,
    key,
    value,
    updated_at: now,
  });
  const conflictColumns = await getConflictColumns(
    knex,
    'app_settings',
    ['app_id', 'key'],
    (row as Record<string, unknown>).tenant_id as string | undefined
  );

  try {
    const [data] = await knex('app_settings')
      .insert(row)
      .onConflict(conflictColumns)
      .merge(['value', 'updated_at'])
      .returning('*');

    return normalizeRow(data) as AppSetting;
  } catch (error) {
    throw new Error(
      `Failed to set app setting: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteAppSetting(
  appId: string,
  key: string
): Promise<void> {
  const knex = await getDb();
  let query = knex('app_settings')
    .where('app_id', appId)
    .where('key', key)
    .del();
  query = await applyTenantFilter(knex, query, 'app_settings');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete app setting: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteAllAppSettings(appId: string): Promise<void> {
  const knex = await getDb();
  let query = knex('app_settings')
    .where('app_id', appId)
    .del();
  query = await applyTenantFilter(knex, query, 'app_settings');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete app settings: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
