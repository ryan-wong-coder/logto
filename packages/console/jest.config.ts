import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      '@swc/jest',
      {
        sourceMaps: true,
        jsc: {
          transform: {
            react: {
              runtime: 'automatic',
            },
          },
        },
      },
    ],
    '\\.(svg)$': 'jest-transformer-svg',
    '\\.(png)$': 'jest-transform-stub',
  },
  moduleNameMapper: {
    '^@logto/core-kit/assets/(.*)\\.svg\\?url$': '<rootDir>/../toolkit/core-kit/assets/$1.svg',
    '^@/(.*)\\.svg\\?url$': '<rootDir>/src/$1.svg',
    '^@/(.*)\\.svg\\?react$': '<rootDir>/src/$1.svg',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@logto/shared/(.*)$': '<rootDir>/../shared/lib/$1',
    '\\.module\\.(css|sass|scss)$': 'identity-obj-proxy',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(.*(nanoid|jose|ky|@blobatar|blobatar|@logto|@silverhand))/)',
  ],
};

export default config;
