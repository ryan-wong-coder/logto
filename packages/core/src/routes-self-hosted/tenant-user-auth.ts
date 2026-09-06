import { buildOrganizationUrn } from '@logto/core-kit';
import {
  AdminTenantRole,
  cloudApiIndicator,
  getTenantOrganizationId,
  TenantScope,
} from '@logto/schemas';
import type { Request } from 'koa';

import RequestError from '#src/errors/RequestError/index.js';
import { verifyBearerTokenFromRequest } from '#src/middleware/koa-auth/index.js';
import type TenantContext from '#src/tenants/TenantContext.js';
import assertThat from '#src/utils/assert-that.js';

/**
 * Accept a tenant organization token, or a self-hosted Cloud API token whose user is authorized
 * through tenant membership or the global platform administrator role.
 */
const resolveSelfHostedTenantUser = async (
  tenant: TenantContext,
  request: Request,
  tenantId: string
) => {
  try {
    return await verifyBearerTokenFromRequest(
      tenant.envSet,
      request,
      buildOrganizationUrn(getTenantOrganizationId(tenantId))
    );
  } catch (error: unknown) {
    if (!(error instanceof RequestError) || error.code !== 'auth.unauthorized') {
      throw error;
    }

    const tokenInfo = await verifyBearerTokenFromRequest(tenant.envSet, request, cloudApiIndicator);
    const role = await tenant.queries.roles.findRoleByRoleName(
      AdminTenantRole.PlatformAdministrator
    );
    const isPlatformAdministrator = Boolean(
      role && (await tenant.queries.usersRoles.hasUserRole(tokenInfo.sub, [role.id]))
    );
    const organizationScopes =
      await tenant.queries.organizations.relations.usersRoles.getUserScopes(
        getTenantOrganizationId(tenantId),
        tokenInfo.sub
      );
    const scopes = isPlatformAdministrator
      ? Object.values(TenantScope)
      : organizationScopes.map(({ name }) => name);
    assertThat(scopes.length > 0, new RequestError({ code: 'auth.forbidden', status: 403 }));

    return { ...tokenInfo, scopes };
  }
};

export const verifySelfHostedTenantUser = async (
  tenant: TenantContext,
  request: Request,
  tenantId: string
) => {
  const tokenInfo = await resolveSelfHostedTenantUser(tenant, request, tenantId);
  assertThat(
    tokenInfo.sub !== tokenInfo.clientId,
    new RequestError({ code: 'auth.forbidden', status: 403 })
  );
  return tokenInfo;
};
