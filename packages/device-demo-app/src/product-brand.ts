import {
  installSelfHostedHelpNavigation,
  isCloudBrandEnvironment,
  loadRuntimePlatformBranding,
  resolveBrandProfile,
} from '@logto/core-kit';
import idenAppIcon from '@logto/core-kit/assets/iden-app-icon.svg';

export const isCloudBuild = isCloudBrandEnvironment(process.env.IS_CLOUD);
export const productBrand = { ...resolveBrandProfile(isCloudBuild) };
export const initializeProductBrand = async () =>
  loadRuntimePlatformBranding(productBrand, isCloudBuild);

export const applyProductBrandToDocument = () => {
  Reflect.set(document.documentElement.dataset, 'productBrand', productBrand.id);
  if (!isCloudBuild) {
    // eslint-disable-next-line @silverhand/fp/no-mutation -- The browser title reflects runtime platform branding.
    document.title = `${productBrand.productName} Device Flow Demo`;
    installSelfHostedHelpNavigation();
    const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (favicon) {
      favicon.setAttribute('href', productBrand.logoUrl ?? idenAppIcon);
    }
  }
};
