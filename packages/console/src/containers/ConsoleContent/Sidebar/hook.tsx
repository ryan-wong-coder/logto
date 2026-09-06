import { type Optional } from '@silverhand/essentials';
import type { TFuncKey } from 'i18next';
import {
  AppWindow,
  Blocks,
  Bolt,
  Braces,
  Building2,
  Cable,
  Code2,
  FileKey2,
  Gauge,
  KeyRound,
  Landmark,
  PanelsTopLeft,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import useIsActionsEnabled from '@/hooks/use-is-actions-enabled';
import { usePlatformAccess } from '@/hooks/use-platform-api';

type SidebarItem = {
  Icon: LucideIcon;
  title: TFuncKey<'translation', 'admin_console.tabs'>;
  isHidden?: boolean;
  modal?: (isOpen: boolean, onCancel: () => void) => ReactNode;
  externalLink?: string;
  path?: string;
};

type SidebarSection = {
  title: TFuncKey<'translation', 'admin_console.tab_sections'>;
  isHidden?: boolean;
  items: SidebarItem[];
};

const findFirstItem = (sections: SidebarSection[]): Optional<SidebarItem> => {
  for (const section of sections) {
    const found = section.items.find((item) => !item.isHidden);

    if (found) {
      return found;
    }
  }
};

export const useSidebarMenuItems = (): {
  sections: SidebarSection[];
  firstItem: Optional<SidebarItem>;
} => {
  const isActionsEnabled = useIsActionsEnabled();
  const { isPlatformAdministrator } = usePlatformAccess();
  const allSections: SidebarSection[] = [
    {
      title: 'overview',
      items: [
        {
          Icon: Bolt,
          title: 'get_started',
        },
        {
          Icon: Gauge,
          title: 'dashboard',
        },
      ],
    },
    {
      title: 'authentication',
      items: [
        {
          Icon: AppWindow,
          title: 'applications',
        },

        {
          Icon: PanelsTopLeft,
          title: 'sign_in_experience',
          path: 'sign-in-experience',
        },
        {
          Icon: FileKey2,
          title: 'mfa',
        },
        {
          Icon: Cable,
          title: 'connectors',
        },
        {
          Icon: Building2,
          title: 'enterprise_sso',
        },
        {
          Icon: ShieldCheck,
          title: 'security',
        },
      ],
    },
    {
      title: 'authorization',
      items: [
        {
          Icon: Blocks,
          title: 'api_resources',
        },
        {
          Icon: KeyRound,
          title: 'roles',
        },
        {
          Icon: SlidersHorizontal,
          title: 'organization_template',
        },
      ],
    },
    {
      title: 'users',
      items: [
        {
          Icon: Building2,
          title: 'organizations',
        },
        {
          Icon: UsersRound,
          title: 'users',
        },
      ],
    },
    {
      title: 'developer',
      items: [
        {
          Icon: Code2,
          title: 'actions',
          path: 'actions',
          // Actions are still under development and should be released as one feature.
          isHidden: !isActionsEnabled,
        },
        {
          Icon: Braces,
          title: 'customize_jwt',
        },
        {
          Icon: Webhook,
          title: 'webhooks',
        },
        {
          Icon: ScrollText,
          title: 'audit_logs',
        },
      ],
    },
    {
      title: 'platform',
      isHidden: !isPlatformAdministrator,
      items: [
        {
          Icon: Landmark,
          title: 'platform_settings',
          path: 'platform-settings',
        },
      ],
    },
    {
      title: 'tenant',
      items: [
        {
          Icon: Settings2,
          title: 'tenant_settings',
        },
      ],
    },
  ];

  const enabledSections = allSections.filter((section) => !section.isHidden);

  return { sections: enabledSections, firstItem: findFirstItem(enabledSections) };
};
