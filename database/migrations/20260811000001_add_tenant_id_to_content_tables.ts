import type { Knex } from 'knex';

/**
 * Shared-DB readiness: add nullable tenant_id to all content tables and
 * create tenant-scoped unique indexes for cloud (SKIP_SETUP=true).
 *
 * Opensource keeps existing global uniques (one site per DB).
 * Cloud drops colliding global uniques and recreates them with tenant_id.
 */

const CONTENT_TABLES = [
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

async function ensureTenantIdColumn(knex: Knex, table: string): Promise<void> {
  const hasTable = await knex.schema.hasTable(table);
  if (!hasTable) return;

  const hasTenantId = await knex.schema.hasColumn(table, 'tenant_id');
  if (hasTenantId) return;

  await knex.schema.alterTable(table, (t) => {
    t.uuid('tenant_id').nullable();
  });

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_${table}_tenant_id
    ON ${table}(tenant_id)
  `);
}

export async function up(knex: Knex): Promise<void> {
  // Session helper used by Knex bulk inserts / cloud triggers
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM set_config('app.tenant_id', COALESCE(p_tenant_id::text, ''), true);
    END;
    $$;
  `);

  for (const table of CONTENT_TABLES) {
    await ensureTenantIdColumn(knex, table);
  }

  // Cloud shared-DB: replace global uniques with tenant-scoped ones
  if (process.env.SKIP_SETUP !== 'true') {
    return;
  }

  // settings: UNIQUE(key) → UNIQUE(tenant_id, key)
  await knex.schema.raw(`
    ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_key_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS settings_tenant_key_unique
    ON settings (tenant_id, key)
    WHERE tenant_id IS NOT NULL;
  `);

  // app_settings: UNIQUE(app_id, key) → UNIQUE(tenant_id, app_id, key)
  await knex.schema.raw(`
    ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_app_id_key_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_tenant_app_key_unique
    ON app_settings (tenant_id, app_id, key)
    WHERE tenant_id IS NOT NULL;
  `);

  // locales: UNIQUE(code, is_published) → include tenant_id
  await knex.schema.raw(`
    ALTER TABLE locales DROP CONSTRAINT IF EXISTS locales_code_is_published_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS locales_tenant_code_published_unique
    ON locales (tenant_id, code, is_published)
    WHERE tenant_id IS NOT NULL;
  `);

  // collections: UNIQUE(uuid) → UNIQUE(tenant_id, uuid)
  await knex.schema.raw(`
    ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_uuid_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS collections_tenant_uuid_unique
    ON collections (tenant_id, uuid)
    WHERE tenant_id IS NOT NULL;
  `);

  // pages: tenant-scoped slug uniqueness (cloud_migrations may already create this)
  await knex.schema.raw(`
    DROP INDEX IF EXISTS pages_slug_is_published_folder_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS pages_tenant_slug_unique
    ON pages (
      tenant_id,
      slug,
      is_published,
      COALESCE(page_folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(error_page, 0)
    )
    WHERE deleted_at IS NULL AND is_dynamic = false AND tenant_id IS NOT NULL;
  `);

  // translations: add tenant_id to uniqueness when present
  await knex.schema.raw(`
    ALTER TABLE translations DROP CONSTRAINT IF EXISTS translations_locale_id_source_type_source_id_content_key_is_published_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS translations_tenant_source_unique
    ON translations (tenant_id, locale_id, source_type, source_id, content_key, is_published)
    WHERE tenant_id IS NOT NULL;
  `);

  // collection_item_values: tenant-aware unique
  await knex.schema.raw(`
    DROP INDEX IF EXISTS idx_collection_item_values_unique;
  `);
  await knex.schema.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_item_values_tenant_unique
    ON collection_item_values (tenant_id, item_id, field_id, is_published)
    WHERE deleted_at IS NULL AND tenant_id IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  if (process.env.SKIP_SETUP === 'true') {
    await knex.schema.raw('DROP INDEX IF EXISTS settings_tenant_key_unique');
    await knex.schema.raw('DROP INDEX IF EXISTS app_settings_tenant_app_key_unique');
    await knex.schema.raw('DROP INDEX IF EXISTS locales_tenant_code_published_unique');
    await knex.schema.raw('DROP INDEX IF EXISTS collections_tenant_uuid_unique');
    await knex.schema.raw('DROP INDEX IF EXISTS pages_tenant_slug_unique');
    await knex.schema.raw('DROP INDEX IF EXISTS translations_tenant_source_unique');
    await knex.schema.raw('DROP INDEX IF EXISTS idx_collection_item_values_tenant_unique');
  }

  for (const table of CONTENT_TABLES) {
    const hasTable = await knex.schema.hasTable(table);
    if (!hasTable) continue;
    const hasTenantId = await knex.schema.hasColumn(table, 'tenant_id');
    if (!hasTenantId) continue;

    // Keep color_variables.tenant_id from earlier migration
    if (table === 'color_variables') continue;

    await knex.schema.raw(`DROP INDEX IF EXISTS idx_${table}_tenant_id`);
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('tenant_id');
    });
  }

  await knex.raw('DROP FUNCTION IF EXISTS set_tenant_context(uuid)');
}
