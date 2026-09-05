/**
 * 轮牌板查询路由
 *
 * 从 server.ts 拆出。包含：
 * - 轮牌大屏与排位计算 (/v1/desk/rotation, /api/rotation/query)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { computeStanding, explain, FULL_TURN } from '@gf/rotation';
import { currentBusinessDate, loadRotation, stripRank } from '../handlers/rotation';
import type { CtxFromHeaders } from './utils';

export function registerRotationRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {
  const handleRotation = async (req: FastifyRequest<{ Querystring: { businessDate?: string; date?: string } }>) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('rotation.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'rotation.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const { date: todayDate, policy } = await currentBusinessDate(tx, ctx.locationId);
        const queryDate = req.query.date || req.query.businessDate || todayDate;
        const { participants, events } = await loadRotation(tx, ctx, queryDate);
        const st = computeStanding(participants, events, policy);
        const busyRows = await tx<{ membership_id: string }[]>`
          select distinct tis.membership_id
          from ticket_item_staff tis
          join tickets t on t.id = (
            select ti.ticket_id from ticket_items ti where ti.id = tis.ticket_item_id
          )
          where t.location_id = ${ctx.locationId}
            and t.business_date = ${queryDate}::date
            and t.status = 'in_service'`;
        const busyIds = new Set(busyRows.map((row) => row.membership_id));

        const nameByMember = new Map(participants.map((p) => [p.membershipId, p.name]));

        return {
          businessDate: queryDate,
          todayDate,
          policy,
          nextUpMembershipId: st.nextUp?.membershipId ?? null,
          entries: st.entries.map((e) => ({
            membershipId: e.membershipId,
            name: e.name,
            turns: e.turnsBp / FULL_TURN,
            owed: e.owed,
            state: busyIds.has(e.membershipId) ? 'in_service' : e.state,
            position: e.position,
            manualRank: e.manualRank,
            skills: e.skills || [],
            levelName: e.levelName || null,
            arrivedAt: e.arrivedAt,
            leftAt: e.leftAt,
            why: explain(e, policy),
            trail: e.trail.map((t) => ({
              at: t.at,
              reason: t.reason,
              turns: t.deltaBp / FULL_TURN,
              note: stripRank(t.note),
            })),
          })),
          fullEvents: events.map((ev) => ({
            id: ev.id,
            membershipId: ev.membershipId,
            staffName: nameByMember.get(ev.membershipId) || '技师',
            reason: ev.reason,
            deltaTurns: ev.deltaBp / FULL_TURN,
            at: ev.at,
            note: stripRank(ev.note),
            actorId: ev.actorId,
          })),
        };
      });
  };

  app.get<{ Querystring: { businessDate?: string; date?: string } }>('/v1/desk/rotation', handleRotation);
  app.get<{ Querystring: { businessDate?: string; date?: string } }>('/api/rotation/query', handleRotation);
}
