import { safeLazy } from 'react-safe-lazy';

const PlatformSettings = safeLazy(async () => import('@/pages/PlatformSettings'));

export const platformSettings = {
  path: 'platform-settings',
  element: <PlatformSettings />,
};
