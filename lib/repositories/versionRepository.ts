import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
  parseCount,
} from './knex-repository-utils';
import type { Version, CreateVersionData, VersionEntityType, VersionHistoryItem } from '@/types';

/**
 * Version Repository
 *
 * Handles CRUD operations for version history (undo/redo functionality).
 */

export const SNAPSHOT_INTERVAL = 10;
export const MAX_VERSIONS_PER_ENTITY = 50;

export async function createVersion(data: CreateVersionData): Promise<Version> {
  const knex = await getDb();
  await enforceVersionLimit(data.entity_type, data.entity_id, MAX_VERSIONS_PER_ENTITY - 1);

  const row = await addTenantIdToRow(knex, 'versions', {
    entity_type: data.entity_type,
    entity_id: data.entity_id,
    action_type: data.action_type,
    description: data.description || null,
    redo: data.redo,
    undo: data.undo || null,
    snapshot: data.snapshot || null,
    previous_hash: data.previous_hash || null,
    current_hash: data.current_hash,
    session_id: data.session_id || null,
    metadata: data.metadata || null,
  });

  try {
    const [result] = await knex('versions')
      .insert(row)
      .returning('*');
    return normalizeRow(result) as Version;
  } catch (error) {
    throw new Error(
      `Failed to create version: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getVersionHistory(
  entityType: VersionEntityType,
  entityId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Version[]> {
  const knex = await getDb();
  let query = knex('versions')
    .select('*')
    .where('entity_type', entityType)
    .where('entity_id', entityId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset);
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    return normalizeRows(await query) as Version[];
  } catch (error) {
    throw new Error(
      `Failed to fetch version history: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getVersionHistorySummary(
  entityType: VersionEntityType,
  entityId: string,
  limit: number = 50
): Promise<VersionHistoryItem[]> {
  const knex = await getDb();
  let query = knex('versions')
    .select('id', 'action_type', 'description', 'created_at')
    .where('entity_type', entityType)
    .where('entity_id', entityId)
    .orderBy('created_at', 'desc')
    .limit(limit);
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    return normalizeRows(await query) as VersionHistoryItem[];
  } catch (error) {
    throw new Error(
      `Failed to fetch version history summary: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getVersionById(id: string): Promise<Version | null> {
  const knex = await getDb();
  let query = knex('versions')
    .select('*')
    .where('id', id);
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Version : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch version: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getLatestVersion(
  entityType: VersionEntityType,
  entityId: string
): Promise<Version | null> {
  const knex = await getDb();
  let query = knex('versions')
    .select('*')
    .where('entity_type', entityType)
    .where('entity_id', entityId)
    .orderBy('created_at', 'desc')
    .limit(1);
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Version : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch latest version: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getVersionCount(
  entityType: VersionEntityType,
  entityId: string
): Promise<number> {
  const knex = await getDb();
  let query = knex('versions')
    .where('entity_type', entityType)
    .where('entity_id', entityId)
    .count<{ count: string | number }[]>({ count: '*' });
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    const row = await query.first() as { count?: string | number } | undefined;
    return parseCount(row);
  } catch (error) {
    throw new Error(
      `Failed to count versions: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function shouldStoreSnapshot(
  entityType: VersionEntityType,
  entityId: string
): Promise<boolean> {
  const count = await getVersionCount(entityType, entityId);
  return count > 0 && count % SNAPSHOT_INTERVAL === 0;
}

export async function getLatestSnapshot(
  entityType: VersionEntityType,
  entityId: string
): Promise<{ version: Version; snapshot: object } | null> {
  const knex = await getDb();
  let query = knex('versions')
    .select('*')
    .where('entity_type', entityType)
    .where('entity_id', entityId)
    .whereNotNull('snapshot')
    .orderBy('created_at', 'desc')
    .limit(1);
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    const row = await query.first();
    if (!row?.snapshot) {
      return null;
    }

    const version = normalizeRow(row) as Version;
    return { version, snapshot: version.snapshot as object };
  } catch (error) {
    throw new Error(
      `Failed to fetch latest snapshot: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function enforceVersionLimit(
  entityType?: VersionEntityType,
  entityId?: string,
  maxVersions: number = MAX_VERSIONS_PER_ENTITY
): Promise<number> {
  const knex = await getDb();

  try {
    if (entityType && entityId) {
      let selectQuery = knex('versions')
        .select('id')
        .where('entity_type', entityType)
        .where('entity_id', entityId)
        .orderBy('created_at', 'desc');
      selectQuery = await applyTenantFilter(knex, selectQuery, 'versions');
      const allVersions = await selectQuery as Array<{ id: string }>;

      if (allVersions.length <= maxVersions) {
        return 0;
      }

      const idsToDelete = allVersions.slice(maxVersions).map(version => version.id);
      let deleteQuery = knex('versions')
        .whereIn('id', idsToDelete)
        .del();
      deleteQuery = await applyTenantFilter(knex, deleteQuery, 'versions');
      await deleteQuery;
      return idsToDelete.length;
    }

    let entitiesQuery = knex('versions')
      .distinct('entity_type', 'entity_id');
    entitiesQuery = await applyTenantFilter(knex, entitiesQuery, 'versions');
    const entities = await entitiesQuery as Array<{ entity_type: VersionEntityType; entity_id: string }>;

    let totalDeleted = 0;
    for (const entity of entities) {
      totalDeleted += await enforceVersionLimit(entity.entity_type, entity.entity_id, maxVersions);
    }
    return totalDeleted;
  } catch {
    return 0;
  }
}

export async function cleanupOldVersions(
  olderThanDays: number = 30
): Promise<number> {
  const knex = await getDb();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  let totalDeleted = 0;
  try {
    let deleteQuery = knex('versions')
      .where('created_at', '<', cutoffDate.toISOString())
      .del()
      .returning('id');
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'versions');
    const oldVersions = await deleteQuery as Array<{ id: string }>;
    totalDeleted += oldVersions.length;
  } catch (error) {
    console.error('Failed to cleanup old versions:', error);
  }

  totalDeleted += await enforceVersionLimit();
  return totalDeleted;
}

export async function getVersionsBySession(sessionId: string): Promise<Version[]> {
  const knex = await getDb();
  let query = knex('versions')
    .select('*')
    .where('session_id', sessionId)
    .orderBy('created_at', 'asc');
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    return normalizeRows(await query) as Version[];
  } catch (error) {
    throw new Error(
      `Failed to fetch versions by session: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteVersionsForEntity(
  entityType: VersionEntityType,
  entityId: string
): Promise<void> {
  const knex = await getDb();
  let query = knex('versions')
    .where('entity_type', entityType)
    .where('entity_id', entityId)
    .del();
  query = await applyTenantFilter(knex, query, 'versions');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete versions: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
