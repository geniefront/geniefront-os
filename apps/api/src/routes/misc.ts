/**
 * 电话转录、来电待复核、上行短信与 Yelp 外部搜索路由
 *
 * 从 server.ts 拆出。包含：
 * - 来电待复核队列 (/v1/desk/call-drafts)
 * - 来电转录与通话记录 (/v1/desk/calls)
 * - 客户上行退订/咨询短信 (/v1/desk/sms-inbound)
 * - Yelp 门店信息搜寻 (/v1/desk/yelp/search)
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { searchBusinesses, getBusiness } from '@gf/yelp';
import { loadCallDrafts } from '../queries/callDrafts';
import { loadCalls } from '../queries/calls';
import { loadInboundSms } from '../queries/smsInbound';
import type { CtxFromHeaders } from './utils';

export function registerMiscRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：来电待复核队列 ──────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>('/v1/desk/call-drafts', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCallDrafts(tx, ctx, req.query.status ?? 'pending'));
  });

  // ── 查询：来电记录（转录 / 录音 / 计量）───────────────────────────────────
  app.get<{ Querystring: { days?: string; limit?: string } }>('/v1/desk/calls', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCalls(tx, ctx, {
        days: Number(req.query.days ?? '7') || 7,
        limit: Number(req.query.limit ?? '50') || 50,
      }));
  });

  // ── 查询：客人发进来的短信 ───────────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>('/v1/desk/sms-inbound', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? '14') || 14));
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadInboundSms(tx, ctx, days));
  });

  // ── 查询：Yelp 搜店 ───────────────────────────────────────────────────────
  app.get<{ Querystring: { term?: string; location?: string; id?: string } }>(
    '/v1/desk/yelp/search', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    const apiKey = process.env['YELP_API_KEY'];
    if (!apiKey) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'yelp' } });
    }

    if (req.query.id) {
      return { business: await getBusiness(req.query.id, { apiKey }) };
    }

    const term = (req.query.term ?? '').trim();
    const location = (req.query.location ?? '').trim();
    if (term.length < 2 || location.length < 3) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '要店名和邮编（或城市）才能搜' },
      });
    }
    return { businesses: await searchBusinesses({ term, location }, { apiKey }) };
  });
}
