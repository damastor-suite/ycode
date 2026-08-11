/**
 * File upload utilities for platform storage
 * Creates Asset records in database for uploaded files
 */

import { createAsset } from '@/lib/repositories/assetRepository';
import { deleteAsset as deleteAssetRecord, getAssetById } from '@/lib/repositories/assetRepository';
import { getDb } from '@/lib/platform/db';
import { getStorage } from '@/lib/platform/storage';
import { isAssetOfType } from './asset-utils';
import { ASSET_CATEGORIES, generateStoragePath, getDisplayName } from '@/lib/asset-constants';
import sharp from 'sharp';
import type { Asset } from '@/types';

/**
 * Validate SVG content
 * @param content - SVG content to validate
 * @returns true if valid, false otherwise
 */
export function isValidSvg(content: string): boolean {
  if (!content || typeof content !== 'string') {
    return false;
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // Check for SVG tag (case-insensitive)
  const svgTagRegex = /<svg[\s>]/i;
  if (!svgTagRegex.test(trimmed)) {
    return false;
  }

  // Check for closing SVG tag or self-closing tag
  const hasClosingTag = /<\/svg>/i.test(trimmed);
  const hasSelfClosing = /<svg[^>]*\/>/i.test(trimmed);

  if (!hasClosingTag && !hasSelfClosing) {
    return false;
  }

  // Basic structure check: ensure we have at least one SVG element
  const svgMatch = trimmed.match(/<svg[\s>][\s\S]*<\/svg>/i);
  if (!svgMatch) {
    return false;
  }

  return true;
}

/**
 * Clean SVG content by removing potentially dangerous elements, attributes, and comments
 * @param svgContent - Raw SVG string
 * @returns Cleaned SVG string without classes, IDs, comments, or fixed dimensions (preserves inline styles)
 */
export function cleanSvgContent(svgContent: string): string {
  // Remove XML declarations and DOCTYPE
  let cleaned = svgContent
    .replace(/<\?xml[^?]*\?>/gi, '') // Remove <?xml ... ?>
    .replace(/<!DOCTYPE[^>]*>/gi, ''); // Remove <!DOCTYPE ... >

  // Remove HTML/XML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // Remove script tags and event handlers
  cleaned = cleaned
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, ''); // Remove event handlers like onclick, onload, etc.

  // Remove potentially dangerous tags. `<style>` is safe inside SVG (CSS can't
  // execute code) and is commonly used to define class-based fills (e.g.
  // `.cls-1 { fill: #5d5d5d; }` from Illustrator exports) — stripping it would
  // leave path classes referencing nothing and the SVG would render all-black.
  const dangerousTags = ['script', 'iframe', 'embed', 'object', 'link'];
  dangerousTags.forEach(tag => {
    const regex = new RegExp(`<${tag}\\b[^<]*(?:(?!<\\/${tag}>)<[^<]*)*<\\/${tag}>`, 'gi');
    cleaned = cleaned.replace(regex, '');
  });

  // Remove unwanted attributes (width, height)
  cleaned = cleaned
    .replace(/(<svg[^>]*)\s+width\s*=\s*["'][^"']*["']/gi, '$1') // Remove width from SVG
    .replace(/(<svg[^>]*)\s+height\s*=\s*["'][^"']*["']/gi, '$1'); // Remove height from SVG

  // Remove excessive whitespace
  cleaned = cleaned
    .replace(/\s+/g, ' ') // Replace multiple spaces/newlines with single space
    .replace(/>\s+</g, '><'); // Remove spaces between tags

  return cleaned.trim();
}

/**
 * Extract image dimensions from file buffer using sharp
 */
async function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  try {
    if (!isAssetOfType(file.type, ASSET_CATEGORIES.IMAGES)) {
      return null;
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const metadata = await sharp(buffer).metadata();

    if (metadata.width && metadata.height) {
      return {
        width: metadata.width,
        height: metadata.height,
      };
    }

    return null;
  } catch (error) {
    console.error('Error extracting image dimensions:', error);
    return null;
  }
}

/**
 * Convert image to WebP format using sharp
 * @param file - Original image file
 * @returns Converted file data and metadata, or null if not an image or conversion fails
 */
