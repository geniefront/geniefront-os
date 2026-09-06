import { describe, expect, it } from 'vitest';
import { locationTaxCents } from './tax';

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
