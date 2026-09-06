/**
 * 看板顶栏「今日已结营收」。
 *
 * 服务价不是实收：结账含小费。日结 money 有净额和小费拆分时用它们相加；
 * 没有日结快照时，才退回已结卡片上的服务价（不含小费，会少一截）。
 */
export function settledRevenueCents(input: {
  netCents?: number | null;
  tipCashCents?: number | null;
  tipCardCents?: number | null;
  fallbackServiceCents: number;
}): number {
  const hasDayClose =
    input.netCents != null
    && Number.isFinite(input.netCents);
  if (!hasDayClose) return Math.max(0, input.fallbackServiceCents);
  return Math.max(
    0,
    (input.netCents ?? 0)
      + (input.tipCashCents ?? 0)
      + (input.tipCardCents ?? 0),
  );
}
