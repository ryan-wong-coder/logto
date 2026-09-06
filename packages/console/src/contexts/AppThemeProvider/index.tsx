import { installSelfHostedHelpNavigation } from '@logto/core-kit';
import idenAppIcon from '@logto/core-kit/assets/iden-app-icon.svg?url';
import { Theme } from '@logto/schemas';
import { condArray, noop, trySafe } from '@silverhand/essentials';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState, createContext } from 'react';

import { brandProfile, isIdenBrand } from '@/consts/brand';
import { storageKeys } from '@/consts/storage';
import type { AppearanceMode } from '@/types/appearance-mode';
import { appearanceModeGuard, DynamicAppearanceMode } from '@/types/appearance-mode';

import styles from './index.module.scss';

type Props = {
  readonly children: ReactNode;
};

type Context = {
  theme: Theme;
  setAppearanceMode: (mode: AppearanceMode) => void;
  setThemeOverride: React.Dispatch<React.SetStateAction<Theme | undefined>>;
};

const darkThemeWatchMedia = window.matchMedia('(prefers-color-scheme: dark)');
const getThemeBySystemConfiguration = (): Theme =>
  darkThemeWatchMedia.matches ? Theme.Dark : Theme.Light;

export const buildDefaultAppearanceMode = (): AppearanceMode =>
  trySafe(() => appearanceModeGuard.parse(localStorage.getItem(storageKeys.appearanceMode))) ??
  DynamicAppearanceMode.System;

const defaultAppearanceMode = buildDefaultAppearanceMode();

const defaultTheme =
  defaultAppearanceMode === DynamicAppearanceMode.System
    ? getThemeBySystemConfiguration()
    : defaultAppearanceMode;

export const AppThemeContext = createContext<Context>({
  theme: defaultTheme,
  setAppearanceMode: noop,
  setThemeOverride: noop,
});

export function AppThemeProvider({ children }: Props) {
  const [theme, setTheme] = useState<Theme>(defaultTheme);
  const [themeOverride, setThemeOverride] = useState<Theme>();
  const [mode, setMode] = useState<AppearanceMode>(defaultAppearanceMode);

  const setAppearanceMode = (mode: AppearanceMode) => {
    setMode(mode);
    localStorage.setItem(storageKeys.appearanceMode, mode);
  };

  useEffect(() => {
    if (themeOverride) {
      setTheme(themeOverride);

      return;
    }

    if (mode !== DynamicAppearanceMode.System) {
      setTheme(mode);

      return;
    }

    const changeTheme = () => {
      setTheme(getThemeBySystemConfiguration());
    };

    changeTheme();

    darkThemeWatchMedia.addEventListener('change', changeTheme);

    return () => {
      darkThemeWatchMedia.removeEventListener('change', changeTheme);
    };
  }, [mode, themeOverride]);

  // Set Theme Mode
  useEffect(() => {
    document.body.classList.remove(...condArray(styles.light, styles.dark));
    document.body.classList.add(...condArray(styles[theme], isIdenBrand && styles.iden));
    Reflect.set(document.documentElement.dataset, 'productBrand', brandProfile.id);
    if (isIdenBrand) {
      const uninstallHelpNavigation = installSelfHostedHelpNavigation();
      const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (favicon) {
        favicon.setAttribute(
          'href',
          theme === Theme.Dark
            ? (brandProfile.darkLogoUrl ?? brandProfile.logoUrl ?? idenAppIcon)
            : (brandProfile.logoUrl ?? brandProfile.darkLogoUrl ?? idenAppIcon)
        );
      }

      return uninstallHelpNavigation;
    }
  }, [theme]);

  const context = useMemo<Context>(
    () => ({
      theme,
      setAppearanceMode,
      setThemeOverride,
    }),
    [theme]
  );

  return <AppThemeContext.Provider value={context}>{children}</AppThemeContext.Provider>;
}
