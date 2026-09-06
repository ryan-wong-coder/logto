import {
  CloudflareKey,
  type EmailServiceConfig,
  EmailServiceProvider,
  EmailServiceProviderKey,
  type HostnameProviderData,
  type StorageProviderData,
  hostnameProviderDataGuard,
  emailServiceConfigGuard,
  storageProviderDataGuard,
  StorageProvider,
  StorageProviderKey,
  type SystemKey,
  type ProtectedAppConfigProviderData,
  protectedAppConfigProviderDataGuard,
  type PlatformBrandingConfig,
  PlatformBrandingKey,
  platformBrandingConfigGuard,
} from '@logto/schemas';
import type { CommonQueryMethods } from '@silverhand/slonik';
import { type ZodType } from 'zod';

import { EnvSet } from '#src/env-set/index.js';
import { createSystemsQuery } from '#src/queries/system.js';
import { devConsole } from '#src/utils/console.js';

export default class SystemContext {
  static shared = new SystemContext();
  public storageProviderConfig?: StorageProviderData;
  public experienceBlobsProviderConfig?: StorageProviderData;
  public experienceZipsProviderConfig?: StorageProviderData;
  public hostnameProviderConfig?: HostnameProviderData;
  public protectedAppConfigProviderConfig?: ProtectedAppConfigProviderData;
  public protectedAppHostnameProviderConfig?: HostnameProviderData;
  public emailServiceProviderConfig?: EmailServiceConfig;
  public platformBrandingConfig?: PlatformBrandingConfig;

  async loadProviderConfigs(pool: CommonQueryMethods) {
    await Promise.all([
      (async () => {
        this.storageProviderConfig = await this.loadConfig(
          pool,
          StorageProviderKey.StorageProvider,
          storageProviderDataGuard
        );
      })(),
      (async () => {
        this.experienceBlobsProviderConfig = await this.loadConfig(
          pool,
          StorageProviderKey.ExperienceBlobsProvider,
          storageProviderDataGuard
        );
      })(),
      (async () => {
        this.experienceZipsProviderConfig = await this.loadConfig(
          pool,
          StorageProviderKey.ExperienceZipsProvider,
          storageProviderDataGuard
        );
      })(),
      (async () => {
        this.hostnameProviderConfig = await this.loadConfig(
          pool,
          CloudflareKey.HostnameProvider,
          hostnameProviderDataGuard
        );
      })(),
      (async () => {
        this.protectedAppConfigProviderConfig = await this.loadConfig(
          pool,
          CloudflareKey.ProtectedAppConfigProvider,
          protectedAppConfigProviderDataGuard
        );
      })(),
      (async () => {
        this.protectedAppHostnameProviderConfig = await this.loadConfig(
          pool,
          CloudflareKey.ProtectedAppHostnameProvider,
          hostnameProviderDataGuard
        );
      })(),
      (async () => {
        this.emailServiceProviderConfig = await this.loadConfig(
          pool,
          EmailServiceProviderKey.EmailServiceProvider,
          emailServiceConfigGuard
        );
      })(),
      (async () => {
        this.platformBrandingConfig = await this.loadConfig(
          pool,
          PlatformBrandingKey.PlatformBranding,
          platformBrandingConfigGuard
        );
      })(),
    ]);

    if (EnvSet.values.isSelfHostedParityEnabled) {
      const localExperienceStorage: StorageProviderData = {
        provider: StorageProvider.LocalStorage,
        rootPath: EnvSet.values.selfHostedDataPath,
      };

      this.experienceBlobsProviderConfig ??= localExperienceStorage;
      this.experienceZipsProviderConfig ??= localExperienceStorage;
      this.storageProviderConfig ??= localExperienceStorage;
      this.emailServiceProviderConfig ??= {
        provider: EmailServiceProvider.LocalOutbox,
        fromName: this.platformBrandingConfig?.productName ?? 'iden',
        fromEmail: 'no-reply@localhost',
      };
    }
  }

  private async loadConfig<T>(
    pool: CommonQueryMethods,
    key: SystemKey,
    guard: ZodType<T>
  ): Promise<T | undefined> {
    const { findSystemByKey } = createSystemsQuery(pool);
    const record = await findSystemByKey(key);

    if (!record) {
      return;
    }

    const result = guard.safeParse(record.value);

    if (!result.success) {
      devConsole.error(`Failed to parse ${key} config:`, result.error);

      return;
    }

    return result.data;
  }
}
