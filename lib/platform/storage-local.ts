/**
 * Local filesystem storage adapter (OSS / self-host default).
 */

import fs from 'fs/promises';
import path from 'path';

import type { StorageProvider, UploadOptions } from './storage';

function getRoot(): string {
  return process.env.STORAGE_LOCAL_PATH || path.join(process.cwd(), 'storage');
}

function getPublicBase(): string {
  const base = process.env.STORAGE_PUBLIC_BASE_URL || '/a/local';
  return base.replace(/\/$/, '');
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function toBuffer(body: Buffer | Uint8Array | Blob | File): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const ab = await body.arrayBuffer();
  return Buffer.from(ab);
}

export function createLocalStorage(): StorageProvider {
  const root = getRoot();

  return {
    async upload(objectPath, body, _options?: UploadOptions) {
      const full = path.join(root, objectPath);
      await ensureDir(full);
      const buf = await toBuffer(body);
      await fs.writeFile(full, buf);
      return { path: objectPath };
    },

    async remove(paths) {
      await Promise.all(
        paths.map(async (p) => {
          try {
            await fs.unlink(path.join(root, p));
          } catch {
            // ignore missing
          }
        })
      );
    },

    getPublicUrl(objectPath) {
      const encoded = objectPath
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/');
      return `${getPublicBase()}/${encoded}`;
    },

    async getObject(objectPath) {
      try {
        const full = path.join(root, objectPath);
        const body = await fs.readFile(full);
        return { body };
      } catch {
        return null;
      }
    },
  };
}
