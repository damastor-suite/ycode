/**
 * Storage provider port — local disk or S3-compatible object storage.
 */

export interface UploadOptions {
  contentType?: string;
  cacheControl?: string;
  upsert?: boolean;
}

export interface StorageProvider {
  upload(
    path: string,
    body: Buffer | Uint8Array | Blob | File,
    options?: UploadOptions
  ): Promise<{ path: string }>;
  remove(paths: string[]): Promise<void>;
  getPublicUrl(path: string): string;
  createSignedUploadUrl?(
    path: string,
    expiresInSeconds?: number
  ): Promise<{ signedUrl: string; path: string; token?: string }>;
  /** Fetch object bytes (asset proxy). */
  getObject?(path: string): Promise<{ body: Buffer; contentType?: string } | null>;
}

let storageInstance: StorageProvider | null = null;

export function setStorageProvider(provider: StorageProvider): void {
  storageInstance = provider;
}

export async function getStorage(): Promise<StorageProvider> {
  if (storageInstance) {
    return storageInstance;
  }

  const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();

  if (driver === 's3') {
    const { createS3Storage } = await import('./storage-s3');
    storageInstance = createS3Storage();
  } else {
    const { createLocalStorage } = await import('./storage-local');
    storageInstance = createLocalStorage();
  }

  return storageInstance;
}
