import type { Knex } from 'knex';

import { addTenantFilter } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';

type DbRow = Record<string, unknown>;

export async function applyTenantFilter(
  knex: Knex,
  query: Knex.QueryBuilder,
  tableName: string,
  tenantId?: string
): Promise<Knex.QueryBuilder> {
  if (!tenantId) {
    return addTenantFilter(knex, query, tableName);
  }

  const hasTenantColumn = await knex.schema.hasColumn(tableName, 'tenant_id');
  if (!hasTenantColumn) {
    return query;
  }

  return query.where('tenant_id', tenantId);
}

export async function resolveTenantIdForTable(
  knex: Knex,
  tableName: string,
  tenantId?: string
): Promise<string | null> {
  const resolvedTenantId = tenantId ?? await getTenantIdFromHeaders();
  if (!resolvedTenantId) {
    return null;
  }

  const hasTenantColumn = await knex.schema.hasColumn(tableName, 'tenant_id');
  return hasTenantColumn ? resolvedTenantId : null;
}

export async function addTenantIdToRow<T extends DbRow>(
  knex: Knex,
  tableName: string,
  row: T,
  tenantId?: string
): Promise<T> {
  const resolvedTenantId = await resolveTenantIdForTable(knex, tableName, tenantId);
  if (!resolvedTenantId) {
    return row;
  }

  return {
    ...row,
    tenant_id: resolvedTenantId,
  };
}

export async function getConflictColumns(
  knex: Knex,
  tableName: string,
  columns: string[],
  tenantId?: string | null
): Promise<string[]> {
  if (!tenantId) {
    return columns;
  }

  const hasTenantColumn = await knex.schema.hasColumn(tableName, 'tenant_id');
  return hasTenantColumn ? ['tenant_id', ...columns] : columns;
}

export function normalizeRow<T>(row: T): T {
  if (!row || typeof row !== 'object' || row instanceof Date) {
    return row;
  }

  const normalized: DbRow = {};
  for (const [key, value] of Object.entries(row as DbRow)) {
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }

  return normalized as T;
}

export function normalizeRows<T>(rows: T[]): T[] {
  return rows.map(normalizeRow);
}

export function parseCount(row: { count?: string | number } | undefined): number {
  return Number(row?.count ?? 0);
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function stripUndefined<T extends DbRow>(row: T): DbRow {
  const result: DbRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
