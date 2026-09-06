import {
  applyProductBrandToDocument,
  initializeProductBrand,
  productBrand,
} from '@experience/shared/utils/product-brand';
import { createRoot } from 'react-dom/client';
import ReactModal from 'react-modal';

import App from './App';
import initI18n from './i18n/init';

const render = async () => {
  await initializeProductBrand();
  applyProductBrandToDocument();
  // eslint-disable-next-line @silverhand/fp/no-mutation -- The browser title reflects runtime platform branding.
  document.title = `${productBrand.productName} Account Center`;
  await initI18n();
  const app = document.querySelector<HTMLElement>('#app');
  if (app) {
    ReactModal.setAppElement(app);
  }
  const root = app && createRoot(app);
  root?.render(<App />);
};

void render();
