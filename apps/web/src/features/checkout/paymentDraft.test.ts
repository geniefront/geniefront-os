import { describe, expect, it } from 'vitest';
import { cashChange, distributeTip, emptyLine, patchPayment, toPaymentLine } from './paymentDraft';

describe('cash and channel tip accounting (#22, #23)', () => {
  it('deducts the entire charge and recalculates when the tip changes', () => {
    const line = { ...emptyLine('cash'), baseCents: 5000, tipCents: 1000, tenderedCents: 7000 };
    expect(cashChange(line)).toBe(1000);
    expect(toPaymentLine(line)).toMatchObject({ amountCents: 6000, tipCents: 1000, changeCents: 1000, tenderedCents: 7000 });
    expect(toPaymentLine(patchPayment(line, { tipCents: 1500 })).changeCents).toBe(500);
    expect(toPaymentLine(patchPayment(line, { tipCents: 0 })).changeCents).toBe(2000);
  });
  it('retains all excess as tip, including an already entered tip', () => {
    const line = patchPayment({ ...emptyLine('cash'), baseCents: 5000, tipCents: 1000, tenderedCents: 7000 }, { keepChange: true });
    expect(toPaymentLine(line)).toMatchObject({ amountCents: 7000, tipCents: 2000, changeCents: 0 });
    expect(patchPayment(line, { tenderedCents: 8000 }).tipCents).toBe(3000);
    expect(cashChange(patchPayment(line, { keepChange: false, tipCents: 0 }))).toBe(2000);
  });
  it('global or staff totals replace the channel allocation without double counting', () => {
    const lines = [{ ...emptyLine('card'), baseCents: 3000, tipCents: 1000 }, { ...emptyLine('cash'), baseCents: 2000, tipCents: 500, tenderedCents: 3000 }];
    const updated = distributeTip(lines, 700);
    expect(updated.map(line => line.tipCents)).toEqual([700, 0]);
    expect(updated.map(toPaymentLine).reduce((sum, line) => sum + line.tipCents, 0)).toBe(700);
    expect(cashChange(updated[1]!)).toBe(1000);
    expect(distributeTip(updated, 0).every(line => line.tipCents === 0)).toBe(true);
  });
  it('supports a tip-only payment with no service amount', () => {
    const line = patchPayment({ ...emptyLine('cash'), tenderedCents: 1500 }, { tipCents: 1000 });
    expect(toPaymentLine(line)).toMatchObject({ amountCents: 1000, tipCents: 1000, changeCents: 500 });
  });
});
