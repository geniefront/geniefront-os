/**
 * 订单页税行文案用真实门店税率，不再写死 NY 8.875%。
 * 未开征（0）走另一条文案，避免「0% 纽约税」。
 */
export function formatTaxRatePercent(ratePercent: number): string {
  if (!Number.isFinite(ratePercent) || ratePercent <= 0) return '0';
  const trimmed = ratePercent.toFixed(4).replace(/\.?0+$/, '');
  return trimmed || '0';
}

export function taxNoteKind(ratePercent: number): 'none' | 'rate' {
  return Number.isFinite(ratePercent) && ratePercent > 0 ? 'rate' : 'none';
}
