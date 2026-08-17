/**
 * 余额与自动续充的测试。
 *
 * 这一层每一条都直接对应钱：算错了不是界面难看，是**多收或少收客户的钱**。
 * 所以每个用例都在问「这一行没有的话，谁会损失什么」。
 */

import { describe, it, expect } from 'vitest';
import {
  shouldAutoTopup, applyEntry, replayBalance, findLedgerBreak,
  usageChargeCents, isTopupTier, TOPUP_TIERS, TOPUP_COOLDOWN_MS, MAX_TOPUP_FAILURES,
  consumeIncluded, includedAssistsFor, PLAN_INCLUDED_ASSISTS,
  AUTO_TOPUP_TIERS, isAutoTopupTier, DEFAULT_AUTO_TOPUP_CENTS,
  type BillingAccountState,
} from './credits';

const NOW = new Date('2026-08-16T12:00:00Z');

function acct(over: Partial<BillingAccountState> = {}): BillingAccountState {
  return {
    balanceCents: 500,                 // $5，低于默认 $10 的阈值
    autoTopupEnabled: true,
    autoTopupThresholdCents: 1000,
    autoTopupAmountCents: 10000,
    lastAutoTopupAt: null,
    autoTopupFailures: 0,
    defaultPaymentMethodId: 'pm_123',
    subscriptionStatus: 'active',
    ...over,
  };
}

describe('自动续充三档', () => {
  it('只有 $50 / $100 / $200 三个值合法', () => {
    // 让客户填任意金额会引来试卡的人（拿被盗的卡刷 $0.5 试活）
    expect(TOPUP_TIERS).toEqual([2000, 5000, 10000]);
    expect(isTopupTier(5000)).toBe(true);
    expect(isTopupTier(10000)).toBe(true);
    expect(isTopupTier(20000)).toBe(false);

    // ⭐ 自动续充是**更窄的一张表**：$20 只给手动充值。
    // 拿 $20 做自动续充，一家忙店一个月要被扣 1.5 次 ——
    // 每次都是客户账单上的一条记录和一通「怎么又扣钱」的电话
    expect(AUTO_TOPUP_TIERS).toEqual([5000, 10000]);
    expect(isAutoTopupTier(2000)).toBe(false);
    expect(isAutoTopupTier(10000)).toBe(true);
    expect(isTopupTier(4999)).toBe(false);
    expect(isTopupTier(50)).toBe(false);
  });
});

