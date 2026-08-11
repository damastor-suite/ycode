/**
 * Page Repository
 *
 * Data access layer for page operations with Knex
 */

import type { Knex } from 'knex';

import { getDb, isMissingTableError } from '@/lib/platform/db';
import { addTenantFilter, batchUpdateColumn } from '@/lib/knex-helpers';
import { getTenantIdFromHeaders } from '@/lib/platform/tenant';
import { generatePageLayersHash, generatePageMetadataHash } from '@/lib/hash-utils';
import { isHomepage } from '@/lib/page-utils';
import { reorderSiblings } from '@/lib/repositories/pageFolderRepository';
import { fixOrphanedPageSlugs, incrementSiblingOrders } from '@/lib/services/pageService';
import type { Page, PageLayers, PageSettings } from '@/types';

/**
 * Query filters for page lookups
 */
export interface QueryFilters {
  [key: string]: string | number | boolean | null;
}

/**
 * Data required to create a new page
 */
export interface CreatePageData {
  id?: string;
  name: string;
  slug: string;
  is_published?: boolean;
  is_publishable?: boolean;
  page_folder_id?: string | null;
  order?: number;
  depth?: number;
  is_index?: boolean;
  is_dynamic?: boolean;
  error_page?: number | null;
  settings?: PageSettings;
  content_hash?: string;
}

/**
 * Data that can be updated on an existing page
 */
export interface UpdatePageData {
  name?: string;
  slug?: string;
  is_published?: boolean;
  is_publishable?: boolean;
  page_folder_id?: string | null;
  order?: number;
  depth?: number;
  is_index?: boolean;
  is_dynamic?: boolean;
  error_page?: number | null;
  settings?: PageSettings;
  content_hash?: string; // Auto-calculated, should not be set manually
}

type PageLayerHashRow = {
  id?: string;
  page_id: string;
  content_hash: string | null;
};

type PageWithLayerHash = Page & {
  page_layers: Array<{ content_hash: string | null }>;
};

type InsertRow = Record<string, unknown>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function applyTenantFilter(
  knex: Knex,
  query: Knex.QueryBuilder,
  tableName: string
): Promise<Knex.QueryBuilder> {
  return addTenantFilter(knex, query, tableName);
}

async function withTenantOnInsert<T extends InsertRow>(row: T): Promise<T> {
  const tenantId = await getTenantIdFromHeaders();
  if (!tenantId) return row;
  return { ...row, tenant_id: tenantId } as T;
}

function applyFilters(query: Knex.QueryBuilder, filters?: QueryFilters): Knex.QueryBuilder {
  if (!filters) return query;

  for (const [column, value] of Object.entries(filters)) {
    if (value === null) {
      query.whereNull(column);
    } else {
      query.where(column, value);
    }
  }

  return query;
}

function normalizePageFolderId(folderId?: string | null): string | null {
  if (folderId === undefined || folderId === null) {
    return null;
  }

  if (typeof folderId === 'string') {
    const trimmed = folderId.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
      return null;
    }
    return trimmed;
  }

  return folderId;
}

/**
 * Retrieves all pages from the database
 */
export async function getAllPages(filters?: QueryFilters): Promise<Page[]> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('*')
      .whereNull('deleted_at')
      .orderBy('order', 'asc');
    query = applyFilters(query, filters);
    query = await applyTenantFilter(knex, query, 'pages');
    return await query as Page[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    console.error('[pageRepository.getAllPages] Query error:', error);
    throw new Error(`Failed to fetch pages: ${getErrorMessage(error)}`);
  }
}

/**
 * Get page by ID
 */
