import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';
import { STORAGE_FOLDERS } from '@/lib/asset-constants';
import { getAuthUser } from '@/lib/platform/auth';
import { getDb } from '@/lib/platform/db';
import { getStorage } from '@/lib/platform/storage';
import { generateId } from '@/lib/utils';
import sharp from 'sharp';

/**
 * POST /ycode/api/profile/avatar
 *
 * Upload user's profile photo
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return noCache({ error: 'No file provided' }, 400);
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      return noCache({ error: 'Only image files are allowed' }, 400);
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      return noCache({ error: 'File size must be less than 5MB' }, 400);
    }

    const auth = await getAuthUser();
    if (!auth) {
      return noCache({ error: 'Not authenticated' }, 401);
    }

    // Convert image to WebP and resize for avatar
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const webpBuffer = await sharp(buffer)
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();

    // Create storage path: avatars/{userId}-{randomId}.webp
    const storagePath = `${STORAGE_FOLDERS.AVATARS}/${generateId(auth.user.id)}.webp`;
    const storage = await getStorage();

    // Delete old avatar if exists
    const oldAvatarUrl = auth.user.image || auth.user.user_metadata?.avatar_url;
    if (oldAvatarUrl) {
      try {
        const idx = oldAvatarUrl.indexOf(`${STORAGE_FOLDERS.AVATARS}/`);
        if (idx !== -1) {
          await storage.remove([oldAvatarUrl.substring(idx)]);
        }
      } catch (error) {
        console.error('Failed to delete old avatar:', error);
        // Continue even if deletion fails
      }
    }

    // Upload new avatar
    const uploadData = await storage.upload(storagePath, webpBuffer, {
      cacheControl: '3600',
      upsert: true,
      contentType: 'image/webp',
    });
    const publicUrl = storage.getPublicUrl(uploadData.path);

    const db = await getDb();
    const [user] = await db('user')
      .where('id', auth.user.id)
      .update({
        image: publicUrl,
        updatedAt: new Date(),
      })
      .returning(['id', 'email', 'name', 'image', 'role', 'createdAt', 'updatedAt']);

    return noCache({
      data: {
        avatar_url: publicUrl,
        user,
      },
    });
  } catch (error) {
    console.error('Failed to upload avatar:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return noCache({ error: `Failed to upload avatar: ${message}` }, 500);
  }
}
