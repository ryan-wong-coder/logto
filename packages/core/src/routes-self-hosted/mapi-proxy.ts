import {
  adminTenantId,
  getManagementApiResourceIndicator,
  getMapiProxyM2mApp,
  PredefinedScope,
  TenantScope,
} from '@logto/schemas';
import { appendPath } from '@silverhand/essentials';
import { got, type Method } from 'got';
import Koa from 'koa';
import Router from 'koa-router';
import { z } from 'zod';

import { EnvSet, getTenantEndpoint } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import type TenantContext from '#src/tenants/TenantContext.js';
import assertThat from '#src/utils/assert-that.js';

import { verifySelfHostedTenantUser } from './tenant-user-auth.js';

const tokenResponseGuard = z.object({ access_token: z.string(), expires_in: z.number() });
const methodGuard: z.ZodType<Method> = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const excludedResponseHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'transfer-encoding',
]);

export const shouldForwardProxyResponseHeader = (name: string) =>
  !excludedResponseHeaders.has(name.toLowerCase());

const getProxyAccessToken = async (tenant: TenantContext, tenantId: string) => {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const application = await tenant.queries.applications.findApplicationById(
    getMapiProxyM2mApp(tenantId).id
  );
  assertThat(application.secret, new RequestError({ code: 'auth.unauthorized', status: 401 }));
  const tokenEndpoint = appendPath(getTenantEndpoint(adminTenantId, EnvSet.values), '/oidc/token');
  const response = tokenResponseGuard.parse(
    await got
      .post(tokenEndpoint, {
        form: {
          grant_type: 'client_credentials',
          client_id: application.id,
          client_secret: application.secret,
          resource: getManagementApiResourceIndicator(tenantId),
          scope: PredefinedScope.All,
        },
      })
      .json()
  );
  tokenCache.set(tenantId, {
    token: response.access_token,
    expiresAt: Date.now() + response.expires_in * 1000,
  });
  return response.access_token;
};

export default function initSelfHostedMapiProxy(tenant: TenantContext): Koa {
  assertThat(tenant.id === adminTenantId, 'guard.not_allowed_for_admin_tenant');
  const router = new Router();

  router.all('/:tenantId/(.*)', async (ctx) => {
    assertThat(
      EnvSet.values.isSelfHostedParityEnabled,
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );
    const tenantId = z.string().parse(ctx.params.tenantId);
    const { scopes } = await verifySelfHostedTenantUser(tenant, ctx.request, tenantId);
    const requiredScope = ['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)
      ? TenantScope.ReadData
      : ctx.method === 'DELETE'
        ? TenantScope.DeleteData
        : TenantScope.WriteData;
    assertThat(
      scopes.includes(requiredScope),
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );

    const accessToken = await getProxyAccessToken(tenant, tenantId);
    const upstreamBase = getTenantEndpoint(tenantId, EnvSet.values);
    const upstreamPath = appendPath(upstreamBase, z.string().parse(ctx.params[0]));
    const upstreamUrl = new URL(`${upstreamPath.pathname}${ctx.URL.search}`, upstreamBase);
    const headers = { ...ctx.headers, host: undefined, authorization: `Bearer ${accessToken}` };
    const response = await got(upstreamUrl, {
      method: methodGuard.parse(ctx.method),
      headers,
      body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : ctx.req,
      followRedirect: false,
      throwHttpErrors: false,
    });

    ctx.status = response.statusCode;
    for (const [name, value] of Object.entries(response.headers)) {
      // `got` decompresses response bodies by default. Do not forward headers that describe the
      // upstream wire representation; Koa will calculate them for the decompressed body.
      if (value !== undefined && shouldForwardProxyResponseHeader(name)) {
        ctx.set(name, Array.isArray(value) ? value : String(value));
      }
    }
    ctx.body = response.rawBody;
  });

  const app = new Koa();
  app.use(router.routes()).use(router.allowedMethods());
  return app;
}
