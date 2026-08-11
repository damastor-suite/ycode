import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../auth';
import { getCollectionById } from '@/lib/repositories/collectionRepository';
import { getFieldsByCollectionId } from '@/lib/repositories/collectionFieldRepository';
import { getDb } from '@/lib/platform/db';
import { addTenantIdToRow, getConflictColumns } from '@/lib/repositories/knex-repository-utils';
import { getItemsWithValues, createItem, getMaxIdValue, getItemWithValues } from '@/lib/repositories/collectionItemRepository';
import { setValues, getValuesByItemId } from '@/lib/repositories/collectionItemValueRepository';
import { invalidateForCollectionChange } from '@/lib/services/cacheService';
import { transformItemToPublicWithRefs, parseFieldProjections } from '../../../reference-resolver';
import type { CollectionItem, CollectionItemValue } from '@/types';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function upsertPublishedItemVersion(
  item: CollectionItem,
  collectionId: string
): Promise<void> {
  const db = await getDb();
  const row = await addTenantIdToRow<Record<string, unknown>>(db, 'collection_items', {
    id: item.id,
    collection_id: collectionId,
    manual_order: item.manual_order,
    is_published: true,
    is_publishable: true,
    content_hash: item.content_hash ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    deleted_at: null,
  });
  const tenantId = typeof row.tenant_id === 'string' ? row.tenant_id : null;
  const conflictColumns = await getConflictColumns(db, 'collection_items', ['id', 'is_published'], tenantId);

  await db('collection_items')
    .insert(row)
    .onConflict(conflictColumns)
    .merge(['collection_id', 'manual_order', 'is_publishable', 'content_hash', 'updated_at', 'deleted_at']);
}

async function upsertPublishedValues(draftValues: CollectionItemValue[]): Promise<void> {
  if (draftValues.length === 0) {
    return;
  }

  const db = await getDb();
  const now = new Date().toISOString();
  const rows = await Promise.all(
    draftValues.map((value) => addTenantIdToRow<Record<string, unknown>>(db, 'collection_item_values', {
      id: value.id,
      item_id: value.item_id,
      field_id: value.field_id,
      value: value.value,
      is_published: true,
      created_at: value.created_at,
      updated_at: now,
      deleted_at: null,
    }))
  );
  const tenantId = typeof rows[0]?.tenant_id === 'string' ? rows[0].tenant_id : null;
  const conflictColumns = await getConflictColumns(
    db,
    'collection_item_values',
    ['id', 'is_published'],
    tenantId
  );

  await db('collection_item_values')
    .insert(rows)
    .onConflict(conflictColumns)
    .merge(['value', 'updated_at', 'deleted_at']);
}

