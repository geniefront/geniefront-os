import { describe, expect, it } from 'vitest';
import { formatTaxRatePercent, taxNoteKind } from './taxCopy';

describe('tax copy', () => {
  it('未开征时不走纽约税文案', () => {
    expect(taxNoteKind(0)).toBe('none');
    expect(taxNoteKind(Number.NaN)).toBe('none');
  });

  it('金足 0、莲花 8.875 都能插进文案', () => {
    expect(formatTaxRatePercent(0)).toBe('0');
    expect(formatTaxRatePercent(8.875)).toBe('8.875');
    expect(formatTaxRatePercent(9.5)).toBe('9.5');
  });
});
