import type { Knex } from 'knex';

const TENANT_SCOPED_TABLES = [
  'settings',
  'fonts',
  'asset_folders',
  'assets',
  'page_folders',
  'pages',
  'page_layers',
  'layer_styles',
  'components',
  'collections',
  'collection_fields',
  'collection_items',
  'collection_item_values',
  'collection_imports',
  'locales',
  'translations',
  'versions',
  'webhooks',
  'webhook_deliveries',
  'api_keys',
  'app_settings',
  'form_submissions',
  'color_variables',
  'global_variables',
  'ai_chats',
] as const;

export async function up(knex: Knex): Promise<void> {
  for (const tableName of TENANT_SCOPED_TABLES) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) continue;

    const hasTenantId = await knex.schema.hasColumn(tableName, 'tenant_id');
    if (!hasTenantId) {
      await knex.schema.alterTable(tableName, (table) => {
        table.uuid('tenant_id').nullable();
      });
    }

    await knex.schema.raw(
      `CREATE INDEX IF NOT EXISTS ?? ON ?? (tenant_id)`,
      [`idx_${tableName}_tenant_id`, tableName]
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const tableName of TENANT_SCOPED_TABLES) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) continue;

    await knex.schema.raw('DROP INDEX IF EXISTS ??', [`idx_${tableName}_tenant_id`]);

    const hasTenantId = await knex.schema.hasColumn(tableName, 'tenant_id');
    if (hasTenantId) {
      await knex.schema.alterTable(tableName, (table) => {
        table.dropColumn('tenant_id');
      });
    }
  }
}
