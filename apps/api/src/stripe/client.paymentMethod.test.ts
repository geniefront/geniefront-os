import { describe, expect, it } from 'vitest';
import { stripeDefaultPaymentMethod } from './client';

describe('stripeDefaultPaymentMethod', () => {
  it('returns the Stripe payment method id and label from an expanded object', () => {
    expect(stripeDefaultPaymentMethod({
      id: 'pm_test_4242',
      type: 'card',
      card: { brand: 'visa', last4: '4242' },
    } as never)).toEqual({
      id: 'pm_test_4242',
      label: 'Visa ···· 4242',
    });
  });

  it('returns a string id without inventing a label', () => {
    expect(stripeDefaultPaymentMethod('pm_test_string')).toEqual({
      id: 'pm_test_string',
      label: null,
    });
  });

  it('returns null when Stripe has no default payment method', () => {
    expect(stripeDefaultPaymentMethod(null)).toBeNull();
    expect(stripeDefaultPaymentMethod(undefined)).toBeNull();
    expect(stripeDefaultPaymentMethod('')).toBeNull();
  });
});
