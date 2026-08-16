import { describe, it, expect } from 'vitest';
import { largestRemainderSplit, distributeBuckets } from './split';
import {
  computeCommission, settleDayPay, assertValidPlan, explainCommission,
  DEFAULT_PLAN, CompensationPlanError, type CompensationPlan, type RevenueItem,
} from './commission';

const plan = (over: Partial<CompensationPlan> = {}): CompensationPlan => ({
  ...DEFAULT_PLAN, ...over,
});

const item = (over: Partial<RevenueItem> = {}): RevenueItem => ({
  ticketItemId: 'i1', kind: 'service', categoryId: null,
  grossCents: 10_000, itemDiscountCents: 0,
  staff: [{ membershipId: 'a', role: 'primary', minutes: 60 }],
  ...over,
});

describe('largestRemainderSplit', () => {
  it('拆出来的各份之和恒等于总额', () => {
    for (const total of [1, 7, 99, 100, 3333, 10_001]) {
      for (const ws of [[1, 1, 1], [3, 5, 7], [1, 0, 0], [60, 30, 30]]) {
        const out = largestRemainderSplit(total, ws);
        expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('负数是正数结果的精确相反数 —— 冲账才对得上', () => {
    const pos = largestRemainderSplit(1000, [3, 5, 7]);
    const neg = largestRemainderSplit(-1000, [3, 5, 7]);
    expect(neg).toEqual(pos.map((x) => -x));
  });

  it('权重全 0 时默认平均分，不把钱吞掉', () => {
    expect(largestRemainderSplit(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it('结果确定：同样的输入永远给同样的答案', () => {
    const a = largestRemainderSplit(100, [1, 1, 1]);
    const b = largestRemainderSplit(100, [1, 1, 1]);
    expect(a).toEqual(b);
  });
});

describe('提成引擎', () => {
  it('基础：净额 × 费率', () => {
    const r = computeCommission({ items: [item()], plans: { a: plan({ rateBp: 4500 }) } });
    expect(r.byStaff[0]!.commissionCents).toBe(4500);   // $100 × 45%
  });

  it('小费永远不进基数 —— 引擎压根不接收小费参数', () => {
    // 这条靠类型保证：RevenueItem 没有 tip 字段，调用方无从传入。
    // 断言留在这里是为了让改结构的人看到这行注释。
    expect(Object.keys(item())).not.toContain('tipCents');
  });

  it('base=net 时折扣压低提成，base=gross 时不压', () => {
    const it0 = item({ itemDiscountCents: 2000 });
    const net = computeCommission({ items: [it0], plans: { a: plan({ base: 'net', rateBp: 5000 }) } });
    const gross = computeCommission({ items: [it0], plans: { a: plan({ base: 'gross', rateBp: 5000 }) } });
    expect(net.byStaff[0]!.commissionCents).toBe(4000);   // (100-20) × 50%
    expect(gross.byStaff[0]!.commissionCents).toBe(5000);
  });

  it('单据级折扣按各 item 原价摊回去', () => {
    const items = [
      item({ ticketItemId: 'i1', grossCents: 6000 }),
      item({ ticketItemId: 'i2', grossCents: 4000 }),
    ];
    const r = computeCommission({
      items, ticketDiscountCents: 1000, plans: { a: plan({ rateBp: 10_000 }) },
    });
    // 折扣 $10 按 6:4 摊 → 基数 (60-6) + (40-4) = 90
    expect(r.byStaff[0]!.baseCents).toBe(9000);
  });

  it('双技师：营业额按分钟 × 角色权重分摊，不是每人算全额', () => {
    const r = computeCommission({
      items: [item({
        grossCents: 10_000,
        staff: [
          { membershipId: 'a', role: 'primary', minutes: 60 },
          { membershipId: 'b', role: 'assistant', minutes: 60 },
        ],
      })],
      plans: { a: plan({ rateBp: 5000 }), b: plan({ rateBp: 5000 }) },
    });
    const total = r.byStaff.reduce((s, x) => s + x.baseCents, 0);
    expect(total).toBe(10_000);                      // 关键：合计不超过营业额
    const a = r.byStaff.find((x) => x.membershipId === 'a')!;
    const b = r.byStaff.find((x) => x.membershipId === 'b')!;
    expect(a.baseCents).toBeGreaterThan(b.baseCents); // 主技师拿大头
  });

  it('分钟数全是 0（前台没记时长）时退化成角色权重，不把提成算成 0', () => {
    const r = computeCommission({
      items: [item({
        staff: [
          { membershipId: 'a', role: 'primary', minutes: 0 },
          { membershipId: 'b', role: 'assistant', minutes: 0 },
        ],
      })],
      plans: { a: plan(), b: plan() },
    });
    expect(r.byStaff.every((x) => x.baseCents > 0)).toBe(true);
    expect(r.byStaff.reduce((s, x) => s + x.baseCents, 0)).toBe(10_000);
  });

  it('零售走独立费率，混合时 basis 列出明细', () => {
    const r = computeCommission({
      items: [
        item({ ticketItemId: 'i1', grossCents: 10_000 }),
        item({ ticketItemId: 'i2', kind: 'retail', grossCents: 5_000 }),
      ],
      plans: { a: plan({ rateBp: 4000, retailRateBp: 1000 }) },
    });
    expect(r.byStaff[0]!.commissionCents).toBe(4000 + 500);
    expect(r.byStaff[0]!.basis.mixedRates).toHaveLength(2);
    expect(explainCommission(r.byStaff[0]!)).toContain('零售');
  });

  it('分类费率覆盖默认费率', () => {
    const r = computeCommission({
      items: [item({ categoryId: 'cat-wax' })],
      plans: { a: plan({ rateBp: 4000, categoryRateBp: { 'cat-wax': 6000 } }) },
    });
    expect(r.byStaff[0]!.commissionCents).toBe(6000);
  });

  it('租椅技师门店不发提成', () => {
    const r = computeCommission({
      items: [item()],
      plans: { a: plan({ kind: 'booth_rent' }) },
    });
    expect(r.byStaff[0]!.commissionCents).toBe(0);
    expect(explainCommission(r.byStaff[0]!)).toContain('租椅');
  });

  it('无人认领的行不产生提成', () => {
    const r = computeCommission({ items: [item({ staff: [] })], plans: {} });
    expect(r.byStaff).toHaveLength(0);
  });

  it('非法方案当场拒绝', () => {
    expect(() => assertValidPlan(plan({ rateBp: 12_000 }))).toThrow(CompensationPlanError);
    expect(() => assertValidPlan(plan({ kind: 'hourly', hourlyRateCents: 0 }))).toThrow(/时薪/);
  });
});

describe('保底与时薪', () => {
  const hourlyPlan = plan({ kind: 'commission_vs_hourly', hourlyRateCents: 1800, rateBp: 4000 });

  it('提成高于保底时发提成', () => {
    const d = settleDayPay(20_000, 8 * 60, hourlyPlan);
    expect(d.paidBy).toBe('commission');
    expect(d.payCents).toBe(20_000);
  });

  it('提成不足保底时发时薪 —— 取大值不是相加', () => {
    const d = settleDayPay(5_000, 8 * 60, hourlyPlan);
    expect(d.paidBy).toBe('hourly');
    expect(d.payCents).toBe(14_400);          // $18 × 8h
    expect(d.payCents).not.toBe(5_000 + 14_400);
  });

  it('纯时薪不看营业额', () => {
    const d = settleDayPay(99_999, 4 * 60, plan({ kind: 'hourly', hourlyRateCents: 1500 }));
    expect(d.payCents).toBe(6_000);
  });
});

describe('distributeBuckets（组单合并结账）', () => {
  it('每张单拿到的钱和每种支付方式的合计【同时】精确', () => {
    const needs = [3_333, 3_333, 3_334];         // 三张单
    const buckets = [5_000, 5_000];              // 现金 $50 + 刷卡 $50
    const m = distributeBuckets(needs, buckets);
    needs.forEach((n, i) => expect(m[i]!.reduce((a, b) => a + b, 0)).toBe(n));
    buckets.forEach((b, j) =>
      expect(m.reduce((s, row) => s + row[j]!, 0)).toBe(b));
  });

  it('现金先冲抵前面的单，用完了刷卡顶上 —— 前台解释得清', () => {
    const m = distributeBuckets([4_000, 4_000], [5_000, 3_000]);
    expect(m[0]).toEqual([4_000, 0]);
    expect(m[1]).toEqual([1_000, 3_000]);
  });

  it('总额对不上时当场拒绝，不静默吞掉差额', () => {
    expect(() => distributeBuckets([100], [99])).toThrow(/无法填充/);
  });

  it('0 元的单不占用任何桶', () => {
    const m = distributeBuckets([0, 100], [100]);
    expect(m[0]).toEqual([0]);
    expect(m[1]).toEqual([100]);
  });
});
