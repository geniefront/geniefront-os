/**
 * 现场日程、排班与预约查询路由
 *
 * 从 server.ts 拆出。包含：
 * - 当日现场看板 (/v1/desk/day)
 * - 月视图概览 (/v1/desk/days)
 * - 员工排班表 (/v1/desk/roster)
 * - 技师今日单据快照 (/v1/staff/me/today)
 * - 房间与工位看板 (/v1/desk/rooms)
 * - 预约详情 (/v1/desk/appointments/:id)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError, ERROR_CODES, actingMembership,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { loadDay } from '../queries/day';
import { loadMonth } from '../queries/month';
import { loadRoster } from '../queries/roster';
import { loadStaffToday } from '../queries/staff';
import { loadRooms } from '../queries/rooms';
import { loadAppointmentDetail } from '../queries/appointmentDetail';
import { resolveDate } from '../handlers/dayclose';
import { addDaysIso, type CtxFromHeaders } from './utils';

export function registerScheduleRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：当日现场 ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { date?: string } }>('/v1/desk/day', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    const [loc] = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => tx<{ tz: string; cutoff: string }[]>`
        select timezone as tz, business_day_cutoff::text as cutoff
        from locations where id = ${ctx.locationId}`);
    const date = req.query.date ?? businessDateOf(new Date(), loc!.tz, loc!.cutoff);

    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadDay(tx, ctx, date));
  });

  // ── 查询：区间概览（月视图）────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/desk/days', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }

    const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };
    const DATE = /^\d{4}-\d{2}-\d{2}$/;

    const today = await withTenant(tenant, (tx) => resolveDate(tx, ctx.locationId));
    const from = DATE.test(req.query.from ?? '') ? req.query.from! : `${today.slice(0, 7)}-01`;
    const to = DATE.test(req.query.to ?? '') ? req.query.to! : addDaysIso(`${today.slice(0, 7)}-01`, 41);

    if (from > to) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_range' } });
    }
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(span) || span > 92) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'range_too_wide', maxDays: 92 },
      });
    }

    return withTenant(tenant, (tx) => loadMonth(tx, ctx.locationId, from, to));
  });

  // ── 查询：排班表 ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; days?: string } }>('/v1/desk/roster', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('schedule.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'schedule.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? '')
          ? req.query.from! : await resolveDate(tx, ctx.locationId);
        const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 31);
        return loadRoster(tx, ctx, from, days);
      });
  });

  // ── 查询：技师端今日快照 ─────────────────────────────────────────────────
  app.get<{ Querystring: { date?: string; membershipId?: string } }>(
    '/v1/staff/me/today', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    const wanted = req.query.membershipId ?? actingMembership(ctx);
    if (wanted !== ctx.membershipId && !ctx.permissions.has('payroll.view_all')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
        details: { need: 'payroll.view_all', reason: '只能看自己的今日单' },
      });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const date = await resolveDate(tx, ctx.locationId, req.query.date);
        return loadStaffToday(tx, ctx, date, wanted);
      });
  });

  // ── 房间与工位实时看板 ─────────────────────────────────────────────────────
  app.get('/v1/desk/rooms', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(ctx, (tx) => loadRooms(tx, ctx));
  });

  // ── 预约详情（带客户健康表与单据明细）────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/appointments/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(ctx, (tx) => loadAppointmentDetail(tx, ctx, req.params.id));
  });

  // ── 前台维护技师服务前提示 ───────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/v1/desk/appointments/:id/service-brief', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('appointment.write')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.write' } });
      }
      const body = z.object({ note: z.string().trim().max(2_000) }).parse(req.body);
      return withTenant(ctx, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          update appointments
          set notes = ${body.note || null}
          where id = ${req.params.id} and location_id = ${ctx.locationId}
          returning id`;
        if (!rows[0]) {
          throw new AppError(ERROR_CODES.NOT_FOUND, {
            details: { entity: 'appointment', id: req.params.id },
          });
        }
        return { appointmentId: rows[0].id, note: body.note || null };
      });
    },
  );
}
