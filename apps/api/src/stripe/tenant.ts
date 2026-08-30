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

export async function resolveWebhookTenant(event: Stripe.Event): Promise<WebhookTenant | null> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const direct = tenantFromMetadata(asStringMeta(obj) ?? undefined);
  if (direct) return direct;

  if (!isInvoiceLike(event, obj)) return null;

  for (const meta of invoiceRelatedMetadata(obj)) {
    const nested = tenantFromMetadata(meta);
    if (nested) return nested;
  }

  const refs = invoiceStripeRefs(obj);
  return findBillingTenantByStripeRefs(refs);
}
