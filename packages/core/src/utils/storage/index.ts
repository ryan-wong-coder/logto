import { StorageProvider, type StorageProviderData } from '@logto/schemas';
import { appendPath } from '@silverhand/essentials';

import { buildAzureStorage } from './azure-storage.js';
import { buildGoogleStorage } from './google-storage.js';
import { buildLocalStorage } from './local-storage.js';
import { buildS3Storage } from './s3-storage.js';
import type { UploadFile } from './types.js';

const localUserAssetsRoute = 'api/user-assets/files';

/**
 * Resolve the public base URL used by uploaded user assets.
 *
 * Cloud object storage providers already return a public provider URL when `publicUrl` is omitted.
 * Local storage needs an HTTP route owned by the current tenant instead of exposing its object key
 * as a root-relative path (which would be handled by the SPA fallback).
 */
export const getUserAssetsPublicUrl = (
  config: StorageProviderData,
  tenantEndpoint: URL
): string | undefined =>
  config.publicUrl ??
  (config.provider === StorageProvider.LocalStorage
    ? appendPath(tenantEndpoint, localUserAssetsRoute).href.replace(/\/$/, '')
    : undefined);

// eslint-disable-next-line @typescript-eslint/ban-types -- Google doesn't allow us to use Uint8Array
export const buildUploadFile = (config: StorageProviderData): UploadFile | UploadFile<Buffer> => {
  if (config.provider === 'LocalStorage') {
    return buildLocalStorage(config.rootPath).uploadFile;
  }
  if (config.provider === 'AzureStorage') {
    const storage = buildAzureStorage(config.connectionString, config.container);

    return storage.uploadFile;
  }
  if (config.provider === 'GoogleStorage') {
    const { projectId, keyFilename, bucketName } = config;
    const storage = buildGoogleStorage(projectId, keyFilename, bucketName);

    return storage.uploadFile;
  }

  const { endpoint, bucket, accessKeyId, forcePathStyle, accessSecretKey, region } = config;

  const storage = buildS3Storage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey: accessSecretKey,
    region,
    forcePathStyle,
  });

  return storage.uploadFile;
};
