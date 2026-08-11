import { NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/platform/storage';
import { validateCategoryMimeType } from '@/lib/asset-utils';
import { MAX_UPLOAD_FILE_SIZE, generateStoragePath } from '@/lib/asset-constants';

export const runtime = 'nodejs';

/**
 * POST /ycode/api/files/presign
 * Generate a signed upload URL for direct browser-to-storage uploads.
 * Used for large files that exceed serverless body limits.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename, mimeType, fileSize, category } = body as {
      filename: string;
      mimeType: string;
      fileSize: number;
      category?: string | null;
    };

    if (!filename || !mimeType || !fileSize) {
      return NextResponse.json(
        { error: 'filename, mimeType, and fileSize are required' },
        { status: 400 }
      );
    }

    const mimeError = validateCategoryMimeType(mimeType, category);
    if (mimeError) {
      return NextResponse.json({ error: mimeError }, { status: 400 });
    }

    if (fileSize > MAX_UPLOAD_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File size must be less than 50MB' },
        { status: 400 }
      );
    }

    const storagePath = generateStoragePath(filename);

    const storage = await getStorage();
    if (!storage.createSignedUploadUrl) {
      return NextResponse.json(
        { error: 'Signed uploads are not supported by the configured storage provider' },
        { status: 500 }
      );
    }

    const data = await storage.createSignedUploadUrl(storagePath);

    return NextResponse.json({
      data: {
        signedUrl: data.signedUrl,
        token: data.token,
        storagePath,
      },
    });
  } catch (error) {
    console.error('Error in presign route:', error);
    return NextResponse.json({ error: 'Failed to generate upload URL' }, { status: 500 });
  }
}
