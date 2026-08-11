/**
 * Color Variable Repository
 *
 * Data access layer for color variable operations with Supabase.
 * Color variables are site-wide design tokens stored as CSS custom properties.
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import { generateContentHash } from '@/lib/hash-utils';
import { applyTenantEq, stampTenantId, stampTenantIdMany } from '@/lib/tenant';
import type { ColorVariable } from '@/types';

export interface CreateColorVariableData {
  name: string;
  value: string;
}

export interface UpdateColorVariableData {
  name?: string;
  value?: string;
}

/**
 * Convert a stored color value (#hex or #hex/opacity) to a CSS-ready value.
 */
function toCssValue(val: string): string {
  const parts = val.split('/');
  if (parts.length < 2) return val;
  const hex = parts[0];
  const opacity = parseInt(parts[1]) / 100;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

/**
 * Generate a `:root { ... }` CSS string with all color variable declarations.
 * Returns null if no variables exist.
 */
export async function generateColorVariablesCss(): Promise<string | null> {
  try {
    const colorVars = await getAllColorVariables();
    if (colorVars.length === 0) return null;
    const declarations = colorVars.map((v) => `--${v.id}: ${toCssValue(v.value)};`).join(' ');
    return `:root { ${declarations} }`;
  } catch {
    return null;
  }
}

export async function getAllColorVariables(): Promise<ColorVariable[]> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client
    .from('color_variables')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  query = (await applyTenantEq(query)).query;
  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch color variables: ${error.message}`);
  }

  return data || [];
}

export async function getColorVariableById(id: string): Promise<ColorVariable | null> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client
    .from('color_variables')
    .select('*')
    .eq('id', id);

  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch color variable: ${error.message}`);
  }

  return data;
}

export async function createColorVariable(
  variableData: CreateColorVariableData
): Promise<ColorVariable> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Get max sort_order to append at end
  let maxQuery = client
    .from('color_variables')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1);

  maxQuery = (await applyTenantEq(maxQuery)).query;
  const { data: maxRow } = await maxQuery.single();
  const nextOrder = (maxRow?.sort_order ?? -1) + 1;

  const row = await stampTenantId({ ...variableData, sort_order: nextOrder });

  const { data, error } = await client
    .from('color_variables')
    .insert(row)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create color variable: ${error.message}`);
  }

  return data;
}

export async function updateColorVariable(
  id: string,
  updates: UpdateColorVariableData
): Promise<ColorVariable> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client
    .from('color_variables')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);

  query = (await applyTenantEq(query)).query;
  const { data, error } = await query.select().single();

  if (error) {
    throw new Error(`Failed to update color variable: ${error.message}`);
  }

  return data;
}

export async function deleteColorVariable(id: string): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client
    .from('color_variables')
    .delete()
    .eq('id', id);

  query = (await applyTenantEq(query)).query;
  const { error } = await query;

  if (error) {
    throw new Error(`Failed to delete color variable: ${error.message}`);
  }
}

export async function reorderColorVariables(
  orderedIds: string[]
): Promise<void> {
  const client = await getSupabaseAdmin();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  // Fetch full rows so upsert includes all NOT NULL columns
  let fetchQuery = client
    .from('color_variables')
    .select('*')
    .in('id', orderedIds);

  fetchQuery = (await applyTenantEq(fetchQuery)).query;
  const { data: existing, error: fetchError } = await fetchQuery;

  if (fetchError) {
    throw new Error(`Failed to fetch color variables for reorder: ${fetchError.message}`);
  }

  const existingMap = new Map((existing || []).map((v) => [v.id, v]));
  const now = new Date().toISOString();

  const updates = orderedIds
    .map((id, index) => {
      const row = existingMap.get(id);
      if (!row) return null;
      return { ...row, sort_order: index, updated_at: now };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const stamped = await stampTenantIdMany(updates);

  const { error } = await client
    .from('color_variables')
    .upsert(stamped, { onConflict: 'id' });

  if (error) {
    throw new Error(`Failed to reorder color variables: ${error.message}`);
  }
}

/**
 * Compute a deterministic hash of all color variables.
 * Used to detect changes between publishes — color variables have no
 * draft/published model so we compare the current state against a
 * stored snapshot hash.
 */
export async function getColorVariablesHash(): Promise<string> {
  const variables = await getAllColorVariables();
  return generateContentHash(
    variables.map(v => ({ id: v.id, name: v.name, value: v.value, sort_order: v.sort_order }))
  );
}
