import { useTranslation } from 'react-i18next';

import { isDevFeaturesEnabled, brandProfile, isIdenBrand } from '@/consts/env';
import OverlayScrollbar from '@/ds-components/OverlayScrollbar';
import useDocumentationUrl from '@/hooks/use-documentation-url';
import useInterfaceTranslation from '@/hooks/use-interface-translation';
import useMatchTenantPath from '@/hooks/use-tenant-pathname';

import Item from './components/Item';
import Section from './components/Section';
import { useSidebarMenuItems } from './hook';
import styles from './index.module.scss';
import { getPath } from './utils';

function Sidebar() {
  const { t: tUi } = useInterfaceTranslation();
  const { t } = useTranslation(undefined, {
    keyPrefix: 'admin_console.tab_sections',
  });
  const { sections } = useSidebarMenuItems();
  const { match } = useMatchTenantPath();
  const { documentationSiteUrl } = useDocumentationUrl();

  return (
    <div className={styles.sidebar}>
      <OverlayScrollbar className={styles.menu}>
        <div className={styles.menuContent}>
          {sections.map(({ title, items }) => (
            <Section key={title} title={t(title)}>
              {items.map(
                ({ title, Icon, isHidden, modal, externalLink, path }) =>
                  !isHidden && (
                    <Item
                      key={title}
                      titleKey={title}
                      icon={<Icon />}
                      isActive={match('/' + (path ?? getPath(title)))}
                      modal={modal}
                      externalLink={externalLink}
                      path={path}
                    />
                  )
              )}
            </Section>
          ))}
          {isDevFeaturesEnabled && <div aria-hidden className={styles.devStatusSpacer} />}
          {isIdenBrand && (
            <footer className={styles.footer}>
              <div className={styles.slogan}>{brandProfile.slogan}</div>
              {!brandProfile.hideOpenSourceNotice && (
                <a className={styles.about} href={`${documentationSiteUrl}/about`}>
                  {tUi('about')}
                </a>
              )}
            </footer>
          )}
        </div>
      </OverlayScrollbar>
    </div>
  );
}

export default Sidebar;

export * from './utils';
