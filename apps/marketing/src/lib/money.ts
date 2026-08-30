/** Integer cents only. Do not use parseFloat. */
export function formatUsdFromCents(cents: number): string {
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const dollars = Math.trunc(abs / 100);
  const fraction = abs % 100;
  const frac = fraction < 10 ? `0${fraction}` : String(fraction);
  return `${negative ? '-' : ''}$${dollars}.${frac}`;
}

export function formatUsdMonthly(cents: number): string {
  return `${formatUsdFromCents(cents)}/mo`;
}
