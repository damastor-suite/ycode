/**
 * Thumbnail upload utility for component previews
 * Converts image buffers to WebP and uploads to platform storage
 */

import { STORAGE_FOLDERS } from '@/lib/asset-constants';
import { getStorage } from '@/lib/platform/storage';
import sharp from 'sharp';

/**
 * Convert an image buffer to WebP format
 * @param imageBuffer - Raw image buffer (PNG, JPEG, etc.)
 * @param quality - WebP quality 0-100
 * @returns WebP buffer
 */
export async function convertToWebP(imageBuffer: Buffer, quality: number = 85): Promise<Buffer> {
  return sharp(imageBuffer)
    .webp({ quality })
    .toBuffer();
}

/**
 * Upload a component thumbnail to Supabase Storage as WebP
 * Replaces existing thumbnail if present (upsert)
 * @param componentId - Component ID used as filename
 * @param imageBuffer - Raw image buffer (PNG from html-to-image)
 * @returns Public URL of the uploaded thumbnail
 */
export async function uploadThumbnail(componentId: string, imageBuffer: Buffer): Promise<string> {
  const webpBuffer = await convertToWebP(imageBuffer);
  const storagePath = `${STORAGE_FOLDERS.COMPONENTS}/${componentId}.webp`;
  const storage = await getStorage();

  const { path } = await storage.upload(storagePath, webpBuffer, {
    cacheControl: '3600',
    upsert: true,
    contentType: 'image/webp',
  });

  return storage.getPublicUrl(path);
}

/**
 * Delete a component thumbnail from Supabase Storage
 * @param componentId - Component ID used as filename
 */
export async function deleteThumbnail(componentId: string): Promise<void> {
  const storagePath = `${STORAGE_FOLDERS.COMPONENTS}/${componentId}.webp`;
  const storage = await getStorage();
  await storage.remove([storagePath]);
}
