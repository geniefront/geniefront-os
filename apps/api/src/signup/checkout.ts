/**
 * Public marketing signup → Stripe Hosted Checkout.
 *
 * The browser may supply only shopName / ownerEmail / plan. Price IDs,
 * customer ids, org/location ids, metadata, trial length, and return URLs
 * are chosen here. The existing signed webhook (`POST /v1/stripe/webhook`)
 * remains the only provisioning path (docs/11, docs/12).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { sql } from '@gf/db';
import { TRIAL_DAYS, isPlan, type Plan } from '@gf/payroll';
import { checkRateLimits } from '../public/rateLimit';
import { declineReason, priceIdFor, stripeClient, type Stripe } from '../stripe/client';
import { signupReturnUrls } from '../stripe/returnUrl';

export const SignupCheckoutInput = z.object({
  shopName: z.string().trim().min(1).max(80),
  ownerEmail: z.string().trim().email().max(254),
  plan: z.enum(['essential', 'growth']),
}).strict();

export type SignupCheckoutInput = z.infer<typeof SignupCheckoutInput>;

export const SIGNUP_CHECKOUT_DEFAULTS = {
  businessType: 'nail',
  timezone: 'America/New_York',
  locale: 'en',
} as const;

type CheckoutCreate = (
  params: Stripe.Checkout.SessionCreateParams,
) => Promise<Pick<Stripe.Checkout.Session, 'id' | 'url'>>;

const defaultCreate: CheckoutCreate = (params) =>
  stripeClient().checkout.sessions.create(params);

let createCheckoutSession: CheckoutCreate = defaultCreate;

export function __setSignupCheckoutCreatorForTests(fn: CheckoutCreate | null): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__setSignupCheckoutCreatorForTests 只能在测试环境用');
  }
  createCheckoutSession = fn ?? defaultCreate;
}

function canonicalShopName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 80);
}

async function canonicalOwnerEmail(email: string): Promise<string> {
  const trimmed = email.trim().toLowerCase();
  try {
    const [row] = await sql<{ v: string | null }[]>`
      select public.gf_canonical_email(${trimmed}) as v`;
    const canon = row?.v?.trim().toLowerCase();
    if (canon) return canon;
  } catch {
    // Same discipline as password reset: do not copy the Gmail rules into TS.
  }
  return trimmed;
}

function emailRateKey(email: string): string {
  return createHash('sha256').update(`gf-signup:${email}`, 'utf8').digest('hex').slice(0, 32);
}

export async function createSignupCheckout(
  input: unknown,
  ctx: { ip: string; log?: { warn: (o: unknown, m: string) => void } },
): Promise<{ url: string }> {
  const parsed = SignupCheckoutInput.safeParse(input);
  if (!parsed.success) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'invalid_signup' },
    });
  }

  const shopName = canonicalShopName(parsed.data.shopName);
  if (!shopName) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'invalid_shop_name' },
    });
  }

  const plan: Plan = parsed.data.plan;
  if (!isPlan(plan)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'invalid_plan' },
    });
  }

  const ownerEmail = await canonicalOwnerEmail(parsed.data.ownerEmail);
  const verdict = await checkRateLimits([
    { scope: 'signup-ip', id: ctx.ip, limit: 10, windowSec: 3600 },
    { scope: 'signup-email', id: emailRateKey(ownerEmail), limit: 5, windowSec: 3600 },
  ], ctx.log);
  if (!verdict.ok) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'too_many_attempts', retryAfterSec: verdict.retryAfterSec },
      messageKey: 'error.TOO_MANY_ATTEMPTS',
    });
  }

  const { successUrl, cancelUrl } = signupReturnUrls();
  const price = priceIdFor(plan);

  let session: Pick<Stripe.Checkout.Session, 'id' | 'url'>;
  try {
    session = await createCheckoutSession({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: ownerEmail,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        gf_signup: '1',
        gf_plan: plan,
        gf_shop_name: shopName,
        gf_owner_email: ownerEmail,
        gf_business_type: SIGNUP_CHECKOUT_DEFAULTS.businessType,
        gf_timezone: SIGNUP_CHECKOUT_DEFAULTS.timezone,
        gf_locale: SIGNUP_CHECKOUT_DEFAULTS.locale,
      },
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { gf_signup: '1' },
      },
    });
  } catch (e) {
    ctx.log?.warn({ err: e, plan }, 'signup checkout: Stripe session create failed');
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'stripe', reason: declineReason(e) },
    });
  }

  if (typeof session.url !== 'string' || session.url.length === 0) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'stripe', reason: 'checkout_url_missing' },
    });
  }

  return { url: session.url };
}
