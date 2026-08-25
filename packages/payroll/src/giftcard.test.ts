import { describe, it, expect } from 'vitest';
import {
  balanceOfLedger, planRedeem, commissionBaseForGiftCard,
  encodeCardCode, normalizeCardCode,
} from './giftcard';

describe('礼品卡余额', () => {
  it('余额 = 账本求和', () => {
    expect(balanceOfLedger([
      { entry: 'issue', amountCents: 10000 },
      { entry: 'redeem', amountCents: -3000 },
      { entry: 'redeem', amountCents: -2000 },
    ])).toBe(5000);
  });

  it('冲销之后回到冲销前', () => {
    expect(balanceOfLedger([
      { entry: 'issue', amountCents: 10000 },
      { entry: 'redeem', amountCents: -3000 },
      { entry: 'refund', amountCents: 3000 },
    ])).toBe(10000);
  });

  it('空账本是 0，不是 NaN', () => {
    expect(balanceOfLedger([])).toBe(0);
  });
});

describe('核销', () => {
  it('⭐ 不足额时付一部分，不整笔拒绝', () => {
    // 一张 $30 的卡遇到 $80 的单：扣 $30，剩下 $50 走别的方式。
    // 整笔拒绝的话，前台要当着客人的面把卡还回去
    expect(planRedeem(3000, 8000)).toEqual({
      appliedCents: 3000, remainingCents: 0, shortfallCents: 5000,
    });
  });

  it('够付时全付，卡上还剩钱', () => {
    expect(planRedeem(10000, 3000)).toEqual({
      appliedCents: 3000, remainingCents: 7000, shortfallCents: 0,
    });
  });

  it('⭐ 负余额和零一律当 0，不抛异常 —— 结账不能被卡住', () => {
    expect(planRedeem(-500, 8000).appliedCents).toBe(0);
    expect(planRedeem(0, 8000).shortfallCents).toBe(8000);
  });

  it('小数一律向下取整 —— 分是最小单位', () => {
    expect(planRedeem(3000.9, 8000.9).appliedCents).toBe(3000);
  });
});

describe('⭐ 提成基数：面值还是售价（老板设的）', () => {
  // 一张面值 $100、售价 $80 的卡，这次用掉 $50
  const applied = 5000; const face = 10000; const sale = 8000;

  it('face —— 客人享受了多少服务就提多少，店家吃掉折扣', () => {
    expect(commissionBaseForGiftCard('face', applied, face, sale)).toBe(5000);
  });

  it('sale —— 店家收到多少就提多少，折扣双方分担', () => {
    // 用掉一半面值 → 按一半售价算 = $40
    expect(commissionBaseForGiftCard('sale', applied, face, sale)).toBe(4000);
  });

  it('⭐ 分摊余数留在店家这边，不给技师多算', () => {
    // $33 / $100 × $80 = $26.4 → 向下取整成 $26
    expect(commissionBaseForGiftCard('sale', 3300, 10000, 8000)).toBe(2640);
    expect(commissionBaseForGiftCard('sale', 1, 3, 2)).toBe(0);
  });

  it('面值为 0 的脏数据不炸，返回 0', () => {
    expect(commissionBaseForGiftCard('sale', 5000, 0, 8000)).toBe(0);
  });
});

describe('卡号', () => {
  it('22 位 + 分组横线，字母表里没有易混的 I/L/O/U', () => {
    const code = encodeCardCode(new Uint8Array(32).fill(7));
    expect(code.replace(/-/g, '')).toHaveLength(22);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z-]+$/);
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('规范化：客人念的时候不会带横线，大小写也不一定对', () => {
    expect(normalizeCardCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeCardCode(' a b c d ')).toBe('ABCD');
  });

  it('⭐ 不同随机源给出不同卡号 —— 能猜的卡号等于把钱放门口', () => {
    const a = encodeCardCode(Uint8Array.from({ length: 32 }, (_, i) => i));
    const b = encodeCardCode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(a).not.toBe(b);
  });
});
