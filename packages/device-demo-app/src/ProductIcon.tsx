import idenAppIcon from '@logto/core-kit/assets/iden-app-icon.svg';

import logtoIcon from './assets/logto-icon.svg';
import { isCloudBuild, productBrand } from './product-brand';

type Props = {
  readonly className?: string;
};

const ProductIcon = ({ className }: Props) => {
  const lightLogo = productBrand.logoUrl ?? productBrand.darkLogoUrl ?? idenAppIcon;
  const darkLogo = productBrand.darkLogoUrl ?? productBrand.logoUrl ?? idenAppIcon;

  return (
    <picture>
      {!isCloudBuild && <source media="(prefers-color-scheme: dark)" srcSet={darkLogo} />}
      <img
        className={className}
        src={isCloudBuild ? logtoIcon : lightLogo}
        alt={isCloudBuild ? 'Logto' : productBrand.productName}
      />
    </picture>
  );
};

export default ProductIcon;
