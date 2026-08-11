/**
 * Shared helpers for wiping / clearing tenant-scoped content safely.
 */

import type { Knex } from 'knex';
import { deleteTenantRows, resolveTenantId } from '@/lib/tenant';

/**
 * Clear content tables for import/template apply.
 * - With tenant context: DELETE WHERE tenant_id = ?
 * - Without (OSS single-tenant): TRUNCATE CASCADE (whole DB ownership)
 */
export async function clearContentTables(
  trx: Knex.Transaction,
  tables: string[],
  tenantId?: string | null
): Promise<void> {
  const resolved = tenantId ?? await resolveTenantId();

  if (resolved) {
    await deleteTenantRows(trx, tables, resolved);
    return;
  }

  const existingTables: string[] = [];
  for (const table of tables) {
    if (await trx.schema.hasTable(table)) {
      existingTables.push(table);
    }
  }

  if (existingTables.length > 0) {
    await trx.raw(`TRUNCATE ${existingTables.join(', ')} CASCADE`);
  }
}
