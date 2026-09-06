import { Theme } from '@logto/schemas';
import classNames from 'classnames';
import { useContext } from 'react';

import CloudLogo from '@/assets/images/cloud-logo.svg?react';
import { brandProfile, isCloudBrand } from '@/consts/brand';
import { AppThemeContext } from '@/contexts/AppThemeProvider';

import styles from './index.module.scss';

type Props = {
  readonly className?: string;
  readonly onClick?: () => void;
};

function BrandLogo({ className, onClick }: Props) {
  const { theme } = useContext(AppThemeContext);
  if (isCloudBrand) {
    return (
      <CloudLogo
        aria-label={brandProfile.productName}
        className={className}
        role="button"
        onClick={onClick}
      />
    );
  }

  const logoUrl =
    theme === Theme.Dark
      ? (brandProfile.darkLogoUrl ?? brandProfile.logoUrl)
      : (brandProfile.logoUrl ?? brandProfile.darkLogoUrl);

  return (
    <button
      aria-label={brandProfile.productName}
      className={classNames(styles.logo, className)}
      type="button"
      onClick={onClick}
    >
      {logoUrl ? (
        <img alt="" className={styles.customMark} src={logoUrl} />
      ) : (
        <span aria-hidden className={styles.mark} />
      )}
      <span className={styles.name}>{brandProfile.productName}</span>
    </button>
  );
}

export default BrandLogo;
