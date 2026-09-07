import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildLocalStorage } from './local-storage.js';

const withStorage = async (
  run: (storage: ReturnType<typeof buildLocalStorage>, rootPath: string) => Promise<void>
) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'logto-storage-'));
  try {
    await run(buildLocalStorage(rootPath), rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
};

describe('local object storage', () => {
  it('stores, reads, checks, and removes an object prefix', async () => {
    await withStorage(async (storage, rootPath) => {
      await storage.uploadFile(Buffer.from('hello'), 'tenant/assets/index.html');

      await expect(readFile(path.join(rootPath, 'tenant/assets/index.html'), 'utf8')).resolves.toBe(
        'hello'
      );
      await expect(storage.isFileExisted('tenant/assets/index.html')).resolves.toBe(true);
      await expect(storage.downloadFile('tenant/assets/index.html')).resolves.toEqual(
        Buffer.from('hello')
      );

      await storage.deleteFilesByPrefix('tenant/assets');
      await expect(storage.isFileExisted('tenant/assets/index.html')).resolves.toBe(false);
    });
  });

  it('returns an absolute, URL-encoded public URL when a public base is provided', async () => {
    await withStorage(async (storage) => {
      await expect(
        storage.uploadFile(Buffer.from('image'), 'default/user/company logo 中文.png', {
          publicUrl: 'https://identity.example.com/api/user-assets/files',
        })
      ).resolves.toEqual({
        url: 'https://identity.example.com/api/user-assets/files/default/user/company%20logo%20%E4%B8%AD%E6%96%87.png',
      });
    });
  });

  it.each(['../outside', '/absolute/path'])(
    'rejects object key %s outside the root',
    async (key) => {
      await withStorage(async (storage) => {
        await expect(storage.downloadFile(key)).rejects.toThrow();
      });
    }
  );
});
