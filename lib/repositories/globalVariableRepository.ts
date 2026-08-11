import { cache } from 'react';

import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  getConflictColumns,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type {
  GlobalVariable,
  CreateGlobalVariableData,
  UpdateGlobalVariableData,
} from '@/types';

function globalSignature(v: GlobalVariable): string {
  return JSON.stringify({
    name: v.name,
    key: v.key,
    type: v.type,
    value: v.value,
    data: v.data ?? {},
    order: v.order,
  });
}

export const getAllGlobalVariables = cache(async (
  isPublished: boolean = false
): Promise<GlobalVariable[]> => {
  const knex = await getDb();
  let query = knex('global_variables')
    .select('*')
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('order', 'asc')
    .orderBy('created_at', 'asc');
  query = await applyTenantFilter(knex, query, 'global_variables');

  try {
    return normalizeRows(await query) as GlobalVariable[];
  } catch (error) {
    throw new Error(
      `Failed to fetch global variables: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
});

export async function getGlobalVariableById(
  id: string,
  isPublished: boolean = false
): Promise<GlobalVariable | null> {
  const knex = await getDb();
  let query = knex('global_variables')
    .select('*')
    .where('id', id)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'global_variables');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as GlobalVariable : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch global variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createGlobalVariable(
  variableData: CreateGlobalVariableData
): Promise<GlobalVariable> {
  const knex = await getDb();

  try {
    let order = variableData.order;
    if (order === undefined) {
      let maxQuery = knex('global_variables')
        .max<{ max: number | string | null }>('order as max')
        .where('is_published', false);
      maxQuery = await applyTenantFilter(knex, maxQuery, 'global_variables');
      const maxRow = await maxQuery.first();
      order = Number(maxRow?.max ?? -1) + 1;
    }

    const row = await addTenantIdToRow(knex, 'global_variables', {
      name: variableData.name,
      key: variableData.key ?? null,
      type: variableData.type,
      value: variableData.value ?? null,
      data: variableData.data ?? {},
      order,
      is_published: false,
    });

    const [data] = await knex('global_variables')
      .insert(row)
      .returning('*');

    return normalizeRow(data) as GlobalVariable;
  } catch (error) {
    throw new Error(
      `Failed to create global variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateGlobalVariable(
  id: string,
  updates: UpdateGlobalVariableData
): Promise<GlobalVariable> {
  const knex = await getDb();
  let query = knex('global_variables')
    .where('id', id)
    .where('is_published', false)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .returning('*');
  query = await applyTenantFilter(knex, query, 'global_variables');

  try {
    const [data] = await query;
    if (!data) {
      throw new Error('Global variable not found');
    }
    return normalizeRow(data) as GlobalVariable;
  } catch (error) {
    throw new Error(
      `Failed to update global variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function softDeleteGlobalVariable(id: string): Promise<void> {
  const knex = await getDb();
  let query = knex('global_variables')
    .where('id', id)
    .where('is_published', false)
    .update({ deleted_at: new Date().toISOString() });
  query = await applyTenantFilter(knex, query, 'global_variables');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete global variable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getUnpublishedGlobalVariables(): Promise<GlobalVariable[]> {
  const knex = await getDb();
  let draftQuery = knex('global_variables')
    .select('*')
    .where('is_published', false);
  draftQuery = await applyTenantFilter(knex, draftQuery, 'global_variables');

  try {
    const drafts = normalizeRows(await draftQuery) as GlobalVariable[];
    if (drafts.length === 0) {
      return [];
    }

    let publishedQuery = knex('global_variables')
      .select('*')
      .whereIn('id', drafts.map((draft) => draft.id))
      .where('is_published', true);
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'global_variables');
    const published = normalizeRows(await publishedQuery) as GlobalVariable[];
    const publishedById = new Map(published.map((item) => [item.id, item]));

    return drafts.filter((draft) => {
      const live = publishedById.get(draft.id);
      if (draft.deleted_at) {
        return Boolean(live && !live.deleted_at);
      }
      return !live || Boolean(live.deleted_at) || globalSignature(draft) !== globalSignature(live);
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch draft global variables: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getUnpublishedGlobalVariablesCount(): Promise<number> {
  const globals = await getUnpublishedGlobalVariables();
  return globals.length;
}

export async function publishGlobalVariables(): Promise<{ count: number; changedIds: string[] }> {
  const knex = await getDb();
  let draftQuery = knex('global_variables')
    .select('*')
    .where('is_published', false);
  draftQuery = await applyTenantFilter(knex, draftQuery, 'global_variables');

  try {
    const drafts = normalizeRows(await draftQuery) as GlobalVariable[];
    if (drafts.length === 0) {
      return { count: 0, changedIds: [] };
    }

    let publishedQuery = knex('global_variables')
      .select('*')
      .whereIn('id', drafts.map((draft) => draft.id))
      .where('is_published', true);
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'global_variables');
    const published = normalizeRows(await publishedQuery) as GlobalVariable[];
    const publishedById = new Map(published.map((item) => [item.id, item]));

    const now = new Date().toISOString();
    const deletedIds: string[] = [];
    const toUpsert: Record<string, unknown>[] = [];

    for (const draft of drafts) {
      const live = publishedById.get(draft.id);
      if (draft.deleted_at) {
        if (live) deletedIds.push(draft.id);
        continue;
      }

      if (!live || globalSignature(draft) !== globalSignature(live)) {
        const record: Record<string, unknown> = {
          id: draft.id,
          name: draft.name,
          key: draft.key,
          type: draft.type,
          value: draft.value,
          data: draft.data ?? {},
          order: draft.order,
          is_published: true,
          updated_at: now,
        };
        const tenantId = (draft as unknown as Record<string, unknown>).tenant_id;
        if (tenantId) record.tenant_id = tenantId;
        toUpsert.push(record);
      }
    }

    if (toUpsert.length > 0) {
      const conflictColumns = await getConflictColumns(
        knex,
        'global_variables',
        ['id', 'is_published'],
        toUpsert[0].tenant_id as string | undefined
      );
      await knex('global_variables')
        .insert(toUpsert)
        .onConflict(conflictColumns)
        .merge(['name', 'key', 'type', 'value', 'data', 'order', 'updated_at', 'deleted_at']);
    }

    if (deletedIds.length > 0) {
      let deleteQuery = knex('global_variables')
        .whereIn('id', deletedIds)
        .where('is_published', true)
        .del();
      deleteQuery = await applyTenantFilter(knex, deleteQuery, 'global_variables');
      await deleteQuery;
    }

    const changedIds = [...toUpsert.map((u) => u.id as string), ...deletedIds];
    return { count: changedIds.length, changedIds };
  } catch (error) {
    throw new Error(
      `Failed to publish global variables: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function hardDeleteSoftDeletedGlobalVariables(): Promise<{ count: number }> {
  const knex = await getDb();
  let selectQuery = knex('global_variables')
    .select('id')
    .where('is_published', false)
    .whereNotNull('deleted_at');
  selectQuery = await applyTenantFilter(knex, selectQuery, 'global_variables');

  try {
    const deletedDrafts = await selectQuery as Array<{ id: string }>;
    if (deletedDrafts.length === 0) {
      return { count: 0 };
    }

    let deleteQuery = knex('global_variables')
      .whereIn('id', deletedDrafts.map((draft) => draft.id))
      .del();
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'global_variables');
    await deleteQuery;

    return { count: deletedDrafts.length };
  } catch (error) {
    throw new Error(
      `Failed to hard delete global variables: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
