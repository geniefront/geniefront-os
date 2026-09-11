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
import { loadReceipt } from '../queries/receipt';
import { z } from 'zod';
import { loadServiceBrief } from '../queries/serviceBrief';
import type { CtxFromHeaders } from './utils';

export function registerTicketsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  /*
   * ── 查询：入座服务单一页纸 ───────────────────────────────────────────────
   *
   * 打印给技师看的那张纸。健康问卷原文由 `loadServiceBrief` 内部经
   * `readSubmission()` 读取 —— 权限校验与访问留痕都在那里，本路由不重复。
   * 这里只把门槛定在 `ticket.read`：没有工单读取权限的人连客人是谁都不该看到。
   */
  app.get<{ Params: { ticketId: string } }>('/v1/desk/tickets/:ticketId/service-brief', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadServiceBrief(tx, ctx, req.params.ticketId),
    );
  });

  app.get<{ Params: { ticketId: string } }>('/v1/desk/tickets/:ticketId/receipt', async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const ticketId = z.string().uuid().parse(req.params.ticketId);
    reply.header('Cache-Control', 'no-store');
    return withTenant(ctx, tx => loadReceipt(tx, ctx, ticketId));
  });

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
          checkout_timing: string;
          auto_print_receipt: boolean;
        }[]>`
          select sales_tax_rate_percent::text, tax_calculation_mode, suggested_tip_percentages, checkout_timing, auto_print_receipt
          from location_checkout_settings
          where location_id = ${ctx.locationId}`;

        const checkoutSettings = {
          autoPrintReceipt: checkoutSettingsRow?.auto_print_receipt ?? true,
          salesTaxRatePercent: checkoutSettingsRow?.sales_tax_rate_percent ?? '0',
          taxCalculationMode: (checkoutSettingsRow?.tax_calculation_mode ?? 'exclusive') as 'exclusive' | 'inclusive',
          suggestedTipPercentages: checkoutSettingsRow?.suggested_tip_percentages ?? [15, 18, 20, 25],
          checkoutTiming: checkoutSettingsRow?.checkout_timing ?? 'after_service_combined',
          packageCoverageMode: 'bundle' as 'bundle' | 'any_included',
          packageCommissionBasis: 'allocated_sale_price' as 'catalog_price' | 'allocated_sale_price' | 'zero',
          allowTipSplitOverride: true,
          tipDistributionBasis: 'active_minutes' as 'active_minutes' | 'price_share' | 'equal' | 'level_weighted',
        };
        const [locationConfig] = await tx<{ settings: Record<string, unknown> }[]>`
          select settings from locations where id = ${ctx.locationId}`;
        const checkoutConfig = (locationConfig?.settings?.['checkout'] ?? {}) as Record<string, unknown>;
        checkoutSettings.packageCoverageMode = checkoutConfig['packageCoverageMode'] === 'any_included' ? 'any_included' : 'bundle';
        checkoutSettings.packageCommissionBasis = (
          ['catalog_price', 'allocated_sale_price', 'zero'].includes(String(checkoutConfig['packageCommissionBasis']))
            ? checkoutConfig['packageCommissionBasis']
            : 'allocated_sale_price'
        ) as typeof checkoutSettings.packageCommissionBasis;
        checkoutSettings.allowTipSplitOverride = checkoutConfig['allowTipSplitOverride'] !== false;
        const [tipPolicy] = await tx<{ config: Record<string, unknown> }[]>`
          select config from tip_policies where location_id = ${ctx.locationId}
          order by effective_from desc, version desc limit 1`;
        checkoutSettings.tipDistributionBasis = (tipPolicy?.config?.['basis'] ?? 'active_minutes') as typeof checkoutSettings.tipDistributionBasis;

        /*
         * ⚠️ 技师那一跳必须是 left join。内连接会让**尚无技师归属**的项目整条
         * 从响应里消失 —— 而 subtotal_cents 仍然含着它，于是看板卡片上的明细
         * 与总额对不上，那一项也不会有任何可点的入口，单子就此卡死。归属为空
         * 的行由调用方按「待指派」处理，不是把它藏起来。
         *
         * 另注意本查询是按 ticket_item_staff 展开的：一个项目派了几位技师就
         * 返回几行，**每行都带着该项目的完整金额**。调用方必须按 ticketItemId
         * 去重（前端的 queueTicketItems），把各行金额直接相加会得到翻倍的营收。
         */
        const rows = await tx<{
          ticket_id: string; appointment_id: string | null; status: string;
          checkout_timing_snapshot: string; service_settled_at: string | null; tip_settled_at: string | null;
          customer_id: string | null; customer_name: string | null; walk_in_name: string | null;
          group_id: string | null; group_label: string | null; business_date: string;
          subtotal_cents: number; discount_cents: number; tax_cents: number; total_cents: number;
          item_id: string; service_id: string | null; item_name: string; item_total: number;
          duration_min: number; started_at: string | null; finished_at: string | null;
          staff_name: unknown; membership_id: string | null; room_name: string | null; resource_id: string | null;
          bundle_instance_id: string | null; bundle_component_id: string | null;
          bundle_unit_index: number | null; bundle_list_price_cents: number | null;
        }[]>`
          select t.id as ticket_id, t.appointment_id, t.status,
                  t.checkout_timing_snapshot, t.service_settled_at::text as service_settled_at,
                  t.tip_settled_at::text as tip_settled_at,
                  t.customer_id, c.display_name as customer_name, t.walk_in_name,
                  t.group_id, g.label as group_label,
                  t.business_date::text as business_date,
                  t.subtotal_cents, t.discount_cents, t.tax_cents, t.total_cents,
                  ti.id as item_id, ti.service_id, ti.name_snapshot as item_name,
                  ti.total_cents as item_total, ti.duration_min,
                  ti.started_at::text as started_at, ti.finished_at::text as finished_at,
                  sp.display_name as staff_name, tis.membership_id,
                  r.name as room_name, ti.resource_id,
                  ti.bundle_instance_id, ti.bundle_component_id,
                  ti.bundle_unit_index, ti.bundle_list_price_cents
          from tickets t
          left join customers c on c.id = t.customer_id
          left join ticket_groups g on g.id = t.group_id
          join ticket_items ti on ti.ticket_id = t.id
          left join ticket_item_staff tis on tis.ticket_item_id = ti.id
          left join staff_profiles sp on sp.membership_id = tis.membership_id
          left join resources r on r.id = ti.resource_id
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
          ticketId: string; appointmentId: string | null; status: string; customerId: string | null; customerName: string;
          subtotalCents: number; discountCents: number; taxCents: number; totalCents: number;
          groupId: string | null; groupLabel: string | null;
          checkoutTiming: string; serviceSettledAt: string | null; tipSettledAt: string | null;
          serviceCompleted: boolean;
          businessDate: string; daysAgo: number;
          items: Array<Record<string, unknown>>;
          availablePackages: Array<Record<string, unknown>>;
          bundles: Array<Record<string, unknown>>;
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
            customerId: r.customer_id,
            subtotalCents: r.subtotal_cents,
            discountCents: r.discount_cents,
            taxCents: r.tax_cents,
            totalCents: r.total_cents,
            groupId: r.group_id, groupLabel: r.group_label,
            checkoutTiming: r.checkout_timing_snapshot,
            serviceSettledAt: r.service_settled_at,
            tipSettledAt: r.tip_settled_at,
            serviceCompleted: r.finished_at !== null,
            businessDate: r.business_date,
            daysAgo: daysAgoOf(r.business_date),
            items: [],
            availablePackages: [],
            bundles: [],
          };
          t.items.push({
            ticketItemId: r.item_id, serviceId: r.service_id, name: r.item_name, totalCents: r.item_total,
            durationMin: r.duration_min, staffName: pickText(r.staff_name, ctx.locale),
            // 尚无归属时回空串而不是 null：前端各处已经按 falsy 判「待指派」。
            membershipId: r.membership_id ?? '', startedAt: r.started_at, finishedAt: r.finished_at,
            roomName: r.room_name, resourceId: r.resource_id,
            bundleInstanceId: r.bundle_instance_id, bundleComponentId: r.bundle_component_id,
            bundleUnitIndex: r.bundle_unit_index, bundleListPriceCents: r.bundle_list_price_cents,
          });
          t.serviceCompleted = t.serviceCompleted && r.finished_at !== null;
          map.set(r.ticket_id, t);
        }
        const tickets = [...map.values()];
        const customerIds = [...new Set(tickets.map((ticket) => ticket.customerId).filter((id): id is string => Boolean(id)))];
        if (customerIds.length > 0) {
          const packageRows = await tx<{
            id: string; customer_id: string; name: unknown; service_ids: string[];
            remaining_sessions: number; total_sessions: number; expires_at: string | null;
          }[]>`
            select cp.id, cp.customer_id, pt.name, pt.service_ids::text[] as service_ids,
                   cp.remaining_sessions, cp.total_sessions, cp.expires_at::text
            from customer_packages cp join package_templates pt on pt.id = cp.template_id
            where cp.location_id = ${ctx.locationId} and cp.customer_id = any(${customerIds})
              and cp.status = 'active' and (cp.total_sessions = 0 or cp.remaining_sessions > 0)
              and (cp.expires_at is null or cp.expires_at >= now())
            order by cp.expires_at nulls last, cp.created_at`;
          for (const ticket of tickets) {
            ticket.availablePackages = packageRows
              .filter((pkg) => pkg.customer_id === ticket.customerId)
              .map((pkg) => ({
                customerPackageId: pkg.id,
                name: pickText(pkg.name, ctx.locale, '套餐'),
                serviceIds: pkg.service_ids ?? [],
                remainingSessions: pkg.remaining_sessions,
                totalSessions: pkg.total_sessions,
                expiresAt: pkg.expires_at,
              }));
          }
        }

        // ── 组合套餐分组（U10 / 计划 §7「看板卡片」、§4.3「按有效子项进度」）──
        const ticketIds = tickets.map((t) => t.ticketId);
        if (ticketIds.length > 0) {
          const bundleRows = await tx<{
            id: string; ticket_id: string; name_snapshot: unknown;
            bundle_price_cents: number; discount_cents: number; extra_discount_cents: number; status: string;
          }[]>`
            select id, ticket_id, name_snapshot,
                   bundle_price_cents, discount_cents, extra_discount_cents, status
            from order_bundle_instances
            where location_id = ${ctx.locationId} and ticket_id = any(${ticketIds})`;
          for (const ticket of tickets) {
            ticket.bundles = bundleRows
              .filter((b) => b.ticket_id === ticket.ticketId)
              .map((b) => {
                const units = ticket.items.filter((i) => i['bundleInstanceId'] === b.id);
                // 完成进度按**有效子项**：全部 finishedAt 非空才算这份套餐履约完成，
                // 完成 1/3 不让整单提前完工（计划 §4.3）。
                const done = units.filter((i) => i['finishedAt'] != null).length;
                return {
                  instanceId: b.id,
                  name: pickText(b.name_snapshot, ctx.locale, '套餐'),
                  bundlePriceCents: b.bundle_price_cents,
                  discountCents: b.discount_cents,
                  extraDiscountCents: b.extra_discount_cents,
                  unitCount: units.length,
                  doneCount: done,
                  fulfilled: units.length > 0 && done === units.length,
                  status: b.status,
                };
              });
          }
        }

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
