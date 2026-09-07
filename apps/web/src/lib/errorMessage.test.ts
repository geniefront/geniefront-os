/**
 * 错误文案的完整性与优先级测试。
 *
 * 这里保护的是一条曾经真实发生的故障：服务端把「为什么失败」放在
 * `details.reason` 里，前端只映射了顶层错误码，于是
 * `combined_stage_not_available` 在前台显示成「输入内容格式有误，请核对」——
 * 前台无论如何都无法据此行动。
 */
import { describe, expect, it } from 'vitest';
import { ERROR_REASON_KEYS } from './errorMessage';
import { translations } from '@/i18n';
import { UI_LANGUAGES } from '@/i18n/types';

describe('details.reason 文案', () => {
  it('每个失败原因在全部界面语言下都有非空译文', () => {
    const missing: string[] = [];
    for (const { code } of UI_LANGUAGES) {
      for (const [reason, key] of Object.entries(ERROR_REASON_KEYS)) {
        const text = translations[code][key];
        if (typeof text !== 'string' || text.trim() === '') missing.push(`${code}/${reason}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('文案不得原样回吐失败原因标识符', () => {
    const leaked = Object.entries(ERROR_REASON_KEYS).filter(([reason]) =>
      UI_LANGUAGES.some(({ code }) => {
        const entry = ERROR_REASON_KEYS[reason];
        return entry !== undefined && translations[code][entry].includes(reason);
      }),
    );
    expect(leaked).toEqual([]);
  });

  it('计划中点名的收款阶段与回退原因均已覆盖', () => {
    /*
     * 这几条是运营看板的必经路径：门店一旦把结账时机设为先服务后小费，
     * 前三条几乎每天都会出现，缺一条就意味着前台当场卡住。
     */
    const required = [
      'combined_stage_not_available',
      'service_stage_not_available',
      'tip_stage_not_available',
      'ticket_exists_requires_void',
      'package_cannot_pay_tip',
      'stored_value_cannot_pay_tip',
      'tip_split_override_disabled',
      'appointment_ticket_exists',
      'resource_not_available',
    ];
    expect(required.filter((reason) => !(reason in ERROR_REASON_KEYS))).toEqual([]);
  });
});
