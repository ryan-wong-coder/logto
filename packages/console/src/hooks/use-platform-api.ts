import { useLogto } from '@logto/react';
import { useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { z } from 'zod';

import { isSelfHostedParityEnabled } from '@/consts/env';
import { cloudApi } from '@/consts/resources';

export type PlatformBranding = {
  productName: string;
  slogan: string;
  logoUrl?: string;
  darkLogoUrl?: string;
  hideOpenSourceNotice: boolean;
};

export type PlatformAdministrator = {
  id: string;
  username?: string;
  primaryEmail?: string;
  name?: string;
  avatar?: string;
};

const platformApiErrorGuard = z.object({ message: z.string() });

export const usePlatformApi = () => {
  const { getAccessToken } = useLogto();
  const { t, i18n } = useTranslation();

  return useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getAccessToken(cloudApi.indicator);
      const response = await fetch(path, {
        ...init,
        headers: {
          ...(!(init.body instanceof FormData) && init.body
            ? { 'Content-Type': 'application/json' }
            : {}),
          Authorization: `Bearer ${token ?? ''}`,
          'Accept-Language': i18n.language,
          ...init.headers,
        },
      });
      if (!response.ok) {
        const responseBody: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        const result = platformApiErrorGuard.safeParse(responseBody);
        toast.error(
          result.success ? result.data.message : t('admin_console.errors.unknown_server_error')
        );
        throw new Error(`Platform API request failed (${response.status}).`);
      }
      // eslint-disable-next-line no-restricted-syntax -- The caller supplies the response type for this internal typed API wrapper.
      return (response.status === 204 ? undefined : await response.json()) as T;
    },
    [getAccessToken, i18n.language, t]
  );
};

export const usePlatformAccess = () => {
  const request = usePlatformApi();
  const { data, isLoading } = useSWR(
    isSelfHostedParityEnabled ? '/api/instance/platform-access' : null,
    async (path) => request<{ isPlatformAdministrator: boolean }>(path)
  );

  return {
    isLoading,
    isPlatformAdministrator: data?.isPlatformAdministrator === true,
  };
};
