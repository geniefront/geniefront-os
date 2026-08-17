/**
 * Telnyx 的入口：三个 AI 工具 + 一个通话事件 webhook（09-TELNYX §4.2）
 *
 * 这几条路由和系统里所有别的路由有一个根本区别：**它们没有登录用户**。
 * 没有 Bearer token、没有 X-Membership-Id、没有会话 —— 身份证明只有一个
 * Ed25519 签名。所以这个文件里每一条路由都以同一件事开头：验签。
 *
 * 定位门店靠**被叫号码**：`phone_lines.e164 → location`。
 * 这是 webhook 里唯一能用来确定租户的东西，所以那张表的 e164 是全局唯一的。
 *
 * ⚠️ 写操作一律走命令总线（宪法第 1 条不为任何供应商破例）。
 * 这里只做：验签 → 定位门店 → 组一个系统上下文 → dispatch。
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, pickText,
  type CommandContext, type Permission,
} from '@gf/contracts';
import { withTenant, tenantForPhoneNumber } from '@gf/db';
import { dispatch } from '../bus';
import { loadSlotContext, summariseSlots } from '../queries/slots';
import { verifyTelnyxSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './verify';
import { rawBodyOf } from '../rawBody';
import { maybeAutoTopup, billingSystemContext } from '../billing/autoTopup';
import '../handlers/phone';
import '../handlers/billing';

/**
 * AI 电话这个 actor 的全部权限。
 *
 * 只有一条写权限，而且写的是复核队列不是排期表 ——
 * 就算整个验签被绕过，攻击者也只能往前台的待办里塞垃圾。
 *
 * 特别注意**没有** `customer.view_contact`：AI 用号码查人，
 * 但不需要把完整号码念出来。少一个权限就少一条泄露路径。
 */
const PHONE_AI_PERMISSIONS: readonly Permission[] = [
  'call.draft',
  'appointment.read',
  'customer.read',
  'schedule.read',
];

interface Tenant { orgId: string; locationId: string; timezone: string; locale: string }

/**
 * 组一个系统上下文。
 *
 * `membershipId: null` —— 电话背后**没有人**。硬塞一个真实 membership
 * 会让审计流水指向某位技师，而她什么都没做过。
 * `actorKind: 'api'` 把「这是机器干的」写进 audit_log。
 */
function systemContext(t: Tenant): CommandContext {
  return {
    orgId: t.orgId,
    locationId: t.locationId,
    userId: '00000000-0000-4000-8000-000000000000',
    membershipId: null,
    permissions: new Set(PHONE_AI_PERMISSIONS),
    actorKind: 'api',
    locale: (t.locale as CommandContext['locale']) ?? 'en',
    timezone: t.timezone,
  };
}

