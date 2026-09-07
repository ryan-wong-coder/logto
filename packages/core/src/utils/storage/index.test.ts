import { StorageProvider, type StorageProviderData } from '@logto/schemas';

import { getUserAssetsPublicUrl } from './index.js';

describe('getUserAssetsPublicUrl', () => {
  const localStorageConfig: StorageProviderData = {
    provider: StorageProvider.LocalStorage,
    rootPath: '/var/lib/logto',
  };

  it('uses the tenant public asset route for local storage', () => {
    expect(
      getUserAssetsPublicUrl(localStorageConfig, new URL('https://identity.example.com/default'))
    ).toBe('https://identity.example.com/default/api/user-assets/files');
  });

  it('keeps an explicitly configured public URL', () => {
    expect(
      getUserAssetsPublicUrl(
        { ...localStorageConfig, publicUrl: 'https://assets.example.com' },
        new URL('https://identity.example.com')
      )
    ).toBe('https://assets.example.com');
  });

  it('lets remote storage providers build their native public URL', () => {
    expect(
      getUserAssetsPublicUrl(
        {
          provider: StorageProvider.AzureStorage,
          connectionString: 'connection-string',
          container: 'container',
        },
        new URL('https://identity.example.com')
      )
    ).toBeUndefined();
  });
});
