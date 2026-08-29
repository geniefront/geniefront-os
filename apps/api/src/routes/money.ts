/**
 * 薪酬、日结、营业报表与收入估算查询路由
 *
 * 从 server.ts 拆出。包含：
 * - 技师当日收入看板 (/v1/desk/earnings)
 * - 打烊日结 (/v1/desk/dayclose)
 * - 营业报表含 CSV 导出 (/v1/desk/reports)
 * - 薪酬方案 (/v1/desk/payroll/plans)
 * - 收入估算与扣回明细 (/v1/desk/earnings/estimates*, /v1/desk/payouts/clawbacks)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  AppError, ERROR_CODES, pickText, actingMembership,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import { resolveDate } from '../handlers/dayclose';
import {
  loadEarningsBoard, loadDayClose, loadReport, reportToCsv, eachDate,
} from '../queries/money';
import {
  loadEarningsEstimates, loadEarningsEstimate, loadClawbacks,
} from '../queries/payouts';
import type { CtxFromHeaders } from './utils';

export function registerMoneyRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：技师当日收入看板 ─────────────────────────────────────────────────
  // 没有 payroll.view_all 的人只看得到自己那一行 —— 技师互相看收入
  // 是门店里最直接的矛盾来源（00 §3.0）。
  app.get<{ Querystring: { date?: string } }>('/v1/desk/earnings', async (req) => {
    const ctx = await ctxFromHeaders(req);
    const all = ctx.permissions.has('payroll.view_all');
    if (!all && !ctx.permissions.has('payroll.view_own')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.view_own' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadEarningsBoard(tx, ctx, date, all ? undefined : actingMembership(ctx));
      });
  });

  // ── 查询：打烊日结 ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { date?: string } }>('/v1/desk/dayclose', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('dayclose.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'dayclose.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadDayClose(tx, ctx, date);
      });
  });

  // ── 查询：营业报表（含 CSV 导出）───────────────────────────────────────────
  const handleDeskReport = async (
    req: FastifyRequest<{ Querystring: { from?: string; to?: string; format?: string } }>,
    reply: FastifyReply,
  ) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
    }
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const today = await resolveDate(tx, ctx.locationId);
        const from = DATE.test(req.query.from ?? '') ? req.query.from! : today;
        const to = DATE.test(req.query.to ?? '') ? req.query.to! : today;
        if (from > to) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: '起始日期不能晚于结束日期' },
          });
        }
        const span = eachDate(from, to).length;
        if (span > 366) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: '一次最多查一年', days: span },
          });
        }
        const report = await loadReport(tx, ctx, from, to);
        if (req.query.format !== 'csv') return report;
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition',
                  `attachment; filename="sales-report-${from}-to-${to}.csv"`)
          .send(reportToCsv(report));
      });
  };
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/v1/desk/reports', handleDeskReport);
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>('/v1/desk/report', handleDeskReport);

  // ── 查询：薪酬方案 ────────────────────────────────────────────────────────
  app.get('/v1/desk/payroll/plans', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('payroll.configure')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.configure' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const rows = await tx<{
          membership_id: string | null; version: number; config: unknown;
        }[]>`
          select distinct on (membership_id) membership_id, version, config
          from compensation_plans
          where location_id = ${ctx.locationId}
          order by membership_id, version desc`;

        const staff = await tx<{ membership_id: string; name: unknown }[]>`
          select sp.membership_id, sp.display_name as name
          from staff_profiles sp
          join memberships m on m.id = sp.membership_id and m.status = 'active'
          where sp.location_id = ${ctx.locationId}
          order by sp.is_bookable desc, sp.display_name->>'en'`;

        const cats = await tx<{ id: string; name: unknown }[]>`
          select id, name from service_categories
          where location_id = ${ctx.locationId} order by sort`;

        const byMember = new Map(rows.map((r) => [r.membership_id, r]));
        const shape = (r: { version: number; config: unknown } | undefined) =>
          r ? { version: r.version, ...(r.config as Record<string, unknown>) } : null;

        return {
          defaultPlan: shape(byMember.get(null)),
          staff: staff.map((sp) => ({
            membershipId: sp.membership_id,
            name: pickText(sp.name, ctx.locale),
            plan: shape(byMember.get(sp.membership_id)),
          })),
          categories: cats.map((c) => ({ id: c.id, name: pickText(c.name, ctx.locale) })),
        };
      });
  });

  // ── 收入估算与记账（不代收、不打款、不执行工资支付）────────────────────────
  app.get(
    '/v1/desk/earnings/estimates', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('payroll.view_all') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.view_all' } });
      }
      return withTenant(ctx, (tx) => loadEarningsEstimates(tx, ctx));
    }
  );

  app.get<{ Params: { membershipId: string } }>(
    '/v1/desk/earnings/estimates/:membershipId', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('payroll.view_all') && ctx.membershipId !== req.params.membershipId) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'payroll.view_all' } });
      }
      return withTenant(ctx, (tx) => loadEarningsEstimate(tx, ctx, req.params.membershipId));
    }
  );

  app.get(
    '/v1/desk/payouts/clawbacks', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view') && !ctx.permissions.has('payroll.view_all')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      return withTenant(ctx, (tx) => loadClawbacks(tx, ctx));
    }
  );
}
