/**
 * 门店销售税。结账只认这一份，不信收银台各算各的。
 *
 * 金额一律整数分。税率为 0 是合法值（金足未开征），不得回落到纽约 8.875%。
 */
export function locationTaxCents(input: {
  afterDiscountCents: number;
  salesTaxRatePercent: number;
  taxCalculationMode: 'exclusive' | 'inclusive';
}): number {
  const base = Math.max(0, input.afterDiscountCents);
  const rate = Number.isFinite(input.salesTaxRatePercent)
    ? Math.max(0, input.salesTaxRatePercent) / 100
    : 0;
  if (base <= 0 || rate <= 0) return 0;
  if (input.taxCalculationMode === 'inclusive') {
    return Math.round(base - base / (1 + rate));
  }
  return Math.round(base * rate);
}
