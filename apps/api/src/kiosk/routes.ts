/**
 * Kiosk 门口端的接口。
 *
 * 和 Telnyx 那几条一样，这些路由**没有登录用户** —— 身份是一个设备令牌。
 * 不同的是：Telnyx 那边前面站的是机器，这边前面**站着客人**。
 * 所以这里多防一层：客人能看到的东西，必须假设「路过的任何人都能看到」。
 *
 * ## 签到查询为什么不是一个客户查询接口 ⭐
 *
 * 最自然的写法是「输手机号 → 查客户表 → 返回姓名」。**不能这么做** ——
 * 那等于把整个客户名单挂在门口：站在那儿输一串号码，就能知道
 * 谁是这家店的客人、叫什么。对一家防挖客防到要给技师端手机号打码的产品
 * （决策 16），这是个自相矛盾的口子。
 *
 * 所以 `/check-in/lookup` 是一条**专用的窄路径**：
 *   · 只在**当天有预约**的人里面找 —— 查不到「上个月来过的张女士」
 *   · 只返回**打码的名字**（张** / A***y），够客人认出自己，不够别人认出他
 *   · 每台设备限频
 *
 * 剩下的信息（完整姓名、上次做什么）**只在客人确认「是我」之后**才给，
 * 而那时候他已经证明自己知道这个号码属于自己。
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, pickText } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { dispatch } from '../bus';
import { verifyDeviceToken, type DeviceSession } from './deviceAuth';
import '../handlers/kiosk';

const DEVICE_HEADER = 'x-device-token';

/**
 * 每台设备的限频。
 *
 * 门口那台 iPad 一天正常也就几十次签到。一分钟 20 次已经远超真人手速 ——
 * 超了基本只有一种可能：有人在那儿一个个试号码。
 *
 * 内存计数就够：两台实例各自限一半，攻击者的收益减半，
 * 而为这个引入 Redis 会违反宪法第 10 条（不自管状态）。
 */
const RATE = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;

function rateLimit(deviceId: string): void {
  const now = Date.now();
  if (RATE.size > 1_000) {
    for (const [key, value] of RATE) {
      if (value.resetAt < now) RATE.delete(key);
    }
  }
  const cur = RATE.get(deviceId);
  if (!cur || now > cur.resetAt) {
    RATE.set(deviceId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  if (++cur.count > RATE_MAX) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'too_many_attempts' },
      messageKey: 'error.TOO_MANY_ATTEMPTS',
    });
  }
}

/**
 * 打码。
 *
 * 中文名留姓：`张丽华` → `张**`
 * 西文名留首尾：`Amy Chen` → `A***n`
 *
 * 够本人一眼认出「这是我」，不够旁边排队的人认出他是谁。
 */
export function maskName(name: string): string {
  const v = name.trim();
  if (!v) return '—';
  // 中日韩字符按「留第一个字」处理 —— 那通常是姓
  if (/^[㐀-鿿豈-﫿]/.test(v)) {
    return v.length <= 1 ? v : `${v[0]}${'*'.repeat(Math.min(v.length - 1, 3))}`;
  }
  if (v.length <= 2) return `${v[0]}*`;
  return `${v[0]}${'*'.repeat(Math.min(v.length - 2, 3))}${v[v.length - 1]}`;
}

