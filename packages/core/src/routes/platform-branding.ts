import { idenBrandProfile } from '@logto/core-kit';
import { StorageProvider } from '@logto/schemas';
import { z } from 'zod';

import { EnvSet } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import SystemContext from '#src/tenants/SystemContext.js';
import assertThat from '#src/utils/assert-that.js';
import { buildObjectStorage } from '#src/utils/storage/object-storage.js';

import type { AnonymousRouter, RouterInitArgs } from './types.js';

const assetNameGuard = z.string().regex(/^(?:light|dark)-[\da-z]{8,32}\.(?:png|jpe?g|svg)$/i);

export const getEffectivePlatformBranding = () => ({
  productName: idenBrandProfile.productName,
  slogan: idenBrandProfile.slogan,
  hideOpenSourceNotice: false,
  ...SystemContext.shared.platformBrandingConfig,
});

export default function platformBrandingRoutes<T extends AnonymousRouter>(
  ...[router]: RouterInitArgs<T>
) {
  router.get('/platform-branding', async (ctx, next) => {
    assertThat(
      !EnvSet.values.isCloud && EnvSet.values.isSelfHostedParityEnabled,
      new RequestError({ code: 'entity.not_found', status: 404 })
    );
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.body = getEffectivePlatformBranding();
    return next();
  });

  router.get(
    '/platform-assets/:assetName',
    koaGuard({ params: z.object({ assetName: assetNameGuard }) }),
    async (ctx, next) => {
      assertThat(
        !EnvSet.values.isCloud && EnvSet.values.isSelfHostedParityEnabled,
        new RequestError({ code: 'entity.not_found', status: 404 })
      );
      const { storageProviderConfig } = SystemContext.shared;
      assertThat(storageProviderConfig, 'storage.not_configured');
      const { assetName } = ctx.guard.params;
      const object = await buildObjectStorage(storageProviderConfig).downloadFile(
        `platform-branding/${assetName}`
      );
      const extension = assetName.split('.').at(-1)?.toLowerCase();
      ctx.type =
        object.contentType ??
        (extension === 'svg' ? 'image/svg+xml' : extension === 'png' ? 'image/png' : 'image/jpeg');
      ctx.length = object.contentLength;
      ctx.body = object.data;
      ctx.set(
        'Cache-Control',
        storageProviderConfig.provider === StorageProvider.LocalStorage
          ? 'public, max-age=604800, immutable'
          : 'public, max-age=86400, immutable'
      );
      return next();
    }
  );
}
