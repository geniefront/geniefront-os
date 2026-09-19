import React, { createContext, useContext, useState, useEffect } from 'react';
import type { LanguageCode, TranslationSchema } from '../types/i18n';
import type { MarketingPlan } from '../lib/plans';
import { translations, detectBrowserLanguage } from '../translations';

interface LanguageContextType {
  currentLang: LanguageCode;
  t: TranslationSchema;
  setLanguage: (lang: LanguageCode) => void;
  openTrialModal: (prefillIndustry?: string, plan?: MarketingPlan) => void;
  closeTrialModal: () => void;
  isTrialModalOpen: boolean;
  selectedIndustryForTrial: string;
  selectedPlanForTrial: MarketingPlan;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentLang, setCurrentLangState] = useState<LanguageCode>(() => detectBrowserLanguage());
  const [isTrialModalOpen, setIsTrialModalOpen] = useState(false);
  const [selectedIndustryForTrial, setSelectedIndustryForTrial] = useState('nail');
  const [selectedPlanForTrial, setSelectedPlanForTrial] = useState<MarketingPlan>('essential');

  useEffect(() => {
    const trans = translations[currentLang] || translations.en;
    document.documentElement.lang = currentLang;
    document.title = trans.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', trans.meta.description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', trans.meta.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', trans.meta.description);
  }, [currentLang]);

  const setLanguage = (lang: LanguageCode) => {
    setCurrentLangState(lang);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('geniefront_lang', lang);
      } catch {
        // The current session still switches language if storage is blocked.
      }
    }
  };

  const openTrialModal = (industry = 'nail', plan: 'essential' | 'growth' = 'essential') => {
    setSelectedIndustryForTrial(industry);
    setSelectedPlanForTrial(plan);
    setIsTrialModalOpen(true);
  };

  const closeTrialModal = () => {
    setIsTrialModalOpen(false);
  };

  const t = translations[currentLang] || translations.en;

  return (
    <LanguageContext.Provider
      value={{
        currentLang,
        t,
        setLanguage,
        openTrialModal,
        closeTrialModal,
        isTrialModalOpen,
        selectedIndustryForTrial,
        selectedPlanForTrial,
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
