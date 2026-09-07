import path from 'node:path';

import {
  StorageProvider,
  allowUploadMimeTypes,
  mimeTypeToFileExtensionMappings,
  type AllowedUploadMimeType,
} from '@logto/schemas';
import { z } from 'zod';

import { EnvSet } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import SystemContext from '#src/tenants/SystemContext.js';
import assertThat from '#src/utils/assert-that.js';
import { buildObjectStorage } from '#src/utils/storage/object-storage.js';

import type { AnonymousRouter, RouterInitArgs } from './types.js';

const contentTypeByExtension = new Map<string, AllowedUploadMimeType>(
  allowUploadMimeTypes.flatMap((contentType) =>
    mimeTypeToFileExtensionMappings[contentType].map(
      (extension): [string, AllowedUploadMimeType] => [extension, contentType]
    )
  )
);

const objectKeyGuard = z.string().trim().min(1).max(4096);

export default function publicUserAssetsRoutes<T extends AnonymousRouter>(
  ...[router, tenant]: RouterInitArgs<T>
) {
  router.get('/user-assets/files/(.*)', async (ctx, next) => {
    assertThat(
      !EnvSet.values.isCloud && EnvSet.values.isSelfHostedParityEnabled,
      new RequestError({ code: 'entity.not_found', status: 404 })
    );

    const { storageProviderConfig } = SystemContext.shared;
    assertThat(
      storageProviderConfig?.provider === StorageProvider.LocalStorage,
      new RequestError({ code: 'entity.not_found', status: 404 })
    );

    const objectKey = objectKeyGuard.parse(ctx.params[0]);
    assertThat(
      objectKey.startsWith(`${tenant.id}/`),
      new RequestError({ code: 'entity.not_found', status: 404 })
    );

    const extension = path.extname(objectKey).slice(1).toLowerCase();
    const contentType = contentTypeByExtension.get(extension);
    assertThat(contentType, new RequestError({ code: 'entity.not_found', status: 404 }));

    const storage = buildObjectStorage(storageProviderConfig);
    assertThat(
      await storage.isFileExisted(objectKey),
      new RequestError({ code: 'entity.not_found', status: 404 })
    );

    const object = await storage.downloadFile(objectKey);
    ctx.type = object.contentType ?? contentType;
    ctx.length = object.contentLength;
    ctx.body = object.data;
    ctx.set('Cache-Control', 'public, max-age=604800, immutable');
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    ctx.set('X-Content-Type-Options', 'nosniff');

    return next();
  });
}