export async function getPageById(id: string, isPublished: boolean = false): Promise<Page | null> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('*')
      .where('id', id)
      .where('is_published', isPublished)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'pages');
    return (await query.first() as Page | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch page: ${getErrorMessage(error)}`);
  }
}

/**
 * Get page by slug
 */
export async function getPageBySlug(slug: string, filters?: QueryFilters): Promise<Page | null> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('*')
      .where('slug', slug)
      .whereNull('deleted_at');
    query = applyFilters(query, filters);
    query = await applyTenantFilter(knex, query, 'pages');
    return (await query.first() as Page | undefined) ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw new Error(`Failed to fetch page: ${getErrorMessage(error)}`);
  }
}

/**
 * Generate a unique slug from a page name
 */
function generateSlugFromName(name: string, timestamp?: number): string {
  const baseSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (timestamp) {
    return `${baseSlug}-${timestamp}`;
  }

  return baseSlug || `page-${Date.now()}`;
}

/**
 * Automatically transfer index status from existing index page to new one
 */
async function transferIndexPage(
  knex: Knex,
  newIndexPageId: string,
  pageFolderId: string | null,
  isPublished: boolean = false
): Promise<void> {
  let query = knex('pages')
    .select('id', 'name', 'slug', 'settings', 'is_dynamic', 'error_page')
    .where('is_index', true)
    .where('is_published', isPublished)
    .whereNull('deleted_at')
    .whereNot('id', newIndexPageId);

  if (pageFolderId === null || pageFolderId === undefined) {
    query.whereNull('page_folder_id');
  } else {
    query.where('page_folder_id', pageFolderId);
  }

  query = await applyTenantFilter(knex, query, 'pages');
  const existingIndex = await query.first() as Pick<Page, 'id' | 'name' | 'slug' | 'settings' | 'is_dynamic' | 'error_page'> | undefined;

  if (!existingIndex) {
    return;
  }

  if (existingIndex.slug && existingIndex.slug.trim() !== '') {
    const demotedHash = generatePageMetadataHash({
      name: existingIndex.name,
      slug: existingIndex.slug,
      settings: existingIndex.settings,
      is_index: false,
      is_dynamic: existingIndex.is_dynamic ?? false,
      error_page: existingIndex.error_page ?? null,
    });

    let updateQuery = knex('pages')
      .where('id', existingIndex.id)
      .where('is_published', isPublished);
    updateQuery = await applyTenantFilter(knex, updateQuery, 'pages');
    await updateQuery.update({
      is_index: false,
      content_hash: demotedHash,
      updated_at: new Date().toISOString(),
    });
    return;
  }

  const timestamp = Date.now();
  let newSlug = generateSlugFromName(existingIndex.name);

  let duplicateQuery = knex('pages')
    .select('id')
    .where('slug', newSlug)
    .whereNull('deleted_at')
    .whereNot('id', existingIndex.id);
  duplicateQuery = await applyTenantFilter(knex, duplicateQuery, 'pages');
  const duplicateCheck = await duplicateQuery.first() as { id: string } | undefined;

  if (duplicateCheck) {
    newSlug = generateSlugFromName(existingIndex.name, timestamp);

    let timestampedQuery = knex('pages')
      .select('id')
      .where('slug', newSlug)
      .whereNull('deleted_at')
      .whereNot('id', existingIndex.id);
    timestampedQuery = await applyTenantFilter(knex, timestampedQuery, 'pages');
    const timestampedDuplicateCheck = await timestampedQuery.first() as { id: string } | undefined;

    if (timestampedDuplicateCheck) {
      newSlug = `${newSlug}-${Math.random().toString(36).slice(2, 7)}`;
    }
  }

  const demotedHash = generatePageMetadataHash({
    name: existingIndex.name,
    slug: newSlug,
    settings: existingIndex.settings,
    is_index: false,
    is_dynamic: existingIndex.is_dynamic ?? false,
    error_page: existingIndex.error_page ?? null,
  });

  let updateQuery = knex('pages')
    .where('id', existingIndex.id)
    .where('is_published', isPublished);
  updateQuery = await applyTenantFilter(knex, updateQuery, 'pages');
  await updateQuery.update({
    is_index: false,
    slug: newSlug,
    content_hash: demotedHash,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Validate index page constraints
 */
async function validateIndexPageConstraints(
  knex: Knex,
  pageData: { is_index?: boolean; slug: string; page_folder_id?: string | null; error_page?: number | null; is_dynamic?: boolean },
  excludePageId?: string,
  currentPageData?: { is_index: boolean; page_folder_id: string | null; is_dynamic?: boolean }
): Promise<void> {
  if (pageData.is_index && pageData.slug.trim() !== '') {
    throw new Error('Index pages must have an empty slug');
  }

  const isErrorPage = pageData.error_page !== null && pageData.error_page !== undefined;
  const isDynamicPage = pageData.is_dynamic === true;
  if (!pageData.is_index && !isErrorPage && !isDynamicPage && pageData.slug.trim() === '') {
    throw new Error('Non-index pages must have a non-empty slug');
  }

  if (currentPageData && isHomepage(currentPageData as Page)) {
    if (pageData.page_folder_id !== null && pageData.page_folder_id !== undefined) {
      throw new Error('The Homepage cannot be moved to another folder. It must remain in the root folder.');
    }
  }

  if (!pageData.is_index && (pageData.page_folder_id === null || pageData.page_folder_id === undefined)) {
    let query = knex('pages')
      .select('id')
      .where('is_index', true)
      .whereNull('page_folder_id')
      .whereNull('deleted_at');

    if (excludePageId) {
      query.whereNot('id', excludePageId);
    }

    query = await applyTenantFilter(knex, query, 'pages');
    const otherRootIndexPages = await query as Array<{ id: string }>;

    if (otherRootIndexPages.length === 0) {
      throw new Error('The root folder must have an index page. Please set another page as index first.');
    }
  }
}

/**
 * Create new page
 */
export async function createPage(pageData: CreatePageData, additionalData?: Record<string, any>): Promise<Page> {
  const knex = await getDb();
  const normalizedPageFolderId = normalizePageFolderId(pageData.page_folder_id);
  const normalizedPageData: CreatePageData = {
    ...pageData,
    page_folder_id: normalizedPageFolderId,
  };

  await validateIndexPageConstraints(
    knex,
    {
      is_index: normalizedPageData.is_index || false,
      slug: normalizedPageData.slug,
      page_folder_id: normalizedPageFolderId,
      error_page: normalizedPageData.error_page,
      is_dynamic: normalizedPageData.is_dynamic || false,
    },
    undefined,
    undefined
  );

  const contentHash = generatePageMetadataHash({
    name: normalizedPageData.name,
    slug: normalizedPageData.slug,
    settings: normalizedPageData.settings || {},
    is_index: normalizedPageData.is_index || false,
    is_dynamic: normalizedPageData.is_dynamic || false,
    error_page: normalizedPageData.error_page || null,
  });

  const { content_hash: _contentHash, ...pageDataWithoutHash } = normalizedPageData;
  const insertData = await withTenantOnInsert({
    ...(additionalData || {}),
    ...pageDataWithoutHash,
    content_hash: contentHash,
  });

  try {
    const rows = await knex('pages').insert(insertData).returning('*') as Page[];
    const data = rows[0];
    if (!data) throw new Error('No page returned');

    if (normalizedPageData.is_index) {
      await transferIndexPage(knex, data.id, normalizedPageFolderId, normalizedPageData.is_published || false);
    }

    return data;
  } catch (error) {
    throw new Error(`Failed to create page: ${getErrorMessage(error)}`);
  }
}

/**
 * Update page
 */
export async function updatePage(id: string, updates: UpdatePageData): Promise<Page> {
  const knex = await getDb();

  const currentPage = await getPageById(id, false);
  if (!currentPage) {
    throw new Error('Page not found');
  }

  const normalizedUpdates: UpdatePageData =
    updates.page_folder_id !== undefined
      ? {
        ...updates,
        page_folder_id: normalizePageFolderId(updates.page_folder_id),
      }
      : updates;

  const mergedData = {
    is_index: normalizedUpdates.is_index !== undefined ? normalizedUpdates.is_index : currentPage.is_index,
    slug: normalizedUpdates.slug !== undefined ? normalizedUpdates.slug : currentPage.slug,
    page_folder_id: normalizedUpdates.page_folder_id !== undefined ? normalizedUpdates.page_folder_id : currentPage.page_folder_id,
    error_page: normalizedUpdates.error_page !== undefined ? normalizedUpdates.error_page : currentPage.error_page,
    is_dynamic: normalizedUpdates.is_dynamic !== undefined ? normalizedUpdates.is_dynamic : currentPage.is_dynamic,
  };

  if (normalizedUpdates.is_index !== undefined || normalizedUpdates.slug !== undefined || normalizedUpdates.page_folder_id !== undefined) {
    await validateIndexPageConstraints(
      knex,
      mergedData,
      id,
      { is_index: currentPage.is_index, page_folder_id: currentPage.page_folder_id }
    );
  }

  const isBecomingIndex = normalizedUpdates.is_index === true && !currentPage.is_index;

  if (isBecomingIndex) {
    const folderIdForTransfer = normalizedUpdates.page_folder_id !== undefined ? normalizedUpdates.page_folder_id : currentPage.page_folder_id;
    let orphanQuery = knex('pages')
      .select('id', 'name', 'slug', 'is_index', 'page_folder_id')
      .where('slug', '')
      .where('is_index', false)
      .whereNull('deleted_at');
    orphanQuery = await applyTenantFilter(knex, orphanQuery, 'pages');
    const orphanedPages = await orphanQuery as Array<{ id: string; name: string; slug: string; is_index: boolean; page_folder_id: string | null }>;

    if (orphanedPages.length > 0) {
      await fixOrphanedPageSlugs(orphanedPages);
    }

    await transferIndexPage(knex, id, folderIdForTransfer, currentPage.is_published);
  }

  const finalData = {
    name: normalizedUpdates.name !== undefined ? normalizedUpdates.name : currentPage.name,
    slug: normalizedUpdates.slug !== undefined ? normalizedUpdates.slug : currentPage.slug,
    settings: normalizedUpdates.settings !== undefined ? normalizedUpdates.settings : currentPage.settings,
    is_index: normalizedUpdates.is_index !== undefined ? normalizedUpdates.is_index : currentPage.is_index,
    is_dynamic: normalizedUpdates.is_dynamic !== undefined ? normalizedUpdates.is_dynamic : currentPage.is_dynamic,
    error_page: normalizedUpdates.error_page !== undefined ? normalizedUpdates.error_page : currentPage.error_page,
  };

  const contentHash = generatePageMetadataHash(finalData);
  const { content_hash: _contentHash, ...updatesWithoutHash } = normalizedUpdates;

  const updatesWithHash = {
    ...updatesWithoutHash,
    content_hash: contentHash,
    updated_at: new Date().toISOString(),
  };

  try {
    let query = knex('pages')
      .where('id', id)
      .where('is_published', false)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'pages');
    const rows = await query.update(updatesWithHash).returning('*') as Page[];
    const data = rows[0];
    if (!data) throw new Error('Page not found');
    return data;
  } catch (error) {
    throw new Error(`Failed to update page: ${getErrorMessage(error)}`);
  }
}

/**
 * Batch update order for multiple pages
 */
export async function batchUpdatePageOrder(updates: Array<{ id: string; order: number }>): Promise<void> {
  if (updates.length === 0) return;

  const knex = await getDb();

  try {
    await batchUpdateColumn(knex, 'pages', 'order',
      updates.map(u => ({ id: u.id, value: u.order })),
      {
        extraWhereClause: 'AND is_published = false AND deleted_at IS NULL',
        castType: 'integer',
      }
    );
  } catch (error) {
    throw new Error(`Failed to update page order: ${getErrorMessage(error)}`);
  }
}

/**
 * Soft delete a page and its associated page layers
 */
export async function deletePage(id: string): Promise<void> {
  const knex = await getDb();
  const deletedAt = new Date().toISOString();

  const pageToDelete = await getPageById(id, false);
  if (!pageToDelete) {
    throw new Error('Page not found');
  }

  if (isHomepage(pageToDelete)) {
    let checkQuery = knex('pages')
      .select('id')
      .where('is_index', true)
      .whereNull('page_folder_id')
      .whereNull('deleted_at')
      .whereNot('id', id);
    checkQuery = await applyTenantFilter(knex, checkQuery, 'pages');
    const otherRootIndexPages = await checkQuery as Array<{ id: string }>;

    if (otherRootIndexPages.length === 0) {
      throw new Error('Cannot delete the last index page in the root folder. Please set another page as index first.');
    }
  }

  try {
    let layersQuery = knex('page_layers')
      .where('page_id', id)
      .where('is_published', false)
      .whereNull('deleted_at');
    layersQuery = await applyTenantFilter(knex, layersQuery, 'page_layers');
    await layersQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });

    let pageQuery = knex('pages')
      .where('id', id)
      .where('is_published', false)
      .whereNull('deleted_at');
    pageQuery = await applyTenantFilter(knex, pageQuery, 'pages');
    await pageQuery.update({ deleted_at: deletedAt, updated_at: deletedAt });
  } catch (error) {
    throw new Error(`Failed to delete page: ${getErrorMessage(error)}`);
  }

  try {
    await reorderSiblings(pageToDelete.page_folder_id, pageToDelete.depth);
  } catch (reorderError) {
    console.error('[deletePage] Failed to reorder siblings:', reorderError);
  }
}

/**
 * Restore a soft-deleted page
 */
export async function restorePage(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .where('id', id)
      .where('is_published', false)
      .whereNotNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'pages');
    await query.update({ deleted_at: null, updated_at: new Date().toISOString() });
  } catch (error) {
    throw new Error(`Failed to restore page: ${getErrorMessage(error)}`);
  }
}

/**
 * Force delete a page (permanent deletion)
 */
export async function forceDeletePage(id: string): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('pages').where('id', id);
    query = await applyTenantFilter(knex, query, 'pages');
    await query.delete();
  } catch (error) {
    throw new Error(`Failed to force delete page: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all draft pages
 */
export async function getAllDraftPages(includeDeleted = false): Promise<Page[]> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('*')
      .where('is_published', false)
      .orderBy('created_at', 'desc');

    if (!includeDeleted) {
      query.whereNull('deleted_at');
    }

    query = await applyTenantFilter(knex, query, 'pages');
    return await query as Page[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch draft pages: ${getErrorMessage(error)}`);
  }
}

/**
 * Get published pages by IDs
 */
export async function getPublishedPagesByIds(ids: string[]): Promise<Page[]> {
  if (ids.length === 0) {
    return [];
  }

  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('*')
      .whereIn('id', ids)
      .where('is_published', true)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'pages');
    return await query as Page[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch published pages: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all pages in a specific folder
 */
export async function getPagesByFolder(folderId: string | null): Promise<Page[]> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('*')
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');

    if (folderId === null) {
      query.whereNull('page_folder_id');
    } else {
      query.where('page_folder_id', folderId);
    }

    query = await applyTenantFilter(knex, query, 'pages');
    return await query as Page[];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch pages by folder: ${getErrorMessage(error)}`);
  }
}

