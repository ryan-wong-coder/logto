import { rebrandProductPhrases } from '@logto/core-kit';
import { interfaceResources } from '@logto/phrases-experience/lib/interface';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { isCloudBuild, productBrand } from '../product-brand';

export default async function initI18n() {
  await i18next
    .use(initReactI18next)
    .use(LanguageDetector)
    .init({
      resources: Object.fromEntries(
        Object.entries(interfaceResources).map(([locale, phrases]) => [
          locale,
          { interface: rebrandProductPhrases(phrases, isCloudBuild, productBrand.productName) },
        ])
      ),
      fallbackLng: 'en',
      defaultNS: 'interface',
      interpolation: { escapeValue: false },
    });
  document.documentElement.setAttribute('lang', i18next.resolvedLanguage);
  document.documentElement.setAttribute('dir', i18next.dir());
  Reflect.set(
    document,
    'title',
    `${productBrand.productName} · ${i18next.t('authentication_request')}`
  );
}
