import { loadRuntimePlatformBranding, resolveBrandProfile } from '@logto/core-kit';
import { yes } from '@silverhand/essentials';

const normalizeEnv = (value: unknown) =>
  value === null || value === undefined ? undefined : String(value);

/**
 * Keep brand selection independent from Vite's `import.meta` object so shared visual components
 * remain consumable by Jest. The Vite config replaces this exact expression for browser builds.
 */
export const isCloudBrand = yes(normalizeEnv(process.env.IS_CLOUD));
export const brandProfile = { ...resolveBrandProfile(isCloudBrand) };
export const isIdenBrand = brandProfile.id === 'iden';
export const initializeBrandProfile = async () =>
  loadRuntimePlatformBranding(brandProfile, isCloudBrand);
