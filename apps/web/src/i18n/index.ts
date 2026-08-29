/**
 * 多语言文案表的合并入口。
 *
 * 文案按业务域分文件维护（`common.ts` 承接历史扁平词条，其余按页面分组）。
 * 分文件的直接理由是并行改造：多人同时向单一字典文件追加词条必然产生
 * 合并冲突，而文案改造恰恰是需要按页面并行推进的工作。
 *
 * 取词路径见 `LanguageContext.tsx` 的 `t()`。
 */
import { common } from './common';
import { schedule } from './schedule';
import { queue } from './queue';
import { rotation } from './rotation';
import { checkout } from './checkout';
import { finance } from './finance';
import { crm } from './crm';
import { settings } from './settings';
import { healthForms } from './healthForms';
import { tech } from './tech';
import { UI_LANGUAGES } from './types';
import type { Language } from './types';

export type { Language } from './types';
export { UI_LANGUAGES, DEFAULT_LANGUAGE } from './types';

/** @deprecated 使用 `UI_LANGUAGES`。保留此别名仅为兼容存量调用点。 */
export const LANGUAGES = UI_LANGUAGES;

const dict = {
  ...common,
  ...schedule,
  ...queue,
  ...rotation,
  ...checkout,
  ...finance,
  ...crm,
  ...settings,
  ...healthForms,
  ...tech,
};

export type TranslationKey = keyof typeof dict;

/**
 * 摊平成 `translations[语言][key]`。
 *
 * 取词是渲染热路径，逐次穿两层对象查找没有必要；
 * 且摊平后的结构可直接用于「某语言是否缺词条」的完整性测试。
 */
export const translations = Object.fromEntries(
  UI_LANGUAGES.map(({ code }) => [
    code,
    Object.fromEntries(
      Object.entries(dict as Record<string, Record<Language, string>>).map(([key, value]) => [
        key,
        value[code],
      ]),
    ),
  ]),
) as Record<Language, Record<TranslationKey, string>>;

/** 供完整性测试与字典瘦身脚本使用：全部已定义的 key。 */
export const ALL_TRANSLATION_KEYS = Object.keys(dict) as TranslationKey[];

