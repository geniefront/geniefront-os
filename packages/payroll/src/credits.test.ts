/**
 * 额度与充值的纯逻辑测试。
 *
 * 每一条都在问同一个问题：**这一行没了，客户的账单会怎么错？**
 * 因为这些函数回答的全是客户会打电话来问的问题 ——
 * 「为什么扣我积分」「为什么没自动充上」「我的分钟去哪了」。
 */

import { describe, it, expect } from 'vitest';
import {
  creditsFor, minutesFor, MILLICENTS_PER_CREDIT,
  PLAN_QUOTAS, planQuota, includedFor,
  TOPUP_PRICE_CENTS, TOPUP_UNITS, unitsPerTopup,
  allocateQuota, shouldAutoTopup, applyEntry, replayBalance, findLedgerBreak,
  TOPUP_COOLDOWN_MS, MAX_TOPUP_FAILURES, DEFAULT_TOPUP_THRESHOLD,
  isQuotaUnit, QUOTA_UNITS,
  type AutoTopupState,
} from './credits';

const NOW = new Date('2026-08-17T12:00:00Z');

const acct = (over: Partial<AutoTopupState> = {}): AutoTopupState => ({
  balance: 10,
  enabled: true,
  thresholdUnits: 50,
  lastAt: null,
  failures: 0,
  defaultPaymentMethodId: 'pm_test',
  subscriptionStatus: 'active',
  includedRemaining: 0,
  ...over,
});

// ───────────────────────────────────────────────────────────── 单位与换算

describe('额度单位', () => {
  it('只有两种', () => {
    expect(QUOTA_UNITS).toEqual(['credit', 'voice_minute']);
    expect(isQuotaUnit('credit')).toBe(true);
    expect(isQuotaUnit('sms')).toBe(false);
  });

  it('⭐ 没有任何「积分 ↔ 分钟」的换算函数', async () => {
    // 一分钟电话的成本是一次副驾操作的 5.6 倍（$0.056 vs $0.01）。
    // 只要能换，客户就会把额度全换成最贵的那种用 —— 而那恰恰是最忙、
    // 最该赚钱的客户（决策 8）。这条测试是留给以后想加换算的人看的。
    const mod = await import('./credits');
    const suspicious = Object.keys(mod).filter((k) =>
      /convert|exchange|swap|toMinutes|toCredits/i.test(k));
    expect(suspicious).toEqual([]);
  });
});

describe('1 积分 = $0.01 的真实成本', () => {
  it('实测的三档各扣几个积分', () => {
    // 实测（05 §6.0）：只读回答 292 毫分、带工具 1020、复杂 3429
    expect(creditsFor(292)).toBe(1);      // 不足一分也算一个 —— 向上取整
    expect(creditsFor(1020)).toBe(2);
    expect(creditsFor(3429)).toBe(4);
  });

  it('⭐ 拍照开店自然扣得多，不用单独定规则', () => {
    // Opus 一张图 $0.08 = 8000 毫分 → 8 积分。
    // 用同一把尺子量，就不会有人拿它当免费午餐
    expect(creditsFor(8000)).toBe(8);
  });

  it('成本为 0 不扣 —— 关键词直接答的那些', () => {
    expect(creditsFor(0)).toBe(0);
    expect(creditsFor(-5)).toBe(0);
  });

  it('一分钱一个积分', () => {
    expect(MILLICENTS_PER_CREDIT).toBe(1000);
    expect(creditsFor(1000)).toBe(1);
    expect(creditsFor(1001)).toBe(2);
  });
});

