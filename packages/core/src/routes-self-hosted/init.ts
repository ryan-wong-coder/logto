/* eslint-disable max-lines -- The isolated local control-plane module intentionally mirrors the existing Cloud-compatible route surface. */
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { provisionTenant } from '@logto/cli/lib/commands/database/seed/tenant.js';
import { replaceSendMessageHandlebars, sendMessageDataGuard } from '@logto/connector-kit';
import {
  adminTenantId,
  AdminTenantRole,
  ApplicationType,
  cloudApiIndicator,
  defaultTenantId,
  emailServiceConfigGuard,
  EmailServiceProviderKey,
  getManagementApiResourceIndicator,
  getTenantIdFromOrganizationId,
  getTenantOrganizationId,
  getTenantRole,
  mfaGuard,
  OneTimeTokenStatus,
  OrganizationInvitationStatus,
  platformBrandingConfigGuard,
  PlatformBrandingKey,
  ReservedPlanId,
  storageProviderDataGuard,
  StorageProviderKey,
  TenantRole,
  TenantScope,
  TenantTag,
  uploadFileGuard,
} from '@logto/schemas';
import { Tenants } from '@logto/schemas/models';
import { generateStandardId, generateStandardSecret } from '@logto/shared';
import { appendPath } from '@silverhand/essentials';
import { sql } from '@silverhand/slonik';
import { addDays } from 'date-fns';
import Koa, { type MiddlewareType } from 'koa';
import Router from 'koa-router';
import type { IRouterParamContext } from 'koa-router';
import { z } from 'zod';

import { EnvSet, getTenantEndpoint } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import type { WithAuthContext } from '#src/middleware/koa-auth/index.js';
import { verifyBearerTokenFromRequest } from '#src/middleware/koa-auth/index.js';
import koaBodyEtag from '#src/middleware/koa-body-etag.js';
import koaCors from '#src/middleware/koa-cors.js';
import koaGuard from '#src/middleware/koa-guard.js';
import { createSystemsQuery } from '#src/queries/system.js';
import {
  deleteOutboxMessage,
  getOutboxMessage,
  listOutboxMessages,
  sendSelfHostedEmail,
} from '#src/services/self-hosted-email.js';
import SystemContext from '#src/tenants/SystemContext.js';
import type TenantContext from '#src/tenants/TenantContext.js';
import { acquireTenant, invalidateTenant } from '#src/tenants/pool-access.js';
import assertThat from '#src/utils/assert-that.js';
import { convertToIdentifiers } from '#src/utils/sql.js';
import { buildObjectStorage } from '#src/utils/storage/object-storage.js';

import { getEffectivePlatformBranding } from '../routes/platform-branding.js';

import { maskedSecret, preserveEmailSecret, preserveStorageSecret } from './config.js';
import { selfHostedTenantOrganizationPath } from './route-path.js';
import { verifySelfHostedTenantUser } from './tenant-user-auth.js';

const { table: tenantsTable, fields: tenantFields } = convertToIdentifiers({
  table: Tenants.tableName,
  fields: Tenants.rawKeys,
});
const invitationLifetimeDays = 7;

type TenantRow = Record<string, unknown> & {
  id: string;
  name: string;
  tag: TenantTag;
};

const tenantResponse = (tenant: Record<string, unknown>) => ({
  ...tenant,
  indicator: getManagementApiResourceIndicator(String(tenant.id)),
  planId: ReservedPlanId.Development,
  regionName: 'self-hosted',
  subscription: {
    status: 'active',
    planId: ReservedPlanId.Development,
    quotaScope: 'dedicated',
    isEnterprisePlan: false,
    currentPeriodStart: new Date(0),
    currentPeriodEnd: new Date(8_640_000_000_000_000),
  },
  quota: { mauLimit: null, tokenLimit: null },
  usage: { activeUsers: 0, tokenUsage: 0, userTokenUsage: 0, m2mTokenUsage: 0 },
  openInvoices: [],
});

const assertParityEnabled = () => {
  assertThat(
    EnvSet.values.isSelfHostedParityEnabled,
    new RequestError({ code: 'auth.forbidden', status: 403 })
  );
};

const buildUserAuth = <ContextT extends IRouterParamContext = IRouterParamContext>(
  tenant: TenantContext,
  audience: string | ((id: string) => string)
) => {
  const authMiddleware: MiddlewareType<unknown, WithAuthContext<ContextT>> = async (ctx, next) => {
    assertParityEnabled();
    const resolvedAudience =
      typeof audience === 'string' ? audience : audience(z.string().parse(ctx.params.tenantId));
    const { sub, clientId, scopes } = await verifyBearerTokenFromRequest(
      tenant.envSet,
      ctx.request,
      resolvedAudience
    );
    assertThat(sub !== clientId, new RequestError({ code: 'auth.forbidden', status: 403 }));
    ctx.auth = { type: 'user', id: sub, scopes: new Set(scopes) };
    return next();
  };

  return authMiddleware;
};

const assertScope = (scopes: ReadonlySet<string>, scope: TenantScope) => {
  assertThat(scopes.has(scope), new RequestError({ code: 'auth.forbidden', status: 403 }));
};