describe('该不该现在自动续充', () => {
  it('余额低于阈值、卡在、订阅正常 → 充', () => {
    expect(shouldAutoTopup(acct(), NOW)).toEqual({ charge: true, amountCents: 10000 });
  });

  it('余额还够就不充', () => {
    expect(shouldAutoTopup(acct({ balanceCents: 50000 }), NOW))
      .toEqual({ charge: false, reason: 'above_threshold' });
  });

  it('恰好等于阈值也充 —— 边界上宁可早一步', () => {
    // 「刚好等于」时不充的话，下一次调用就把余额扣成负的了
    expect(shouldAutoTopup(acct({ balanceCents: 1000 }), NOW).charge).toBe(true);
  });

  it('没开自动续充就不充', () => {
    expect(shouldAutoTopup(acct({ autoTopupEnabled: false }), NOW))
      .toEqual({ charge: false, reason: 'disabled' });
  });

  it('没有卡就不充', () => {
    expect(shouldAutoTopup(acct({ defaultPaymentMethodId: null }), NOW))
      .toEqual({ charge: false, reason: 'no_payment_method' });
  });

  it('⭐ 订阅已停就不再往余额里充钱', () => {
    // 客户已经在走流失流程，这时候扣他 $50 最容易变成投诉和拒付
    for (const s of ['canceled', 'past_due']) {
      expect(shouldAutoTopup(acct({ subscriptionStatus: s }), NOW))
        .toEqual({ charge: false, reason: 'subscription_inactive' });
    }
    expect(shouldAutoTopup(acct({ subscriptionStatus: 'trialing' }), NOW).charge).toBe(true);
  });

  it('⭐ 冷却期内不重复扣 —— 防「续充风暴」', () => {
    // 没有这条，卡被拒时一晚上能触发几十次扣款尝试。
    // 每次都是账单上的一条失败记录，而银行看到连续失败会把卡冻了
    const justNow = new Date(NOW.getTime() - 60_000);
    expect(shouldAutoTopup(acct({ lastAutoTopupAt: justNow }), NOW))
      .toEqual({ charge: false, reason: 'cooling_down' });

    const longAgo = new Date(NOW.getTime() - TOPUP_COOLDOWN_MS - 1000);
    expect(shouldAutoTopup(acct({ lastAutoTopupAt: longAgo }), NOW).charge).toBe(true);
  });

  it('⭐ 连续失败几次就停手，别再骚扰那张卡', () => {
    expect(shouldAutoTopup(acct({ autoTopupFailures: MAX_TOPUP_FAILURES }), NOW))
      .toEqual({ charge: false, reason: 'too_many_failures' });
    expect(shouldAutoTopup(acct({ autoTopupFailures: MAX_TOPUP_FAILURES - 1 }), NOW).charge)
      .toBe(true);
  });

  it('档位存坏了不会扣出一个怪金额', () => {
    // 人工改过库、或者以后加了新档又回滚
    expect(shouldAutoTopup(acct({ autoTopupAmountCents: 7777 }), NOW))
      .toEqual({ charge: true, amountCents: DEFAULT_AUTO_TOPUP_CENTS });
  });

  it('⭐ 兜底用的是自动续充的默认档，不是手动充值的最小档', () => {
    // 兜到 $20 的话，一家忙店会一个月被扣三次 ——
    // 而那正是 $20 这一档不该用来自动续充的原因
    expect(shouldAutoTopup(acct({ autoTopupAmountCents: 2000 }), NOW))
      .toEqual({ charge: true, amountCents: DEFAULT_AUTO_TOPUP_CENTS });
    expect(DEFAULT_AUTO_TOPUP_CENTS).toBe(10000);
  });

  it('每个不充的分支都有名字 —— 出账单纠纷时要能回答「为什么那天没充上」', () => {
    const reasons = [
      shouldAutoTopup(acct({ autoTopupEnabled: false }), NOW),
      shouldAutoTopup(acct({ defaultPaymentMethodId: null }), NOW),
      shouldAutoTopup(acct({ balanceCents: 99999 }), NOW),
      shouldAutoTopup(acct({ subscriptionStatus: 'canceled' }), NOW),
    ].map((d) => (d.charge ? null : d.reason));
    expect(reasons.every(Boolean)).toBe(true);
    expect(new Set(reasons).size).toBe(4);
  });
});

describe('账本', () => {
  it('充值加、扣费减', () => {
    expect(applyEntry(0, { kind: 'topup', amountCents: 5000 }).balanceAfterCents).toBe(5000);
    expect(applyEntry(5000, { kind: 'usage', amountCents: -36 }).balanceAfterCents).toBe(4964);
  });

  it('⭐ 余额允许为负 —— 调用已经发生了，拒绝记账不会把它变没', () => {
    // 反过来做（余额不足就不记账）会导致用量照常发生、账上却看不到，
    // 月底冒出一笔对不上的差额，谁也说不清是哪几次调用
    expect(applyEntry(20, { kind: 'usage', amountCents: -100 }).balanceAfterCents).toBe(-80);
  });

  it('⭐ 只用整数分，小数直接报错', () => {
    expect(() => applyEntry(0, { kind: 'topup', amountCents: 12.5 })).toThrow(/整数分/);
  });

  it('⭐ 方向和类型必须对得上', () => {
    // 「充值 −$50」这种行混进账本之后，对账就永远对不平了
    expect(() => applyEntry(0, { kind: 'topup', amountCents: -5000 })).toThrow(/必须为正/);
    expect(() => applyEntry(0, { kind: 'usage', amountCents: 100 })).toThrow(/必须为负/);
  });

  it('⭐ 调账与冲销必须写原因', () => {
    expect(() => applyEntry(0, { kind: 'adjustment', amountCents: 500 })).toThrow(/原因/);
    expect(() => applyEntry(0, { kind: 'reversal', amountCents: -500 })).toThrow(/原因/);
    expect(applyEntry(0, { kind: 'adjustment', amountCents: 500, reason: '客服补偿' })
      .balanceAfterCents).toBe(500);
  });

  it('重放账本算出的余额，等于缓存的余额', () => {
    const entries = [
      { amountCents: 5000 }, { amountCents: -36 }, { amountCents: -12 },
      { amountCents: 10000 }, { amountCents: -240 },
    ];
    expect(replayBalance(entries)).toBe(14712);
  });

  it('⭐ 账本被就地改过一行 —— 能指出是第几行', () => {
    // 每行都记「这一笔之后余额是多少」，改一行必然和相邻行对不上，
    // 篡改因此是看得见的
    const clean = [
      { amountCents: 5000, balanceAfterCents: 5000 },
      { amountCents: -36, balanceAfterCents: 4964 },
      { amountCents: -12, balanceAfterCents: 4952 },
    ];
    expect(findLedgerBreak(clean)).toBeNull();

    const tampered = [...clean];
    tampered[1] = { amountCents: -36, balanceAfterCents: 4900 };
    expect(findLedgerBreak(tampered)).toBe(1);
  });
});

