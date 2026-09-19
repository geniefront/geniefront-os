/**
 * Stripe 薄客户端。
 *
 * 这个文件里**没有任何业务逻辑** —— 该不该充值、充多少、账怎么记，
 * 全在 `@gf/payroll/credits` 的纯函数里（宪法第 2 条：算钱的逻辑只有一份，
 * 而且是纯函数、有测试）。这里只负责「怎么和 Stripe 说话」。
 *
 * ## 两条不能破的
 *
 * 1. **绝不碰卡号 / CVV / 有效期。** 我们只见得到 Stripe 的
 *    `payment_method` id 和一句给人看的 `Visa ···· 4242`。
 *    碰一下 PCI 范围，整个合规成本就是另一个量级（决策 3 的同一条精神）。
 *    所以绑卡走 Stripe 托管的 Checkout，卡号只在 Stripe 的页面上输入。
 * 2. **金额只用整数分。** Stripe 的 API 本来就收整数分，这里不做任何换算。
 */

import Stripe from 'stripe';
import { AppError, ERROR_CODES } from '@gf/contracts';
import type { Plan } from '@gf/payroll';

let cached: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * 拿客户端。没配密钥就抛 503 而不是让请求走到一半才炸 ——
 * 「计费整条不可用」和「计费半途失败」是完全不同的两件事，
 * 后者会留下一堆没头没尾的中间状态。
 */
export function stripeClient(): Stripe {
  const key = process.env['STRIPE_SECRET_KEY'];
  if (!key) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'stripe', reason: 'STRIPE_SECRET_KEY 未配置' },
    });
  }
  // 密钥换了（测试 ↔ 生产）就重建，别让进程一直揣着旧的
  if (!cached || cachedKey !== key) {
    cached = new Stripe(key, {
      // 网络差的时候宁可失败也别卡住整个请求：计费不是热路径，
      // 但它挂在前台点「充值」那个按钮后面，转圈半分钟前台会连点五次
      timeout: 20_000,
      maxNetworkRetries: 2,
    });
    cachedKey = key;
  }
  return cached;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env['STRIPE_SECRET_KEY']);
}

// ─────────────────────────────────────────────────────────────── 套餐与价格

export type { Plan } from '@gf/payroll';
export { PLANS, isPlan } from '@gf/payroll';

/**
 * 套餐 → Stripe Price id。
 *
 * 价格**不写在代码里**（决策 8 那张表的数字还要用真实账单校准，`04` §4.1）——
 * 写死在代码里意味着调价要发一次版，而调价是运营动作不是工程动作。
 * 这里只存「哪个套餐对应 Stripe 上的哪个 price」。
 */
export function priceIdFor(plan: Plan | 'voice_booking'): string {
  if (plan === 'growth') {
    const id = process.env['STRIPE_PRICE_GROWTH'];
    if (!id) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'stripe', reason: `${plan} 套餐的 STRIPE_PRICE_* 未配置` },
      });
    }
    return id;
  }
  if (plan === 'voice_booking') {
    const id = process.env['STRIPE_PRICE_VOICE_BOOKING'];
    if (!id) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'stripe', reason: `${plan} 套餐的 STRIPE_PRICE_* 未配置` },
      });
    }
    return id;
  }
  const id = process.env['STRIPE_PRICE_ESSENTIAL'];
  if (!id) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'stripe', reason: `${plan} 套餐的 STRIPE_PRICE_* 未配置` },
    });
  }
  return id;
}

/**
 * 反过来：Stripe 回调里的 price id → 我们的套餐名。
 *
 * webhook 里拿到的是 price id，而 `billing_accounts.plan` 存的是 `starter`/`pro`
 * （DB 有 check 约束）。认不出来时**保持原样不动**，别把一个未知套餐
 * 写成 starter —— 那会让一个付 Pro 钱的客户被降档，而且没人会发现。
 */
export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  if (priceId === process.env['STRIPE_PRICE_GROWTH']) return 'growth';
  if (priceId === process.env['STRIPE_PRICE_VOICE_BOOKING']) return 'voice_booking';
  if (priceId === process.env['STRIPE_PRICE_ESSENTIAL']) return 'essential';
  return null;
}

/**
 * Stripe 的订阅状态 → 我们的四态（DB 里 `subscription_status` 只认这四个）。
 *
 * Stripe 有七八种状态，我们只关心「能不能用」和「要不要催」：
 * `incomplete` / `unpaid` / `paused` 全部当 past_due —— 它们的共同点是
 * 「钱没到位」，而前台要看到的是同一句话：去更新支付方式。
 */
export function mapSubscriptionStatus(s: string): string {
  switch (s) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'canceled':
    case 'incomplete_expired': return 'canceled';
    default: return 'past_due';
  }
}

// ─────────────────────────────────────────────────────────── 卡片显示文案

/**
 * 给人看的一句话：`Visa ···· 4242`。
 *
 * **只是显示，不参与任何逻辑** —— 判断有没有卡看的是
 * `default_payment_method_id` 是否为空，不是这一句。
 */
export function paymentMethodLabel(pm: Stripe.PaymentMethod | null | undefined): string | null {
  const card = pm?.card;
  if (!card) return pm?.type ? pm.type : null;
  const brand = card.brand.charAt(0).toUpperCase() + card.brand.slice(1);
  return `${brand} ···· ${card.last4}`;
}

/**
 * Stripe's default payment method on a Subscription (or an already-retrieved
 * PaymentMethod). `null` means Stripe has none — callers must not invent one.
 */
export type StripePaymentMethodRef =
  | string
  | Pick<Stripe.PaymentMethod, 'id' | 'type' | 'card'>
  | null
  | undefined;

export function stripeDefaultPaymentMethod(
  raw: StripePaymentMethodRef,
): { id: string; label: string | null } | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id.length > 0 ? { id, label: null } : null;
  }
  if (!raw.id) return null;
  return { id: raw.id, label: paymentMethodLabel(raw as Stripe.PaymentMethod) };
}

/**
 * 从 Stripe 的错误里挑一句能给老板看的话。
 *
 * ⚠️ **绝不把 Stripe 的原始报错原样抛给前台** —— 里面可能带我们的
 * 客户 id、请求 id、甚至内部字段名。而 `decline_code` 恰恰是老板最需要的
 * 那一个信息：「余额不足」和「卡被银行拦了」要打的电话不是同一个。
 */
export function declineReason(err: unknown): string {
  const e = err as { code?: string; decline_code?: string; type?: string };
  return e?.decline_code ?? e?.code ?? e?.type ?? 'unknown';
}

export type { Stripe };
