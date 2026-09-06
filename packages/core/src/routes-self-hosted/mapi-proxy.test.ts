import { TenantScope, adminTenantId } from '@logto/schemas';
import Koa from 'koa';
import mount from 'koa-mount';
import request from 'supertest';

import { EnvSet } from '#src/env-set/index.js';
import type TenantContext from '#src/tenants/TenantContext.js';

const { jest } = import.meta;

const proxyResponse = {
  statusCode: 200,
  headers: {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'content-length': '22',
    connection: 'keep-alive',
  },
  rawBody: Buffer.from('[]'),
};
const gotPost = jest.fn(() => ({
  json: jest.fn(async () => ({ access_token: 'proxy-token', expires_in: 3600 })),
}));
const gotRequest = new Proxy(
  jest.fn(async () => proxyResponse),
  {
    get: (target, property, receiver) =>
      property === 'post' ? gotPost : Reflect.get(target, property, receiver),
  }
);

jest.unstable_mockModule('got', () => ({ got: gotRequest }));
jest.unstable_mockModule('#src/middleware/koa-auth/index.js', () => ({
  verifyBearerTokenFromRequest: jest.fn(async () => ({
    sub: 'user-id',
    clientId: undefined,
    scopes: [TenantScope.ReadData],
  })),
}));

const { default: initSelfHostedMapiProxy, shouldForwardProxyResponseHeader } = await import(
  './mapi-proxy.js'
);

const originalIsSelfHostedParityEnabled = EnvSet.values.isSelfHostedParityEnabled;

describe('self-hosted Management API proxy response headers', () => {
  beforeAll(() => {
    // eslint-disable-next-line @silverhand/fp/no-mutation -- The proxy only registers for explicitly enabled self-hosted parity.
    (EnvSet.values as { isSelfHostedParityEnabled: boolean }).isSelfHostedParityEnabled = true;
  });

  afterAll(() => {
    // eslint-disable-next-line @silverhand/fp/no-mutation -- Restore the shared environment after the route test.
    (EnvSet.values as { isSelfHostedParityEnabled: boolean }).isSelfHostedParityEnabled =
      originalIsSelfHostedParityEnabled;
  });

  it.each(['connection', 'content-encoding', 'content-length', 'transfer-encoding'])(
    'does not forward %s after the upstream response is decompressed',
    (name) => {
      expect(shouldForwardProxyResponseHeader(name)).toBe(false);
    }
  );

  it('matches excluded response headers case-insensitively', () => {
    expect(shouldForwardProxyResponseHeader('Content-Encoding')).toBe(false);
  });

  it('keeps end-to-end response headers', () => {
    expect(shouldForwardProxyResponseHeader('content-type')).toBe(true);
  });

  it('finishes matched proxy requests without falling through to the SPA', async () => {
    const app = new Koa();
    const tenant = {
      id: adminTenantId,
      envSet: {},
      queries: {
        applications: {
          findApplicationById: jest.fn(async () => ({ secret: 'proxy-secret' })),
        },
      },
    } as unknown as TenantContext;

    app.use(mount('/m', initSelfHostedMapiProxy(tenant)));
    app.use((ctx) => {
      ctx.type = 'text/html';
      ctx.body = '<!DOCTYPE html><html></html>';
    });

    const response = await request(app.callback())
      .get('/m/default/api/users')
      .set('Authorization', 'Bearer console-token');

    expect(response.status).toBe(200);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual([]);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-length']).toBe('2');
  });
});