export function registerKioskRoutes(app: FastifyInstance): void {
  /** 验设备令牌，换一个受限的门店上下文 */
  async function device(req: { headers: Record<string, unknown>; ip: string }): Promise<DeviceSession> {
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    return verifyDeviceToken(req.headers[DEVICE_HEADER] as string | undefined, req.ip, userAgent);
  }

  // ── 开机自检：这台设备还认不认得出自己是哪家店 ──────────────────────────
  //
  // Kiosk 一开机就调它。令牌被吊销时立刻显示「这台设备已停用，请找前台」，
  // 而不是等客人输完号码才报错。
  app.get('/v1/kiosk/hello', async (req) => {
    const { ctx, label, terminalType } = await device(req);
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      async (tx) => {
        const [loc] = await tx<{ name: unknown; tz: string; cutoff: string }[]>`
          select name, timezone as tz, business_day_cutoff::text as cutoff
          from locations where id = ${ctx.locationId}`;

        const services = await tx<{ id: string; name: unknown; duration_min: number }[]>`
          select id, name, duration_min from services
          where location_id = ${ctx.locationId} and active = true
          order by sort, name->>'en' limit 40`;

        const [intake] = await tx<{
          require_signature: boolean; require_health_allergies: boolean;
          require_pressure_preference: boolean; require_body_soreness_map: boolean;
          auto_create_crm_profile: boolean; auto_prompt_tip_percentages: boolean;
        }[]>`
          select require_signature, require_health_allergies, require_pressure_preference,
                 require_body_soreness_map, auto_create_crm_profile, auto_prompt_tip_percentages
          from location_intake_templates where location_id = ${ctx.locationId}`;
        const [checkout] = await tx<{ suggested_tip_percentages: number[] }[]>`
          select suggested_tip_percentages from location_checkout_settings
          where location_id = ${ctx.locationId}`;

        return {
          deviceLabel: label,
          terminalType,
          locationName: loc!.name,
          timezone: loc!.tz,
          businessDate: businessDateOf(new Date(), loc!.tz, loc!.cutoff),
          // 客人在 Kiosk 上自己选项目，所以要把项目名的多语言整份给出去
          services: services.map((s) => ({
            id: s.id, name: s.name, durationMin: s.duration_min,
          })),
          deviceConfig: {
            requireSignature: intake?.require_signature ?? true,
            requireHealthAllergies: intake?.require_health_allergies ?? true,
            requirePressurePreference: intake?.require_pressure_preference ?? true,
            requireBodySorenessMap: intake?.require_body_soreness_map ?? true,
            autoCreateCrmProfile: intake?.auto_create_crm_profile ?? true,
            autoPromptTipPercentages: intake?.auto_prompt_tip_percentages ?? true,
            suggestedTipPercentages: checkout?.suggested_tip_percentages ?? [15, 18, 20, 25],
          },
        };
      });
  });

  // ── 设备心跳：上报可选遥测，并领取后台下发的短命令 ──────────────────────
  app.post<{ Body?: {
    model?: string; batteryLevel?: number; wifiSignalDbm?: number; appVersion?: string;
  } }>('/v1/kiosk/heartbeat', async (req) => {
    const { ctx, deviceId } = await device(req);
    const body = req.body ?? {};
    const battery = Number.isInteger(body.batteryLevel) && body.batteryLevel! >= 0 && body.batteryLevel! <= 100
      ? body.batteryLevel! : null;
    const wifi = Number.isInteger(body.wifiSignalDbm) && body.wifiSignalDbm! >= -150 && body.wifiSignalDbm! <= 0
      ? body.wifiSignalDbm! : null;
    const model = typeof body.model === 'string' ? body.model.trim().slice(0, 120) : null;
    const appVersion = typeof body.appVersion === 'string' ? body.appVersion.trim().slice(0, 60) : null;
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      async (tx) => {
        await tx`
          update device_tokens set
            last_seen_at = now(),
            ip_address = ${req.ip},
            model = coalesce(${model || null}, model),
            battery_level = coalesce(${battery}, battery_level),
            wifi_signal_dbm = coalesce(${wifi}, wifi_signal_dbm),
            app_version = coalesce(${appVersion || null}, app_version)
          where id = ${deviceId}`;
        await tx`
          update device_commands set status = 'expired'
          where device_id = ${deviceId} and status = 'pending'
            and created_at < now() - interval '10 minutes'`;
        const commands = await tx<{ id: string; kind: 'wake' | 'reset_home'; created_at: Date | string }[]>`
          select id, kind, created_at from device_commands
          where device_id = ${deviceId} and status = 'pending'
          order by created_at limit 20`;
        return {
          serverTime: new Date().toISOString(),
          commands: commands.map((command) => ({
            commandId: command.id,
            kind: command.kind,
            createdAt: new Date(command.created_at).toISOString(),
          })),
        };
      },
    );
  });

  app.post<{ Params: { id: string }; Body?: { status?: 'acknowledged' | 'failed'; errorMessage?: string } }>(
    '/v1/kiosk/commands/:id/ack', async (req) => {
      const { ctx, deviceId } = await device(req);
      const status = req.body?.status === 'failed' ? 'failed' : 'acknowledged';
      return withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
        async (tx) => {
          const rows = await tx<{ id: string }[]>`
            update device_commands set
              status = ${status}, acknowledged_at = now(),
              error_message = ${status === 'failed' ? (req.body?.errorMessage ?? '').slice(0, 500) : null}
            where id = ${req.params.id} and device_id = ${deviceId} and status = 'pending'
            returning id`;
          if (rows.length === 0) {
            throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'device_command' } });
          }
          return { commandId: rows[0]!.id, status };
        },
      );
    },
  );

  // ── 签到：手机号 → 今天的预约（窄路径，见文件头）─────────────────────────
  app.post<{ Body: { phone?: string } }>('/v1/kiosk/check-in/lookup', async (req) => {
    const { ctx, deviceId } = await device(req);
    rateLimit(deviceId);

    const digits = (req.body?.phone ?? '').replace(/\D/g, '');
    // 后四位太少 —— 一家店里撞上的概率不低，而且更好枚举
    if (digits.length < 7) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'phone_too_short' },
      });
    }

    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      async (tx) => {
        const [loc] = await tx<{ tz: string; cutoff: string }[]>`
          select timezone as tz, business_day_cutoff::text as cutoff
          from locations where id = ${ctx.locationId}`;
        const businessDate = businessDateOf(new Date(), loc!.tz, loc!.cutoff);

        // ⭐ 只在【今天有预约】的人里面找。
        // 查全表的话，站在门口输号码就能知道谁是这家店的客人
        const rows = await tx<{
          appointment_id: string; customer_id: string; display_name: string;
          starts_at: string | Date; already_queued: boolean;
        }[]>`
          select a.id as appointment_id, c.id as customer_id, c.display_name,
                 a.starts_at,
                 exists (select 1 from walkin_queue q
                          where q.appointment_id = a.id and q.status <> 'left') as already_queued
          from appointments a
          join customers c on c.id = a.customer_id
          where a.location_id = ${ctx.locationId}
            and a.business_date = ${businessDate}
            and a.status not in ('cancelled','done')
            and c.merged_into_id is null
            and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
          order by a.starts_at
          limit 5`;

        return {
          businessDate,
          // 同号多客户（夫妻/母女共号）时让客人自己点是哪位（决策 21）
          matches: rows.map((r) => ({
            appointmentId: r.appointment_id,
            // ⭐ 只给打码的名字。完整姓名等他点了「是我」再说
            maskedName: maskName(r.display_name),
            startsAt: new Date(r.starts_at).toISOString(),
            alreadyQueued: r.already_queued,
          })),
        };
      });
  });

  // ── 签到：确认是我 → 进队列取号 ────────────────────────────────────────
  app.post<{ Body: { appointmentId?: string } }>('/v1/kiosk/check-in', async (req) => {
    const { ctx, deviceId } = await device(req);
    rateLimit(deviceId);

    const appointmentId = req.body?.appointmentId;
    if (!appointmentId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_appointment' } });
    }

    const appt = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      (tx) => tx<{ id: string; customer_id: string | null }[]>`
        select id, customer_id from appointments
        where id = ${appointmentId} and location_id = ${ctx.locationId}
          and status not in ('cancelled','done')`);
    if (appt.length === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });
    }

    const out = await dispatch<{
      queueId: string; ticketNumber: number; aheadCount: number;
      quotedWaitMin: number | null; businessDate: string;
    }>('queue.join', {
      customerId: appt[0]!.customer_id,
      appointmentId,
      source: 'kiosk',
    }, ctx, { idempotencyKey: `kiosk-checkin-${appointmentId}` });

    return out.result;
  });

  // ── walk-in：没有预约，自己排 ──────────────────────────────────────────
  app.post<{ Body: {
    name?: string; phone?: string; email?: string; serviceId?: string;
    partySize?: number; idempotencyKey?: string;
  } }>('/v1/kiosk/walk-in', async (req) => {
    const { ctx, deviceId } = await device(req);
    rateLimit(deviceId);

    const name = (req.body?.name ?? '').trim();
    if (name.length < 1 || name.length > 60) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_name' } });
    }

    const phoneDigits = (req.body?.phone ?? '').replace(/\D/g, '');
    const walkInPhone = phoneDigits.length === 10
      ? `+1${phoneDigits}`
      : phoneDigits.length >= 7 && phoneDigits.length <= 15
        ? `+${phoneDigits}`
        : undefined;
    if (req.body?.phone && !walkInPhone) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_phone' } });
    }
    const walkInEmail = req.body?.email?.trim().toLowerCase() || undefined;

    const serviceId = req.body?.serviceId;
    if (serviceId) {
      const service = await withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
        (tx) => tx<{ id: string }[]>`
          select id from services
          where id = ${serviceId} and location_id = ${ctx.locationId} and active = true`,
      );
      if (service.length === 0) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'service' } });
      }
    }

    const idempotencyKey = req.body?.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length > 120 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'invalid_idempotency_key' },
      });
    }

    // 幂等键由 Kiosk 生成：门口那台 iPad 的网常常是店里最差的一条，
    // 重试不能变成两个号（客人手上会拿到两张纸，前台会喊两次）
    const out = await dispatch<{
      queueId: string; ticketNumber: number; aheadCount: number;
      quotedWaitMin: number | null; businessDate: string;
    }>('queue.join', {
      walkInName: name,
      walkInPhone,
      walkInEmail,
      requestedServiceId: serviceId ?? null,
      partySize: Math.min(Math.max(req.body?.partySize ?? 1, 1), 20),
      source: 'kiosk',
    }, ctx, {
      idempotencyKey: `kiosk-walkin-${deviceId}-${idempotencyKey}`,
    });

    return out.result;
  });

  // ── 我的号还要等多久 ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/kiosk/queue/:id', async (req) => {
    const { ctx } = await device(req);
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      async (tx) => {
        const [row] = await tx<{
          ticket_number: number; status: string; business_date: string;
          joined_at: string | Date; quoted_wait_min: number | null;
        }[]>`
          select ticket_number, status, business_date::text, joined_at, quoted_wait_min
          from walkin_queue
          where id = ${req.params.id} and location_id = ${ctx.locationId}`;
        if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'queue' } });

        const [ahead] = await tx<{ n: string }[]>`
          select count(*) as n from walkin_queue
          where location_id = ${ctx.locationId} and business_date = ${row.business_date}
            and status = 'waiting' and joined_at < ${row.joined_at}`;

        return {
          ticketNumber: row.ticket_number,
          status: row.status,
          aheadCount: Number(ahead!.n),
          quotedWaitMin: row.quoted_wait_min,
        };
      });
  });

  // ── 这次要不要签健康表 ─────────────────────────────────────────────────
  //
  // 「上次签过」不等于「不用签」—— 到期就要重签（三年前签的在法律上站不住）。
  app.get<{ Querystring: { appointmentId?: string; queueId?: string } }>(
    '/v1/kiosk/forms/required', async (req) => {
    const { ctx } = await device(req);

    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      async (tx) => {
        let customerId: string | undefined;
        const requestedServiceIds: string[] = [];

        if (!req.query.appointmentId && !req.query.queueId) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: 'missing_visit_context' },
          });
        }

        if (req.query.appointmentId) {
          const [appt] = await tx<{ customer_id: string | null }[]>`
            select customer_id from appointments
            where id = ${req.query.appointmentId} and location_id = ${ctx.locationId}`;
          if (!appt) {
            throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });
          }
          if (appt?.customer_id) {
            customerId = appt.customer_id;
          }
          const items = await tx<{ service_id: string }[]>`
            select service_id from appointment_items
            where appointment_id = ${req.query.appointmentId} and location_id = ${ctx.locationId}`;
          for (const it of items) {
            if (it.service_id && !requestedServiceIds.includes(it.service_id)) {
              requestedServiceIds.push(it.service_id);
            }
          }
        } else if (req.query.queueId) {
          const [q] = await tx<{ customer_id: string | null; requested_service_id: string | null; appointment_id: string | null }[]>`
            select customer_id, requested_service_id, appointment_id from walkin_queue
            where id = ${req.query.queueId} and location_id = ${ctx.locationId}`;
          if (!q) {
            throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'queue' } });
          }
          if (q) {
            if (q.customer_id) customerId = q.customer_id;
            if (q.requested_service_id && !requestedServiceIds.includes(q.requested_service_id)) {
              requestedServiceIds.push(q.requested_service_id);
            }
            if (q.appointment_id) {
              const items = await tx<{ service_id: string }[]>`
                select service_id from appointment_items
                where appointment_id = ${q.appointment_id} and location_id = ${ctx.locationId}`;
              for (const it of items) {
                if (it.service_id && !requestedServiceIds.includes(it.service_id)) {
                  requestedServiceIds.push(it.service_id);
                }
              }
            }
          }
        }

        const templates = await tx<{
          id: string; key: string; version: number; title: unknown; schema: unknown;
          requires_signature: boolean; service_ids: unknown;
        }[]>`
          select id, key, version, title, schema, requires_signature, service_ids
          from form_templates
          where location_id = ${ctx.locationId} and active = true and published_at is not null`;

        const applicable = templates.filter((t) => {
          const ids = (t.service_ids as string[]) ?? [];
          return ids.length === 0 || (requestedServiceIds.length > 0
            ? ids.some((id) => requestedServiceIds.includes(id))
            : false);
        });

        // 已经签过而且**还没到期**的就不用再签
        const signed = customerId
          ? await tx<{ template_id: string }[]>`
              select distinct template_id from form_submissions
              where location_id = ${ctx.locationId} and customer_id = ${customerId}
                and anonymized_at is null
                and (expires_on is null or expires_on >= current_date)`
          : [];
        const signedIds = new Set(signed.map((s) => s.template_id));

        return {
          forms: applicable
            .filter((t) => !signedIds.has(t.id))
            .map((t) => ({
              templateId: t.id,
              key: t.key,
              version: t.version,
              // i18n 整份给出去 —— 客人看的是自己的语言（宪法第 7 条）
              title: t.title,
              questions: Array.isArray(t.schema)
                ? t.schema.filter((question) => !question || typeof question !== 'object'
                  || !(question as { hidden?: boolean }).hidden)
                : [],
              requiresSignature: t.requires_signature,
            })),
        };
      });
  });

  // ── 交表 ───────────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>('/v1/kiosk/forms/submit', async (req) => {
    const { ctx, deviceId } = await device(req);
    rateLimit(deviceId);

    const body = req.body ?? {};
    const idempotencyKey = typeof body['idempotencyKey'] === 'string'
      ? body['idempotencyKey'].trim()
      : '';
    if (!idempotencyKey || idempotencyKey.length > 120 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'invalid_idempotency_key' },
      });
    }
    if (!body['appointmentId'] && !body['queueId']) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'missing_visit_context' },
      });
    }
    const out = await dispatch<{ submissionId: string; expiresOn: string | null }>(
      'form.submit',
      {
        templateId: body['templateId'],
        appointmentId: body['appointmentId'],
        queueId: body['queueId'],
        answers: body['answers'],
        signatureDataUrl: body['signatureDataUrl'],
        signerName: body['signerName'],
        signerRelation: body['signerRelation'],
        locale: body['locale'],
        customerId: null,
        shareLinkId: null,
        source: 'kiosk',
      },
      ctx,
      { idempotencyKey: `kiosk-form-${deviceId}-${idempotencyKey}` },
    );
    return out.result;
  });
}

/** 测试用：清掉限频计数 */
export function __resetRateLimit(): void {
  RATE.clear();
}
