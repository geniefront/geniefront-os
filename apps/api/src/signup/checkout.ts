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
import { signupReturnUrls } from '../links';
import {
  ownerLocaleFromAcceptLanguage, stripeLocaleFor, type OwnerLocale,
} from '../email/locale';

export const SignupCheckoutInput = z.object({
  shopName: z.string().trim().min(1).max(80),
  ownerEmail: z.string().trim().email().max(254),
  plan: z.enum(['essential', 'growth']),
}).strict();

export type SignupCheckoutInput = z.infer<typeof SignupCheckoutInput>;

export const SIGNUP_CHECKOUT_DEFAULTS = {
  businessType: 'nail',
  timezone: 'America/New_York',
  /**
   * ⚠️ 仅在无法推断浏览器语言时使用。语言的实际取值见
   * `createSignupCheckout` 中的 `ownerLocale` —— 此前该常量被无条件写入
   * `gf_locale`，导致 `organizations.default_locale` 永远是 `'en'`，
   * 「结账页语言即邮件语言」这条规则实际从未生效。
   */
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

/**
 * 这个邮箱开过户没有 —— 决定这次给不给七天试用。
 *
 * ⭐ 原来这条公开通道**无条件**给 `trial_period_days`，而「只给第一次」
 * 的判据只存在于站内那条路（`/v1/billing/checkout` 的 `everSubscribed`）。
 * 于是同一个人退订之后再开一次，又是七天，无限循环。
 *
 * 判据落在 `signup_intents`（每一次成功开户一行）。那张表受 RLS 保护，
 * 而开户是**未登录**的公开请求，所以走 sql/0085 那个只回答布尔值的
 * SECURITY DEFINER 函数 —— 它不返回门店、不返回时间，枚举不出任何东西。
 *
 * ⚠️ 查不到就当**没开过**（放行试用）。反过来（查询失败就不给试用）
 * 会在一次数据库抖动里把所有新客的试用都吞掉，而那是我们最不想丢的转化。
 */
async function hasSignedUpBefore(canonicalEmail: string): Promise<boolean> {
  try {
    const [row] = await sql<{ seen: boolean }[]>`
      select public.gf_signup_email_seen(${canonicalEmail}) as seen`;
    return row?.seen === true;
  } catch {
    return false;
  }
}

export async function createSignupCheckout(
  input: unknown,
  ctx: {
    ip: string;
    /** 浏览器的 `Accept-Language`，用于决定结账页与后续账单邮件的语言 */
    acceptLanguage?: string | undefined;
    log?: { warn: (o: unknown, m: string) => void };
  },
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
  const repeatCustomer = await hasSignedUpBefore(ownerEmail);

  /**
   * ⭐ 结账页语言 = 店主邮件语言（2026-09-01 店主确认）。
   *
   * 由浏览器 `Accept-Language` 推断，**显式下发**给 Stripe，再由 webhook
   * 从会话对象回读写入 `organizations.default_locale`。不使用 `auto`：
   * 那样 Checkout Session 的 `locale` 字段回读到的仍是 `'auto'`，
   * 页面实际渲染成哪种语言无从查证（`email/locale.ts`）。
   *
   * 店主之后可在后台「邮件语言」中改（命令 `org.setEmailLocale`）。
   */
  const ownerLocale: OwnerLocale = ownerLocaleFromAcceptLanguage(ctx.acceptLanguage);

  let session: Pick<Stripe.Checkout.Session, 'id' | 'url'>;
  try {
    session = await createCheckoutSession({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: ownerEmail,
      locale: stripeLocaleFor(ownerLocale),
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        gf_signup: '1',
        gf_plan: plan,
        gf_shop_name: shopName,
        gf_owner_email: ownerEmail,
        gf_business_type: SIGNUP_CHECKOUT_DEFAULTS.businessType,
        gf_timezone: SIGNUP_CHECKOUT_DEFAULTS.timezone,
        gf_locale: ownerLocale,
      },
      subscription_data: {
        /**
         * ⭐ 七天试用**只给第一次**。Stripe 不替我们判这个 ——
         * `trial_period_days` 给了就生效，所以判据必须在这里。
         */
        ...(repeatCustomer ? {} : { trial_period_days: TRIAL_DAYS }),
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
