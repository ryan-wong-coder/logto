import fs from 'node:fs/promises';
import path from 'node:path';

import type { UploadFile } from './types.js';

const resolveLocalStoragePath = (rootPath: string, objectKey: string) => {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, objectKey);
  const relative = path.relative(root, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Storage object key escapes the configured root path.');
  }

  return target;
};

export const buildLocalStorage = (rootPath: string) => {
  const uploadFile: UploadFile = async (data, objectKey, { publicUrl } = {}) => {
    const target = resolveLocalStoragePath(rootPath, objectKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);

    const publicObjectPath = objectKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return { url: publicUrl ? `${publicUrl}/${publicObjectPath}` : `/${publicObjectPath}` };
  };

  const downloadFile = async (objectKey: string) =>
    fs.readFile(resolveLocalStoragePath(rootPath, objectKey));

  const isFileExisted = async (objectKey: string) => {
    try {
      const stats = await fs.stat(resolveLocalStoragePath(rootPath, objectKey));
      return stats.isFile();
    } catch (error: unknown) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  };

  const deleteFilesByPrefix = async (prefix: string) => {
    await fs.rm(resolveLocalStoragePath(rootPath, prefix), { recursive: true, force: true });
  };

  return { uploadFile, downloadFile, isFileExisted, deleteFilesByPrefix };
};
