import type { Plan } from './plans';

export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

export function isTrustedCheckoutUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'checkout.stripe.com' || host.endsWith('.checkout.stripe.com');
  } catch {
    return false;
  }
}

export function validateSignupForm(input: { shopName: string; ownerEmail: string }): string[] {
  const errors: string[] = [];
  const shop = input.shopName.trim();
  if (!shop) errors.push('Shop name is required.');
  else if (shop.length > 80) errors.push('Shop name must be 80 characters or fewer.');
  const email = input.ownerEmail.trim();
  if (!email) errors.push('Owner email is required.');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    errors.push('Enter a valid owner email.');
  }
  return errors;
}

export async function requestSignupCheckout(input: {
  shopName: string;
  ownerEmail: string;
  plan: Plan;
}): Promise<{ url?: string }> {
  const res = await fetch(`${__API_BASE__}/v1/public/signup-checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shopName: input.shopName.trim(),
      ownerEmail: input.ownerEmail.trim(),
      plan: input.plan,
    }),
  });
  if (!res.ok) {
    throw new Error('checkout_failed');
  }
  return res.json() as Promise<{ url?: string }>;
}

export function goToCheckout(url: string): void {
  navigation.assign(url);
}
