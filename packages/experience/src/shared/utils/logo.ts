import idenAppIcon from '@logto/core-kit/assets/iden-app-icon.svg';
import type { Branding } from '@logto/schemas';
import { Theme } from '@logto/schemas';
import type { Nullable } from '@silverhand/essentials';

import { isCloudBuild, productBrand } from '@/shared/utils/product-brand';

const legacySelfHostedLogoUrls = new Set([
  'https://logto.io/logo.svg',
  'https://logto.io/logo-dark.svg',
]);

export const resolveSelfHostedBrandingLogoUrl = (
  logoUrl: Nullable<string> | undefined,
  theme = Theme.Light
) => {
  if (isCloudBuild || (logoUrl && !legacySelfHostedLogoUrls.has(logoUrl))) {
    return logoUrl;
  }

  return theme === Theme.Dark
    ? (productBrand.darkLogoUrl ?? productBrand.logoUrl ?? idenAppIcon)
    : (productBrand.logoUrl ?? productBrand.darkLogoUrl ?? idenAppIcon);
};

export type GetLogoUrl = {
  theme: Theme;
  logoUrl: string;
  darkLogoUrl?: Nullable<string>;
};

export const getLogoUrl = ({ theme, logoUrl, darkLogoUrl }: GetLogoUrl) => {
  if (theme === Theme.Dark) {
    return darkLogoUrl ?? logoUrl;
  }

  return logoUrl;
};

export type GetBrandingLogoUrl = {
  theme: Theme;
  branding: Branding;
  isDarkModeEnabled: boolean;
};

export const getBrandingLogoUrl = ({ theme, branding, isDarkModeEnabled }: GetBrandingLogoUrl) => {
  const { logoUrl, darkLogoUrl } = branding;

  if (!isDarkModeEnabled) {
    return resolveSelfHostedBrandingLogoUrl(logoUrl, theme);
  }

  if (!logoUrl && !darkLogoUrl) {
    return resolveSelfHostedBrandingLogoUrl(null, theme);
  }

  if (logoUrl && darkLogoUrl) {
    return resolveSelfHostedBrandingLogoUrl(getLogoUrl({ theme, logoUrl, darkLogoUrl }), theme);
  }

  return resolveSelfHostedBrandingLogoUrl(logoUrl ?? darkLogoUrl, theme);
};