export function registerTelnyxRoutes(app: FastifyInstance): void {
  const publicKey = process.env['TELNYX_PUBLIC_KEY'];

  /**
   * 验签 + 解析 body。**顺序不能反**（09 §8）。
   *
   * 原始字节由 `registerRawBodyParser` 留住（`/v1/telnyx/` 在
   * RAW_BODY_PREFIXES 里）—— 验的必须是原文，反序列化再序列化会改字节。
   */
  function verified(req: { headers: Record<string, unknown>; body: unknown }): Record<string, unknown> {
    if (!publicKey) {
      // 没配公钥就等于这道门没关。宁可整条路不可用，也不能放行。
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { reason: 'TELNYX_PUBLIC_KEY 未配置' },
      });
    }
    const raw = rawBodyOf(req);
    verifyTelnyxSignature({
      rawBody: raw,
      signatureB64: req.headers[SIGNATURE_HEADER] as string | undefined,
      timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
      publicKeyB64: publicKey,
    });
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'body 不是合法 JSON' } });
    }
  }

  /**
   * 被叫号码 → 门店。
   *
   * 走 `withPhoneLine` 的号码维度上下文（packages/db/src/phone.ts）——
   * 不绕过 RLS，策略只放行 e164 恰好相等的那一行。
   * 找不到就 404：**别把一通电话落到一个猜出来的租户上**。
   */
  async function tenantForNumber(e164: string | undefined): Promise<Tenant> {
    if (!e164) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'missing_to_number' } });
    const t = await tenantForPhoneNumber(e164).catch(() => null);
    if (!t) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { reason: 'number_not_bound_to_any_location', e164 },
      });
    }
    return { orgId: t.orgId, locationId: t.locationId, timezone: t.timezone, locale: t.locale };
  }

  // ── tool 1：查老客（只读）────────────────────────────────────────────────
  //
  // 决策 21：同号多客户（夫妻/母女共号）必须返回列表让 AI 在电话里问
  // 「请问是哪位」，**不许自动挑一个**。挑错了整通电话会挂到另一个人头上。
  app.post('/v1/telnyx/tools/lookup_customer', async (req) => {
    const body = verified(req);
    const t = await tenantForNumber(str(body['to']));
    const from = str(body['from']);
    if (!from) return { customers: [] };

    const digits = from.replace(/\D/g, '');
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{
        id: string; display_name: string; last_visit_on: string | null; last_service: string | null;
      }[]>`
        select c.id, c.display_name,
               (select max(a.business_date)::text from appointments a
                 where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on,
               (select ti.name_snapshot from tickets t
                  join ticket_items ti on ti.ticket_id = t.id
                 where t.customer_id = c.id order by t.opened_at desc limit 1) as last_service
        from customers c
        where c.merged_into_id is null
          and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
        order by c.display_name limit 5`);

    return {
      // AI 拿到 >1 条时必须开口问，这句话直接写在返回里，比藏在 prompt 里可靠
      guidance: rows.length > 1
        ? '这个号码下有多位客人，请在电话里问清是哪一位，不要替客人选。'
        : undefined,
      customers: rows.map((r) => ({
        customerId: r.id,
        displayName: r.display_name,
        lastVisitOn: r.last_visit_on,
        lastService: r.last_service,
      })),
    };
  });

  // ── tool 2：查真实空档（只读）───────────────────────────────────────────
  //
  // ⭐ 这是 09 §8「不让 AI 自己算空档」那条护栏的正面实现。
  // AI 在电话里报的每一个时间都必须来自这个接口。
  app.post('/v1/telnyx/tools/find_slots', async (req) => {
    const body = verified(req);
    const t = await tenantForNumber(str(body['to']));

    const durationMin = num(body['duration_min']) ?? 45;
    const around = str(body['around']) ? new Date(str(body['around'])!) : new Date();
    if (Number.isNaN(around.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_around' } });
    }
    const preferred = str(body['staff_membership_id']) ?? null;

    const { businessDate, timezone, slots } = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => loadSlotContext(tx, t.locationId, around, durationMin, preferred));

    const top = summariseSlots(slots, minutesOf(around, timezone), 3);

    return {
      businessDate,
      timezone,
      // 一个都没有时给 AI 一句能直接说出口的话，而不是让它自己编
      guidance: top.length === 0
        ? '这一天没有空档。请告诉客人换一天，或者转前台。不要自己另报时间。'
        : '只能从下面这些时间里选，不要自己推算别的时间。',
      slots: top.map((s) => ({
        startsAt: s.startsAt.toISOString(),
        staff: s.staff,
      })),
    };
  });

  // ── tool 3：放进复核队列（写）───────────────────────────────────────────
  app.post('/v1/telnyx/tools/draft_appointment', async (req) => {
    const body = verified(req);
    const t = await tenantForNumber(str(body['to']));
    const ctx = systemContext(t);

    // 幂等键用 Telnyx 的 call id：通话重连、webhook 重投都会重放，
    // 不去重前台会看到两条一模一样的待办，而她分不清是客人打了两次还是系统重了
    const callId = str(body['call_session_id']) ?? str(body['call_control_id']);

    const out = await dispatch<{ draftId: string; queuedAt: string }>(
      'call.draftAppointment',
      {
        providerCallId: callId,
        fromE164: str(body['from']),
        serviceNameHeard: str(body['service_heard']),
        serviceId: await matchService(t, str(body['service_heard'])),
        staffNameHeard: str(body['staff_heard']),
        staffMembershipId: await matchStaff(t, str(body['staff_heard'])),
        timeHeard: str(body['time_heard']),
        slotStartsAt: str(body['slot_starts_at']) ?? null,
        durationMin: num(body['duration_min']) ?? null,
        callerNameHeard: str(body['caller_name']),
        confidenceBp: num(body['confidence_bp']) ?? 10000,
        notes: str(body['notes']),
      },
      ctx,
      { idempotencyKey: callId ? `telnyx-draft-${callId}` : crypto.randomUUID() },
    );

    return {
      ok: true,
      draftId: out.result.draftId,
      // AI 要在电话里说的那句话 —— 措辞在这里定死，
      // 否则模型会说成「已经帮您约好了」，而它其实只是放进了待办
      say: '好的，我已经记下来了。前台确认之后会给您回电，通常几分钟内。',
    };
  });

  // ── webhook：通话事件 → 计费 ────────────────────────────────────────────
  app.post('/v1/telnyx/webhook', async (req) => {
    const body = verified(req);
    const data = (body['data'] ?? {}) as Record<string, unknown>;
    const payload = (data['payload'] ?? {}) as Record<string, unknown>;
    const eventType = str(data['event_type']);

    // 只认挂机事件。别的事件（answered / speak.ended…）照常 200，
    // 不然 Telnyx 会认为投递失败并一直重试
    if (eventType !== 'call.hangup') return { ok: true, ignored: eventType };

    const t = await tenantForNumber(str(payload['to']));
    const ctx = systemContext(t);

    const startedAt = str(payload['start_time']);
    const endedAt = str(payload['end_time']) ?? new Date().toISOString();
    const durationSeconds = startedAt
      ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000))
      : 0;

    const callId = str(payload['call_session_id']) ?? str(payload['call_control_id']) ?? '';
    if (!callId) return { ok: true, ignored: 'missing_call_id' };

    const out = await dispatch<{ callId: string; billedMinutes: number }>(
      'call.record',
      {
        providerCallId: callId,
        fromE164: str(payload['from']),
        toE164: str(payload['to']),
        startedAt, endedAt, durationSeconds,
        outcome: str(payload['hangup_cause']) === 'normal_clearing' ? 'completed' : 'failed',
      },
      ctx,
      { idempotencyKey: `telnyx-hangup-${callId}` },
    );

    // ⭐ 电话也会烧余额，挂机记完账顺手看一眼要不要自动续充（事务外）。
    // ⚠️ 换一个上下文：电话那个 actor 的四条权限里**没有** billing.manage ——
    // 一个靠签名进来的入口不该有扣客户钱的权限（见 billing/autoTopup.ts）
    // 电话烧的是**语音分钟**那本账，不是积分
    void maybeAutoTopup(billingSystemContext(ctx), 'voice_minute', req.log);

    return { ok: true, billedMinutes: out.result.billedMinutes };
  });

  // ── 模糊匹配：听到的名字 → 库里的 id ───────────────────────────────────
  //
  // 匹配不上就返回 null，**原话照样存**（call_drafts 两个字段都留）。
  // 猜一个「最像的」项目比留空危险得多：前台屏幕上会写着一个看起来
  // 完全正常的项目名，而客人说的是另一个。
  async function matchService(t: Tenant, heard: string | undefined): Promise<string | null> {
    if (!heard) return null;
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ id: string; name: unknown }[]>`
        select id, name from services
        where location_id = ${t.locationId} and active = true`);
    return bestMatch(heard, rows.map((r) => ({ id: r.id, text: pickText(r.name, 'en') })));
  }

  async function matchStaff(t: Tenant, heard: string | undefined): Promise<string | null> {
    if (!heard) return null;
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ membership_id: string; name: unknown }[]>`
        select sp.membership_id, sp.display_name as name
        from staff_profiles sp
        join memberships m on m.id = sp.membership_id and m.status = 'active'
        where sp.location_id = ${t.locationId} and sp.is_bookable = true`);
    return bestMatch(heard, rows.map((r) => ({ id: r.membership_id, text: pickText(r.name, 'en') })));
  }
}

/**
 * 保守的名字匹配：只认**完全相等**或**一方包含另一方**。
 *
 * 刻意不做编辑距离 —— "gel manicure" 和 "gel removal" 的距离很近，
 * 而它们是两个完全不同的活儿，价格差一倍。宁可匹配不上让前台填，
 * 也不要匹配错让前台以为已经填对了。
 */
function bestMatch(heard: string, pool: Array<{ id: string; text: string }>): string | null {
  const h = norm(heard);
  if (!h) return null;

  const exact = pool.filter((p) => norm(p.text) === h);
  if (exact.length === 1) return exact[0]!.id;

  const contains = pool.filter((p) => {
    const t = norm(p.text);
    return t.includes(h) || h.includes(t);
  });
  // 命中多个 = 有歧义（"gel" 同时像 "Gel Manicure" 和 "Gel Pedicure"），
  // 这时候留空比挑一个强
  return contains.length === 1 ? contains[0]!.id : null;
}

const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** 门店墙上时间的分钟数，用来把「客人说的时间」排到前面 */
function minutesOf(d: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60
    + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}