/**
 * Duplicate a page with its draft layers
 */
export async function duplicatePage(pageId: string): Promise<Page> {
  const knex = await getDb();
  const originalPage = await getPageById(pageId, false);
  if (!originalPage) {
    throw new Error('Page not found');
  }

  const newName = `${originalPage.name} (Copy)`;
  let newSlug = originalPage.slug;

  if (!originalPage.is_dynamic) {
    const baseSlug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    let query = knex('pages')
      .select('slug')
      .where('is_published', false)
      .whereNull('error_page')
      .whereNull('deleted_at');

    if (originalPage.page_folder_id === null) {
      query.whereNull('page_folder_id');
    } else {
      query.where('page_folder_id', originalPage.page_folder_id);
    }

    query = await applyTenantFilter(knex, query, 'pages');
    const existingPages = await query as Array<{ slug: string }>;
    const existingSlugs = existingPages.map(p => p.slug.toLowerCase());

    newSlug = baseSlug;
    if (existingSlugs.includes(baseSlug)) {
      let counter = 2;
      newSlug = `${baseSlug}-${counter}`;
      while (existingSlugs.includes(newSlug)) {
        counter++;
        newSlug = `${baseSlug}-${counter}`;
      }
    }
  }

  const newOrder = originalPage.order + 1;
  await incrementSiblingOrders(newOrder, originalPage.depth, originalPage.page_folder_id);

  const contentHash = generatePageMetadataHash({
    name: newName,
    slug: newSlug,
    settings: originalPage.settings || {},
    is_index: false,
    is_dynamic: originalPage.is_dynamic || false,
    error_page: originalPage.error_page ?? null,
  });

  try {
    const insertData = await withTenantOnInsert({
      name: newName,
      slug: newSlug,
      is_published: false,
      page_folder_id: originalPage.page_folder_id,
      order: newOrder,
      depth: originalPage.depth,
      is_index: false,
      is_dynamic: originalPage.is_dynamic,
      error_page: originalPage.error_page,
      settings: originalPage.settings || {},
      content_hash: contentHash,
    });
    const rows = await knex('pages').insert(insertData).returning('*') as Page[];
    const newPage = rows[0];
    if (!newPage) throw new Error('No page returned');

    let layersQuery = knex('page_layers')
      .select('*')
      .where('page_id', pageId)
      .where('is_published', false)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .limit(1);
    layersQuery = await applyTenantFilter(knex, layersQuery, 'page_layers');
    const originalLayers = await layersQuery.first() as PageLayers | undefined;

    if (originalLayers) {
      const layerInsert = await withTenantOnInsert({
        page_id: newPage.id,
        layers: originalLayers.layers,
        content_hash: generatePageLayersHash({
          layers: originalLayers.layers,
          generated_css: null,
        }),
        is_published: false,
      });
      await knex('page_layers').insert(layerInsert);
    }

    return newPage;
  } catch (error) {
    throw new Error(`Failed to create duplicate page: ${getErrorMessage(error)}`);
  }
}

