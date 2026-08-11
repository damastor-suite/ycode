/**
 * S3-compatible storage adapter (AWS S3, MinIO, R2, etc.).
 */

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand as PutCmd } from '@aws-sdk/client-s3';

import type { StorageProvider, UploadOptions } from './storage';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} for S3 storage`);
  return v;
}

async function toBuffer(body: Buffer | Uint8Array | Blob | File): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const ab = await body.arrayBuffer();
  return Buffer.from(ab);
}

export function createS3Storage(): StorageProvider {
  const bucket = required('S3_BUCKET');
  const region = process.env.S3_REGION || 'us-east-1';
  const endpoint = process.env.S3_ENDPOINT;
  const publicBase = (process.env.STORAGE_PUBLIC_BASE_URL || endpoint || '')
    .replace(/\/$/, '');

  const client = new S3Client({
    region,
    ...(endpoint
      ? {
        endpoint,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      }
      : {}),
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    },
  });

  return {
    async upload(objectPath, body, options?: UploadOptions) {
      const buf = await toBuffer(body);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectPath,
          Body: buf,
          ContentType: options?.contentType,
          CacheControl: options?.cacheControl || 'public, max-age=3600',
        })
      );
      return { path: objectPath };
    },

    async remove(paths) {
      if (paths.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: paths.map((Key) => ({ Key })),
          },
        })
      );
    },

    getPublicUrl(objectPath) {
      if (publicBase) {
        return `${publicBase}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
      }
      return `https://${bucket}.s3.${region}.amazonaws.com/${objectPath}`;
    },

    async createSignedUploadUrl(objectPath, expiresInSeconds = 3600) {
      const command = new PutCmd({
        Bucket: bucket,
        Key: objectPath,
      });
      const signedUrl = await getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
      });
      return { signedUrl, path: objectPath };
    },

    async getObject(objectPath) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: objectPath })
        );
        if (!res.Body) return null;
        const bytes = await res.Body.transformToByteArray();
        return {
          body: Buffer.from(bytes),
          contentType: res.ContentType,
        };
      } catch {
        return null;
      }
    },
  };
}
