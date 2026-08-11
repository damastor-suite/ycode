import { batchUpdateColumn } from '@/lib/knex-helpers';
import { generateContentHash } from '@/lib/hash-utils';
import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type { ColorVariable } from '@/types';

/**
 * Color Variable Repository
 *
 * Data access layer for site-wide color design tokens.
 */

export interface CreateColorVariableData {
  name: string;
  value: string;
}

export interface UpdateColorVariableData {
  name?: string;
  value?: string;
}

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
  const knex = await getDb();
  let query = knex('color_variables')
    .select('*')
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc');
  query = await applyTenantFilter(knex, query, 'color_variables');

  try {
    return normalizeRows(await query) as ColorVariable[];
  } catch (error) {
    throw new Error(
      `Failed to fetch color variables: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getColorVariableById(id: string): Promise<ColorVariable | null> {
  const knex = await getDb();
  let query = knex('color_variables')
    .select('*')
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'color_variables');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as ColorVariable : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch color variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createColorVariable(
  variableData: CreateColorVariableData
): Promise<ColorVariable> {
  const knex = await getDb();
  let maxQuery = knex('color_variables')
    .max<{ max: number | string | null }>('sort_order as max');
  maxQuery = await applyTenantFilter(knex, maxQuery, 'color_variables');

  try {
    const [maxRow] = await maxQuery;
    const nextOrder = Number(maxRow?.max ?? -1) + 1;
    const row = await addTenantIdToRow(knex, 'color_variables', {
      ...variableData,
      sort_order: nextOrder,
    });

    const [data] = await knex('color_variables')
      .insert(row)
      .returning('*');

    return normalizeRow(data) as ColorVariable;
  } catch (error) {
    throw new Error(
      `Failed to create color variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateColorVariable(
  id: string,
  updates: UpdateColorVariableData
): Promise<ColorVariable> {
  const knex = await getDb();
  let query = knex('color_variables')
    .where('id', id)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .returning('*');
  query = await applyTenantFilter(knex, query, 'color_variables');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Color variable not found');
    }
    return normalizeRow(data) as ColorVariable;
  } catch (error) {
    throw new Error(
      `Failed to update color variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteColorVariable(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('color_variables')
    .where('id', id)
    .del();
  query = await applyTenantFilter(knex, query, 'color_variables');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete color variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function reorderColorVariables(
  orderedIds: string[]
): Promise<void> {
  if (orderedIds.length === 0) {
    return;
  }

  const knex = await getDb();

  try {
    await batchUpdateColumn(
      knex,
      'color_variables',
      'sort_order',
      orderedIds.map((id, index) => ({ id, value: index })),
      { castType: 'integer' }
    );
  } catch (error) {
    throw new Error(
      `Failed to reorder color variables: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getColorVariablesHash(): Promise<string> {
  const variables = await getAllColorVariables();
  return generateContentHash(
    variables.map(v => ({ id: v.id, name: v.name, value: v.value, sort_order: v.sort_order }))
  );
}