/**
 * Backfill missing `content_hash` on pages and page_layers (draft + published).
 */
export async function backfillMissingPageHashes(): Promise<{
  pagesUpdated: number;
  layersUpdated: number;
}> {
  const knex = await getDb();
  let pagesUpdated = 0;
  let layersUpdated = 0;

  try {
    let pagesQuery = knex('pages')
      .select('*')
      .whereNull('content_hash')
      .whereNull('deleted_at');
    pagesQuery = await applyTenantFilter(knex, pagesQuery, 'pages');
    const pagesToBackfill = await pagesQuery as Page[];

    if (pagesToBackfill.length > 0) {
      const upsertRows = pagesToBackfill.map(page => ({
        ...page,
        content_hash: generatePageMetadataHash({
          name: page.name,
          slug: page.slug,
          settings: page.settings || {},
          is_index: page.is_index || false,
          is_dynamic: page.is_dynamic || false,
          error_page: page.error_page ?? null,
        }),
      }));

      await knex('pages')
        .insert(upsertRows)
        .onConflict(['id', 'is_published'])
        .merge();
      pagesUpdated = upsertRows.length;
    }
  } catch (error) {
    if (isMissingTableError(error)) return { pagesUpdated: 0, layersUpdated: 0 };
    console.error('Failed to backfill page content_hash:', error);
  }

  try {
    let layersQuery = knex('page_layers')
      .select('*')
      .whereNull('content_hash')
      .whereNull('deleted_at');
    layersQuery = await applyTenantFilter(knex, layersQuery, 'page_layers');
    const layersToBackfill = await layersQuery as PageLayers[];

    if (layersToBackfill.length > 0) {
      const upsertRows = layersToBackfill.map(row => ({
        ...row,
        content_hash: generatePageLayersHash({
          layers: row.layers || [],
          generated_css: row.generated_css ?? null,
        }),
      }));

      await knex('page_layers')
        .insert(upsertRows)
        .onConflict(['id', 'is_published'])
        .merge();
      layersUpdated = upsertRows.length;
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.error('Failed to backfill page_layers content_hash:', error);
    }
  }

  return { pagesUpdated, layersUpdated };
}

