import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Language } from '../types';
import { dict, DEFAULT_LANGUAGE, type TranslationKey } from '../i18n/dict';

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  pickText: (i18nObj: unknown, fallback?: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const STORAGE_KEY = 'gf_kiosk_language';

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (saved === 'zh-Hans' || saved === 'en' || saved === 'ko' || saved === 'es' || saved === 'vi')) {
        return saved as Language;
      }
    } catch {
      // Ignore
    }
    return DEFAULT_LANGUAGE;
  });

  const setLanguage = useCallback((newLang: Language) => {
    setLanguageState(newLang);
    try {
      localStorage.setItem(STORAGE_KEY, newLang);
    } catch {
      // Ignore
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>): string => {
      const entry = (dict as Record<string, Record<Language, string>>)[key];
      if (!entry) return key;
      let text: string = entry[language] || entry.en || entry['zh-Hans'] || key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    [language],
  );

  const pickText = useCallback(
    (i18nObj: unknown, fallback = ''): string => {
      if (!i18nObj) return fallback;
      if (typeof i18nObj === 'string') return i18nObj;
      if (typeof i18nObj === 'object') {
        const obj = i18nObj as Record<string, string>;
        return obj[language] || obj['zh-Hans'] || obj.en || Object.values(obj)[0] || fallback;
      }
      return fallback;
    },
    [language],
  );

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, pickText }}>
      {children}
    </LanguageContext.Provider>
  );
};

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return ctx;
}
