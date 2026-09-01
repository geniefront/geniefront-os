/**
 * Resolve which GenieFront shop a signed Stripe event belongs to.
 *
 * Direct object metadata is preferred: we wrote `gf_location_id` / `gf_org_id`
 * onto Checkout sessions, customers, and subscriptions. Invoice objects often
 * do not copy that metadata, so invoice.* events fall back to:
 *
 *   1. nested Stripe-owned metadata on the invoice (subscription_details)
 *   2. expanded related objects already present on the event payload
 *   3. local billing_accounts mapping from subscription/customer id
 *
 * Ambiguous or unknown mappings return null. The webhook then ignores the
 * event instead of guessing a tenant.
 */

import { findBillingTenantByStripeRefs } from '@gf/db';
import type { Stripe } from './client';

export interface WebhookTenant {
  orgId: string;
  locationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantFromMetadata(
  meta: Record<string, string> | null | undefined,
): WebhookTenant | null {
  const locationId = meta?.['gf_location_id'];
  const orgId = meta?.['gf_org_id'];
  if (!locationId || !orgId || !UUID.test(locationId) || !UUID.test(orgId)) return null;
  return { orgId, locationId };
}

function stripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function asStringMeta(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object') return null;
  const meta = (value as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(meta as Record<string, unknown>)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function isInvoiceLike(event: Stripe.Event, obj: Record<string, unknown>): boolean {
  if (event.type.startsWith('invoice.')) return true;
  return obj['object'] === 'invoice';
}

/**
 * Stripe invoice payloads have moved fields across API versions.
 * Read every location we ourselves may have written, never a client header.
 */
export function invoiceStripeRefs(obj: Record<string, unknown>): {
  subscriptionId: string | null;
  customerId: string | null;
} {
  const parent = obj['parent'];
  const parentDetails = parent && typeof parent === 'object'
    ? (parent as { subscription_details?: unknown }).subscription_details
    : undefined;
  const subscriptionDetails = obj['subscription_details'];

  const subscriptionId =
    stripeId(obj['subscription'])
    ?? stripeId(
      parentDetails && typeof parentDetails === 'object'
        ? (parentDetails as { subscription?: unknown }).subscription
        : null,
    )
    ?? stripeId(
      subscriptionDetails && typeof subscriptionDetails === 'object'
        ? (subscriptionDetails as { subscription?: unknown }).subscription
        : null,
    );

  return {
    subscriptionId,
    customerId: stripeId(obj['customer']),
  };
}

function invoiceRelatedMetadata(obj: Record<string, unknown>): Array<Record<string, string> | null> {
  const parent = obj['parent'];
  const parentDetails = parent && typeof parent === 'object'
    ? (parent as { subscription_details?: unknown }).subscription_details
    : undefined;
  return [
    asStringMeta(parentDetails),
    asStringMeta(obj['subscription_details']),
    asStringMeta(obj['subscription']),
    asStringMeta(obj['customer']),
  ];
}

/**
 * `payment_method.*` 事件的租户解析（AUD-02 / AUD-07）。
 *
 * ⚠️ **detached 事件里 `customer` 已经是 null 了** —— 卡都摘了，
 * Stripe 自然不再挂客户。旧的客户 id 在 `data.previous_attributes.customer`。
 * 只读 `obj.customer` 的话，这类事件永远认不出租户、被静默忽略，
 * 而那恰恰是「卡没了要清本地投影」最需要收到的一条。
 *
 * 两个来源都只当作**查询键**，最终仍然过
 * `findBillingTenantByStripeRefs`：命中多于一行就不返回，绝不猜。
 */
function paymentMethodCustomerId(event: Stripe.Event, obj: Record<string, unknown>): string | null {
  const current = stripeId(obj['customer']);
  if (current) return current;
  const prev = (event.data as { previous_attributes?: unknown }).previous_attributes;
  if (prev && typeof prev === 'object') {
    return stripeId((prev as { customer?: unknown }).customer);
  }
  return null;
}

/**
 * `customer.subscription.*` 的兜底（订阅 id / 客户 id → 门店）。
 *
 * ⚠️ 原来这类事件**只认 metadata**。而那份 metadata 是开户之后由
 * `backfillStripeMetadata` 回写上去的，回写失败时只记一条日志 ——
 * 于是这家店此后的**每一条续费、欠费、退订事件都被静默丢弃并回 200**，
 * 一个月后才会有人发现「这家店的订阅状态从来没变过」。
 *
 * 兜底走的是同一个「命中多于一个 org 就不返回」的查询函数（sql/0080），
 * 所以它不会猜：认不出来仍然是认不出来，只是不再因为一次回写失败而全瞎。
 */
function subscriptionStripeRefs(obj: Record<string, unknown>): {
  subscriptionId: string | null; customerId: string | null;
} {
  return {
    subscriptionId: stripeId(obj['id']),
    customerId: stripeId(obj['customer']),
  };
}

export async function resolveWebhookTenant(event: Stripe.Event): Promise<WebhookTenant | null> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const direct = tenantFromMetadata(asStringMeta(obj) ?? undefined);
  if (direct) return direct;

  if (event.type.startsWith('payment_method.') || obj['object'] === 'payment_method') {
    const customerId = paymentMethodCustomerId(event, obj);
    return findBillingTenantByStripeRefs({ subscriptionId: null, customerId });
  }

  if (event.type.startsWith('customer.subscription.') || obj['object'] === 'subscription') {
    return findBillingTenantByStripeRefs(subscriptionStripeRefs(obj));
  }

  /*
   * `charge.*`（退款、拒付）挂在 PaymentIntent 上，而我们自己发起的每一笔
   * 扣款都写了 gf_ metadata —— 走到这里说明是订阅月费那种由 Stripe 生成的
   * charge，按客户 id 兜底。
   */
  if (event.type.startsWith('charge.') || obj['object'] === 'charge') {
    return findBillingTenantByStripeRefs({
      subscriptionId: null, customerId: stripeId(obj['customer']),
    });
  }

  if (!isInvoiceLike(event, obj)) return null;

  for (const meta of invoiceRelatedMetadata(obj)) {
    const nested = tenantFromMetadata(meta);
    if (nested) return nested;
  }

  const refs = invoiceStripeRefs(obj);
  return findBillingTenantByStripeRefs(refs);
}