/**
 * Treat a null on either side as "unchanged".
 */
function hashesDiffer(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return a !== b;
}

async function getPageLayerHashes(
  knex: Knex,
  pageIds: string[],
  isPublished: boolean
): Promise<Map<string, PageLayerHashRow>> {
  if (pageIds.length === 0) return new Map();

  let query = knex('page_layers')
    .select('id', 'page_id', 'content_hash')
    .whereIn('page_id', pageIds)
    .where('is_published', isPublished)
    .whereNull('deleted_at');
  query = await applyTenantFilter(knex, query, 'page_layers');
  const rows = await query as PageLayerHashRow[];
  return new Map(rows.map(row => [row.page_id, row]));
}

/**
 * Get count of unpublished pages efficiently.
 */
export async function getUnpublishedPagesCount(): Promise<number> {
  await backfillMissingPageHashes();

  const knex = await getDb();

  try {
    let draftQuery = knex('pages')
      .select('id', 'content_hash', 'page_folder_id', 'is_publishable')
      .where('is_published', false)
      .whereNull('deleted_at');
    draftQuery = await applyTenantFilter(knex, draftQuery, 'pages');
    const draftPages = await draftQuery as Array<Pick<Page, 'id' | 'page_folder_id' | 'is_publishable'> & { content_hash: string | null }>;

    if (draftPages.length === 0) return 0;

    let publishedQuery = knex('pages')
      .select('id', 'content_hash', 'page_folder_id')
      .where('is_published', true)
      .whereNull('deleted_at');
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'pages');
    const publishedPages = await publishedQuery as Array<Pick<Page, 'id' | 'page_folder_id'> & { content_hash: string | null }>;

    const draftLayerByPageId = await getPageLayerHashes(knex, draftPages.map(p => p.id), false);
    const publishedLayerByPageId = await getPageLayerHashes(knex, publishedPages.map(p => p.id), true);

    const publishedMap = new Map<string, {
      content_hash: string | null;
      page_folder_id: string | null;
      layerHash: string | null;
    }>();
    for (const pub of publishedPages) {
      publishedMap.set(pub.id, {
        content_hash: pub.content_hash,
        page_folder_id: pub.page_folder_id,
        layerHash: publishedLayerByPageId.get(pub.id)?.content_hash ?? null,
      });
    }

    let count = 0;
    for (const draft of draftPages) {
      const draftLayer = draftLayerByPageId.get(draft.id);
      if (!draftLayer) continue;

      const pub = publishedMap.get(draft.id);
      const isDraftOnly = draft.is_publishable === false;

      if (!pub) {
        if (!isDraftOnly) count++;
        continue;
      }

      if (isDraftOnly) {
        count++;
        continue;
      }

      const pageMetadataChanged = hashesDiffer(draft.content_hash, pub.content_hash);
      const layersChanged = hashesDiffer(draftLayer.content_hash, pub.layerHash);
      const folderChanged = draft.page_folder_id !== pub.page_folder_id;

      if (pageMetadataChanged || layersChanged || folderChanged) {
        count++;
      }
    }

    return count;
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw new Error(`Failed to fetch draft pages: ${getErrorMessage(error)}`);
  }
}

