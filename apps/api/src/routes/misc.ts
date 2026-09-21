import { loadDeliveryLog } from '../queries/deliveryLog';
import { getRecordingMetadata } from '../voice/provider';
/**
 * 电话转录、来电待复核、上行短信与 Yelp 外部搜索路由
 *
 * 从 server.ts 拆出。包含：
 * - 来电待复核队列 (/v1/desk/call-drafts)
 * - 来电转录与通话记录 (/v1/desk/calls)
 * - 客户上行退订/咨询短信 (/v1/desk/sms-inbound)
 * - Yelp 门店信息搜寻 (/v1/desk/yelp/search)
 * - 本店自己提的客服工单与状态 (/v1/desk/support/requests)
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { searchGooglePlaces, getGooglePlace } from '../integrations/googlePlaces';
import { loadCallDrafts } from '../queries/callDrafts';
import { loadCalls } from '../queries/calls';
import { loadAiVoiceReadiness } from '../queries/aiVoiceReadiness';
import { loadInboundSms } from '../queries/smsInbound';
import { loadMySupportRequests } from '../queries/support';
import type { CtxFromHeaders } from './utils';

export function registerMiscRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {
  app.get('/v1/desk/communications/deliveries', async req => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    return withTenant(ctx, async tx => ({ messages: await loadDeliveryLog(tx, ctx) }));
  });


  app.get<{ Querystring: { term?: string; location?: string; id?: string } }>(
    '/v1/desk/google/search', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('settings.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
      }
      const apiKey = process.env['GOOGLE_PLACES_API_KEY'];
      if (!apiKey) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'google_places' } });
      if (req.query.id) return { business: await getGooglePlace(req.query.id, apiKey) };
      const term = (req.query.term ?? '').trim(); const location = (req.query.location ?? '').trim();
      if (term.length < 2 || location.length < 3) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: '要店名和邮编（或城市）才能搜' } });
      }
      return { businesses: await searchGooglePlaces(`${term}, ${location}`, apiKey) };
    });

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

  app.get<{ Params: { id: string } }>('/v1/desk/calls/:id', async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw new AppError(ERROR_CODES.NOT_FOUND);
    const result = await withTenant(ctx, tx => loadCalls(tx, ctx, { callId: req.params.id }));
    if (!result.calls[0]) throw new AppError(ERROR_CODES.NOT_FOUND);
    reply.header('Cache-Control', 'no-store');
    return { call: result.calls[0] };
  });

  app.get<{ Params: { id: string } }>('/v1/desk/calls/:id/recording', async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new AppError(ERROR_CODES.NOT_FOUND);
    const [call] = await withTenant(ctx, tx => tx<{ recording_id: string | null;recording_url:string|null }[]>`
      select recording_id,recording_url from phone_calls where id=${req.params.id} and location_id=${ctx.locationId}`);
    if (!call) throw new AppError(ERROR_CODES.NOT_FOUND);
    const meta = call.recording_id?await getRecordingMetadata(call.recording_id):null;
    const url = meta?.download_urls?.mp3 ?? meta?.download_urls?.wav ?? call.recording_url;
    if (!url || new URL(url).protocol !== 'https:') throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE);
    reply.header('Cache-Control', 'no-store');
    return { url };
  });

  // ── 查询：来电记录（转录 / 录音 / 计量）───────────────────────────────────
  app.get<{ Querystring: { days?: string; limit?: string; offset?: string; fromDate?: string; toDate?: string } }>('/v1/desk/calls', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => ({
        ...(await loadCalls(tx, ctx, {
          days: Number(req.query.days ?? '7') || 7,
          offset: Number(req.query.offset) || 0,
          fromDate: /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate ?? '') ? req.query.fromDate : undefined,
          toDate: /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate ?? '') ? req.query.toDate : undefined,
          limit: Number(req.query.limit ?? '50') || 50,
        })),
        // 向导「功能设置」步骤与本页共用同一份就绪推导。
        aiVoice: await loadAiVoiceReadiness(tx, ctx),
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

  /**
   * 本店自己提的客服工单（AUD-08）。
   *
   * ⛔ 只返回工单主表。`support_request_notes` 是运营的内部备注，
   * 这里一个字都不碰 —— sql/0077 已经把那张表的 RLS 收成「必须是运营」，
   * 但查询层也不该提到它（两道都在，改错一处不会漏）。
   *
   * 权限用 `settings.manage`：提工单的是老板/店长，工单里往往有账务和
   * 合同上的话，不该让全店员工都看见。
   */
  app.get('/v1/desk/support/requests', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadMySupportRequests(tx, ctx));
  });

}