/**
 * GET /ycode/api/v1/collections/{collection_id}/items
 * List all published items in a collection with pagination, filtering, and sorting
 * 
 * Query Parameters:
 * - page: number (default: 1) - Page number
 * - per_page: number (default: 100) - Items per page
 * - limit: number - Limit total number of records (alternative to pagination)
 * - sort_by: string - Field slug to sort by
 * - order_by: string (asc|desc, default: asc) - Sort order
 * - filter[field_slug]: string - Filter by exact field value
 * 
 * Response format:
 * {
 *   "items": [
 *     { "id": "...", "name": "...", "slug": "...", ... }
 *   ],
 *   "pagination": { "page": 1, "per_page": 100, "total": 50 }
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ collection_id: string }> }
) {
  // Validate API key
  const authResult = await validateApiKey(request);
  if (!authResult.valid) {
    return unauthorizedResponse(authResult.error!);
  }

  try {
    const { collection_id } = await params;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const pageParam = searchParams.get('page');
    const perPageParam = searchParams.get('per_page');
    const limitParam = searchParams.get('limit');
    const sortByParam = searchParams.get('sort_by');
    const orderByParam = searchParams.get('order_by');
    
    // Pagination with validation
    const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
    const perPage = perPageParam 
      ? Math.min(Math.max(1, parseInt(perPageParam, 10) || 100), 1000) 
      : 100;
    const limit = limitParam 
      ? Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 1000) 
      : perPage;
    const offset = (page - 1) * perPage;

    // Verify collection exists (published)
    const collection = await getCollectionById(collection_id, true);
    if (!collection) {
      return NextResponse.json(
        { error: 'Collection not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    // Get published fields for reference resolution and filtering (exclude computed like Status)
    const fields = await getFieldsByCollectionId(collection_id, true, { excludeComputed: true });
    const fieldSlugToId: Record<string, string> = {};
    fields.forEach(field => {
      const slug = field.key || field.name.toLowerCase().replace(/\s+/g, '-');
      fieldSlugToId[slug] = field.id;
    });

    // Parse filter params first to determine if we need client-side pagination
    const filterParams: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      const match = key.match(/^filter\[(.+)\]$/);
      if (match) {
        filterParams[match[1]] = value;
      }
    });

    // Parse field projections for limiting returned fields
    const fieldProjections = parseFieldProjections(searchParams);

    // If sorting or filtering is requested, we need to fetch all items first,
    // then apply filter/sort, then paginate client-side
    const needsClientPagination = sortByParam || Object.keys(filterParams).length > 0;

    // Get published items with values
    let { items, total } = await getItemsWithValues(collection_id, true, {
      limit: needsClientPagination ? undefined : (limitParam ? limit : perPage),
      offset: needsClientPagination ? undefined : offset,
      deleted: false,
    });

    // Apply client-side filtering (filter[field_slug]=value)
    if (Object.keys(filterParams).length > 0) {
      items = items.filter(item => {
        for (const [key, filterValue] of Object.entries(filterParams)) {
          // Normalize filter key to lowercase slug for case-insensitive matching
          const slug = key.toLowerCase().replace(/\s+/g, '-');
          const fieldId = fieldSlugToId[slug];
          if (fieldId) {
            const itemValue = item.values[fieldId];
            if (itemValue !== filterValue) {
              return false;
            }
          }
        }
        return true;
      });
    }

    // Apply sorting (case-insensitive field matching)
    if (sortByParam) {
      const normalizedSort = sortByParam.toLowerCase().replace(/\s+/g, '-');
      const sortFieldId = fieldSlugToId[normalizedSort];
      if (sortFieldId) {
        // Get field type for proper sorting (numeric vs string)
        const sortField = fields.find(f => f.id === sortFieldId);
        const isNumeric = sortField?.type === 'number';
        const order = orderByParam === 'desc' ? -1 : 1;
        
        items.sort((a, b) => {
          const aVal = a.values[sortFieldId] || '';
          const bVal = b.values[sortFieldId] || '';
          
          if (isNumeric) {
            // Numeric comparison
            const aNum = parseFloat(aVal) || 0;
            const bNum = parseFloat(bVal) || 0;
            return (aNum - bNum) * order;
          } else {
            // String comparison
            return aVal.localeCompare(bVal) * order;
          }
        });
      }
    }

    // Apply pagination AFTER filtering and sorting (if needed)
    if (needsClientPagination) {
      total = items.length;
      items = items.slice(offset, offset + (limitParam ? limit : perPage));
    }

    // Transform items to public format with resolved references
    // Pass field projections and collection name for field filtering
    const hasProjections = Object.keys(fieldProjections).length > 0;
    const publicItems = await Promise.all(
      items.map(item => transformItemToPublicWithRefs(
        item, 
        fields, 
        true,
        hasProjections ? fieldProjections : undefined,
        hasProjections ? collection.name : undefined
      ))
    );

    return NextResponse.json({
      items: publicItems,
      pagination: {
        page,
        per_page: perPage,
        total,
      },
    });
  } catch (error) {
    console.error('Error fetching collection items:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch collection items', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}

/**
 * POST /ycode/api/v1/collections/{collection_id}/items
 * Create a new published item in a collection
 * 
 * Request body (field values directly, no wrapper):
 * {
 *   "name": "My Blog Post",
 *   "slug": "my-blog-post",
 *   "content": "..."
 * }
 * 
 * Response: created item with all field values (flattened)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ collection_id: string }> }
) {
  // Validate API key
  const authResult = await validateApiKey(request);
  if (!authResult.valid) {
    return unauthorizedResponse(authResult.error!);
  }

  try {
    const { collection_id } = await params;

    // Parse field projections from query params (for response filtering)
    const { searchParams } = new URL(request.url);
    const fieldProjections = parseFieldProjections(searchParams);
    const hasProjections = Object.keys(fieldProjections).length > 0;

    // Verify collection exists (published)
    const collection = await getCollectionById(collection_id, true);
    if (!collection) {
      return NextResponse.json(
        { error: 'Collection not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    // Parse request body - field values directly (no fieldData wrapper)
    const body = await request.json();

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body', code: 'INVALID_REQUEST' },
        { status: 400 }
      );
    }

    // Get published fields for mapping slugs to IDs (exclude computed like Status)
    const fields = await getFieldsByCollectionId(collection_id, true, { excludeComputed: true });
    const fieldSlugToId: Record<string, string> = {};
    
    // Identify protected fields (cannot be set by user)
    const protectedFieldKeys = ['id', 'created_at', 'updated_at'];
    const protectedFieldIds = new Set(
      fields.filter(f => f.key && protectedFieldKeys.includes(f.key)).map(f => f.id)
    );
    
    fields.forEach(field => {
      const slug = field.key || field.name.toLowerCase().replace(/\s+/g, '-');
      fieldSlugToId[slug] = field.id;
    });

    // Map field slugs to IDs (case-insensitive matching, exclude protected fields)
    const valuesToSet: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(body)) {
      const slug = key.toLowerCase().replace(/\s+/g, '-');
      const fieldId = fieldSlugToId[slug];
      if (fieldId && !protectedFieldIds.has(fieldId)) {
        valuesToSet[fieldId] = value as string | null;
      }
    }

    // Auto-generate ID field (always, user cannot override)
    const idField = fields.find(f => f.key === 'id');
    if (idField) {
      const maxId = await getMaxIdValue(collection_id, true);
      valuesToSet[idField.id] = String(maxId + 1);
    }

    // Auto-generate timestamps (always, user cannot override)
    const now = new Date().toISOString();
    const createdAtField = fields.find(f => f.key === 'created_at');
    if (createdAtField) {
      valuesToSet[createdAtField.id] = now;
    }
    const updatedAtField = fields.find(f => f.key === 'updated_at');
    if (updatedAtField) {
      valuesToSet[updatedAtField.id] = now;
    }

    // Create both draft and published items with the same ID
    // First create the draft item (this generates the ID)
    const item = await createItem({
      collection_id,
      is_published: false,
    });

    // Set values on draft first
    if (Object.keys(valuesToSet).length > 0) {
      await setValues(item.id, valuesToSet, false);
    }

    // Now create the published version with the same ID
    await upsertPublishedItemVersion(item, collection_id);

    // Copy draft values to published with SAME IDs (matching publishValues pattern)
    if (Object.keys(valuesToSet).length > 0) {
      const draftValues = await getValuesByItemId(item.id, false);
      await upsertPublishedValues(draftValues);
    }

    // Get the created item with values and transform with resolved references
    const createdItem = await getItemWithValues(item.id, true);
    
    if (!createdItem) {
      return NextResponse.json(
        { error: 'Failed to retrieve created item', code: 'INTERNAL_ERROR' },
        { status: 500 }
      );
    }

    const response = await transformItemToPublicWithRefs(
      createdItem, 
      fields, 
      true,
      hasProjections ? fieldProjections : undefined,
      hasProjections ? collection.name : undefined
    );

    // Purge CDN/data caches for pages that render this collection (lists,
    // grids, dynamic page). Without this, the new item is in the DB but
    // every public page keeps serving cached HTML that doesn't include it.
    // No old slug to pass — POST adds a new row, doesn't remove one.
    try {
      const result = await invalidateForCollectionChange(collection_id);
      if (result.invalidatedRoutes.length > 0) {
        console.log(`[Cache] v1 item create: invalidated ${result.invalidatedRoutes.length} route(s)`);
      }
    } catch (cacheError) {
      console.error(`[Cache] v1 item create: invalidation failed:`, cacheError);
    }

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('Error creating collection item:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create collection item', code: 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}