/**
 * Get all unpublished pages
 */
export async function getUnpublishedPages(): Promise<Page[]> {
  await backfillMissingPageHashes();

  const knex = await getDb();

  try {
    let draftQuery = knex('pages')
      .select('*')
      .where('is_published', false)
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc');
    draftQuery = await applyTenantFilter(knex, draftQuery, 'pages');
    const draftPages = await draftQuery as Page[];

    if (draftPages.length === 0) return [];

    let publishedQuery = knex('pages')
      .select('id', 'content_hash', 'page_folder_id')
      .where('is_published', true)
      .whereNull('deleted_at');
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'pages');
    const publishedPages = await publishedQuery as Array<Pick<Page, 'id' | 'page_folder_id'> & { content_hash: string | null }>;

    const draftLayerByPageId = await getPageLayerHashes(knex, draftPages.map(p => p.id), false);
    const publishedLayerByPageId = await getPageLayerHashes(knex, publishedPages.map(p => p.id), true);

    const publishedMap = new Map<string, {
      content_hash: string | null;
      page_folder_id: string | null;
      layerHash: string | null;
    }>();
    for (const pub of publishedPages) {
      publishedMap.set(pub.id, {
        content_hash: pub.content_hash,
        page_folder_id: pub.page_folder_id,
        layerHash: publishedLayerByPageId.get(pub.id)?.content_hash ?? null,
      });
    }

    const unpublishedPages: Page[] = [];

    for (const draftPage of draftPages) {
      const draftLayer = draftLayerByPageId.get(draftPage.id);
      if (!draftLayer) continue;

      const pub = publishedMap.get(draftPage.id);
      const isDraftOnly = draftPage.is_publishable === false;
      const pageWithLayer = {
        ...draftPage,
        page_layers: [{ content_hash: draftLayer.content_hash }],
      } as PageWithLayerHash;

      if (!pub) {
        if (!isDraftOnly) unpublishedPages.push(pageWithLayer);
        continue;
      }

      if (isDraftOnly) {
        unpublishedPages.push(pageWithLayer);
        continue;
      }

      const pageMetadataChanged = hashesDiffer(draftPage.content_hash ?? null, pub.content_hash);
      const layersChanged = hashesDiffer(draftLayer.content_hash, pub.layerHash);
      const folderChanged = draftPage.page_folder_id !== pub.page_folder_id;

      if (pageMetadataChanged || layersChanged || folderChanged) {
        unpublishedPages.push(pageWithLayer);
      }
    }

    return unpublishedPages;
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw new Error(`Failed to fetch draft pages: ${getErrorMessage(error)}`);
  }
}

