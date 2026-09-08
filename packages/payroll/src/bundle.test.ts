import { describe, it, expect } from 'vitest';
import {
  allocateBundle, refundableForUnit, BundlePricingError,
  type BundleComponentSpec,
} from './bundle';

const comp = (over: Partial<BundleComponentSpec> = {}): BundleComponentSpec => ({
  componentId: 'c1', serviceId: 's1', listPriceCents: 10_000, qty: 1, seq: 0,
  ...over,
});

describe('allocateBundle — 计划 §6.1 示例（A 100 / B 50 / C 20，套餐 150）', () => {
  const input = {
    components: [
      comp({ componentId: 'A', serviceId: 'sa', listPriceCents: 10_000, seq: 0 }),
      comp({ componentId: 'B', serviceId: 'sb', listPriceCents: 5_000, seq: 1 }),
      comp({ componentId: 'C', serviceId: 'sc', listPriceCents: 2_000, seq: 2 }),
    ],
    bundlePriceCents: 15_000,
  };

  it('原价合计与套餐内建优惠', () => {
    const r = allocateBundle(input);
    expect(r.originalTotalCents).toBe(17_000);
    expect(r.bundleDiscountCents).toBe(2_000);
  });

  it('各执行单元的套餐净额之和恒等于锁定套餐价（不变量 1）', () => {
    const r = allocateBundle(input);
    expect(r.units.reduce((n, u) => n + u.bundleNetCents, 0)).toBe(15_000);
  });

  it('分摊结果 = [8824, 4412, 1764]，与 §6.1 示例表 / B20 / B32 一致', () => {
    const r = allocateBundle(input);
    expect(r.units.map((u) => u.bundleNetCents)).toEqual([8_824, 4_412, 1_764]);
  });

  it('退 C（无额外优惠税费）：退 1764，剩余套餐 13236（B20）', () => {
    const r = allocateBundle(input);
    const c = r.units.find((u) => u.componentId === 'C')!;
    expect(c.netCents).toBe(1_764);
    const remaining = r.units.filter((u) => u.componentId !== 'C')
      .reduce((n, u) => n + u.netCents, 0);
    expect(remaining).toBe(13_236);
    expect(refundableForUnit(c.netCents, 0)).toBe(1_764);
  });

  it('服务净额合计 = 16500（含 B 额外加项 $15），与示例表一致（B05）', () => {
    const r = allocateBundle({
      ...input,
      extraAddons: [{ ref: 'x1', attachToUnit: 'B#0', listPriceCents: 1_500 }],
    });
    expect(r.extraAddonListTotalCents).toBe(1_500);
    expect(r.serviceNetTotalCents).toBe(16_500);
  });

  it('额外加项不吃套餐折扣：净额 === 目录价（B06）', () => {
    const r = allocateBundle({
      ...input,
      extraAddons: [{ ref: 'x1', attachToUnit: 'B#0', listPriceCents: 1_500 }],
    });
    expect(r.extraAddons[0]!.netCents).toBe(1_500);
    expect(r.extraAddons[0]!.extraDiscountCents).toBe(0);
  });
});

describe('allocateBundle — 执行单元展开（不变量 3）', () => {
  it('qty=2 展开成两个带 unitIndex 的单元，不对 serviceId 去重（B04）', () => {
    const r = allocateBundle({
      components: [comp({ componentId: 'A', serviceId: 'sa', listPriceCents: 10_000, qty: 2, seq: 0 })],
      bundlePriceCents: 15_000,
    });
    expect(r.units).toHaveLength(2);
    expect(r.units.map((u) => u.unitIndex)).toEqual([0, 1]);
    expect(r.units.map((u) => u.unitKey)).toEqual(['A#0', 'A#1']);
    expect(r.units.reduce((n, u) => n + u.bundleNetCents, 0)).toBe(15_000);
  });

  it('展开顺序按 seq，再按 componentId —— 不受传入数组顺序影响', () => {
    const a = allocateBundle({
      components: [
        comp({ componentId: 'B', listPriceCents: 5_000, seq: 1 }),
        comp({ componentId: 'A', listPriceCents: 10_000, seq: 0 }),
      ],
      bundlePriceCents: 12_000,
    });
    expect(a.units.map((u) => u.componentId)).toEqual(['A', 'B']);
  });
});

