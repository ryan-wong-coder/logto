/* eslint-disable max-lines -- The Account API keeps the complete nested organization route contract together. */
import { UserScope } from '@logto/core-kit';
import {
  OneTimeTokenStatus,
  OrganizationInvitationStatus,
  OrganizationJitEmailDomains,
  OrganizationJitEmailDomainVerifications,
  Logs,
  OrganizationManagementPermission,
  OrganizationManagementRoles,
  Organizations,
  uploadFileGuard,
  userAssetsGuard,
  organizationCenterOrganizationGuard,
  organizationCenterMemberGuard,
  organizationInvitationEntityGuard,
  organizationManagementPermissionsGuard,
} from '@logto/schemas';
import { generateStandardId, generateStandardSecret } from '@logto/shared';
import { appendPath } from '@silverhand/essentials';
import { z } from 'zod';

import { EnvSet, getTenantEndpoint } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import SystemContext from '#src/tenants/SystemContext.js';
import assertThat from '#src/utils/assert-that.js';
import { getConsoleLogFromContext } from '#src/utils/console.js';
import { getUserAssetsPublicUrl } from '#src/utils/storage/index.js';

import { uploadAvatar } from '../avatar-upload.js';
import type { RouterInitArgs, UserRouter } from '../types.js';

const organizationAccountApiPrefix = '/account/organizations';

const assertOrganizationScopes = (scopes: Set<string>, managementRoles = false) => {
  assertThat(
    scopes.has(UserScope.Organizations) &&
      (!managementRoles || scopes.has(UserScope.OrganizationRoles)),
    new RequestError({ code: 'auth.forbidden', status: 403 })
  );
};

const assertRecentVerification = (identityVerified?: boolean) => {
  assertThat(
    identityVerified,
    new RequestError({ code: 'verification_record.permission_denied', status: 401 })
  );
};

