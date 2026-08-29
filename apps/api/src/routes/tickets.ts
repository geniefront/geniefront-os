/**
 * 工单、未记账断档与前台走单队列路由
 *
 * 从 server.ts 拆出。包含：
 * - 工单列表 (/v1/desk/tickets)
 * - 营业日断档 (/v1/desk/gaps)
 * - 现场走单叫号队列 (/v1/desk/queue)
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, pickText } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { resolveDate } from '../handlers/dayclose';
import { loadReport } from '../queries/money';
import { loadQueue } from '../queries/queue';
import type { CtxFromHeaders } from './utils';

export function registerTicketsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：工单列表 ────────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>('/v1/desk/tickets', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const filterStatus = req.query.status && req.query.status !== 'all'
      ? (req.query.status === 'paid' ? 'closed' : req.query.status)
      : null;

    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const [checkoutSettingsRow] = await tx<{
          sales_tax_rate_percent: string;
          tax_calculation_mode: string;
          suggested_tip_percentages: number[];
        }[]>`
          select sales_tax_rate_percent::text, tax_calculation_mode, suggested_tip_percentages
          from location_checkout_settings
          where location_id = ${ctx.locationId}`;

        const checkoutSettings = {
          salesTaxRatePercent: checkoutSettingsRow?.sales_tax_rate_percent ?? '8.8750',
          taxCalculationMode: (checkoutSettingsRow?.tax_calculation_mode ?? 'exclusive') as 'exclusive' | 'inclusive',
          suggestedTipPercentages: checkoutSettingsRow?.suggested_tip_percentages ?? [15, 18, 20, 25],
        };

        const rows = await tx<{
          ticket_id: string; appointment_id: string | null; status: string;
          customer_name: string | null; walk_in_name: string | null;
          group_id: string | null; group_label: string | null; business_date: string;
          subtotal_cents: number; discount_cents: number; tax_cents: number; total_cents: number;
          item_id: string; item_name: string; item_total: number;
          duration_min: number; started_at: string | null; finished_at: string | null;
          staff_name: unknown; membership_id: string;
        }[]>`
          select t.id as ticket_id, t.appointment_id, t.status,
                  c.display_name as customer_name, t.walk_in_name,
                  t.group_id, g.label as group_label,
                  t.business_date::text as business_date,
                  t.subtotal_cents, t.discount_cents, t.tax_cents, t.total_cents,
                  ti.id as item_id, ti.name_snapshot as item_name,
                  ti.total_cents as item_total, ti.duration_min,
                  ti.started_at::text as started_at, ti.finished_at::text as finished_at,
                  sp.display_name as staff_name, tis.membership_id
          from tickets t
          left join customers c on c.id = t.customer_id
          left join ticket_groups g on g.id = t.group_id
          join ticket_items ti on ti.ticket_id = t.id
          join ticket_item_staff tis on tis.ticket_item_id = ti.id
          left join staff_profiles sp on sp.membership_id = tis.membership_id
          where t.location_id = ${ctx.locationId}
            and (
              case
                when ${filterStatus}::text is not null then t.status = ${filterStatus}
                else t.status in ('open','in_service','ready_to_pay')
              end
            )
            -- ⚠️ 日期窗口兜底：前台工作台最多看最近 30 天的待处理单。
            and t.business_date >= current_date - 30
          order by t.business_date, t.opened_at, ti.seq
          limit 500`;

        const map = new Map<string, {
          ticketId: string; appointmentId: string | null; status: string; customerName: string;
          subtotalCents: number; discountCents: number; taxCents: number; totalCents: number;
          groupId: string | null; groupLabel: string | null;
          businessDate: string; daysAgo: number;
          items: Array<Record<string, unknown>>;
        }>();

        const today = await resolveDate(tx, ctx.locationId);
        const todayMs = Date.parse(`${today}T00:00:00Z`);
        const daysAgoOf = (d: string) =>
          Math.max(0, Math.round((todayMs - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));

        for (const r of rows) {
          const t = map.get(r.ticket_id) ?? {
            ticketId: r.ticket_id,
            appointmentId: r.appointment_id,
            status: r.status,
            customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
            subtotalCents: r.subtotal_cents,
            discountCents: r.discount_cents,
            taxCents: r.tax_cents,
            totalCents: r.total_cents,
            groupId: r.group_id, groupLabel: r.group_label,
            businessDate: r.business_date,
            daysAgo: daysAgoOf(r.business_date),
            items: [],
          };
          t.items.push({
            ticketItemId: r.item_id, name: r.item_name, totalCents: r.item_total,
            durationMin: r.duration_min, staffName: pickText(r.staff_name, ctx.locale),
            membershipId: r.membership_id, startedAt: r.started_at, finishedAt: r.finished_at,
          });
          map.set(r.ticket_id, t);
        }
        const tickets = [...map.values()];
        return {
          businessDate: today,
          tickets,
          checkoutSettings,
          staleCount: tickets.filter((t) => t.daysAgo > 0).length,
        };
      });
  });

  // ── 查询：没记完的日子 ───────────────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>('/v1/desk/gaps', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('dayclose.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'dayclose.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const today = await resolveDate(tx, ctx.locationId);
        const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 60);
        const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
          .toISOString().slice(0, 10);
        const to = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
          .toISOString().slice(0, 10);

        const [first] = await tx<{ d: string | null }[]>`
          select min(business_date)::text as d from tickets
          where location_id = ${ctx.locationId}`;
        const start = first?.d && first.d > from ? first.d : from;
        if (start > to) return { businessDate: today, days: [], unhandled: 0 };

        const report = await loadReport(tx, ctx, start, to);
        const gaps = report.byDay
          .filter((d) => d.status !== 'ok' && d.status !== 'no_business')
          .map((d) => ({
            businessDate: d.key,
            status: d.status,
            ticketCount: d.ticketCount,
            grossCents: d.grossCents,
            hasEarnings: d.hasEarnings,
            note: d.note,
          }));
        return {
          businessDate: today,
          days: gaps,
          unhandled: gaps.filter((d) => d.status === 'no_record').length,
        };
      });
  });

  // ── 查询：走单队列 ────────────────────────────────────────────────────────
  app.get<{ Querystring: { date?: string } }>('/v1/desk/queue', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('queue.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadQueue(tx, ctx, date);
      });
  });
}