/**
 * Get IDs of soft-deleted draft pages.
 */
export async function getSoftDeletedPageIds(): Promise<string[]> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .select('id')
      .where('is_published', false)
      .whereNotNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'pages');
    const data = await query as Array<{ id: string }>;
    return data.map(p => p.id);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    return [];
  }
}

/**
 * Hard-delete soft-deleted draft pages and their published counterparts.
 */
export async function hardDeleteSoftDeletedPages(): Promise<{ count: number; deletedPageIds: string[] }> {
  const knex = await getDb();

  try {
    let deletedQuery = knex('pages')
      .select('id')
      .where('is_published', false)
      .whereNotNull('deleted_at');
    deletedQuery = await applyTenantFilter(knex, deletedQuery, 'pages');
    const deletedDrafts = await deletedQuery as Array<{ id: string }>;

    if (deletedDrafts.length === 0) {
      return { count: 0, deletedPageIds: [] };
    }

    const ids = deletedDrafts.map(p => p.id);

    try {
      let pubQuery = knex('pages')
        .whereIn('id', ids)
        .where('is_published', true);
      pubQuery = await applyTenantFilter(knex, pubQuery, 'pages');
      await pubQuery.delete();
    } catch (pubError) {
      console.error('Failed to delete published pages:', pubError);
    }

    let draftQuery = knex('pages')
      .whereIn('id', ids)
      .where('is_published', false)
      .whereNotNull('deleted_at');
    draftQuery = await applyTenantFilter(knex, draftQuery, 'pages');
    await draftQuery.delete();

    return { count: deletedDrafts.length, deletedPageIds: ids };
  } catch (error) {
    throw new Error(`Failed to delete draft pages: ${getErrorMessage(error)}`);
  }
}