async function convertImageToWebP(file: File): Promise<{
  buffer: Buffer;
  mimeType: string;
  fileExtension: string;
  width: number | null;
  height: number | null;
} | null> {
  try {
    // Only convert raster images. Skip SVG, animated GIFs, and AVIF — AVIF is
    // already a highly-compressed modern format, so re-encoding to WebP would
    // typically inflate size and lose quality for no benefit.
    if (!isAssetOfType(file.type, ASSET_CATEGORIES.IMAGES) ||
        file.type === 'image/svg+xml' ||
        file.type === 'image/gif' ||
        file.type === 'image/avif') {
      return null;
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Convert to WebP with quality 85
    const webpBuffer = await sharp(buffer)
      .webp({ quality: 85 })
      .toBuffer();

    // Get dimensions from the converted image
    const metadata = await sharp(webpBuffer).metadata();

    return {
      buffer: webpBuffer,
      mimeType: 'image/webp',
      fileExtension: 'webp',
      width: metadata.width || null,
      height: metadata.height || null,
    };
  } catch (error) {
    console.error('Error converting image to WebP:', error);
    return null;
  }
}

/**
 * Upload a file to Supabase Storage and create Asset record
 * Automatically converts raster images to WebP format for better performance
 *
 * @param file - File to upload
 * @param source - Source identifier (e.g., 'library', 'page-settings', 'components')
 * @param customName - Optional custom name for the file
 * @param assetFolderId - Optional asset folder ID to organize the asset
 * @returns Asset with metadata or null if upload fails
 */
export async function uploadFile(
  file: File,
  source: string,
  customName?: string,
  assetFolderId?: string | null
): Promise<Asset | null> {
  try {
    const filename = getDisplayName(file.name, customName);

    // Handle SVG files - store content directly without uploading to storage
    if (file.type === 'image/svg+xml') {
      const svgText = await file.text();
      const cleanedContent = cleanSvgContent(svgText);

      // Try to extract dimensions from SVG if possible
      let dimensions: { width: number; height: number } | null = null;
      try {
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const metadata = await sharp(buffer).metadata();
        if (metadata.width && metadata.height) {
          dimensions = {
            width: metadata.width,
            height: metadata.height,
          };
        }
      } catch {
        // SVG dimension extraction is best-effort
      }

      // Create asset with inline SVG content
      const asset = await createAsset({
        filename,
        storage_path: null,
        public_url: null,
        file_size: cleanedContent.length,
        mime_type: 'image/svg+xml',
        width: dimensions?.width,
        height: dimensions?.height,
        source,
        asset_folder_id: assetFolderId,
        content: cleanedContent,
      });

      return asset;
    }

    // For non-SVG files, proceed with storage upload
    const storage = await getStorage();

    // Try to convert image to WebP
    const webpConversion = await convertImageToWebP(file);

    let fileToUpload: File | Buffer;
    let fileExtension: string;
    let mimeType: string;
    let fileSize: number;
    let dimensions: { width: number; height: number } | null = null;

    if (webpConversion) {
      // Use converted WebP image
      fileToUpload = webpConversion.buffer;
      fileExtension = webpConversion.fileExtension;
      mimeType = webpConversion.mimeType;
      fileSize = webpConversion.buffer.length;
      // Only persist dimensions when both are positive; zero/unknown values
      // would otherwise produce invalid `width="0"` attributes on render.
      dimensions = (webpConversion.width && webpConversion.height)
        ? { width: webpConversion.width, height: webpConversion.height }
        : null;
    } else {
      // Use original file
      fileToUpload = file;
      fileExtension = file.name.split('.').pop() || '';
      mimeType = file.type;
      fileSize = file.size;
      // Get dimensions for non-converted images
      dimensions = await getImageDimensions(file);
    }

    const effectiveFilename = webpConversion
      ? `${file.name.replace(/\.[^/.]+$/, '')}.${fileExtension}`
      : file.name;
    const storagePath = generateStoragePath(effectiveFilename);

    const { path } = await storage.upload(storagePath, fileToUpload, {
      cacheControl: '3600',
      upsert: false,
      contentType: mimeType,
    });

    const asset = await createAsset({
      filename,
      storage_path: path,
      public_url: storage.getPublicUrl(path),
      file_size: fileSize,
      mime_type: mimeType,
      width: dimensions?.width,
      height: dimensions?.height,
      source,
      asset_folder_id: assetFolderId,
    });

    return asset;
  } catch (error) {
    console.error('Error in uploadFile:', error);
    return null;
  }
}

/**
 * Delete an asset (from both storage and database)
 * @deprecated Use deleteAsset from '@/lib/repositories/assetRepository' instead.
 * This function does not support the draft/published workflow.
 *
 * @param assetId - Asset ID to delete
 * @returns True if successful, false otherwise
 */
export async function deleteAsset(assetId: string): Promise<boolean> {
  try {
    const asset = await getAssetById(assetId);
    if (!asset) {
      console.error('Error fetching asset: asset not found');
      return false;
    }

    if (asset.storage_path) {
      const storage = await getStorage();
      await storage.remove([asset.storage_path]);
    }

    await deleteAssetRecord(assetId);
    const knex = await getDb();
    await knex('assets')
      .where('id', assetId)
      .del();

    return true;
  } catch (error) {
    console.error('Error in deleteAsset:', error);
    return false;
  }
}
