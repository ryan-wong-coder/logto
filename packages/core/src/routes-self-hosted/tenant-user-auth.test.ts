import { AdminTenantRole, cloudApiIndicator, TenantScope } from '@logto/schemas';

import RequestError from '#src/errors/RequestError/index.js';
import type TenantContext from '#src/tenants/TenantContext.js';
import createMockContext from '#src/test-utils/jest-koa-mocks/create-mock-context.js';

const { jest } = import.meta;

const verifyBearerTokenFromRequest = jest.fn();

jest.unstable_mockModule('#src/middleware/koa-auth/index.js', () => ({
  verifyBearerTokenFromRequest,
}));

const { verifySelfHostedTenantUser } = await import('./tenant-user-auth.js');

const { request } = createMockContext({ headers: { authorization: 'Bearer token' } });
const platformRole = { id: 'platform-role', name: AdminTenantRole.PlatformAdministrator };

const createTenant = ({
  hasPlatformRole = false,
  organizationScopes = [],
}: {
  hasPlatformRole?: boolean;
  organizationScopes?: Array<{ name: TenantScope }>;
} = {}) =>
  ({
    envSet: {},
    queries: {
      roles: {
        findRoleByRoleName: jest.fn(async () => platformRole),
      },
      usersRoles: {
        hasUserRole: jest.fn(async () => hasPlatformRole),
      },
      organizations: {
        relations: {
          usersRoles: {
            getUserScopes: jest.fn(async () => organizationScopes),
          },
        },
      },
    },
  }) as unknown as TenantContext;

describe('self-hosted tenant user authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a valid tenant organization token unchanged', async () => {
    verifyBearerTokenFromRequest.mockResolvedValueOnce({
      sub: 'tenant-user',
      clientId: undefined,
      scopes: [TenantScope.ReadData],
    });

    await expect(verifySelfHostedTenantUser(createTenant(), request, 'tenant-a')).resolves.toEqual({
      sub: 'tenant-user',
      clientId: undefined,
      scopes: [TenantScope.ReadData],
    });
    expect(verifyBearerTokenFromRequest).toHaveBeenCalledTimes(1);
  });

  it('grants every tenant scope to a platform administrator using a platform token', async () => {
    verifyBearerTokenFromRequest
      .mockRejectedValueOnce(new RequestError({ code: 'auth.unauthorized', status: 401 }))
      .mockResolvedValueOnce({ sub: 'platform-user', clientId: undefined, scopes: [] });

    await expect(
      verifySelfHostedTenantUser(createTenant({ hasPlatformRole: true }), request, 'tenant-a')
    ).resolves.toMatchObject({
      sub: 'platform-user',
      scopes: Object.values(TenantScope),
    });
    expect(verifyBearerTokenFromRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      request,
      cloudApiIndicator
    );
  });

  it('derives tenant scopes from membership for a regular platform user', async () => {
    verifyBearerTokenFromRequest
      .mockRejectedValueOnce(new RequestError({ code: 'auth.unauthorized', status: 401 }))
      .mockResolvedValueOnce({ sub: 'member', clientId: undefined, scopes: [] });

    await expect(
      verifySelfHostedTenantUser(
        createTenant({ organizationScopes: [{ name: TenantScope.ReadData }] }),
        request,
        'tenant-a'
      )
    ).resolves.toMatchObject({ sub: 'member', scopes: [TenantScope.ReadData] });
  });

  it('rejects a platform user without tenant membership', async () => {
    verifyBearerTokenFromRequest
      .mockRejectedValueOnce(new RequestError({ code: 'auth.unauthorized', status: 401 }))
      .mockResolvedValueOnce({ sub: 'unrelated-user', clientId: undefined, scopes: [] });

    await expect(
      verifySelfHostedTenantUser(createTenant(), request, 'tenant-a')
    ).rejects.toMatchObject({ code: 'auth.forbidden', status: 403 });
  });

  it('rejects machine-to-machine tokens', async () => {
    verifyBearerTokenFromRequest.mockResolvedValueOnce({
      sub: 'client',
      clientId: 'client',
      scopes: [TenantScope.ReadData],
    });

    await expect(
      verifySelfHostedTenantUser(createTenant(), request, 'tenant-a')
    ).rejects.toMatchObject({ code: 'auth.forbidden', status: 403 });
  });
});
