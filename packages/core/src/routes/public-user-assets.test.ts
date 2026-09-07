import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StorageProvider } from '@logto/schemas';

import { EnvSet } from '#src/env-set/index.js';
import SystemContext from '#src/tenants/SystemContext.js';
import { MockTenant } from '#src/test-utils/tenant.js';
import { buildLocalStorage } from '#src/utils/storage/local-storage.js';
import { createRequester } from '#src/utils/test-utils.js';

import publicUserAssetsRoutes from './public-user-assets.js';

const originalIsCloud = EnvSet.values.isCloud;
const originalIsSelfHostedParityEnabled = EnvSet.values.isSelfHostedParityEnabled;
const originalStorageProviderConfig = SystemContext.shared.storageProviderConfig;
const rootPath = await mkdtemp(path.join(os.tmpdir(), 'public-user-assets-'));

describe('public local user assets', () => {
  const tenant = new MockTenant();
  const objectKey = `${tenant.id}/m-default/2026/09/07/logo.png`;

  beforeAll(async () => {
    Reflect.set(EnvSet.values, 'isCloud', false);
    Reflect.set(EnvSet.values, 'isSelfHostedParityEnabled', true);
    Reflect.set(SystemContext.shared, 'storageProviderConfig', {
      provider: StorageProvider.LocalStorage,
      rootPath,
    });
    await buildLocalStorage(rootPath).uploadFile(Buffer.from('image-content'), objectKey);
  });

  afterAll(async () => {
    Reflect.set(EnvSet.values, 'isCloud', originalIsCloud);
    Reflect.set(EnvSet.values, 'isSelfHostedParityEnabled', originalIsSelfHostedParityEnabled);
    Reflect.set(SystemContext.shared, 'storageProviderConfig', originalStorageProviderConfig);
    await rm(rootPath, { recursive: true, force: true });
  });

  it('serves an uploaded asset from the current tenant', async () => {
    const requester = createRequester({
      anonymousRoutes: publicUserAssetsRoutes,
      tenantContext: tenant,
    });
    const response = await requester.get(`/user-assets/files/${objectKey}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['cache-control']).toBe('public, max-age=604800, immutable');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toEqual(Buffer.from('image-content'));
  });

  it('does not expose another tenant asset', async () => {
    const requester = createRequester({
      anonymousRoutes: publicUserAssetsRoutes,
      tenantContext: tenant,
    });
    const response = await requester.get('/user-assets/files/another-tenant/user/logo.png');

    expect(response.status).toBe(404);
  });

  it('returns not found for a missing asset', async () => {
    const requester = createRequester({
      anonymousRoutes: publicUserAssetsRoutes,
      tenantContext: tenant,
    });
    const response = await requester.get(`/user-assets/files/${tenant.id}/user/missing.png`);

    expect(response.status).toBe(404);
  });
});
