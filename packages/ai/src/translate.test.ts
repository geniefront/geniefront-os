/**
 * 项目名多语言补齐的纯函数（05 §4.4）。
 *
 * 每一条都在问：**这一行检查没有的话，客人会看到什么？**
 */

import { describe, it, expect } from 'vitest';
import {
  missingLocales, shouldTranslate, itemsNeedingTranslation,
  mergeTranslations, clearAutoFlag, buildTranslateRequest,
  type TranslatableItem,
} from './translate';

const item = (seq: number, name: Record<string, string>, kind = 'service',
              nameAuto: string[] = []): TranslatableItem => ({ seq, name, nameAuto, kind });

describe('缺哪些语言', () => {
  it('已经有值的不算缺', () => {
    expect(missingLocales(item(1, { en: 'Gel Manicure', 'zh-Hans': '光疗美甲' })))
      .toEqual(['zh-Hant', 'ko', 'vi', 'es']);
  });

  it('空字符串和纯空格算缺 —— 否则界面上会是一个空按钮', () => {
    expect(missingLocales(item(1, { en: 'Pedicure', ko: '', vi: '   ' })))
      .toContain('ko');
    expect(missingLocales(item(1, { en: 'Pedicure', ko: '', vi: '   ' })))
      .toContain('vi');
  });
});

describe('哪些行该翻译', () => {
  it('说明和改价规则不翻 —— 那是价目表上的话，不是项目库里的东西', () => {
    expect(shouldTranslate('service')).toBe(true);
    expect(shouldTranslate('addon')).toBe(true);
    expect(shouldTranslate('note')).toBe(false);
    expect(shouldTranslate('price_modifier')).toBe(false);
  });

  it('已经齐全的不再送去翻译 —— 白花钱', () => {
    const full = Object.fromEntries(
      ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'].map((l) => [l, 'x']));
    const need = itemsNeedingTranslation([
      item(1, full),
      item(2, { en: 'Dip Powder' }),
      item(3, { en: 'Cash only' }, 'note'),
    ]);
    expect(need.map((i) => i.seq)).toEqual([2]);
  });
});

describe('合并翻译', () => {
  it('正常补齐，并记下哪些格是机器填的', () => {
    const out = mergeTranslations(
      [item(1, { en: 'Gel Manicure' })],
      [{ seq: 1, names: { 'zh-Hans': '光疗美甲', vi: 'sơn gel' } }]);

    expect(out.rejected).toBeUndefined();
    expect(out.items[0]!.name).toEqual({
      en: 'Gel Manicure', 'zh-Hans': '光疗美甲', vi: 'sơn gel',
    });
    expect(out.items[0]!.nameAuto.sort()).toEqual(['vi', 'zh-Hans']);
    expect(out.filledItems).toBe(1);
    expect(out.filledCells).toBe(2);
  });

  it('⭐ seq 对不上就整批拒绝 —— 一个字都不改', () => {
    // 错位的翻译是静默错误的极端形态：`Gel Manicure` 配上「修脚」，
    // Zod 过得去、界面正常、老板扫一眼中文觉得没问题 ——
    // 直到越南客人在门口自助屏上点了「修脚」，做出来是美甲。
    const items = [item(1, { en: 'Gel Manicure' }), item(2, { en: 'Pedicure' })];
    const out = mergeTranslations(items, [
      { seq: 1, names: { 'zh-Hans': '光疗美甲' } },
      { seq: 99, names: { 'zh-Hans': '修脚' } },   // 模型重编号了
    ]);

    expect(out.rejected).toBe('seq_mismatch');
    expect(out.filledCells).toBe(0);
    // 连能对上的那一条也不写 —— 对不上说明整批的对齐都不可信
    expect(out.items[0]!.name).toEqual({ en: 'Gel Manicure' });
  });

  it('⭐ 已有的语言绝不覆盖 —— 原文是老板核对照片的锚点', () => {
    const out = mergeTranslations(
      [item(1, { en: 'Mani', 'zh-Hans': '老板自己写的' }, 'service', [])],
      [{ seq: 1, names: { en: 'Manicure', 'zh-Hans': '指甲护理' } }]);

    expect(out.items[0]!.name['en']).toBe('Mani');            // 照片上印的就是 Mani
    expect(out.items[0]!.name['zh-Hans']).toBe('老板自己写的');
    expect(out.items[0]!.nameAuto).toEqual([]);               // 一格都没填，不该标 auto
    expect(out.filledCells).toBe(0);
  });

  it('编出来的语言代码直接忽略', () => {
    const out = mergeTranslations(
      [item(1, { en: 'Wax' })],
      [{ seq: 1, names: { ja: 'ワックス', 'zh-Hans': '脱毛' } }]);
    expect(out.items[0]!.name['ja']).toBeUndefined();
    expect(out.items[0]!.name['zh-Hans']).toBe('脱毛');
  });

  it('空翻译不算填充 —— 否则界面上是个空按钮却不显示「缺翻译」', () => {
    const out = mergeTranslations(
      [item(1, { en: 'Wax' })], [{ seq: 1, names: { ko: '   ' } }]);
    expect(out.items[0]!.name['ko']).toBeUndefined();
    expect(out.items[0]!.nameAuto).toEqual([]);
  });

  it('模型什么都没返回时明确报空，不是「成功补齐 0 条」', () => {
    const out = mergeTranslations([item(1, { en: 'Wax' })], []);
    expect(out.rejected).toBe('empty');
  });
});

describe('老板改过之后', () => {
  it('清掉 auto 标记 —— 否则他亲手写的名字会一直显示成淡色', () => {
    expect(clearAutoFlag(['zh-Hans', 'ko', 'vi'], 'ko')).toEqual(['zh-Hans', 'vi']);
  });
});

describe('送给模型的请求', () => {
  it('只列缺的语言，已有的原样附上供参考', () => {
    const txt = buildTranslateRequest([item(1, { en: 'Gel-X' })]);
    expect(txt).toContain('seq=1');
    expect(txt).toContain('en=Gel-X');
    expect(txt).toContain('需要补: zh-Hans, zh-Hant, ko, vi, es');
    expect(txt).toContain('已有的语言原样不动');
  });
});
