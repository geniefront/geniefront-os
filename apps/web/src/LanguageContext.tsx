import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { common } from './i18n/common';
import { DEFAULT_LANGUAGE, UI_LANGUAGES, type Language, type DomainDict } from './i18n/types';
import type { TranslationKey } from './i18n';

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
  'zh-TW': 'zh-Hant',
  zh_TW: 'zh-Hant',
};

function normalizeLanguage(raw: string | null): Language | null {
  if (!raw) return null;
  if (UI_LANGUAGES.some(({ code }) => code === raw)) return raw as Language;
  return LEGACY_LANGUAGE_ALIASES[raw] ?? null;
}

function flatten(dict: DomainDict): Record<Language, Record<string, string>> {
  return Object.fromEntries(UI_LANGUAGES.map(({ code }) => [
    code,
    Object.fromEntries(Object.entries(dict).map(([key, value]) => [key, value[code]])),
  ])) as Record<Language, Record<string, string>>;
}

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey | string, params?: Record<string, string | number>) => string;
  /** 业务域词典已按需下载完成；登录页只依赖同步加载的 common。 */
  ready: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const isTest = import.meta.env.MODE === 'test' && !(globalThis as typeof globalThis & { __GF_TEST_DYNAMIC_I18N__?: boolean }).__GF_TEST_DYNAMIC_I18N__;
  const [translations, setTranslations] = useState<Record<Language, Record<string, string>>>(() => (
    (globalThis as typeof globalThis & { __GF_TEST_TRANSLATIONS__?: Record<Language, Record<string, string>> })
      .__GF_TEST_TRANSLATIONS__ ?? flatten(common)
  ));
  const [ready, setReady] = useState(isTest);

  useEffect(() => {
    if (isTest) return undefined;
    let cancelled = false;

    // 兜底超时：即使网络阻塞或分包加载卡死，最多等待 3.5s 即放行渲染，
    // 基础 common 词典已同步提供，页面绝不会陷入无限转圈。
    const safetyTimer = setTimeout(() => {
      if (!cancelled) {
        setReady(true);
      }
    }, 3500);

    const loadSafe = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        console.warn('[LanguageContext] 分包词典加载异常，自动降级至基础词典:', err);
        return null;
      }
    };

    void Promise.all([
      loadSafe(() => import('./i18n/schedule')),
      loadSafe(() => import('./i18n/queue')),
      loadSafe(() => import('./i18n/rotation')),
      loadSafe(() => import('./i18n/checkout')),
      loadSafe(() => import('./i18n/finance')),
      loadSafe(() => import('./i18n/crm')),
      loadSafe(() => import('./i18n/settings')),
      loadSafe(() => import('./i18n/healthForms')),
      loadSafe(() => import('./i18n/tech')),
      loadSafe(() => import('./i18n/setup')),
      loadSafe(() => import('./i18n/support')),
      loadSafe(() => import('./i18n/email')),
      loadSafe(() => import('./i18n/reviews')),
      loadSafe(() => import('./i18n/permissions')),
      loadSafe(() => import('./i18n/bundles')),
      loadSafe(() => import('./i18n/voiceSettings')),
    ]).then(([schedule, queue, rotation, checkout, finance, crm, settings, healthForms, tech, setup, support, email, reviews, permissions, bundle, voiceSettings]) => {
      if (cancelled) return;
      clearTimeout(safetyTimer);
      const merged: DomainDict = {
        ...common,
        ...schedule?.schedule,
        ...queue?.queue,
        ...rotation?.rotation,
        ...checkout?.checkout,
        ...finance?.finance,
        ...crm?.crm,
        ...settings?.settings,
        ...healthForms?.healthForms,
        ...tech?.tech,
        ...setup?.setup,
        ...support?.support,
        ...email?.email,
        ...reviews?.reviews,
        ...permissions?.permissions,
        ...bundle?.bundle,
        ...voiceSettings?.voiceSettings,
      };
      setTranslations(flatten(merged));
      setReady(true);
    }).catch((err) => {
      console.warn('[LanguageContext] 词典加载未捕获异常:', err);
      if (!cancelled) {
        clearTimeout(safetyTimer);
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
  }, [isTest]);
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
    [language, translations],
  );

  const value = useMemo(() => ({ language, setLanguage, t, ready }), [language, setLanguage, t, ready]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
