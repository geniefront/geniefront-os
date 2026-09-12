import { describe, expect, it } from 'vitest';
import { checkoutDueCents, locationTaxCents } from './tax';

describe('locationTaxCents', () => {
  it('外加税按门店税率四舍五入到分，$45 × 8.875% = $3.99', () => {
    expect(locationTaxCents({
      afterDiscountCents: 4500,
      salesTaxRatePercent: 8.875,
      taxCalculationMode: 'exclusive',
    })).toBe(399);
  });

  it('税率为 0 时税额是 0，不回落到纽约默认', () => {
    expect(locationTaxCents({
      afterDiscountCents: 4500,
      salesTaxRatePercent: 0,
      taxCalculationMode: 'exclusive',
    })).toBe(0);
  });

  it('含税价把税额从实收里拆出来，不另加一层', () => {
    // 10888 含 8.875% → 税 888，净额 10000
    expect(locationTaxCents({
      afterDiscountCents: 10_888,
      salesTaxRatePercent: 8.875,
      taxCalculationMode: 'inclusive',
    })).toBe(888);
  });
});

describe('checkoutDueCents', () => {
  it('外加税：税加在净额之上', () => {
    expect(checkoutDueCents({
      afterDiscountCents: 10_000,
      taxCents: 888,
      tipCents: 0,
      surchargeCents: 0,
      taxCalculationMode: 'exclusive',
    })).toBe(10_888);
  });

  it('内含税：应收就是标价，税不再加一遍', () => {
    // 10888 含 8.875% 的税 888。客人该付的是 10888，不是 11776
    expect(checkoutDueCents({
      afterDiscountCents: 10_888,
      taxCents: 888,
      tipCents: 0,
      surchargeCents: 0,
      taxCalculationMode: 'inclusive',
    })).toBe(10_888);
  });

  it('小费与刷卡附加费两种税制下都是外加', () => {
    const common = { taxCents: 888, tipCents: 2_000, surchargeCents: 300 };
    expect(checkoutDueCents({ ...common, afterDiscountCents: 10_000, taxCalculationMode: 'exclusive' }))
      .toBe(10_000 + 888 + 2_000 + 300);
    expect(checkoutDueCents({ ...common, afterDiscountCents: 10_888, taxCalculationMode: 'inclusive' }))
      .toBe(10_888 + 2_000 + 300);
  });
});
