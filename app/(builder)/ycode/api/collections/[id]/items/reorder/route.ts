import { NextRequest } from 'next/server';
import { batchUpdateColumn } from '@/lib/knex-helpers';
import { getDb } from '@/lib/platform/db';
import { noCache } from '@/lib/api-response';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/collections/[id]/items/reorder
 * Bulk update manual_order for multiple items
 * Used for drag and drop reordering
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: collectionId } = await params;
    
    if (!collectionId) {
      return noCache({ error: 'Invalid collection ID' }, 400);
    }
    
    const body = await request.json();
    const { updates } = body;
    
    if (!Array.isArray(updates)) {
      return noCache({ error: 'updates must be an array' }, 400);
    }
    
    if (updates.length === 0) {
      return noCache({ error: 'updates cannot be empty' }, 400);
    }
    
    // Validate updates format
    for (const update of updates) {
      if (typeof update.id !== 'string' || typeof update.manual_order !== 'number') {
        return noCache({ error: 'Each update must have id as string and manual_order as number' }, 400);
      }
    }
    
    // Update manual_order on draft rows only so publish detects the change
    const db = await getDb();
    await batchUpdateColumn(
      db,
      'collection_items',
      'manual_order',
      updates,
      {
        extraWhereClause: 'AND collection_id = ? AND is_published = false',
        extraWhereParams: [collectionId],
      }
    );
    
    return noCache({ data: { updated: updates.length } }, 200);
  } catch (error) {
    console.error('Error reordering items:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to reorder items' },
      500
    );
  }
}
