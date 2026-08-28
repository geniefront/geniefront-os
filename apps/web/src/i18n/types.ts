/**
 * 界面语言的类型契约。
 *
 * ⚠️ **语言代码必须与服务端一致。** 服务端契约为 `@gf/contracts` 的
 * `LOCALES = ['en','zh-Hans','zh-Hant','ko','vi','es']`，数据库中的 i18n JSONB
 * 字段（服务名、门店名、表单标签等）即以这些代码为键。
 * 前端此前使用 `'zh'`，与服务端的 `'zh-Hans'` 不对应，导致读取需要靠一串
 * 手写回退链兜底，写入方向则无法对齐。
 */
import type { Locale } from '@gf/contracts';

/**
 * 界面语言。
 *
 * 为 `Locale` 的子集：繁体中文（`zh-Hant`）目前**仅作为数据语言**存在 ——
 * 服务端可以存储繁体的服务名并正确回显，但界面文案尚未提供繁体译本，
 * 因此不进入语言切换器。补齐译本后将其加入 `UI_LANGUAGES` 即可，
 * 类型系统会立即指出所有缺失的词条。
 */
export type Language = Extract<Locale, 'en' | 'zh-Hans' | 'ko' | 'vi' | 'es'>;

/** 语言切换器按此顺序渲染。母语名而非英文名 —— 挑语言的人多半看不懂英文名。 */
export const UI_LANGUAGES: { code: Language; label: string }[] = [
  { code: 'zh-Hans', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'vi', label: 'Tiếng Việt' },
];

/** 默认语言。门店以中文运营者居多，且未选择语言时的首屏必须可读。 */
export const DEFAULT_LANGUAGE: Language = 'zh-Hans';

/**
 * 单个域的文案表。每个词条必须提供全部界面语言 ——
 * 缺一种即为类型错误，这是防止静默漏译的唯一机制。
 */
export type DomainDict = Record<string, Record<Language, string>>;
