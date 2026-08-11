/**
 * Settings Repository
 *
 * Data access layer for application settings stored in the database
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import {
  applyTenantEq,
  resolveTenantId,
  stampTenantId,
  stampTenantIdMany,
} from '@/lib/tenant';
import type { Setting } from '@/types';

// Postgres "undefined_table" — the settings table is briefly absent right after
// a DB reset and before migrations re-run. Treat it as "no settings" instead of
// crashing page renders.
const UNDEFINED_TABLE = '42P01';

/** True when an error indicates the settings table does not exist yet. */
function isMissingTableError(error: { code?: string } | null): boolean {
  return error?.code === UNDEFINED_TABLE;
}

/**
 * Get all settings
 *
 * @returns Promise resolving to all settings
 */
export async function getAllSettings(): Promise<Setting[]> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  let query = client
    .from('settings')
    .select('*');
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.order('key', { ascending: true });

  if (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw new Error(`Failed to fetch settings: ${error.message}`);
  }

  return data || [];
}

/**
 * Get a setting by key
 *
 * @param key - The setting key
 * @param tenantId - Optional tenant scope (ignored in single-tenant deployments)
 * @returns Promise resolving to the setting value or null if not found
 */
export async function getSettingByKey(key: string, tenantId?: string): Promise<Setting['value'] | null> {
  const client = await getSupabaseAdmin(tenantId);
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  let query = client
    .from('settings')
    .select('value')
    .eq('key', key);
  query = (await applyTenantEq(query, tenantId)).query;
  const { data, error } = await query.single();

  if (error) {
    if (error.code === 'PGRST116' || isMissingTableError(error)) {
      // Not found, or table not yet created
      return null;
    }
    throw new Error(`Failed to fetch setting: ${error.message}`);
  }

  return data?.value ?? null;
}

/**
 * Get multiple settings by keys in a single query
 *
 * @param keys - Array of setting keys to fetch
 * @returns Promise resolving to a map of key -> value
 */
export async function getSettingsByKeys(keys: string[]): Promise<Record<string, Setting['value']>> {
  if (keys.length === 0) {
    return {};
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  let query = client
    .from('settings')
    .select('key, value')
    .in('key', keys);
  query = (await applyTenantEq(query)).query;
  const { data, error } = await query;

  if (error) {
    if (isMissingTableError(error)) {
      return {};
    }
    throw new Error(`Failed to fetch settings: ${error.message}`);
  }

  const result: Record<string, Setting['value']> = {};
  for (const setting of data || []) {
    result[setting.key] = setting.value;
  }

  return result;
}

/**
 * Set a setting value (insert or update)
 *
 * @param key - The setting key
 * @param value - The value to store
 * @returns Promise resolving to the created/updated setting
 */
export async function setSetting(key: string, value: Setting['value']): Promise<Setting> {
  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveTenantId();
  const record = await stampTenantId({
    key,
    value,
    updated_at: new Date().toISOString(),
  });

  const { data, error } = await client
    .from('settings')
    .upsert(record, {
      onConflict: tenantId ? 'tenant_id,key' : 'key',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to set setting: ${error.message}`);
  }

  return data;
}

/**
 * Set multiple settings at once (batch upsert)
 * Settings with null/undefined values are deleted instead of upserted.
 *
 * @param settings - Object with key-value pairs to store
 * @returns Promise resolving to the number of settings updated
 */
export async function setSettings(settings: Record<string, Setting['value']>): Promise<number> {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return 0;
  }

  const client = await getSupabaseAdmin();
  if (!client) {
    throw new Error('Failed to initialize Supabase client');
  }

  const tenantId = await resolveTenantId();

  // Separate entries: null/undefined values should be deleted, others upserted
  const toUpsert: [string, Setting['value']][] = [];
  const toDelete: string[] = [];

  for (const [key, value] of entries) {
    if (value === null || value === undefined) {
      toDelete.push(key);
    } else {
      toUpsert.push([key, value]);
    }
  }

  // Delete settings with null values
  if (toDelete.length > 0) {
    let deleteQuery = client
      .from('settings')
      .delete()
      .in('key', toDelete);
    deleteQuery = (await applyTenantEq(deleteQuery)).query;
    const { error: deleteError } = await deleteQuery;

    if (deleteError) {
      throw new Error(`Failed to delete settings: ${deleteError.message}`);
    }
  }

  // Upsert settings with non-null values
  if (toUpsert.length > 0) {
    const now = new Date().toISOString();
    const records = await stampTenantIdMany(
      toUpsert.map(([key, value]) => ({
        key,
        value,
        updated_at: now,
      }))
    );

    const { error } = await client
      .from('settings')
      .upsert(records, {
        onConflict: tenantId ? 'tenant_id,key' : 'key',
      });

    if (error) {
      throw new Error(`Failed to set settings: ${error.message}`);
    }
  }

  return entries.length;
}