/**
 * Set the is_publishable flag on a page's draft row.
 */
export async function setPagePublishable(pageId: string, isPublishable: boolean): Promise<void> {
  const knex = await getDb();

  try {
    let query = knex('pages')
      .where('id', pageId)
      .where('is_published', false)
      .whereNull('deleted_at');
    query = await applyTenantFilter(knex, query, 'pages');
    await query.update({ is_publishable: isPublishable, updated_at: new Date().toISOString() });
  } catch (error) {
    throw new Error(`Failed to update page publishable flag: ${getErrorMessage(error)}`);
  }
}

/**
 * Remove a page's published version.
 */
export async function deletePublishedPage(pageId: string): Promise<boolean> {
  const knex = await getDb();

  try {
    let publishedQuery = knex('pages')
      .select('id')
      .where('id', pageId)
      .where('is_published', true);
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'pages');
    const published = await publishedQuery.first() as { id: string } | undefined;

    if (!published) return false;

    let deleteQuery = knex('pages')
      .where('id', pageId)
      .where('is_published', true);
    deleteQuery = await applyTenantFilter(knex, deleteQuery, 'pages');
    await deleteQuery.delete();
    return true;
  } catch (error) {
    throw new Error(`Failed to remove published page: ${getErrorMessage(error)}`);
  }
}

/**
 * Annotate draft pages with computed publish status for the builder listing.
 */
export async function enrichDraftPagesWithPublishStatus(pages: Page[]): Promise<Page[]> {
  if (pages.length === 0) return pages;

  const knex = await getDb();
  const ids = pages.map(p => p.id);

  try {
    let publishedQuery = knex('pages')
      .select('id', 'content_hash', 'page_folder_id')
      .whereIn('id', ids)
      .where('is_published', true)
      .whereNull('deleted_at');
    publishedQuery = await applyTenantFilter(knex, publishedQuery, 'pages');
    const publishedPages = await publishedQuery as Array<Pick<Page, 'id' | 'page_folder_id'> & { content_hash: string | null }>;

    const draftLayers = await getPageLayerHashes(knex, ids, false);
    const publishedLayers = await getPageLayerHashes(knex, ids, true);
    const publishedById = new Map(publishedPages.map(p => [p.id, p]));

    return pages.map(page => {
      const pub = publishedById.get(page.id);
      if (!pub) {
        return { ...page, has_published_version: false, is_modified: false };
      }
      const metaChanged = hashesDiffer(page.content_hash ?? null, pub.content_hash);
      const layersChanged = hashesDiffer(
        draftLayers.get(page.id)?.content_hash ?? null,
        publishedLayers.get(page.id)?.content_hash ?? null
      );
      const folderChanged = page.page_folder_id !== pub.page_folder_id;
      return { ...page, has_published_version: true, is_modified: metaChanged || layersChanged || folderChanged };
    });
  } catch (error) {
    if (isMissingTableError(error)) return pages;
    throw error;
  }
}
