import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  const hasUserTable = await knex.schema.hasTable('user');
  if (!hasUserTable) {
    await knex.schema.createTable('user', (table) => {
      table.text('id').primary();
      table.text('name');
      table.text('email').unique();
      table.boolean('emailVerified').defaultTo(false);
      table.text('image');
      table.text('role').defaultTo('editor');
      table.timestamp('createdAt', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { useTz: true }).defaultTo(knex.fn.now());
    });
  }

  const hasSessionTable = await knex.schema.hasTable('session');
  if (!hasSessionTable) {
    await knex.schema.createTable('session', (table) => {
      table.text('id').primary();
      table.timestamp('expiresAt', { useTz: true }).notNullable();
      table.text('token').unique();
      table.timestamp('createdAt', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { useTz: true }).defaultTo(knex.fn.now());
      table.text('ipAddress');
      table.text('userAgent');
      table.text('userId').references('id').inTable('user').onDelete('CASCADE');
    });
  }

  const hasAccountTable = await knex.schema.hasTable('account');
  if (!hasAccountTable) {
    await knex.schema.createTable('account', (table) => {
      table.text('id').primary();
      table.text('accountId');
      table.text('providerId');
      table.text('userId').references('id').inTable('user').onDelete('CASCADE');
      table.text('accessToken');
      table.text('refreshToken');
      table.text('idToken');
      table.timestamp('accessTokenExpiresAt', { useTz: true });
      table.timestamp('refreshTokenExpiresAt', { useTz: true });
      table.text('scope');
      table.text('password');
      table.timestamp('createdAt', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { useTz: true }).defaultTo(knex.fn.now());
    });
  }

  const hasVerificationTable = await knex.schema.hasTable('verification');
  if (!hasVerificationTable) {
    await knex.schema.createTable('verification', (table) => {
      table.text('id').primary();
      table.text('identifier');
      table.text('value');
      table.timestamp('expiresAt', { useTz: true }).notNullable();
      table.timestamp('createdAt', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { useTz: true }).defaultTo(knex.fn.now());
    });
  }

  const hasSitesTable = await knex.schema.hasTable('sites');
  if (!hasSitesTable) {
    await knex.schema.createTable('sites', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.text('name');
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sites');
  await knex.schema.dropTableIfExists('verification');
  await knex.schema.dropTableIfExists('account');
  await knex.schema.dropTableIfExists('session');
  await knex.schema.dropTableIfExists('user');
}