export default function accountOrganizationRoutes<T extends UserRouter>(
  ...[router, tenant]: RouterInitArgs<T>
) {
  const { id: tenantId, libraries, queries } = tenant;
  const { organizationAutonomy, organizationInvitations } = libraries;

  const sendInvitationEmail = async (
    invitation: Awaited<ReturnType<typeof organizationInvitations.insert>>,
    allowRegistration: boolean
  ) => {
    const invitationUrl = appendPath(
      getTenantEndpoint(tenantId, EnvSet.values),
      `/account/organizations/invitations/${invitation.id}`
    );
    const oneTimeToken = allowRegistration
      ? { id: generateStandardId(), token: generateStandardSecret() }
      : undefined;

    if (oneTimeToken) {
      await queries.oneTimeTokens.insertOneTimeToken({
        id: oneTimeToken.id,
        token: oneTimeToken.token,
        email: invitation.invitee,
        status: OneTimeTokenStatus.Active,
        expiresAt: invitation.expiresAt,
        context: { organizationInvitationId: invitation.id },
      });
      invitationUrl.searchParams.set('one_time_token', oneTimeToken.token);
      invitationUrl.searchParams.set('login_hint', invitation.invitee);
    }

    try {
      const templateContext =
        await organizationInvitations.getOrganizationInvitationTemplateContext(
          invitation.organizationId,
          invitation.inviterId
        );
      await organizationInvitations.sendEmail(invitation.invitee, {
        ...templateContext,
        link: invitationUrl.href,
      });
    } catch (error: unknown) {
      if (oneTimeToken) {
        await queries.oneTimeTokens.deleteOneTimeTokenById(oneTimeToken.id);
      }
      throw error;
    }
  };

  router.get(
    organizationAccountApiPrefix,
    koaGuard({
      response: organizationCenterOrganizationGuard.array(),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes);
      ctx.body = await organizationAutonomy.listOrganizations(ctx.auth.id);
      return next();
    }
  );

  router.post(
    organizationAccountApiPrefix,
    koaGuard({
      body: Organizations.createGuard.pick({ name: true, description: true }),
      response: organizationCenterOrganizationGuard,
      status: [201, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes } = ctx.auth;
      assertOrganizationScopes(scopes);
      const log = ctx.createLog('Organization.Create');
      log.append({ actorId: userId, userId, source: 'AccountApi' });

      const organization = await organizationAutonomy.createOrganization(userId, ctx.guard.body);
      log.append({ organizationId: organization.id, target: { type: 'organization' } });
      ctx.body = organization;
      ctx.status = 201;
      ctx.appendDataHookContext('Organization.Created', { organization });
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: organizationCenterOrganizationGuard,
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes);
      await organizationAutonomy.assertModule('profile');
      ctx.body = await organizationAutonomy.getOrganization(
        ctx.guard.params.organizationId,
        ctx.auth.id
      );
      return next();
    }
  );

  router.patch(
    `${organizationAccountApiPrefix}/:organizationId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: Organizations.updateGuard.pick({
        name: true,
        description: true,
        color: true,
        branding: true,
        customCss: true,
        isMfaRequired: true,
      }),
      response: organizationCenterOrganizationGuard,
      status: [200, 401, 403, 404, 422],
    }),
    // eslint-disable-next-line complexity -- The update audit key and redacted summary depend on the permitted field family.
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes);
      const { color, branding, customCss, isMfaRequired, ...profile } = ctx.guard.body;
      if (
        color !== undefined ||
        branding !== undefined ||
        customCss !== undefined ||
        isMfaRequired !== undefined
      ) {
        assertRecentVerification(identityVerified);
      }
      const log = ctx.createLog(
        isMfaRequired === undefined
          ? color !== undefined || branding !== undefined || customCss !== undefined
            ? 'Organization.Branding.Update'
            : 'Organization.Profile.Update'
          : 'Organization.Security.Update'
      );
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        changes: {
          ...Object.fromEntries(Object.keys(profile).map((key) => [key, true])),
          ...(color !== undefined && { color: true }),
          ...(branding !== undefined && { branding: true }),
          ...(customCss !== undefined && { customCss: customCss === null ? 'removed' : 'updated' }),
          ...(isMfaRequired !== undefined && { isMfaRequired }),
        },
      });

      const organization = await organizationAutonomy.updateOrganization(
        organizationId,
        userId,
        ctx.guard.body
      );
      ctx.body = organization;
      ctx.appendDataHookContext('Organization.Data.Updated', { organization });
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/avatar`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      files: z.object({ file: uploadFileGuard.array().min(1) }),
      response: userAssetsGuard,
      status: [200, 400, 401, 403, 404, 500],
    }),
    async (ctx, next) => {
      const { id: userId, scopes } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes);
      const [file] = ctx.guard.files.file;
      assertThat(file, 'guard.invalid_input');

      await organizationAutonomy.assertModule('branding');
      await organizationAutonomy.assertPermission(
        organizationId,
        userId,
        OrganizationManagementPermission.ManageBranding
      );
      const { storageProviderConfig } = SystemContext.shared;
      const uploaded = await uploadAvatar({
        file,
        storageProviderConfig,
        objectKeyPrefix: `${tenantId}/organizations/${organizationId}`,
        publicUrl: storageProviderConfig
          ? getUserAssetsPublicUrl(storageProviderConfig, tenant.envSet.endpoint)
          : undefined,
        logError: (error) => {
          getConsoleLogFromContext(ctx).error(error);
        },
      });
      const organization = await organizationAutonomy.updateOrganizationAvatar(
        organizationId,
        userId,
        uploaded.url
      );
      const log = ctx.createLog('Organization.Branding.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        changes: { avatar: 'updated' },
      });
      ctx.body = uploaded;
      ctx.appendDataHookContext('Organization.Data.Updated', { organization });
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId/avatar`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: organizationCenterOrganizationGuard,
      status: [200, 401, 403, 404],
    }),
    async (ctx, next) => {
      const { id: userId, scopes } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes);
      const organization = await organizationAutonomy.updateOrganizationAvatar(
        organizationId,
        userId
      );
      const log = ctx.createLog('Organization.Branding.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        changes: { avatar: 'removed' },
      });
      ctx.body = organization;
      ctx.appendDataHookContext('Organization.Data.Updated', { organization });
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes);
      await organizationAutonomy.assertModule('deletion');
      assertRecentVerification(identityVerified);
      const organization = await organizationAutonomy.getOrganization(organizationId, userId);
      const log = ctx.createLog('Organization.Delete');
      log.append({ actorId: userId, userId, organizationId, source: 'AccountApi' });

      await organizationAutonomy.deleteOrganization(organizationId, userId);
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Deleted', { organization });
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId/members`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: organizationCenterMemberGuard.array(),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes, true);
      await organizationAutonomy.assertModule('members');
      ctx.body = await organizationAutonomy.listMembers(
        ctx.guard.params.organizationId,
        ctx.auth.id
      );
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId/members/:userId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), userId: z.string().min(1) }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes, identityVerified } = ctx.auth;
      const { organizationId, userId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('members');
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.Member.Remove');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'user', id: userId },
      });

      await organizationAutonomy.removeMember(organizationId, userId, actorUserId);
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Membership.Updated', {
        organizationId,
        removedUserIds: [userId],
      });
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId/invitations`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: organizationInvitationEntityGuard.array(),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(ctx.auth.scopes, true);
      await organizationAutonomy.assertModule('invitations');
      await organizationAutonomy.assertPermission(
        organizationId,
        ctx.auth.id,
        OrganizationManagementPermission.ManageInvitations
      );
      ctx.body = await queries.organizations.invitations.findEntities({ organizationId });
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/invitations`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: z.object({
        invitee: z.string().email(),
        organizationRoleIds: z.string().min(1).array().default([]),
        organizationManagementRoleIds: z.string().min(1).array().default([]),
      }),
      response: organizationInvitationEntityGuard,
      status: [201, 401, 403, 404, 422, 429, 501],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      const { invitee, organizationRoleIds, organizationManagementRoleIds } = ctx.guard.body;
      assertOrganizationScopes(scopes, true);
      if (organizationRoleIds.length > 0 || organizationManagementRoleIds.length > 0) {
        assertRecentVerification(identityVerified);
      }
      const settings = await organizationAutonomy.assertInvitationResources({
        organizationId,
        actorUserId,
        organizationRoleIds,
        organizationManagementRoleIds,
      });
      const log = ctx.createLog('Organization.Invitation.Create');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'email', value: invitee },
      });

      const invitation = await organizationInvitations.insert(
        {
          inviterId: actorUserId,
          invitee,
          organizationId,
          organizationRoleIds,
          organizationManagementRoleIds,
          expiresAt: Date.now() + settings.invitationPolicy.expiresInDays * 24 * 60 * 60 * 1000,
        },
        false,
        ctx.request.ip
      );
      try {
        await sendInvitationEmail(invitation, settings.invitationPolicy.allowRegistration);
      } catch (error: unknown) {
        await queries.organizations.invitations.deleteById(invitation.id);
        throw error;
      }
      log.append({ target: { type: 'organizationInvitation', id: invitation.id } });
      ctx.body = invitation;
      ctx.status = 201;
      ctx.appendDataHookContext('OrganizationInvitation.Created', {
        organizationId,
        invitation,
      });
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/invitations/:invitationId/resend`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), invitationId: z.string().min(1) }),
      response: organizationInvitationEntityGuard,
      status: [200, 403, 404, 422, 429, 501],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes } = ctx.auth;
      const { organizationId, invitationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('invitations');
      await organizationAutonomy.assertPermission(
        organizationId,
        actorUserId,
        OrganizationManagementPermission.ManageInvitations
      );
      const invitation = await queries.organizations.invitations.findById(invitationId);
      assertThat(
        invitation.organizationId === organizationId,
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      assertThat(
        invitation.status === OrganizationInvitationStatus.Pending ||
          invitation.status === OrganizationInvitationStatus.Expired,
        new RequestError({ code: 'request.invalid_input', status: 422 })
      );
      const settings = await organizationAutonomy.getSettings();
      const expiresAt = Date.now() + settings.invitationPolicy.expiresInDays * 24 * 60 * 60 * 1000;
      await queries.oneTimeTokens.deleteOneTimeTokensByOrganizationInvitationId(invitationId);
      await queries.organizations.invitations.updateById(invitationId, {
        expiresAt,
        status: OrganizationInvitationStatus.Pending,
      });
      const updatedInvitation = await queries.organizations.invitations.findById(invitationId);
      await sendInvitationEmail(updatedInvitation, settings.invitationPolicy.allowRegistration);
      const log = ctx.createLog('Organization.Invitation.Create');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'organizationInvitation', id: invitationId },
        changes: { resent: true },
      });
      ctx.body = updatedInvitation;
      ctx.appendDataHookContext('OrganizationInvitation.Status.Updated', {
        organizationId,
        invitation: updatedInvitation,
      });
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId/invitations/:invitationId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), invitationId: z.string().min(1) }),
      status: [204, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes } = ctx.auth;
      const { organizationId, invitationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('invitations');
      await organizationAutonomy.assertPermission(
        organizationId,
        actorUserId,
        OrganizationManagementPermission.ManageInvitations
      );
      const invitation = await queries.organizations.invitations.findById(invitationId);
      assertThat(
        invitation.organizationId === organizationId,
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      const revoked = await organizationInvitations.updateStatus(
        invitationId,
        OrganizationInvitationStatus.Revoked
      );
      await queries.oneTimeTokens.deleteOneTimeTokensByOrganizationInvitationId(invitationId);
      const log = ctx.createLog('Organization.Invitation.Revoke');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'organizationInvitation', id: invitationId },
      });
      ctx.status = 204;
      ctx.appendDataHookContext('OrganizationInvitation.Status.Updated', {
        organizationId,
        invitation: revoked,
      });
      return next();
    }
  );

  router.get(
    '/account/organization-invitations',
    koaGuard({
      response: organizationInvitationEntityGuard.array(),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes);
      await organizationAutonomy.getSettings();
      const user = await queries.users.findUserById(ctx.auth.id);
      ctx.body = user.primaryEmail
        ? await queries.organizations.invitations.findEntities({ invitee: user.primaryEmail })
        : [];
      return next();
    }
  );

  router.post(
    '/account/organization-invitations/:invitationId/accept',
    koaGuard({
      params: z.object({ invitationId: z.string().min(1) }),
      response: organizationInvitationEntityGuard,
      status: [200, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes } = ctx.auth;
      assertOrganizationScopes(scopes);
      await organizationAutonomy.getSettings();
      const invitation = await queries.organizations.invitations.findById(
        ctx.guard.params.invitationId
      );
      const user = await queries.users.findUserById(userId);
      assertThat(
        user.primaryEmail?.toLowerCase() === invitation.invitee.toLowerCase(),
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      const log = ctx.createLog('Organization.Invitation.Accept');
      log.append({
        actorId: userId,
        userId,
        organizationId: invitation.organizationId,
        source: 'AccountApi',
        target: { type: 'organizationInvitation', id: invitation.id },
      });

      const accepted = await organizationInvitations.updateStatus(
        invitation.id,
        OrganizationInvitationStatus.Accepted,
        userId
      );
      await queries.oneTimeTokens.deleteOneTimeTokensByOrganizationInvitationId(invitation.id);
      ctx.body = accepted;
      ctx.appendDataHookContext('OrganizationInvitation.Status.Updated', {
        organizationId: accepted.organizationId,
        invitation: accepted,
      });
      ctx.appendDataHookContext('Organization.Membership.Updated', {
        organizationId: accepted.organizationId,
        addedUserIds: [userId],
      });
      return next();
    }
  );

  router.post(
    '/account/organization-invitations/:invitationId/decline',
    koaGuard({
      params: z.object({ invitationId: z.string().min(1) }),
      response: organizationInvitationEntityGuard,
      status: [200, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes } = ctx.auth;
      assertOrganizationScopes(scopes);
      await organizationAutonomy.getSettings();
      const invitation = await queries.organizations.invitations.findById(
        ctx.guard.params.invitationId
      );
      const user = await queries.users.findUserById(userId);
      assertThat(
        user.primaryEmail?.toLowerCase() === invitation.invitee.toLowerCase(),
        new RequestError({ code: 'auth.forbidden', status: 403 })
      );
      const log = ctx.createLog('Organization.Invitation.Decline');
      log.append({
        actorId: userId,
        userId,
        organizationId: invitation.organizationId,
        source: 'AccountApi',
        target: { type: 'organizationInvitation', id: invitation.id },
      });

      const declined = await organizationInvitations.updateStatus(
        invitation.id,
        OrganizationInvitationStatus.Declined
      );
      await queries.oneTimeTokens.deleteOneTimeTokensByOrganizationInvitationId(invitation.id);
      ctx.body = declined;
      ctx.appendDataHookContext('OrganizationInvitation.Status.Updated', {
        organizationId: declined.organizationId,
        invitation: declined,
      });
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId/activity`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: Logs.guard.array(),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes, true);
      ctx.body = await organizationAutonomy.listActivity(
        ctx.guard.params.organizationId,
        ctx.auth.id
      );
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId/available-resources`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: z.object({
        ssoConnectors: z
          .object({ id: z.string(), name: z.string(), assigned: z.boolean() })
          .array(),
        applications: z
          .object({ id: z.string(), name: z.string(), type: z.string(), assigned: z.boolean() })
          .array(),
        organizationRoles: z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullable(),
            assigned: z.boolean(),
          })
          .array(),
      }),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes, true);
      ctx.body = await organizationAutonomy.getAvailableResources(
        ctx.guard.params.organizationId,
        ctx.auth.id
      );
      return next();
    }
  );

  router.put(
    `${organizationAccountApiPrefix}/:organizationId/jit/sso-connectors`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: z.object({ ssoConnectorIds: z.string().min(1).array() }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.Jit.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        changes: { ssoConnectorIds: ctx.guard.body.ssoConnectorIds.length },
      });
      await organizationAutonomy.replaceOrganizationSsoConnectors(
        organizationId,
        userId,
        ctx.guard.body.ssoConnectorIds
      );
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Configuration.Updated', {
        organizationId,
        configuration: 'jitSsoConnectors',
      });
      return next();
    }
  );

  router.put(
    `${organizationAccountApiPrefix}/:organizationId/applications`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: z.object({ applicationIds: z.string().min(1).array() }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.Application.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        changes: { applicationIds: ctx.guard.body.applicationIds.length },
      });
      await organizationAutonomy.replaceOrganizationApplications(
        organizationId,
        userId,
        ctx.guard.body.applicationIds
      );
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Membership.Updated', {
        organizationId,
        applicationIds: ctx.guard.body.applicationIds,
      });
      return next();
    }
  );

  router.put(
    `${organizationAccountApiPrefix}/:organizationId/members/:userId/business-roles`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), userId: z.string().min(1) }),
      body: z.object({ organizationRoleIds: z.string().min(1).array() }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes, identityVerified } = ctx.auth;
      const { organizationId, userId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.BusinessRole.Update');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'user', id: userId },
        changes: { organizationRoleIds: ctx.guard.body.organizationRoleIds },
      });
      await organizationAutonomy.replaceMemberBusinessRoles(
        organizationId,
        userId,
        actorUserId,
        ctx.guard.body.organizationRoleIds
      );
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Membership.Updated', {
        organizationId,
        updatedUserIds: [userId],
        organizationRoleIds: ctx.guard.body.organizationRoleIds,
      });
      return next();
    }
  );

  router.put(
    `${organizationAccountApiPrefix}/:organizationId/jit/business-roles`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: z.object({ organizationRoleIds: z.string().min(1).array() }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.BusinessRole.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        changes: { jitOrganizationRoleIds: ctx.guard.body.organizationRoleIds },
      });
      await organizationAutonomy.replaceJitBusinessRoles(
        organizationId,
        userId,
        ctx.guard.body.organizationRoleIds
      );
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Configuration.Updated', {
        organizationId,
        configuration: 'jitBusinessRoles',
      });
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId/jit/email-domains`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: z.object({
        emailDomains: OrganizationJitEmailDomains.guard.array(),
        verifications: OrganizationJitEmailDomainVerifications.guard.array(),
      }),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes, true);
      ctx.body = await organizationAutonomy.listJitEmailDomains(
        ctx.guard.params.organizationId,
        ctx.auth.id
      );
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/jit/email-domain-verifications`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: z.object({ domain: z.string().min(1).max(256) }),
      response: OrganizationJitEmailDomainVerifications.guard,
      status: [201, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.Jit.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'emailDomain', value: ctx.guard.body.domain },
      });
      ctx.body = await organizationAutonomy.createJitEmailDomainVerification(
        organizationId,
        userId,
        ctx.guard.body.domain
      );
      ctx.status = 201;
      ctx.appendDataHookContext('Organization.Configuration.Updated', {
        organizationId,
        configuration: 'jitEmailDomainVerification',
      });
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/jit/email-domain-verifications/:verificationId/verify`,
    koaGuard({
      params: z.object({
        organizationId: z.string().min(1),
        verificationId: z.string().min(1),
      }),
      response: OrganizationJitEmailDomainVerifications.guard,
      status: [200, 401, 403, 404, 422, 429],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId, verificationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.Domain.Verification');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'domainVerification', id: verificationId },
      });
      ctx.body = await organizationAutonomy.verifyJitEmailDomain(
        organizationId,
        verificationId,
        userId
      );
      ctx.appendDataHookContext('Organization.Configuration.Updated', {
        organizationId,
        configuration: 'jitEmailDomain',
      });
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId/jit/email-domains/:domain`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), domain: z.string().min(1) }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId, domain } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.Jit.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'emailDomain', value: domain },
      });
      await organizationAutonomy.deleteJitEmailDomain(organizationId, domain, userId);
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Configuration.Updated', {
        organizationId,
        configuration: 'jitEmailDomain',
      });
      return next();
    }
  );

  router.get(
    `${organizationAccountApiPrefix}/:organizationId/management-roles`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      response: OrganizationManagementRoles.guard.array(),
      status: [200, 403, 404],
    }),
    async (ctx, next) => {
      assertOrganizationScopes(ctx.auth.scopes, true);
      await organizationAutonomy.assertModule('managementRoles');
      ctx.body = await organizationAutonomy.listManagementRoles(
        ctx.guard.params.organizationId,
        ctx.auth.id
      );
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/management-roles`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1) }),
      body: OrganizationManagementRoles.createGuard.pick({
        name: true,
        description: true,
        permissions: true,
      }),
      response: OrganizationManagementRoles.guard,
      status: [201, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('managementRoles');
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.ManagementRole.Create');
      log.append({ actorId: userId, userId, organizationId, source: 'AccountApi' });

      const role = await organizationAutonomy.createManagementRole(
        organizationId,
        userId,
        ctx.guard.body
      );
      log.append({ target: { type: 'organizationManagementRole', id: role.id } });
      ctx.body = role;
      ctx.status = 201;
      ctx.appendDataHookContext('OrganizationManagementRole.Created', {
        organizationId,
        managementRole: role,
      });
      return next();
    }
  );

  router.patch(
    `${organizationAccountApiPrefix}/:organizationId/management-roles/:roleId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), roleId: z.string().min(1) }),
      body: z.object({
        name: z.string().min(1).max(128).optional(),
        description: z.string().max(256).nullable().optional(),
        permissions: organizationManagementPermissionsGuard.optional(),
      }),
      response: OrganizationManagementRoles.guard,
      status: [200, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId, roleId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('managementRoles');
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.ManagementRole.Update');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'organizationManagementRole', id: roleId },
        changes: Object.fromEntries(Object.keys(ctx.guard.body).map((key) => [key, true])),
      });

      const role = await organizationAutonomy.updateManagementRole(
        organizationId,
        roleId,
        userId,
        ctx.guard.body
      );
      ctx.body = role;
      ctx.appendDataHookContext('OrganizationManagementRole.Data.Updated', {
        organizationId,
        managementRole: role,
      });
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId/management-roles/:roleId`,
    koaGuard({
      params: z.object({ organizationId: z.string().min(1), roleId: z.string().min(1) }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: userId, scopes, identityVerified } = ctx.auth;
      const { organizationId, roleId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('managementRoles');
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.ManagementRole.Delete');
      log.append({
        actorId: userId,
        userId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'organizationManagementRole', id: roleId },
      });

      await organizationAutonomy.deleteManagementRole(organizationId, roleId, userId);
      ctx.status = 204;
      ctx.appendDataHookContext('OrganizationManagementRole.Deleted', {
        organizationId,
        managementRole: { id: roleId },
      });
      return next();
    }
  );

  router.post(
    `${organizationAccountApiPrefix}/:organizationId/management-roles/:roleId/users/:userId`,
    koaGuard({
      params: z.object({
        organizationId: z.string().min(1),
        roleId: z.string().min(1),
        userId: z.string().min(1),
      }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes, identityVerified } = ctx.auth;
      const { organizationId, roleId, userId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('managementRoles');
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.ManagementRole.Assign');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'user', id: userId, roleId },
      });

      await organizationAutonomy.assignManagementRole({
        organizationId,
        roleId,
        targetUserId: userId,
        actorUserId,
      });
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Membership.Updated', {
        organizationId,
        updatedUserIds: [userId],
        managementRoleIds: [roleId],
      });
      return next();
    }
  );

  router.delete(
    `${organizationAccountApiPrefix}/:organizationId/management-roles/:roleId/users/:userId`,
    koaGuard({
      params: z.object({
        organizationId: z.string().min(1),
        roleId: z.string().min(1),
        userId: z.string().min(1),
      }),
      status: [204, 401, 403, 404, 422],
    }),
    async (ctx, next) => {
      const { id: actorUserId, scopes, identityVerified } = ctx.auth;
      const { organizationId, roleId, userId } = ctx.guard.params;
      assertOrganizationScopes(scopes, true);
      await organizationAutonomy.assertModule('managementRoles');
      assertRecentVerification(identityVerified);
      const log = ctx.createLog('Organization.ManagementRole.Unassign');
      log.append({
        actorId: actorUserId,
        userId: actorUserId,
        organizationId,
        source: 'AccountApi',
        target: { type: 'user', id: userId, roleId },
      });

      await organizationAutonomy.unassignManagementRole({
        organizationId,
        roleId,
        targetUserId: userId,
        actorUserId,
      });
      ctx.status = 204;
      ctx.appendDataHookContext('Organization.Membership.Updated', {
        organizationId,
        updatedUserIds: [userId],
        managementRoleIds: [roleId],
      });
      return next();
    }
  );
}
/* eslint-enable max-lines */