describe('allocateBundle — 额外整单优惠分摊（计划 §4.5 / 不变量 2）', () => {
  it('默认：额外优惠不落到套餐子项，只摊到额外加项', () => {
    const r = allocateBundle({
      components: [comp({ componentId: 'A', listPriceCents: 10_000, seq: 0 })],
      bundlePriceCents: 9_000,
      extraAddons: [{ ref: 'x1', attachToUnit: 'A#0', listPriceCents: 2_000 }],
      extraDiscountCents: 500,
    });
    expect(r.units[0]!.extraDiscountCents).toBe(0);
    expect(r.units[0]!.netCents).toBe(9_000);
    expect(r.extraAddons[0]!.extraDiscountCents).toBe(500);
    expect(r.extraAddons[0]!.netCents).toBe(1_500);
    expect(r.serviceNetTotalCents).toBe(10_500);
  });

  it('显式允许时：额外优惠按净额权重摊到套餐子项，之和 === 该笔优惠', () => {
    const r = allocateBundle({
      components: [
        comp({ componentId: 'A', listPriceCents: 10_000, seq: 0 }),
        comp({ componentId: 'B', listPriceCents: 5_000, seq: 1 }),
      ],
      bundlePriceCents: 12_000,
      extraDiscountCents: 1_200,
      bundleUnitsEligibleForExtraDiscount: true,
    });
    const totalDisc = r.units.reduce((n, u) => n + u.extraDiscountCents, 0);
    expect(totalDisc).toBe(1_200);
    expect(r.serviceNetTotalCents).toBe(12_000 - 1_200);
    expect(r.units.every((u) => u.netCents >= 0)).toBe(true);
  });

  it('额外优惠超过可分摊净额 → 报错，不产生负净额', () => {
    expect(() => allocateBundle({
      components: [comp({ listPriceCents: 5_000 })],
      bundlePriceCents: 4_000,
      extraDiscountCents: 4_500,
      bundleUnitsEligibleForExtraDiscount: true,
    })).toThrow(BundlePricingError);
  });
});

describe('allocateBundle — 确定性与尾差', () => {
  it('同样的输入永远给同样的输出', () => {
    const mk = () => allocateBundle({
      components: [
        comp({ componentId: 'A', listPriceCents: 3_333, seq: 0 }),
        comp({ componentId: 'B', listPriceCents: 3_333, seq: 1 }),
        comp({ componentId: 'C', listPriceCents: 3_334, seq: 2 }),
      ],
      bundlePriceCents: 9_001,
    });
    expect(mk()).toEqual(mk());
  });

  it('随机金额组合下净额之和始终精确等于套餐价', () => {
    for (const price of [1, 99, 100, 7_777, 10_001, 49_999]) {
      for (const ws of [[100, 100], [1, 2, 3], [9_999, 1, 1], [10_000, 5_000, 2_000]]) {
        const total = ws.reduce((a, b) => a + b, 0);
        const r = allocateBundle({
          components: ws.map((w, i) => comp({ componentId: `c${i}`, serviceId: `s${i}`, listPriceCents: w, seq: i })),
          bundlePriceCents: Math.min(price, total),
        });
        expect(r.units.reduce((n, u) => n + u.bundleNetCents, 0)).toBe(Math.min(price, total));
        expect(r.units.every((u) => u.netCents >= 0)).toBe(true);
      }
    }
  });

  it('零价子项不会被余数分配踩成负净额', () => {
    const r = allocateBundle({
      components: [
        comp({ componentId: 'A', listPriceCents: 3_333, seq: 0 }),
        comp({ componentId: 'FREE', listPriceCents: 0, seq: 1 }),
        comp({ componentId: 'B', listPriceCents: 3_334, seq: 2 }),
      ],
      bundlePriceCents: 5_000,
    });
    expect(r.units.every((u) => u.netCents >= 0)).toBe(true);
    expect(r.units.find((u) => u.componentId === 'FREE')!.netCents).toBe(0);
    expect(r.units.reduce((n, u) => n + u.bundleNetCents, 0)).toBe(5_000);
  });
});

describe('allocateBundle — 校验闸门', () => {
  it('组成为空 → 报错', () => {
    expect(() => allocateBundle({ components: [], bundlePriceCents: 0 })).toThrow(/empty_bundle/);
  });

  it('套餐价高于组成原价合计 → 报错（计划 §4.1）', () => {
    expect(() => allocateBundle({
      components: [comp({ listPriceCents: 5_000 })],
      bundlePriceCents: 6_000,
    })).toThrow(/bundle_price_above_components/);
  });

  it('组成原价合计为 0 时套餐价必须为 0', () => {
    expect(() => allocateBundle({
      components: [comp({ listPriceCents: 0 })],
      bundlePriceCents: 100,
    })).toThrow(/zero_weight_nonzero_price/);
    expect(allocateBundle({
      components: [comp({ listPriceCents: 0 })],
      bundlePriceCents: 0,
    }).units[0]!.bundleNetCents).toBe(0);
  });

  it('数量非正整数 / 负价 / 非整数分 → 报错', () => {
    expect(() => allocateBundle({ components: [comp({ qty: 0 })], bundlePriceCents: 0 }))
      .toThrow(/invalid_component_qty/);
    expect(() => allocateBundle({ components: [comp({ listPriceCents: -1 })], bundlePriceCents: 0 }))
      .toThrow(/negative_component_price/);
    expect(() => allocateBundle({ components: [comp({ listPriceCents: 10.5 })], bundlePriceCents: 0 }))
      .toThrow(/non_integer_cents/);
    expect(() => allocateBundle({ components: [comp()], bundlePriceCents: -5 }))
      .toThrow(/negative_bundle_price/);
  });
});

describe('refundableForUnit', () => {
  it('可退余额 = 最终净额 − 历史已退，最低为 0', () => {
    expect(refundableForUnit(1_764, 0)).toBe(1_764);
    expect(refundableForUnit(1_764, 1_000)).toBe(764);
    expect(refundableForUnit(1_764, 1_764)).toBe(0);
    expect(refundableForUnit(1_764, 2_000)).toBe(0);
  });
});
