import { describe, it, expect } from 'vitest';
import {
  countCash, reconcileCash, reconcileCard, planTipPayouts, breakIntoBills,
  VARIANCE_REASON_THRESHOLD_CENTS, type CashMovement,
} from './settle';

describe('点钞', () => {
  it('按面额合计', () => {
    expect(countCash({ 10_000: 3, 2_000: 4, 500: 1, 25: 2 })).toBe(30_000 + 8_000 + 500 + 50);
  });

  it('空的点钞表是 0，不是 NaN', () => {
    expect(countCash({})).toBe(0);
  });

  it('张数不是非负整数就当场拒绝', () => {
    expect(() => countCash({ 2_000: -1 })).toThrow();
    expect(() => countCash({ 2_000: 1.5 })).toThrow();
  });

  it('拆钞与点钞互为逆运算', () => {
    for (const amt of [0, 1, 99, 3_737, 128_640]) {
      expect(countCash(breakIntoBills(amt))).toBe(amt);
    }
  });
});

describe('现金对账', () => {
  const base = {
    openingFloatCents: 20_000,
    cashTakeCents: 145_000,
    movements: [] as CashMovement[],
    countedCents: 165_000,
    closingFloatCents: 20_000,
  };

  it('账实相符时差异为 0', () => {
    const r = reconcileCash(base);
    expect(r.expectedCents).toBe(165_000);
    expect(r.varianceCents).toBe(0);
    expect(r.needsReason).toBe(false);
    expect(r.depositCents).toBe(145_000);
  });

  it('现金进出计入期望值 —— 填了就必须算，否则填了反而更对不上', () => {
    const r = reconcileCash({
      ...base,
      movements: [
        { kind: 'supply_purchase', amountCents: -4_500, note: '买棉片' },
        { kind: 'cash_drop', amountCents: -50_000 },
      ],
      countedCents: 110_500,
    });
    expect(r.expectedCents).toBe(110_500);
    expect(r.varianceCents).toBe(0);
    expect(r.movementsTotalCents).toBe(-54_500);
  });

  it('少钱是负差异，多钱是正差异', () => {
    expect(reconcileCash({ ...base, countedCents: 164_000 }).varianceCents).toBe(-1_000);
    expect(reconcileCash({ ...base, countedCents: 166_000 }).varianceCents).toBe(1_000);
  });

  it('小于阈值的硬币级差异不弹原因框', () => {
    const r = reconcileCash({ ...base, countedCents: 165_000 + VARIANCE_REASON_THRESHOLD_CENTS - 1 });
    expect(r.needsReason).toBe(false);
    const r2 = reconcileCash({ ...base, countedCents: 165_000 + VARIANCE_REASON_THRESHOLD_CENTS });
    expect(r2.needsReason).toBe(true);
  });

  it('留存备用金不算差异，只影响该交多少', () => {
    const r = reconcileCash({ ...base, closingFloatCents: 30_000 });
    expect(r.varianceCents).toBe(0);
    expect(r.depositCents).toBe(135_000);
  });
});

describe('刷卡机物理对账', () => {
  it('一分不差才算平 —— 刷卡没有磨损', () => {
    expect(reconcileCard(200_000, 200_000).needsReason).toBe(false);
    expect(reconcileCard(200_000, 200_001).needsReason).toBe(true);
    expect(reconcileCard(200_000, 199_000).varianceCents).toBe(-1_000);
  });
});

describe('现金小费发放', () => {
  it('默认发到整元，零头结转明天', () => {
    const [p] = planTipPayouts([
      { membershipId: 'a', name: '阿美', todayCents: 3_760, carryInCents: 0 },
    ]);
    expect(p!.payCents).toBe(3_700);
    expect(p!.carryOutCents).toBe(60);
  });

  it('昨天的结转要加进今天', () => {
    const [p] = planTipPayouts([
      { membershipId: 'a', name: '阿美', todayCents: 3_760, carryInCents: 60 },
    ]);
    expect(p!.owedCents).toBe(3_820);
    expect(p!.payCents).toBe(3_800);
    expect(p!.carryOutCents).toBe(20);
  });

  it('老板有硬币时可以发到分，零头归零', () => {
    const [p] = planTipPayouts(
      [{ membershipId: 'a', name: '阿美', todayCents: 3_763, carryInCents: 0 }], 1);
    expect(p!.payCents).toBe(3_763);
    expect(p!.carryOutCents).toBe(0);
  });

  it('发多了（负欠额）不当面要回来，整额继续结转', () => {
    const [p] = planTipPayouts([
      { membershipId: 'a', name: '阿美', todayCents: 500, carryInCents: -800 },
    ]);
    expect(p!.payCents).toBe(0);
    expect(p!.carryOutCents).toBe(-300);
  });

  it('给出照着数的钞票面额', () => {
    const [p] = planTipPayouts([
      { membershipId: 'a', name: '阿美', todayCents: 8_700, carryInCents: 0 },
    ]);
    expect(p!.bills).toEqual({ 5_000: 1, 2_000: 1, 1_000: 1, 500: 1, 100: 2 });
  });

  it('发放总额 + 结转 = 应发总额，一分不漏', () => {
    const owed = [
      { membershipId: 'a', name: 'A', todayCents: 3_760, carryInCents: 40 },
      { membershipId: 'b', name: 'B', todayCents: 1_233, carryInCents: 0 },
      { membershipId: 'c', name: 'C', todayCents: 99, carryInCents: 0 },
    ];
    const plans = planTipPayouts(owed);
    const owedTotal = owed.reduce((s, o) => s + o.todayCents + o.carryInCents, 0);
    const settled = plans.reduce((s, p) => s + p.payCents + p.carryOutCents, 0);
    expect(settled).toBe(owedTotal);
  });
});
