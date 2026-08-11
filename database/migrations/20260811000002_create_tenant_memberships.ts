import type { Knex } from 'knex';

/**
 * Tenant membership for shared Supabase Auth.
 *
 * Maps auth.users → websites (tenants) with a per-tenant role.
 * Cloud provisioning should insert the first member as owner instead of
 * promoting the globally earliest auth.users row.
 */

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('tenant_memberships');
  if (!hasTable) {
    await knex.schema.createTable('tenant_memberships', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('user_id').notNullable();
      table.string('role', 32).notNullable().defaultTo('designer');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      table.unique(['tenant_id', 'user_id'], {
        indexName: 'tenant_memberships_tenant_user_unique',
      });
    });

    await knex.schema.raw(`
      CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user_id
      ON tenant_memberships(user_id)
    `);
    await knex.schema.raw(`
      CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_id
      ON tenant_memberships(tenant_id)
    `);
  }

  // Helper: ensure a tenant has an owner (first member wins if none)
  await knex.raw(`
    CREATE OR REPLACE FUNCTION bootstrap_tenant_owner(p_tenant_id uuid, p_user_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      existing_owner uuid;
    BEGIN
      SELECT user_id INTO existing_owner
      FROM tenant_memberships
      WHERE tenant_id = p_tenant_id AND role = 'owner'
      LIMIT 1;

      IF existing_owner IS NOT NULL THEN
        INSERT INTO tenant_memberships (tenant_id, user_id, role)
        VALUES (p_tenant_id, p_user_id, 'designer')
        ON CONFLICT (tenant_id, user_id) DO NOTHING;
        RETURN;
      END IF;

      INSERT INTO tenant_memberships (tenant_id, user_id, role)
      VALUES (p_tenant_id, p_user_id, 'owner')
      ON CONFLICT (tenant_id, user_id)
      DO UPDATE SET role = 'owner', updated_at = NOW();
    END;
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP FUNCTION IF EXISTS bootstrap_tenant_owner(uuid, uuid)');

  const hasTable = await knex.schema.hasTable('tenant_memberships');
  if (hasTable) {
    await knex.schema.dropTable('tenant_memberships');
  }
}
