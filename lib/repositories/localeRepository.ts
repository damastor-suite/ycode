import { getDb } from '@/lib/platform/db';
import {
  addTenantIdToRow,
  applyTenantFilter,
  normalizeRow,
  normalizeRows,
} from './knex-repository-utils';
import type { Locale, CreateLocaleData, UpdateLocaleData } from '@/types';

/**
 * Locale Repository
 *
 * Data access layer for locales with draft/published rows.
 */

export async function getAllLocales(
  isPublished: boolean = false,
  tenantId?: string
): Promise<Locale[]> {
  const knex = await getDb();
  let query = knex('locales')
    .select('*')
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .orderBy('is_default', 'desc')
    .orderBy('label', 'asc');
  query = await applyTenantFilter(knex, query, 'locales', tenantId);

  try {
    return normalizeRows(await query) as Locale[];
  } catch (error) {
    throw new Error(
      `Failed to fetch locales: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getLocaleById(
  id: string,
  isPublished: boolean = false
): Promise<Locale | null> {
  const knex = await getDb();
  let query = knex('locales')
    .select('*')
    .where('id', id)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'locales');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Locale : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getLocaleByCode(
  code: string,
  isPublished: boolean = false
): Promise<Locale | null> {
  const knex = await getDb();
  let query = knex('locales')
    .select('*')
    .where('code', code)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'locales');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Locale : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getDefaultLocale(isPublished: boolean = false): Promise<Locale | null> {
  const knex = await getDb();
  let query = knex('locales')
    .select('*')
    .where('is_default', true)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'locales');

  try {
    const row = await query.first();
    return row ? normalizeRow(row) as Locale : null;
  } catch (error) {
    throw new Error(
      `Failed to fetch default locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function createLocale(
  localeData: CreateLocaleData
): Promise<{ locale: Locale; locales: Locale[] }> {
  const knex = await getDb();

  try {
    let existingQuery = knex('locales')
      .select('*')
      .where('code', localeData.code)
      .where('is_published', false);
    existingQuery = await applyTenantFilter(knex, existingQuery, 'locales');
    const existingLocale = await existingQuery.first();

    if (localeData.is_default) {
      let unsetQuery = knex('locales')
        .where('is_default', true)
        .where('is_published', false)
        .update({ is_default: false });
      unsetQuery = await applyTenantFilter(knex, unsetQuery, 'locales');
      await unsetQuery;
    }

    let data: Locale;
    if (existingLocale) {
      let updateQuery = knex('locales')
        .where('id', existingLocale.id)
        .where('is_published', false)
        .update({
          label: localeData.label,
          is_default: localeData.is_default || false,
          deleted_at: null,
          updated_at: new Date().toISOString(),
        })
        .returning('*');
      updateQuery = await applyTenantFilter(knex, updateQuery, 'locales');
      const [updatedData] = await updateQuery;
      data = normalizeRow(updatedData) as Locale;
    } else {
      const row = await addTenantIdToRow(knex, 'locales', {
        code: localeData.code,
        label: localeData.label,
        is_default: localeData.is_default || false,
        is_published: false,
      });

      const [newData] = await knex('locales')
        .insert(row)
        .returning('*');
      data = normalizeRow(newData) as Locale;
    }

    const allLocales = await getAllLocales(false);
    return { locale: data, locales: allLocales };
  } catch (error) {
    throw new Error(
      `Failed to create locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function updateLocale(
  id: string,
  updates: UpdateLocaleData
): Promise<{ locale: Locale; locales: Locale[] }> {
  const knex = await getDb();

  try {
    if (updates.is_default) {
      let unsetQuery = knex('locales')
        .where('is_default', true)
        .where('is_published', false)
        .whereNot('id', id)
        .update({ is_default: false });
      unsetQuery = await applyTenantFilter(knex, unsetQuery, 'locales');
      await unsetQuery;
    }

    let updateQuery = knex('locales')
      .where('id', id)
      .where('is_published', false)
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .returning('*');
    updateQuery = await applyTenantFilter(knex, updateQuery, 'locales');
    const [data] = await updateQuery;

    if (!data) {
      throw new Error('Locale not found');
    }

    const allLocales = await getAllLocales(false);
    return { locale: normalizeRow(data) as Locale, locales: allLocales };
  } catch (error) {
    throw new Error(
      `Failed to update locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteLocale(id: string): Promise<void> {
  const locale = await getLocaleById(id, false);
  if (locale?.is_default) {
    throw new Error('Cannot delete the default locale');
  }

  const knex = await getDb();
  let query = knex('locales')
    .where('id', id)
    .where('is_published', false)
    .update({ deleted_at: new Date().toISOString() });
  query = await applyTenantFilter(knex, query, 'locales');

  try {
    await query;
  } catch (error) {
    throw new Error(
      `Failed to delete locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function setDefaultLocale(id: string): Promise<Locale> {
  const knex = await getDb();

  try {
    let unsetQuery = knex('locales')
      .where('is_default', true)
      .where('is_published', false)
      .update({ is_default: false });
    unsetQuery = await applyTenantFilter(knex, unsetQuery, 'locales');
    await unsetQuery;

    let setQuery = knex('locales')
      .where('id', id)
      .where('is_published', false)
      .update({
        is_default: true,
        updated_at: new Date().toISOString(),
      })
      .returning('*');
    setQuery = await applyTenantFilter(knex, setQuery, 'locales');

    const [data] = await setQuery;
    if (!data) {
      throw new Error('Locale not found');
    }

    return normalizeRow(data) as Locale;
  } catch (error) {
    throw new Error(
      `Failed to set default locale: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
