/**
 * Asset Proxy Route
 *
 * Serves assets with SEO-friendly URLs by proxying from platform storage.
 * URL format: /a/{base62-hash}/{seo-friendly-name}.{ext}
 *
 * The hash is a base62-encoded UUID used for lookup.
 * The name segment is cosmetic (for SEO) and derived from the asset's filename.
 * If the name doesn't match the current filename, a 301 redirect is issued.
 *
 * Supports image resizing via query params (width, height, quality) using sharp.
 * Responses are cached with immutable headers so sharp only runs once per unique URL.
 */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { base62ToUuid } from '@/lib/convertion-utils';
import { getAssetProxyUrl, isAssetOfType, ASSET_CATEGORIES } from '@/lib/asset-utils';
import { getAssetForProxy } from '@/lib/repositories/assetRepository';
import { getStorage } from '@/lib/platform/storage';

// Cache headers set at infrastructure level via next.config.ts headers()
// to prevent Next.js proxy from overriding them

function parseTransformParams(searchParams: URLSearchParams) {
  const width = parseInt(searchParams.get('width') || '');
  const height = parseInt(searchParams.get('height') || '');
  const quality = parseInt(searchParams.get('quality') || '');

  const hasParams = width > 0 || height > 0 || quality > 0;
  if (!hasParams) return null;

  return {
    width: width > 0 ? width : undefined,
    height: height > 0 ? height : undefined,
    quality: quality > 0 ? Math.min(quality, 100) : 80,
  };
}

/**
 * Whether a mime type can be safely resized in-process. SVGs are vector (no
 * point) and GIFs would lose animation when flattened — both fall through to
 * the original passthrough instead.
 */
function isResizableBitmap(mimeType: string | null | undefined): boolean {
  if (!mimeType || !mimeType.startsWith('image/')) return false;
  if (mimeType === 'image/svg+xml') return false;
  if (mimeType === 'image/gif') return false;
  return true;
}

function getContentTypeFromPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

function parseRangeHeader(rangeHeader: string | null, totalLength: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    const start = Math.max(totalLength - suffixLength, 0);
    return { start, end: totalLength - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : totalLength - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= totalLength
  ) {
    return null;
  }

  return { start, end: Math.min(end, totalLength - 1) };
}

function buildObjectResponse(
  body: Buffer,
  contentType: string,
  rangeHeader: string | null = null
): Response {
  const range = parseRangeHeader(rangeHeader, body.length);
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  });

  if (!range) {
    headers.set('Content-Length', body.length.toString());
    return new Response(new Uint8Array(body), { status: 200, headers });
  }

  const chunk = body.subarray(range.start, range.end + 1);
  headers.set('Content-Length', chunk.length.toString());
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${body.length}`);
  return new Response(new Uint8Array(chunk), { status: 206, headers });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string; name: string[] }> }
) {
  try {
    const { hash, name } = await params;
    const storage = await getStorage();

    if (hash === 'local') {
      const storagePath = name.join('/');
      const object = storage.getObject ? await storage.getObject(storagePath) : null;
      if (!object) {
        return new Response('Not found', { status: 404 });
      }

      return buildObjectResponse(
        object.body,
        object.contentType || getContentTypeFromPath(storagePath),
        request.headers.get('range')
      );
    }

    let assetId: string;
    try {
      assetId = base62ToUuid(hash);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const asset = await getAssetForProxy(assetId);
    if (!asset?.storage_path) {
      return new Response('Not found', { status: 404 });
    }

    const canonicalPath = getAssetProxyUrl(asset);
    if (canonicalPath) {
      const requestedName = name.join('/');
      const canonicalName = canonicalPath.split('/').slice(3).join('/');
      if (requestedName !== canonicalName) {
        const url = new URL(request.url);
        const redirectUrl = new URL(canonicalPath, url.origin);
        redirectUrl.search = url.search;
        return Response.redirect(redirectUrl.toString(), 301);
      }
    }

    const url = new URL(request.url);
    const isImage = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES);
    const object = storage.getObject ? await storage.getObject(asset.storage_path) : null;
    if (!object) {
      return new Response('Not found', { status: 404 });
    }

    const transform = parseTransformParams(url.searchParams);
    // Resize the fetched original in-process with sharp. GIFs are excluded via
    // isResizableBitmap — Sharp flattens animated frames into a single static
    // image, so they fall through and stream as raw bytes below.
    if (transform && isImage && isResizableBitmap(asset.mime_type)) {
      const buffer = object.body;

      // Preserve AVIF on output (already highly compressed); re-encoding to WebP
      // would inflate size and lose quality.
      const isAvif = asset.mime_type === 'image/avif';

      try {
        let pipeline = sharp(buffer);

        if (transform.width || transform.height) {
          // `fit: 'inside'` scales down within the requested bounds while
          // preserving aspect ratio — it never crops. Cropping is a display
          // concern handled by CSS `object-fit` on the rendered element; using
          // `fit: 'cover'` here crops the sides whenever both dimensions are
          // present, silently fighting the element's own `object-fit`.
          pipeline = pipeline.resize(transform.width, transform.height, {
            fit: 'inside',
            withoutEnlargement: true,
          });
        }

        pipeline = isAvif
          ? pipeline.avif({ quality: transform.quality })
          : pipeline.webp({ quality: transform.quality });

        const resized = await pipeline.toBuffer();

        return new Response(new Uint8Array(resized), {
          status: 200,
          headers: {
            'Content-Type': isAvif ? 'image/avif' : 'image/webp',
            'Content-Length': resized.length.toString(),
          },
        });
      } catch {
        // Sharp's bundled decoder can't decode some bitstreams (e.g. 10/12-bit
        // AVIF, which browsers still render). Since the decode failure blocks
        // any re-encode, serve the original bytes untouched rather than failing.
        return new Response(new Uint8Array(buffer), {
          status: 200,
          headers: {
            'Content-Type': asset.mime_type || 'application/octet-stream',
            'Content-Length': buffer.length.toString(),
          },
        });
      }
    }

    return buildObjectResponse(
      object.body,
      object.contentType || asset.mime_type || 'application/octet-stream',
      request.headers.get('range')
    );
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
}
