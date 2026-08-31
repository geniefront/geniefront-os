import { en } from './en';
import { zhCN } from './zhCN';
import { ko } from './ko';
import { vi } from './vi';
import { es } from './es';
import type { LanguageCode, LanguageOption, TranslationSchema } from '../types/i18n';

export const translations: Record<LanguageCode, TranslationSchema> = {
  en,
  'zh-CN': zhCN,
  ko,
  vi,
  es,
};

export const languageOptions: LanguageOption[] = [
  { code: 'en', label: 'English', nativeLabel: 'English', flag: '🇺🇸' },
  { code: 'zh-CN', label: 'Simplified Chinese', nativeLabel: '简体中文', flag: '🇨🇳' },
  { code: 'vi', label: 'Vietnamese', nativeLabel: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어', flag: '🇰🇷' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español', flag: '🇪🇸' },
];

export function detectBrowserLanguage(): LanguageCode {
  if (typeof window === 'undefined') return 'en';

  try {
    const saved = localStorage.getItem('geniefront_lang') as LanguageCode;
    if (saved && translations[saved]) return saved;
  } catch {
    // Language detection still works when browser storage is unavailable.
  }

  const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of browserLanguages) {
    const browserLang = (language || '').toLowerCase();
    if (browserLang.startsWith('zh')) return 'zh-CN';
    if (browserLang.startsWith('ko')) return 'ko';
    if (browserLang.startsWith('vi')) return 'vi';
    if (browserLang.startsWith('es')) return 'es';
    if (browserLang.startsWith('en')) return 'en';
  }

  return 'en';
}