describe('语音按分钟向上取整', () => {
  it('29 秒也算一分钟 —— 电话行业的通行口径', () => {
    expect(minutesFor(29)).toBe(1);
    expect(minutesFor(60)).toBe(1);
    expect(minutesFor(61)).toBe(2);
    expect(minutesFor(0)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────── 套餐

describe('套餐额度', () => {
  it('Essential 500 积分 + 60 分钟；Growth 1200 + 500', () => {
    expect(PLAN_QUOTAS.essential).toEqual({ credits: 500, voiceMinutes: 60 });
    expect(PLAN_QUOTAS.growth).toEqual({ credits: 1200, voiceMinutes: 500 });
  });

  it('⭐ 认不出的套餐按最小的给 —— 试用期不能是无限额度', () => {
    // 给无限额度的话试用期会被薅（04 §4.2）
    expect(planQuota('trialing_whatever')).toEqual(PLAN_QUOTAS.essential);
    expect(includedFor('乱七八糟', 'voice_minute')).toBe(60);
  });
});

describe('充值', () => {
  it('$50 换 1000 积分 或 200 分钟', () => {
    expect(TOPUP_PRICE_CENTS).toBe(5000);
    expect(TOPUP_UNITS.credit).toBe(1000);
    expect(TOPUP_UNITS.voice_minute).toBe(200);
    expect(unitsPerTopup('voice_minute')).toBe(200);
  });

  it('单价与毛利：积分 $0.05(80%)、语音 $0.25(78%)', () => {
    const creditPrice = TOPUP_PRICE_CENTS / TOPUP_UNITS.credit;      // 分
    const minutePrice = TOPUP_PRICE_CENTS / TOPUP_UNITS.voice_minute;
    expect(creditPrice).toBe(5);      // $0.05，成本 $0.01
    expect(minutePrice).toBe(25);     // $0.25，成本 $0.056
  });
});

// ─────────────────────────────────────────────────── 先用套餐里的

describe('先用套餐里的', () => {
  const base = { plan: 'essential', unit: 'credit' as const, balance: 100 };

  it('套餐内够用时不动充值余额', () => {
    expect(allocateQuota(3, { ...base, includedUsed: 0 })).toEqual({
      source: 'included', fromIncluded: 3, fromBalance: 0,
      includedRemaining: 497, balanceAfter: 100,
    });
  });

  it('⭐ 一次可以跨两边扣 —— 别浪费掉最后那几个额度', () => {
    // 套餐内还剩 3 个而这次要扣 8 个：3 个走额度 + 5 个走余额。
    // 「不够就整笔走余额」会让老板白白丢掉 3 个已经付过钱的额度
    expect(allocateQuota(8, { ...base, includedUsed: 497 })).toEqual({
      source: 'balance', fromIncluded: 3, fromBalance: 5,
      includedRemaining: 0, balanceAfter: 95,
    });
  });

  it('套餐内用完了全走余额', () => {
    expect(allocateQuota(4, { ...base, includedUsed: 500 })).toMatchObject({
      source: 'balance', fromIncluded: 0, fromBalance: 4, balanceAfter: 96,
    });
  });

  it('⭐ 余额允许扣成负数 —— 调用已经发生了，拒绝记账不会把它变没', () => {
    // 相反的做法会导致用量照常发生、账上却看不到，
    // 到月底突然冒出一笔对不上的差额
    expect(allocateQuota(10, { ...base, includedUsed: 500, balance: 3 }))
      .toMatchObject({ fromBalance: 10, balanceAfter: -7 });
  });

  it('语音走自己的那本账，和积分互不相干', () => {
    expect(allocateQuota(70, {
      plan: 'essential', unit: 'voice_minute', includedUsed: 0, balance: 200,
    })).toEqual({
      source: 'balance', fromIncluded: 60, fromBalance: 10,
      includedRemaining: 0, balanceAfter: 190,
    });
  });

  it('扣 0 个不算扣费', () => {
    expect(allocateQuota(0, { ...base, includedUsed: 0 }).source).toBe('included');
  });

  it('负数或小数直接报错，不猜', () => {
    expect(() => allocateQuota(-1, { ...base, includedUsed: 0 })).toThrow();
    expect(() => allocateQuota(1.5, { ...base, includedUsed: 0 })).toThrow();
  });
});

// ───────────────────────────────────────────────────────────── 自动续充

describe('自动续充', () => {
  it('余额低于阈值 + 有卡 + 订阅正常 + 套餐内用完 → 充', () => {
    expect(shouldAutoTopup('credit', acct(), NOW))
      .toEqual({ charge: true, priceCents: 5000, units: 1000 });
    expect(shouldAutoTopup('voice_minute', acct(), NOW))
      .toEqual({ charge: true, priceCents: 5000, units: 200 });
  });

  it('⭐ 套餐内还有额度就不充 —— 否则刚续期的账户会被白扣一笔 $50', () => {
    expect(shouldAutoTopup('credit', acct({ includedRemaining: 300 }), NOW))
      .toEqual({ charge: false, reason: 'included_remaining' });
  });

  it('余额还够就不充', () => {
    expect(shouldAutoTopup('credit', acct({ balance: 500 }), NOW))
      .toEqual({ charge: false, reason: 'above_threshold' });
  });

  it('⭐ 订阅停了就不再充 —— 那是最容易变成投诉和拒付的操作', () => {
    expect(shouldAutoTopup('credit', acct({ subscriptionStatus: 'canceled' }), NOW))
      .toEqual({ charge: false, reason: 'subscription_inactive' });
  });

  it('没绑卡不充', () => {
    expect(shouldAutoTopup('credit', acct({ defaultPaymentMethodId: null }), NOW))
      .toEqual({ charge: false, reason: 'no_payment_method' });
  });

  it('⭐ 冷却期内不充 —— 不然一晚上能触发几十次扣款尝试', () => {
    // 每一次都是客户账单上的一条失败记录，而银行看到连续失败会把卡冻了
    const justNow = new Date(NOW.getTime() - TOPUP_COOLDOWN_MS + 1000);
    expect(shouldAutoTopup('credit', acct({ lastAt: justNow }), NOW))
      .toEqual({ charge: false, reason: 'cooling_down' });

    const longAgo = new Date(NOW.getTime() - TOPUP_COOLDOWN_MS - 1000);
    expect(shouldAutoTopup('credit', acct({ lastAt: longAgo }), NOW).charge).toBe(true);
  });

  it('⭐ 连续失败到上限就停手', () => {
    expect(shouldAutoTopup('credit', acct({ failures: MAX_TOPUP_FAILURES }), NOW))
      .toEqual({ charge: false, reason: 'too_many_failures' });
    expect(shouldAutoTopup('credit', acct({ failures: MAX_TOPUP_FAILURES - 1 }), NOW).charge)
      .toBe(true);
  });

  it('每个不充的分支都有名字 —— 出账单纠纷时要能回答「为什么那天没充上」', () => {
    const reasons = [
      shouldAutoTopup('credit', acct({ enabled: false }), NOW),
      shouldAutoTopup('credit', acct({ defaultPaymentMethodId: null }), NOW),
      shouldAutoTopup('credit', acct({ balance: 9999 }), NOW),
      shouldAutoTopup('credit', acct({ subscriptionStatus: 'canceled' }), NOW),
      shouldAutoTopup('credit', acct({ failures: 9 }), NOW),
      shouldAutoTopup('credit', acct({ includedRemaining: 1 }), NOW),
    ].map((r) => (r.charge ? 'charged' : r.reason));
    expect(new Set(reasons).size).toBe(reasons.length);   // 每个都不一样
  });

  it('默认阈值：积分 50、分钟 20', () => {
    expect(DEFAULT_TOPUP_THRESHOLD).toEqual({ credit: 50, voice_minute: 20 });
  });
});

// ─────────────────────────────────────────────────────────────────── 账本

describe('账本', () => {
  it('充值为正、扣费为负', () => {
    expect(applyEntry(0, { kind: 'topup', unit: 'credit', amount: 1000 }).balanceAfter)
      .toBe(1000);
    expect(applyEntry(1000, { kind: 'usage', unit: 'credit', amount: -4 }).balanceAfter)
      .toBe(996);
  });

  it('方向和类型对不上就报错 —— 「充值 −1000」不能混进账本', () => {
    expect(() => applyEntry(0, { kind: 'topup', unit: 'credit', amount: -1000 }))
      .toThrow(/必须为正/);
    expect(() => applyEntry(0, { kind: 'usage', unit: 'credit', amount: 5 }))
      .toThrow(/必须为负/);
  });

  it('调账必须写原因 —— 没有原因的调账是查不清的账', () => {
    expect(() => applyEntry(0, { kind: 'adjustment', unit: 'credit', amount: 10 }))
      .toThrow(/必须写原因/);
    expect(applyEntry(0, {
      kind: 'adjustment', unit: 'credit', amount: 10, reason: '客服补偿',
    }).balanceAfter).toBe(10);
  });

  it('未知单位报错', () => {
    expect(() => applyEntry(0, {
      kind: 'topup', unit: 'sms' as never, amount: 1,
    })).toThrow(/未知的额度单位/);
  });

  it('小数报错', () => {
    expect(() => applyEntry(0, { kind: 'topup', unit: 'credit', amount: 1.5 })).toThrow();
  });

  it('⭐ 对账按单位分开算 —— 混在一起加得到的是个没意义的数', () => {
    const rows = [
      { unit: 'credit' as const, amount: 1000 },
      { unit: 'voice_minute' as const, amount: 200 },
      { unit: 'credit' as const, amount: -4 },
    ];
    expect(replayBalance(rows, 'credit')).toBe(996);
    expect(replayBalance(rows, 'voice_minute')).toBe(200);
  });

  it('⭐ 账本行被就地改过能被指出来', () => {
    const good = [
      { unit: 'credit' as const, amount: 1000, balanceAfter: 1000 },
      { unit: 'credit' as const, amount: -4, balanceAfter: 996 },
    ];
    expect(findLedgerBreak(good, 'credit')).toBeNull();

    const tampered = [
      { unit: 'credit' as const, amount: 1000, balanceAfter: 1000 },
      { unit: 'credit' as const, amount: -4, balanceAfter: 9999 },   // 被改过
    ];
    expect(findLedgerBreak(tampered, 'credit')).toBe(1);
  });

  it('⭐ 一种单位的断点不会误报到另一种上', () => {
    const rows = [
      { unit: 'credit' as const, amount: 1000, balanceAfter: 1000 },
      { unit: 'voice_minute' as const, amount: 200, balanceAfter: 200 },
      { unit: 'credit' as const, amount: -4, balanceAfter: 996 },
    ];
    expect(findLedgerBreak(rows, 'credit')).toBeNull();
    expect(findLedgerBreak(rows, 'voice_minute')).toBeNull();
  });
});