describe('用量折价', () => {
  // ⚠️ 单位是**毫分**（1/1000 分），不是分。$0.012 = 1.2 分 = 1200 毫分。
  // 差一个数量级的话，账单会差 10 倍 —— 而这是最难被发现的一类错
  it('副驾一次调用扣几分钱', () => {
    // 05 §7.1：缓存命中后约 $0.012/次 = 1200 毫分 → ×3.0 = 3600 毫分 = 3.6 分 → 4 分
    expect(usageChargeCents(1200, 'ai_assist')).toBe(4);
  });

  it('拍照开店那次实测（~$0.08/张）扣多少', () => {
    // 8000 毫分 = 8 分 → ×3.0 = 24 分
    expect(usageChargeCents(8000, 'ai_assist')).toBe(24);
  });

  it('电话按分钟，加价率更低（本来就贵）', () => {
    // 假设 $0.15/分钟 = 15 分 = 15000 毫分 → ×1.5 = 22.5 分 → 23 分
    expect(usageChargeCents(15000, 'ai_call_min')).toBe(23);
  });

  it('⭐ 向上取整 —— 每次少收一点点，累计起来就是我们在替客户付 AI 的钱', () => {
    expect(usageChargeCents(1, 'ai_assist')).toBe(1);
    expect(usageChargeCents(0, 'ai_assist')).toBe(0);
  });

  it('没定加价率的按 1.0x，不会算成 0', () => {
    // 漏配一个 kind 时收成本价，而不是免费送
    expect(usageChargeCents(10000, 'unknown_kind')).toBe(10);
  });

  it('全程整数', () => {
    for (const m of [1, 7, 999, 12345]) {
      expect(Number.isInteger(usageChargeCents(m, 'ai_assist'))).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────── 套餐内额度（先用套餐里的）

describe('先用套餐里的', () => {
  it('套餐内还有额度时走额度，不扣余额', () => {
    expect(consumeIncluded('ai_assist', 'essential', 0))
      .toEqual({ source: 'included', usedAfter: 1, remaining: 499 });
  });

  it('Growth 的额度更大', () => {
    expect(consumeIncluded('ai_assist', 'growth', 0))
      .toEqual({ source: 'included', usedAfter: 1, remaining: 1999 });
  });

  it('⭐ 用满了才开始扣余额 —— 边界上不能差一次', () => {
    // 第 500 次仍然走额度（用了 499 次，还剩 1 次）
    expect(consumeIncluded('ai_assist', 'essential', 499))
      .toEqual({ source: 'included', usedAfter: 500, remaining: 0 });
    // 第 501 次开始扣钱
    expect(consumeIncluded('ai_assist', 'essential', 500))
      .toEqual({ source: 'balance', remaining: 0 });
  });

  it('⭐ 电话分钟不吃副驾的额度 —— 合成一个额度必被套利（决策 8）', () => {
    // 一分钟电话的成本是一次副驾的 10–16 倍。让它们共用一个「次数」额度，
    // 电话量大的店会把额度全用在最贵的地方，而那恰恰是最该赚钱的客户
    expect(consumeIncluded('ai_call_min', 'growth', 0))
      .toEqual({ source: 'balance', remaining: 0 });
    expect(consumeIncluded('sms', 'growth', 0))
      .toEqual({ source: 'balance', remaining: 0 });
  });

  it('认不出的套餐按最小的给 —— 不能因为数据脏就变成无限额度', () => {
    // 试用期、或者以后加了新档又回滚，都会走到这一支。
    // 给无限额度的话，试用期会被薅（04 §4.2）
    expect(includedAssistsFor('trial_something')).toBe(PLAN_INCLUDED_ASSISTS.essential);
    expect(consumeIncluded('ai_assist', '乱七八糟', 499).source).toBe('included');
    expect(consumeIncluded('ai_assist', '乱七八糟', 500).source).toBe('balance');
  });
});
