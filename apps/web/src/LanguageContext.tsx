import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { translations, DEFAULT_LANGUAGE } from './i18n';
import type { Language, TranslationKey } from './i18n';

const STORAGE_KEY = 'gf.lang';

/**
 * 历史语言代码到服务端契约代码的映射。
 *
 * 前端此前使用 `'zh'`，而服务端 `LOCALES` 中对应的是 `'zh-Hans'`。
 * 已在使用中的终端其 localStorage 里存的是旧值，若不迁移，
 * 这些终端在本次发布后会静默退回默认语言 —— 对每天开店即用的前台而言，
 * 表现为「昨天设好的语言今天没了」。
 */
const LEGACY_LANGUAGE_ALIASES: Record<string, Language> = {
  zh: 'zh-Hans',
  'zh-CN': 'zh-Hans',
  zh_CN: 'zh-Hans',
};

function normalizeLanguage(raw: string | null): Language | null {
  if (!raw) return null;
  if (raw in translations) return raw as Language;
  return LEGACY_LANGUAGE_ALIASES[raw] ?? null;
}

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey | string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  /**
   * 记住上次选择的语言。门店内多台前台终端各有其习惯语言，
   * 若每次刷新都退回默认语言，非中文母语的员工每日均需重复设置。
   */
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const normalized = normalizeLanguage(localStorage.getItem(STORAGE_KEY));
      if (normalized) {
        // 就地改写旧值，避免每次启动都重复迁移
        localStorage.setItem(STORAGE_KEY, normalized);
        return normalized;
      }
    } catch {
      // 隐私模式下 localStorage 可能直接抛出，退回默认语言即可
    }
    return DEFAULT_LANGUAGE;
  });

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // 同上
    }
    document.documentElement.lang = lang;
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  /**
   * 取词。
   *
   * 回退链：当前语言 → 英语 → 简体中文 → key 原文。
   * 支持 `{variable}` 占位符替换。
   *
   * ⚠️ **key 缺失时返回的是 key 本身，而非空字符串。** 因此
   * `t('x') || '兜底文案'` 这一写法无效 —— 逻辑或的右侧永远不会执行，
   * 缺词条的表现是界面上出现 camelCase 变量名。开发环境下此处会显式告警
   * 并以 `⟦key⟧` 渲染，使该问题在自测阶段即可被发现，而非留到门店现场。
   */
  const t = useCallback(
    (key: TranslationKey | string, params?: Record<string, string | number>) => {
      const dictLang = translations[language] as Record<string, string> | undefined;
      const dictEn = translations.en as Record<string, string> | undefined;
      const dictZh = translations['zh-Hans'] as Record<string, string> | undefined;

      const hit = dictLang?.[key] ?? dictEn?.[key] ?? dictZh?.[key];
      let text: string;
      if (hit === undefined) {
        if (import.meta.env.DEV) {
          console.error(`[i18n] 缺少文案词条：${key}`);
          text = `⟦${key}⟧`;
        } else {
          text = key;
        }
      } else {
        text = hit;
      }

      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          text = text.split(`{${k}}`).join(String(v));
        });
      }
      return text;
    },
    [language],
  );

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
