/**
 * 日结点钞是否已经保存。没保存就把账面负现金当成「长款」会误导前台。
 */

export function hasSavedCashCount(countedCashCents: number | null | undefined): boolean {
  return countedCashCents != null;
}

export function displayedCashVarianceCents(input: {
  countedCashCents: number | null | undefined;
  liveCountedCents: number;
  expectedCashCents: number;
}): number | null {
  if (!hasSavedCashCount(input.countedCashCents)) return null;
  return input.liveCountedCents - input.expectedCashCents;
}
