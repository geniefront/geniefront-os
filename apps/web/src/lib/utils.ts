import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { pickText } from "@gf/contracts"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 呈现服务端返回的多语言字段（数据库中的 i18n JSONB，如
 * `{ "en": "Massage", "zh-Hans": "按摩" }`）。
 *
 * ⚠️ **回退策略由 `@gf/contracts` 的 `pickText` 统一实现，前端不得另写一份。**
 * 前后端各自维护一套回退顺序，结果是同一条数据在收银小票与界面上显示为
 * 不同语言，且该差异只在部分语言缺失时才暴露。
 *
 * 本函数在 `pickText` 之上仅补充一件事：部分接口会把 JSONB 字段
 * 以字符串形式返回，需要先行解析。
 */
export function pickI18nText(val: unknown, locale: string = 'zh-Hans'): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        return pickI18nText(JSON.parse(trimmed), locale);
      } catch {
        return val;
      }
    }
    return val;
  }

  if (typeof val === 'object') {
    return pickText(val, locale, '');
  }
  return String(val);
}

/** @deprecated 使用 `pickI18nText`。保留此别名仅为兼容存量调用点。 */
export const formatI18n = pickI18nText;

export { formatPhoneInput, formatPhoneDisplay, normalizePhoneE164 } from "@gf/contracts";
