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

/**
 * 结账应收总额 —— 外加税与内含税的唯一分歧点。
 *
 * ⚠️ 两种税制下 `taxCents` 的含义**不一样**，这是所有错误的来源：
 *
 *   外加税（exclusive）：税加在标价之上 → 应收 = 净额 + 税
 *   内含税（inclusive）：标价里已经含了税 → 应收 = 标价本身，税只是**拆出来
 *                        报给税务局的那一部分**，不能再加一遍
 *
 * 此前 `ticket.close` 无条件写成「净额 + 税」，内含税门店因此被多算了一层；
 * 而前端 `checkoutMath.ts` 根本没读这个设置，一律按外加税算。两个数不相等，
 * 于是内含税门店的每一单都撞 `PAYMENT_MISMATCH` —— 功能在设置页里是可选的，
 * 实际完全不能用。
 *
 * 抽成纯函数是为了能被断言：这一条公式错一分钱，门店当天就对不平账。
 */
export function checkoutDueCents(input: {
  /** 折扣与套餐核销之后的金额。内含税门店下，这个数本身就含税。 */
  afterDiscountCents: number;
  taxCents: number;
  tipCents: number;
  surchargeCents: number;
  taxCalculationMode: 'exclusive' | 'inclusive';
}): number {
  const base = input.taxCalculationMode === 'inclusive'
    ? input.afterDiscountCents            // 税已在其中
    : input.afterDiscountCents + input.taxCents;
  return base + input.tipCents + input.surchargeCents;
}
