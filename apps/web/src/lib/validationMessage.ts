/**
 * 校验失败原因 → 母语文案。
 *
 * `lib/validation.ts` 保持纯函数、不认识 i18n；这里是它与界面之间唯一的桥。
 * 分开的理由是可测性：判定逻辑（金额怎么算、边界在哪）可以用纯函数测试全覆盖，
 * 不必为了断言一句「金额只能填数字」而去搭语言上下文。
 */
import { useCallback } from 'react';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';
import type {
  CountOptions,
  CountReason,
  DurationOptions,
  DurationReason,
  EmailReason,
  MoneyReason,
  PinReason,
} from './validation';

/*
 * 逐条显式列出，不得写成 `` t(`valid.money${reason}`) `` 这类运行期拼接 ——
 * 拼接出来的 key 对字典瘦身脚本不可见，会被判定为未引用词条删除，而删除后
 * 没有任何编译期错误，故障要到用户真的填错时才暴露。
 */
const MONEY_KEYS: Record<MoneyReason, TranslationKey> = {
  empty: 'valid.moneyEmpty',
  format: 'valid.moneyFormat',
  negative: 'valid.moneyNegative',
  tooLarge: 'valid.moneyTooLarge',
};

const DURATION_KEYS: Record<DurationReason, TranslationKey> = {
  empty: 'valid.durationEmpty',
  format: 'valid.durationFormat',
  range: 'valid.durationRange',
};

const EMAIL_KEYS: Record<EmailReason, TranslationKey> = {
  empty: 'valid.emailEmpty',
  format: 'valid.emailFormat',
};

const PIN_KEYS: Record<PinReason, TranslationKey> = {
  empty: 'valid.pinEmpty',
  format: 'valid.pinFormat',
};

const COUNT_KEYS: Record<CountReason, TranslationKey> = {
  empty: 'valid.countEmpty',
  format: 'valid.countFormat',
  range: 'valid.countRange',
};

export interface ValidationMessages {
  money: (reason: MoneyReason) => string;
  /** 越界文案里要写清区间，因此需要传入与判定时相同的选项。 */
  duration: (reason: DurationReason, options?: DurationOptions) => string;
  email: (reason: EmailReason) => string;
  pin: (reason: PinReason) => string;
  count: (reason: CountReason, options?: CountOptions) => string;
}

export function useValidationMessage(): ValidationMessages {
  const { t } = useLanguage();

  return {
    money: useCallback((reason: MoneyReason) => t(MONEY_KEYS[reason]), [t]),
    duration: useCallback(
      (reason: DurationReason, options: DurationOptions = {}) =>
        reason === 'range'
          ? t(DURATION_KEYS.range, { p0: String(options.min ?? 1), p1: String(options.max ?? 600) })
          : t(DURATION_KEYS[reason]),
      [t],
    ),
    email: useCallback((reason: EmailReason) => t(EMAIL_KEYS[reason]), [t]),
    pin: useCallback((reason: PinReason) => t(PIN_KEYS[reason]), [t]),
    count: useCallback(
      (reason: CountReason, options: CountOptions = {}) =>
        reason === 'range'
          ? t(COUNT_KEYS.range, { p0: String(options.min ?? 1), p1: String(options.max ?? 9999) })
          : t(COUNT_KEYS[reason]),
      [t],
    ),
  };
}
