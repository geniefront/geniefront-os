/**
 * 经营与分析领域只读工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadRevenueTrends } from '../../queries/analytics.js';
import { loadReviewsSummary } from '../../queries/reviews.js';

export async function getRevenueAnalytics(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const from = String(input['from'] ?? new Date().toISOString().slice(0, 10));
  const to = String(input['to'] ?? from);

  const trends = await withTenant(ctx, (tx) => loadRevenueTrends(tx, ctx, from, to));
  return {
    from,
    to,
    totalRevenueDollars: (trends.totalRevenueCents / 100).toFixed(2),
    trends: trends.trends,
    byCategory: trends.byCategory,
    byPaymentMethod: trends.byPaymentMethod,
  };
}

export async function searchOrders(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const date = String(input['businessDate'] ?? input['date'] ?? new Date().toISOString().slice(0, 10));
  const limit = Math.max(1, Math.min(50, Number(input['limit'] ?? 20)));

  const rows = await withTenant(ctx, (tx) => tx<{
    id: string;
    ticket_number: number;
    customer_name: string | null;
    status: string;
    total_cents: number;
    subtotal_cents: number;
    tip_cents: number;
    payment_method: string | null;
    closed_at: string | null;
  }[]>`
    select t.id, t.ticket_number, c.display_name as customer_name,
           t.status, t.total_cents, t.subtotal_cents, t.tip_cents,
           t.payment_method, t.closed_at
    from tickets t
    left join customers c on c.id = t.customer_id
    where t.location_id = ${ctx.locationId}
      and t.business_date = ${date}
    order by t.created_at desc
    limit ${limit}`);

  return {
    businessDate: date,
    totalCount: rows.length,
    orders: rows.map((r) => ({
      orderId: r.id,
      ticketNumber: `#${r.ticket_number}`,
      customer: r.customer_name ?? '散客',
      status: r.status,
      totalDollars: (r.total_cents / 100).toFixed(2),
      subtotalDollars: (r.subtotal_cents / 100).toFixed(2),
      tipDollars: (r.tip_cents / 100).toFixed(2),
      paymentMethod: r.payment_method ?? '其他',
      closedAt: r.closed_at,
    })),
  };
}

export async function getStoreReviews(
  ctx: CommandContext,
  _input: Record<string, unknown>,
): Promise<unknown> {
  return withTenant(ctx, (tx) => loadReviewsSummary(tx, ctx));
}
