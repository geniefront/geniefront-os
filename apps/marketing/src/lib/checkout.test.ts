import { describe, expect, it } from 'vitest';
import { isTrustedCheckoutUrl, validateSignupForm } from './checkout';

describe('checkout helpers', () => {
  it('only https Stripe Checkout URLs are trusted', () => {
    expect(isTrustedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_test')).toBe(true);
    expect(isTrustedCheckoutUrl('https://checkout.stripe.com.evil.example/c/pay')).toBe(false);
    expect(isTrustedCheckoutUrl('http://checkout.stripe.com/c/pay/cs_test')).toBe(false);
    expect(isTrustedCheckoutUrl('https://evil.example/cs_test')).toBe(false);
    expect(isTrustedCheckoutUrl(null)).toBe(false);
    expect(isTrustedCheckoutUrl('')).toBe(false);
    expect(isTrustedCheckoutUrl({ url: 'https://checkout.stripe.com/x' })).toBe(false);
  });

  it('validates shop name and email before calling the API', () => {
    expect(validateSignupForm({ shopName: '', ownerEmail: '' }).length).toBeGreaterThan(0);
    expect(validateSignupForm({ shopName: 'Lotus', ownerEmail: 'bad' })).toContain('Enter a valid owner email.');
    expect(validateSignupForm({ shopName: 'Lotus', ownerEmail: 'owner@maildrop.cc' })).toEqual([]);
  });
});
