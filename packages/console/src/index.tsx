import { createRoot } from 'react-dom/client';
import ReactModal from 'react-modal';

import App from './App';
import { initializeBrandProfile } from './consts/brand';
import initI18n from './i18n/init';

const render = async () => {
  await initializeBrandProfile();
  await initI18n();
  const app = document.querySelector('#app');
  const root = app && createRoot(app);
  ReactModal.setAppElement('#app');
  root?.render(<App />);
};

void render();