const isInternalServiceRequest = (value: string | string[] | undefined) => {
  if (typeof value !== 'string') {
    return false;
  }

  const expected = EnvSet.values.selfHostedServiceToken;
  return (
    value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
};

const isProtectedAppGatewayRequest = (value: string | string[] | undefined) => {
  const expected = EnvSet.values.protectedAppGatewaySharedSecret;
  if (!expected || typeof value !== 'string') {
    return false;
  }

  return (
    value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
};

export default function initSelfHostedControlApi(tenant: TenantContext): Koa {
  assertThat(tenant.id === adminTenantId, 'guard.not_allowed_for_admin_tenant');

  const cloudRouter = new Router<unknown, WithAuthContext>();
  const organizationRouter = new Router<unknown, WithAuthContext>();
  const anonymousRouter = new Router();
  cloudRouter.use(buildUserAuth(tenant, cloudApiIndicator));
  const { organizations, users, oneTimeTokens } = tenant.queries;
  const { organizationInvitations } = tenant.libraries;

  const isPlatformAdministrator = async (userId: string) => {
    const role = await tenant.queries.roles.findRoleByRoleName(
      AdminTenantRole.PlatformAdministrator
    );
    return Boolean(role && (await tenant.queries.usersRoles.hasUserRole(userId, [role.id])));
  };

  const assertPlatformAdministrator = async (userId: string) => {
    assertThat(
      await isPlatformAdministrator(userId),
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );
  };

  const tenantUserAuth: MiddlewareType<unknown, WithAuthContext> = async (ctx, next) => {
    assertParityEnabled();
    const tenantId = z.string().parse(ctx.params.tenantId);
    const tokenInfo = await verifySelfHostedTenantUser(tenant, ctx.request, tenantId);

    assertThat(
      tokenInfo.sub !== tokenInfo.clientId,
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );
    ctx.auth = { type: 'user', id: tokenInfo.sub, scopes: new Set(tokenInfo.scopes) };
    return next();
  };

  organizationRouter.use(selfHostedTenantOrganizationPath, tenantUserAuth);

  const assertUserTenantScope = async (userId: string, tenantId: string, scope: TenantScope) => {
    const scopes = await organizations.relations.usersRoles.getUserScopes(
      getTenantOrganizationId(tenantId),
      userId
    );
    assertThat(
      scopes.some(({ name }) => name === scope),
      new RequestError({ code: 'auth.forbidden', status: 403 })
    );
  };

  const getVisibleTenants = async (userId: string) => {
    const isPlatformAdmin = await isPlatformAdministrator(userId);
    const userOrganizations = await organizations.relations.users.getOrganizationsByUserId(userId);
    const organizationIds = userOrganizations
      .map(({ id }) => id)
      .filter((id) => id.startsWith('t-'));
    const tenantIds = organizationIds.map((id) => getTenantIdFromOrganizationId(id));

    if (!isPlatformAdmin && tenantIds.length === 0) {
      return [];
    }

    const pool = await EnvSet.sharedPool;
    const rows = await pool.any<Record<string, unknown>>(sql`
      select ${sql.join(Object.values(tenantFields), sql`, `)}
      from ${tenantsTable}
      where ${
        isPlatformAdmin
          ? sql`${tenantFields.deletedAt} is null`
          : sql`${tenantFields.id} = any(${sql.array(tenantIds, 'varchar')})
              and ${tenantFields.deletedAt} is null`
      }
      order by ${tenantFields.createdAt} desc
    `);

    return rows.map((row) => tenantResponse(row));
  };

  const getTenantById = async (tenantId: string) => {
    const pool = await EnvSet.sharedPool;
    return pool.maybeOne<TenantRow>(sql`
      select ${sql.join(Object.values(tenantFields), sql`, `)}
      from ${tenantsTable}
      where ${tenantFields.id} = ${tenantId} and ${tenantFields.deletedAt} is null
    `);
  };

  const mailRequestGuard = z.object({
    data: sendMessageDataGuard,
  });

  const assertPlatformOrTenantScope = async (
    userId: string,
    tenantId: string,
    scope: TenantScope
  ) => {
    if (await isPlatformAdministrator(userId)) {
      return;
    }
    await assertUserTenantScope(userId, tenantId, scope);
  };

  const platformUserResponse = ({
    id,
    username,
    primaryEmail,
    name,
    avatar,
  }: Awaited<ReturnType<typeof tenant.libraries.users.findUsersByRoleName>>[number]) => ({
    id,
    username,
    primaryEmail,
    name,
    avatar,
  });

  const safePlatformSvgPattern =
    /<(?:script|foreignobject)\b|\bon\w+\s*=|javascript:|data:text\/html/i;
  const validatePlatformLogo = (data: Uint8Array, mimetype: string) => {
    if (mimetype === 'image/png') {
      assertThat(
        Buffer.from(data.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
        'guard.invalid_input'
      );
      return 'png';
    }
    if (mimetype === 'image/jpeg') {
      assertThat(data[0] === 0xff && data[1] === 0xd8, 'guard.invalid_input');
      return 'jpg';
    }
    assertThat(mimetype === 'image/svg+xml', 'guard.mime_type_not_allowed');
    const source = Buffer.from(data).toString('utf8');
    assertThat(
      /<svg\b/i.test(source) && !safePlatformSvgPattern.test(source),
      'guard.invalid_input'
    );
    return 'svg';
  };

  anonymousRouter.post(
    '/services/mails',
    koaGuard({ body: mailRequestGuard, status: [204, 401, 501] }),
    async (ctx, next) => {
      assertThat(
        isInternalServiceRequest(ctx.get('x-logto-internal-token')),
        new RequestError({ code: 'auth.unauthorized', status: 401 })
      );
      const sourceTenantId = ctx.get('x-logto-tenant-id');
      assertThat(sourceTenantId, new RequestError({ code: 'auth.unauthorized', status: 401 }));
      const sourceTenant = await acquireTenant(sourceTenantId);

      try {
        const { to, type, payload } = ctx.guard.body.data;
        const template = await sourceTenant.connectors.getI18nEmailTemplate(
          type,
          typeof payload.locale === 'string' ? payload.locale : undefined
        );
        assertThat(
          template,
          new RequestError({ code: 'connector.template_not_found', status: 501 })
        );
        const config = SystemContext.shared.emailServiceProviderConfig;
        assertThat(config, new RequestError({ code: 'connector.not_found', status: 501 }));
        await sendSelfHostedEmail(config, {
          to,
          subject: replaceSendMessageHandlebars(template.subject, payload),
          content: replaceSendMessageHandlebars(template.content, payload),
          contentType: template.contentType ?? 'text/html',
          replyTo: template.replyTo
            ? replaceSendMessageHandlebars(template.replyTo, payload)
            : undefined,
          sendFrom: template.sendFrom
            ? replaceSendMessageHandlebars(template.sendFrom, payload)
            : undefined,
        });
      } finally {
        sourceTenant.requestEnd();
      }

      ctx.status = 204;
      return next();
    }
  );

  anonymousRouter.get('/services/mails/usage', async (ctx, next) => {
    assertThat(
      isInternalServiceRequest(ctx.get('x-logto-internal-token')),
      new RequestError({ code: 'auth.unauthorized', status: 401 })
    );
    const messages = await listOutboxMessages();
    ctx.body = { count: messages.length };
    return next();
  });

  anonymousRouter.get(
    '/internal/protected-app/config',
    koaGuard({ query: z.object({ host: z.string().min(1) }) }),
    async (ctx, next) => {
      assertThat(
        isProtectedAppGatewayRequest(ctx.get('x-logto-protected-app-key')),
        new RequestError({ code: 'auth.unauthorized', status: 401 })
      );
      const { host } = ctx.guard.query;
      const pool = await EnvSet.sharedPool;
      const located = await pool.maybeOne<{
        id: string;
        tenantId: string;
      }>(sql`
        select applications.id, applications.tenant_id as "tenantId"
        from applications
        join tenants on tenants.id = applications.tenant_id
        where applications.type = ${ApplicationType.Protected}
          and tenants.deleted_at is null
          and tenants.is_suspended = false
          and (
            applications.protected_app_metadata->>'host' = ${host}
            or exists (
              select 1
              from jsonb_array_elements(
                coalesce(applications.protected_app_metadata->'customDomains', '[]'::jsonb)
              ) as custom_domain
              where custom_domain->>'domain' = ${host}
            )
          )
        limit 1
      `);
      assertThat(located, new RequestError({ code: 'entity.not_found', id: host, status: 404 }));
      const sourceTenant = await acquireTenant(located.tenantId);
      try {
        const application = await sourceTenant.queries.applications.findApplicationById(located.id);
        const secret =
          await sourceTenant.queries.applicationSecrets.findActiveSecretByApplicationId(located.id);
        assertThat(
          application.protectedAppMetadata,
          new RequestError({ code: 'application.protected_app_not_configured', status: 501 })
        );
        const { customDomains: _customDomains, ...metadata } = application.protectedAppMetadata;
        ctx.body = {
          ...metadata,
          host,
          sdkConfig: {
            appId: application.id,
            appSecret: secret.value,
            endpoint: getTenantEndpoint(located.tenantId, EnvSet.values).origin,
          },
        };
      } finally {
        sourceTenant.requestEnd();
      }
      return next();
    }
  );

  cloudRouter.get('/instance/platform-access', async (ctx, next) => {
    ctx.body = { isPlatformAdministrator: await isPlatformAdministrator(ctx.auth.id) };
    return next();
  });

  cloudRouter.get('/instance/branding', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    ctx.body = getEffectivePlatformBranding();
    return next();
  });

  cloudRouter.put(
    '/instance/branding',
    koaGuard({ body: platformBrandingConfigGuard }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const { upsertSystemByKey } = createSystemsQuery(await EnvSet.sharedPool);
      await upsertSystemByKey(PlatformBrandingKey.PlatformBranding, ctx.guard.body);
      // eslint-disable-next-line @silverhand/fp/no-mutation -- Synchronize the process cache after an authorized platform update.
      SystemContext.shared.platformBrandingConfig = ctx.guard.body;
      ctx.body = getEffectivePlatformBranding();
      return next();
    }
  );

  cloudRouter.post(
    '/instance/branding/logo/:variant',
    koaGuard({
      params: z.object({ variant: z.enum(['light', 'dark']) }),
      files: z.object({ file: uploadFileGuard.array().min(1).max(1) }),
    }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const [file] = ctx.guard.files.file;
      assertThat(file, 'guard.invalid_input');
      assertThat(file.size <= 2 * 1024 * 1024, 'guard.file_size_exceeded');
      const data = await readFile(file.filepath);
      const extension = validatePlatformLogo(data, file.mimetype);
      const assetName = `${ctx.guard.params.variant}-${generateStandardId(12)}.${extension}`;
      const { storageProviderConfig } = SystemContext.shared;
      assertThat(storageProviderConfig, 'storage.not_configured');
      await buildObjectStorage(storageProviderConfig).uploadFile(
        data,
        `platform-branding/${assetName}`,
        { contentType: file.mimetype }
      );
      const url = `/api/platform-assets/${assetName}`;
      const current = getEffectivePlatformBranding();
      const config = platformBrandingConfigGuard.parse({
        ...current,
        [ctx.guard.params.variant === 'light' ? 'logoUrl' : 'darkLogoUrl']: url,
      });
      const { upsertSystemByKey } = createSystemsQuery(await EnvSet.sharedPool);
      await upsertSystemByKey(PlatformBrandingKey.PlatformBranding, config);
      // eslint-disable-next-line @silverhand/fp/no-mutation -- Synchronize the process cache after an authorized logo upload.
      SystemContext.shared.platformBrandingConfig = config;
      ctx.body = { url, branding: config };
      return next();
    }
  );

  cloudRouter.get('/instance/platform-administrators', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    const administrators = await tenant.libraries.users.findUsersByRoleName(
      AdminTenantRole.PlatformAdministrator
    );
    ctx.body = administrators.map((administrator) => platformUserResponse(administrator));
    return next();
  });

  cloudRouter.post(
    '/instance/platform-administrators',
    koaGuard({ body: z.object({ identifier: z.string().trim().min(1).max(256) }) }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const { identifier } = ctx.guard.body;
      const [byId] = await users.findUsersByIds([identifier]);
      const user =
        byId ??
        (identifier.includes('@')
          ? await users.findUserByEmail(identifier)
          : await users.findUserByUsername(identifier, false));
      assertThat(user, new RequestError({ code: 'entity.not_found', id: identifier, status: 404 }));
      const role = await tenant.queries.roles.findRoleByRoleName(
        AdminTenantRole.PlatformAdministrator
      );
      assertThat(role, new RequestError({ code: 'entity.not_found', status: 404 }));
      if (!(await tenant.queries.usersRoles.hasUserRole(user.id, [role.id]))) {
        await tenant.queries.usersRoles.insertUsersRoles([
          { id: generateStandardId(), userId: user.id, roleId: role.id },
        ]);
      }
      ctx.status = 201;
      ctx.body = platformUserResponse(user);
      return next();
    }
  );

  cloudRouter.delete(
    '/instance/platform-administrators/:userId',
    koaGuard({ params: z.object({ userId: z.string() }), status: [204, 400, 403] }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const role = await tenant.queries.roles.findRoleByRoleName(
        AdminTenantRole.PlatformAdministrator
      );
      assertThat(role, new RequestError({ code: 'entity.not_found', status: 404 }));
      const { count } = await tenant.queries.usersRoles.countUsersRolesByRoleId(role.id);
      assertThat(Number(count) > 1, new RequestError({ code: 'guard.invalid_input', status: 400 }));
      await tenant.queries.usersRoles.deleteUsersRolesByUserIdAndRoleId(
        ctx.guard.params.userId,
        role.id
      );
      ctx.status = 204;
      return next();
    }
  );

  cloudRouter.get('/instance/email', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    const config = SystemContext.shared.emailServiceProviderConfig;
    ctx.body =
      config?.provider === 'Smtp'
        ? { ...config, password: config.password ? maskedSecret : undefined }
        : config?.provider === 'SendGrid' || config?.provider === 'Cloudflare'
          ? { ...config, apiKey: maskedSecret }
          : config;
    return next();
  });

  cloudRouter.put(
    '/instance/email',
    koaGuard({ body: emailServiceConfigGuard }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const config = preserveEmailSecret(
        ctx.guard.body,
        SystemContext.shared.emailServiceProviderConfig
      );
      const { upsertSystemByKey } = createSystemsQuery(await EnvSet.sharedPool);
      await upsertSystemByKey(EmailServiceProviderKey.EmailServiceProvider, config);
      // eslint-disable-next-line @silverhand/fp/no-mutation -- Keep the process-level provider cache synchronized after an administrator update.
      SystemContext.shared.emailServiceProviderConfig = config;
      ctx.body = { provider: config.provider };
      return next();
    }
  );

  cloudRouter.get('/instance/mfa', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    const [organization, signInExperience] = await Promise.all([
      organizations.findById(getTenantOrganizationId(defaultTenantId)),
      tenant.queries.signInExperiences.findDefaultSignInExperience(),
    ]);
    ctx.body = { isMfaRequired: organization.isMfaRequired, mfa: signInExperience.mfa };
    return next();
  });

  cloudRouter.put(
    '/instance/mfa',
    koaGuard({ body: z.object({ isMfaRequired: z.boolean(), mfa: mfaGuard.optional() }) }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const { isMfaRequired, mfa } = ctx.guard.body;
      const [organization, signInExperience] = await Promise.all([
        organizations.updateById(getTenantOrganizationId(defaultTenantId), { isMfaRequired }),
        mfa
          ? tenant.queries.signInExperiences.updateDefaultSignInExperience({ mfa })
          : tenant.queries.signInExperiences.findDefaultSignInExperience(),
      ]);
      ctx.body = { isMfaRequired: organization.isMfaRequired, mfa: signInExperience.mfa };
      return next();
    }
  );

  cloudRouter.get('/instance/storage', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    const mask = (config: typeof SystemContext.shared.experienceBlobsProviderConfig) =>
      config?.provider === 'S3Storage'
        ? { ...config, accessSecretKey: maskedSecret }
        : config?.provider === 'AzureStorage'
          ? { ...config, connectionString: maskedSecret }
          : config;
    ctx.body = {
      experienceBlobsProvider: mask(SystemContext.shared.experienceBlobsProviderConfig),
      experienceZipsProvider: mask(SystemContext.shared.experienceZipsProviderConfig),
    };
    return next();
  });

  cloudRouter.put(
    '/instance/storage',
    koaGuard({
      body: z.object({
        experienceBlobsProvider: storageProviderDataGuard,
        experienceZipsProvider: storageProviderDataGuard,
      }),
    }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const experienceBlobsProvider = preserveStorageSecret(
        ctx.guard.body.experienceBlobsProvider,
        SystemContext.shared.experienceBlobsProviderConfig
      );
      const experienceZipsProvider = preserveStorageSecret(
        ctx.guard.body.experienceZipsProvider,
        SystemContext.shared.experienceZipsProviderConfig
      );
      const { upsertSystemByKey } = createSystemsQuery(await EnvSet.sharedPool);
      await Promise.all([
        upsertSystemByKey(StorageProviderKey.ExperienceBlobsProvider, experienceBlobsProvider),
        upsertSystemByKey(StorageProviderKey.ExperienceZipsProvider, experienceZipsProvider),
      ]);
      // eslint-disable-next-line @silverhand/fp/no-mutation -- Keep the process-level provider cache synchronized after an administrator update.
      SystemContext.shared.experienceBlobsProviderConfig = experienceBlobsProvider;
      // eslint-disable-next-line @silverhand/fp/no-mutation -- Keep the process-level provider cache synchronized after an administrator update.
      SystemContext.shared.experienceZipsProviderConfig = experienceZipsProvider;
      ctx.body = { updated: true };
      return next();
    }
  );

  cloudRouter.get('/instance/gateway', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    ctx.body = {
      domain: EnvSet.values.protectedAppGatewayDomain,
      configured: Boolean(EnvSet.values.protectedAppGatewaySharedSecret),
    };
    return next();
  });

  cloudRouter.post(
    '/instance/email/test',
    koaGuard({ body: z.object({ to: z.string().email() }) }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const config = SystemContext.shared.emailServiceProviderConfig;
      assertThat(config, new RequestError({ code: 'connector.not_found', status: 501 }));
      ctx.body = await sendSelfHostedEmail(config, {
        to: ctx.guard.body.to,
        subject: 'Self-hosted email test',
        content: 'Your self-hosted email service is configured correctly.',
        contentType: 'text/plain',
      });
      return next();
    }
  );

  cloudRouter.get('/instance/email/outbox', async (ctx, next) => {
    await assertPlatformAdministrator(ctx.auth.id);
    const messages = await listOutboxMessages();
    ctx.body = messages.map(({ content: _content, ...message }) => message);
    return next();
  });

  cloudRouter.get(
    '/instance/email/outbox/:messageId',
    koaGuard({ params: z.object({ messageId: z.string() }) }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      ctx.body = await getOutboxMessage(ctx.guard.params.messageId);
      return next();
    }
  );

  cloudRouter.delete(
    '/instance/email/outbox/:messageId',
    koaGuard({ params: z.object({ messageId: z.string() }), status: [204] }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      await deleteOutboxMessage(ctx.guard.params.messageId);
      ctx.status = 204;
      return next();
    }
  );

  cloudRouter.get('/tenants', async (ctx, next) => {
    ctx.body = await getVisibleTenants(ctx.auth.id);
    return next();
  });

  cloudRouter.get(
    '/tenants/:tenantId',
    koaGuard({ params: z.object({ tenantId: z.string() }) }),
    async (ctx, next) => {
      const { tenantId } = ctx.guard.params;
      await assertPlatformOrTenantScope(ctx.auth.id, tenantId, TenantScope.ReadData);
      const targetTenant = await getTenantById(tenantId);
      assertThat(
        targetTenant,
        new RequestError({
          code: 'entity.not_exists_with_id',
          name: Tenants.tableName,
          id: tenantId,
          status: 404,
        })
      );
      ctx.body = tenantResponse(targetTenant);
      return next();
    }
  );

  cloudRouter.post(
    '/tenants',
    koaGuard({
      body: z.object({
        id: z
          .string()
          .regex(/^[a-z][\da-z-]{2,20}$/)
          .optional(),
        name: z.string().trim().min(1).max(128),
        tag: z.nativeEnum(TenantTag).default(TenantTag.Development),
      }),
      status: [201, 400, 403, 409],
    }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const id = ctx.guard.body.id ?? `t-${generateStandardId(6)}`;
      assertThat(![defaultTenantId, adminTenantId].includes(id), 'guard.invalid_input');
      const pool = await EnvSet.sharedPool;

      await pool.transaction(async (connection) =>
        provisionTenant(connection, { ...ctx.guard.body, id, creatorUserId: ctx.auth.id })
      );
      invalidateTenant(id);

      const created = await getTenantById(id);
      assertThat(
        created,
        new RequestError({
          code: 'entity.not_exists_with_id',
          name: Tenants.tableName,
          id,
          status: 404,
        })
      );
      ctx.status = 201;
      ctx.body = tenantResponse(created);
      return next();
    }
  );

  cloudRouter.patch(
    '/tenants/:tenantId',
    koaGuard({
      params: z.object({ tenantId: z.string() }),
      body: z
        .object({ name: z.string().trim().min(1).max(128), tag: z.nativeEnum(TenantTag) })
        .partial(),
    }),
    async (ctx, next) => {
      const { tenantId } = ctx.guard.params;
      await assertPlatformOrTenantScope(ctx.auth.id, tenantId, TenantScope.ManageTenant);
      const entries = Object.entries(ctx.guard.body);
      assertThat(entries.length > 0, 'guard.invalid_input');
      const pool = await EnvSet.sharedPool;
      const updated = await pool.one<Record<string, unknown>>(sql`
        update ${tenantsTable}
        set ${sql.join(
          entries.map(
            ([key, value]) =>
              sql`${key === 'name' ? tenantFields.name : tenantFields.tag} = ${value}`
          ),
          sql`, `
        )}
        where ${tenantFields.id} = ${tenantId} and ${tenantFields.deletedAt} is null
        returning ${sql.join(Object.values(tenantFields), sql`, `)}
      `);
      if (ctx.guard.body.name) {
        await organizations.updateById(getTenantOrganizationId(tenantId), {
          name: ctx.guard.body.name,
        });
      }
      ctx.body = tenantResponse(updated);
      return next();
    }
  );

  cloudRouter.delete(
    '/tenants/:tenantId',
    koaGuard({ params: z.object({ tenantId: z.string() }), status: [204, 400, 403] }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const { tenantId } = ctx.guard.params;
      assertThat(![defaultTenantId, adminTenantId].includes(tenantId), 'guard.invalid_input');
      const pool = await EnvSet.sharedPool;
      await pool.query(sql`
        update ${tenantsTable}
        set ${tenantFields.deletedAt} = now(), ${tenantFields.isSuspended} = true
        where ${tenantFields.id} = ${tenantId} and ${tenantFields.deletedAt} is null
      `);
      invalidateTenant(tenantId);
      ctx.status = 204;
      return next();
    }
  );

  cloudRouter.post(
    '/tenants/:tenantId/restore',
    koaGuard({ params: z.object({ tenantId: z.string() }) }),
    async (ctx, next) => {
      await assertPlatformAdministrator(ctx.auth.id);
      const { tenantId } = ctx.guard.params;
      const pool = await EnvSet.sharedPool;
      const restored = await pool.maybeOne<Record<string, unknown>>(sql`
        update ${tenantsTable}
        set ${tenantFields.deletedAt} = null, ${tenantFields.isSuspended} = false
        where ${tenantFields.id} = ${tenantId}
          and ${tenantFields.deletedAt} > now() - interval '30 days'
        returning ${sql.join(Object.values(tenantFields), sql`, `)}
      `);
      assertThat(
        restored,
        new RequestError({
          code: 'entity.not_exists_with_id',
          name: Tenants.tableName,
          id: tenantId,
          status: 404,
        })
      );
      invalidateTenant(tenantId);
      ctx.body = tenantResponse(restored);
      return next();
    }
  );

  organizationRouter.get(
    '/tenants/:tenantId/settings',
    koaGuard({ params: z.object({ tenantId: z.string() }) }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.ManageTenant);
      const organization = await organizations.findById(
        getTenantOrganizationId(ctx.guard.params.tenantId)
      );
      ctx.body = { isMfaRequired: organization.isMfaRequired };
      return next();
    }
  );

  organizationRouter.patch(
    '/tenants/:tenantId/settings',
    koaGuard({
      params: z.object({ tenantId: z.string() }),
      body: z.object({ isMfaRequired: z.boolean() }),
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.ManageTenant);
      const organization = await organizations.updateById(
        getTenantOrganizationId(ctx.guard.params.tenantId),
        ctx.guard.body
      );
      ctx.body = { isMfaRequired: organization.isMfaRequired };
      return next();
    }
  );

  organizationRouter.get(
    '/tenants/:tenantId/members',
    koaGuard({ params: z.object({ tenantId: z.string() }) }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.ReadMember);
      const [, members] = await organizations.relations.users.getUsersByOrganizationId(
        getTenantOrganizationId(ctx.guard.params.tenantId),
        { limit: 100, offset: 0 }
      );
      ctx.body = members;
      return next();
    }
  );

  organizationRouter.get(
    '/tenants/:tenantId/members/:userId/scopes',
    koaGuard({ params: z.object({ tenantId: z.string(), userId: z.string() }) }),
    async (ctx, next) => {
      assertThat(
        ctx.auth.id === ctx.guard.params.userId || ctx.auth.scopes.has(TenantScope.ReadMember),
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      ctx.body = await organizations.relations.usersRoles.getUserScopes(
        getTenantOrganizationId(ctx.guard.params.tenantId),
        ctx.guard.params.userId
      );
      return next();
    }
  );

  organizationRouter.put(
    '/tenants/:tenantId/members/:userId/roles',
    koaGuard({
      params: z.object({ tenantId: z.string(), userId: z.string() }),
      body: z.object({ roleName: z.nativeEnum(TenantRole) }),
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.UpdateMemberRole);
      const { tenantId, userId } = ctx.guard.params;
      await organizations.relations.usersRoles.replace(getTenantOrganizationId(tenantId), userId, [
        getTenantRole(ctx.guard.body.roleName).id,
      ]);
      ctx.status = 204;
      return next();
    }
  );

  organizationRouter.delete(
    '/tenants/:tenantId/members/:userId',
    koaGuard({
      params: z.object({ tenantId: z.string(), userId: z.string() }),
      status: [204, 403],
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.RemoveMember);
      assertThat(
        ctx.auth.id !== ctx.guard.params.userId,
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      await organizations.relations.users.delete({
        organizationId: getTenantOrganizationId(ctx.guard.params.tenantId),
        userId: ctx.guard.params.userId,
      });
      ctx.status = 204;
      return next();
    }
  );

  organizationRouter.get(
    '/tenants/:tenantId/invitations',
    koaGuard({ params: z.object({ tenantId: z.string() }) }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.ReadMember);
      ctx.body = await organizations.invitations.findEntities({
        organizationId: getTenantOrganizationId(ctx.guard.params.tenantId),
      });
      return next();
    }
  );

  const sendInvitationEmail = async (
    invitation: Awaited<ReturnType<typeof organizationInvitations.insert>>
  ) => {
    const { id: invitationId, invitee, inviterId, organizationId } = invitation;
    const token = generateStandardSecret();
    await oneTimeTokens.insertOneTimeToken({
      id: generateStandardId(),
      token,
      email: invitee,
      status: OneTimeTokenStatus.Active,
      expiresAt: addDays(new Date(), invitationLifetimeDays).getTime(),
      context: { invitationId },
    });
    const consoleEndpoint = appendPath(
      EnvSet.values.adminUrlSet.deduplicated()[0] ??
        getTenantEndpoint(adminTenantId, EnvSet.values),
      '/console'
    );
    const acceptUrl = appendPath(consoleEndpoint, `/accept/${invitationId}`);
    acceptUrl.searchParams.set('one_time_token', token);
    const landingUrl = appendPath(consoleEndpoint, '/one-time-token');
    landingUrl.searchParams.set('one_time_token', token);
    landingUrl.searchParams.set('email', invitee);
    landingUrl.searchParams.set('redirect', acceptUrl.href);
    const templateContext = await organizationInvitations.getOrganizationInvitationTemplateContext(
      organizationId,
      inviterId
    );
    await organizationInvitations.sendEmail(invitee, {
      ...templateContext,
      link: landingUrl.href,
    });
  };

  const createInvitation = async (
    tenantId: string,
    inviterId: string,
    invitee: string,
    roleName: TenantRole
  ) => {
    const invitation = await organizationInvitations.insert(
      {
        inviterId,
        invitee,
        organizationId: getTenantOrganizationId(tenantId),
        organizationRoleIds: [getTenantRole(roleName).id],
        expiresAt: addDays(new Date(), invitationLifetimeDays).getTime(),
      },
      false
    );
    await sendInvitationEmail(invitation);
    return invitation;
  };

  const findInvitationForTenant = async (tenantId: string, invitationId: string) => {
    const invitation = await organizations.invitations.findById(invitationId);
    assertThat(
      invitation.organizationId === getTenantOrganizationId(tenantId),
      new RequestError({ code: 'entity.not_found', id: invitationId, status: 404 })
    );
    return invitation;
  };

  organizationRouter.post(
    '/tenants/:tenantId/invitations',
    koaGuard({
      params: z.object({ tenantId: z.string() }),
      body: z.object({ invitee: z.string().email().array(), roleName: z.nativeEnum(TenantRole) }),
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.InviteMember);
      ctx.body = await Promise.all(
        ctx.guard.body.invitee.map(async (email) =>
          createInvitation(ctx.guard.params.tenantId, ctx.auth.id, email, ctx.guard.body.roleName)
        )
      );
      ctx.status = 201;
      return next();
    }
  );

  organizationRouter.patch(
    '/tenants/:tenantId/invitations/:invitationId/status',
    koaGuard({
      params: z.object({ tenantId: z.string(), invitationId: z.string() }),
      body: z.object({ status: z.literal(OrganizationInvitationStatus.Revoked) }),
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.RemoveMember);
      await findInvitationForTenant(ctx.guard.params.tenantId, ctx.guard.params.invitationId);
      ctx.body = await organizationInvitations.updateStatus(
        ctx.guard.params.invitationId,
        OrganizationInvitationStatus.Revoked
      );
      return next();
    }
  );

  organizationRouter.post(
    '/tenants/:tenantId/invitations/:invitationId/message',
    koaGuard({
      params: z.object({ tenantId: z.string(), invitationId: z.string() }),
      status: [204],
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.InviteMember);
      const invitation = await findInvitationForTenant(
        ctx.guard.params.tenantId,
        ctx.guard.params.invitationId
      );
      assertThat(
        invitation.status === OrganizationInvitationStatus.Pending,
        new RequestError({ code: 'request.invalid_input', status: 422 })
      );
      await sendInvitationEmail(invitation);
      ctx.status = 204;
      return next();
    }
  );

  organizationRouter.delete(
    '/tenants/:tenantId/invitations/:invitationId',
    koaGuard({
      params: z.object({ tenantId: z.string(), invitationId: z.string() }),
      status: [204],
    }),
    async (ctx, next) => {
      assertScope(ctx.auth.scopes, TenantScope.RemoveMember);
      await findInvitationForTenant(ctx.guard.params.tenantId, ctx.guard.params.invitationId);
      await organizations.invitations.deleteById(ctx.guard.params.invitationId);
      ctx.status = 204;
      return next();
    }
  );

  cloudRouter.get('/invitations', async (ctx, next) => {
    const user = await users.findUserById(ctx.auth.id);
    const invitations = user.primaryEmail
      ? await organizations.invitations.findEntities({ invitee: user.primaryEmail })
      : [];

    ctx.body = await Promise.all(
      invitations.map(async (invitation) => {
        const tenantId = getTenantIdFromOrganizationId(invitation.organizationId);
        const targetTenant = await getTenantById(tenantId);

        return {
          ...invitation,
          tenantName: targetTenant?.name ?? tenantId,
          tenantTag: targetTenant?.tag ?? TenantTag.Development,
        };
      })
    );
    return next();
  });

  anonymousRouter.post(
    '/invitations/:invitationId/auth',
    koaGuard({
      params: z.object({ invitationId: z.string() }),
      query: z.object({ one_time_token: z.string().min(1) }),
    }),
    async (ctx) => {
      assertParityEnabled();
      const { invitationId } = ctx.guard.params;
      const tokenRecord = await oneTimeTokens.getOneTimeTokenByToken(
        ctx.guard.query.one_time_token
      );
      assertThat(
        tokenRecord.context.invitationId === invitationId &&
          tokenRecord.status === OneTimeTokenStatus.Active &&
          tokenRecord.expiresAt > Date.now(),
        new RequestError({ code: 'one_time_token.token_expired', status: 401 })
      );
      const consoleEndpoint = appendPath(
        EnvSet.values.adminUrlSet.deduplicated()[0] ??
          getTenantEndpoint(adminTenantId, EnvSet.values),
        '/console'
      );
      const landingUrl = appendPath(consoleEndpoint, '/one-time-token');
      const acceptUrl = appendPath(consoleEndpoint, `/accept/${invitationId}`);
      landingUrl.searchParams.set('one_time_token', tokenRecord.token);
      landingUrl.searchParams.set('email', tokenRecord.email);
      landingUrl.searchParams.set('redirect', acceptUrl.href);
      ctx.redirect(landingUrl.href);
    }
  );

  cloudRouter.get(
    '/invitations/:invitationId',
    koaGuard({ params: z.object({ invitationId: z.string() }) }),
    async (ctx, next) => {
      const invitation = await organizations.invitations.findById(ctx.guard.params.invitationId);
      const user = await users.findUserById(ctx.auth.id);
      assertThat(
        user.primaryEmail?.toLowerCase() === invitation.invitee.toLowerCase(),
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      ctx.body = invitation;
      return next();
    }
  );

  cloudRouter.patch(
    '/invitations/:invitationId/status',
    koaGuard({
      params: z.object({ invitationId: z.string() }),
      body: z.object({ status: z.literal(OrganizationInvitationStatus.Accepted) }),
    }),
    async (ctx, next) => {
      ctx.body = await organizationInvitations.updateStatus(
        ctx.guard.params.invitationId,
        OrganizationInvitationStatus.Accepted,
        ctx.auth.id
      );
      return next();
    }
  );

  const app = new Koa();
  app.use(koaCors([EnvSet.values.adminUrlSet]));
  app.use(koaBodyEtag());
  app.use(anonymousRouter.routes()).use(anonymousRouter.allowedMethods());
  app.use(cloudRouter.routes()).use(cloudRouter.allowedMethods());
  app.use(organizationRouter.routes()).use(organizationRouter.allowedMethods());
  return app;
}
/* eslint-enable max-lines */
