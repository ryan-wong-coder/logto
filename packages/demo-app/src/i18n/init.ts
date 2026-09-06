import type { LanguageTag } from '@logto/language-kit';
import resources from '@logto/phrases';
import { interfaceResources } from '@logto/phrases-experience/lib/interface';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import { getBrandedPhrases } from '../product-brand';

const initI18n = async (language?: LanguageTag) =>
  i18next
    .use(initReactI18next)
    .use(LanguageDetector)
    .init({
      resources: Object.fromEntries(
        Object.entries(interfaceResources).map(([locale, phrases]) => [
          locale,
          {
            ...Object.entries(getBrandedPhrases(resources)).find(([key]) => key === locale)?.[1],
            interface: getBrandedPhrases(phrases),
          },
        ])
      ),
      fallbackLng: 'en',
      ns: ['translation', 'interface'],
      defaultNS: 'translation',
      interpolation: {
        escapeValue: false,
      },
      lng: language,
    });

export default initI18n;
