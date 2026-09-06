import { createRoot } from 'react-dom/client';

import App from './App';
import initI18n from './i18n/init';
import { applyProductBrandToDocument, initializeProductBrand } from './product-brand';

const render = async () => {
  await initializeProductBrand();
  applyProductBrandToDocument();
  await initI18n();
  const app = document.querySelector('#app');
  const root = app && createRoot(app);
  root?.render(<App />);
};

void render();
