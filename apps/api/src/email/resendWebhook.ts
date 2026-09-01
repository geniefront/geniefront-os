/**
 * Resend 的投递回调 —— 退信与投诉的回流入口。
 *
 * ```
 * POST /v1/webhooks/resend
 * ```
 *
 * ⚠️ 本系统同时保留了 SES 侧的同一条链路（`snsWebhook.ts`，`/v1/webhooks/ses`）。
 * 两条路由**始终都注册**，各自靠自己的凭据把关：没配 `RESEND_WEBHOOK_SECRET`
 * 时这一条一律 401，没配 `SES_SNS_TOPIC_ARN` 时那一条一律 401。之所以不按
 * `EMAIL_PROVIDER` 只注册一条：切换供应商之后，旧供应商仍会为切换前发出的邮件
 * 投递回调（退信可能晚几小时到几天），把旧路由摘掉等于把那批退信丢掉，
 * 而丢掉的正是最该进抑制名单的地址。
 *
 * ## 为什么必须接
 *
 * 不接的话，系统对一封信的下场**一无所知**：`email_outbox.status` 停在
 * `sent`，而那只表示 Resend 收下了这一封。于是一个早已不存在的邮箱每次
 * 预约都再退信一次；一位点了「举报垃圾邮件」的顾客下个月照样收到营销邮件。
 *
 * 两者都直接扣发信域名的信誉，而信誉掉下去之后受损的是**所有门店的事务性
 * 邮件送达率** —— 预约确认进垃圾箱这件事，没有任何人会来投诉。
 *
 * ## 验签：Svix，不是 Stripe 那一套
 *
 * Resend 的 webhook 走 Svix，签名在三个头里：
 *
 * ```
 * svix-id         这一条消息的 id
 * svix-timestamp  Unix 秒
 * svix-signature  空格分隔的多个 "v1,<base64>"（轮换期会同时给新旧两个）
 * ```
 *
 * 待签串是 `${id}.${timestamp}.${rawBody}`，密钥是 `whsec_` 之后那一段的
 * **base64 解码结果**，HMAC-SHA256 之后 base64。
 *
 * ⚠️ 必须用**原始请求体**验签，不能用 `JSON.stringify(req.body)` —— 重新
 * 序列化会改变键序与空白，签名必然对不上，而那种失败看起来像「Resend 发的
 * 签名不对」，排查方向会整个跑偏。
 *
 * ⚠️ 时间戳容差 5 分钟。不校验的话，一条被截获的旧回调可以被无限重放。
 *
 * ## 没配密钥时**拒收**，而不是放行
 *
 * 一个不验签的公开写接口，等于任何人都能把任意地址塞进抑制名单 ——
 * 那是一个「让某家店的顾客再也收不到确认信」的接口。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  suppressEmail, recordEmailDelivery, optOutMarketingByEmail,
} from '@gf/db';
import { rawBodyOf } from '../rawBody';

/** Svix 的时间戳容差。与其默认值一致。 */
const TOLERANCE_SEC = 5 * 60;

export interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
    [k: string]: unknown;
  };
}

function secretBytes(): Buffer | null {
  const raw = process.env['RESEND_WEBHOOK_SECRET'];
  if (!raw) return null;
  // `whsec_` 前缀之后是 base64 的密钥本体
  const body = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;
  try {
    return Buffer.from(body, 'base64');
  } catch {
    return null;
  }
}

/**
 * 验签。返回 true 才继续。
 *
 * ⚠️ 逐个比对 `svix-signature` 里的每一个候选：密钥轮换期间 Svix 会同时
 * 带上新旧两个签名，只比第一个会在轮换那几分钟里全部拒收。
 */
export function verifySvixSignature(args: {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now?: number;
}): boolean {
  const key = secretBytes();
  if (!key || !args.id || !args.timestamp || !args.signature) return false;

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SEC) return false;

  const expected = createHmac('sha256', key)
    .update(`${args.id}.${args.timestamp}.${args.rawBody}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');

  for (const part of args.signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const got = Buffer.from(value, 'utf8');
    if (got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf)) return true;
  }
  return false;
}

/** 事件里的收件地址。Resend 的 `to` 有时是数组，有时是单个字符串。 */
function recipientOf(ev: ResendEvent): string | null {
  const to = ev.data?.to;
  if (Array.isArray(to)) return to[0] ?? null;
  if (typeof to === 'string') return to;
  return null;
}

/**
 * ⚠️ 硬退与软退必须分开。
 *
 * 软退是临时性的（对方邮箱满了、服务器暂时拒收）。把它也拦进抑制名单，
 * 一次对方服务器抖动就会让这个顾客**永远**收不到预约确认。
 *
 * Resend 在 `data.bounce.type` 里给 `Permanent` / `Transient` / `Undetermined`。
 * ⚠️ `Undetermined` 按**软退**处理：拿不准的时候，少拦比多拦安全 ——
 * 多拦的代价是顾客再也收不到信，而那是静默的。
 */
export function bounceIsHard(ev: ResendEvent): boolean {
  const t = ev.data?.bounce?.type;
  return typeof t === 'string' && t.toLowerCase() === 'permanent';
}

export async function handleResendEvent(
  ev: ResendEvent,
  log?: { info: (o: unknown, m: string) => void },
): Promise<{ handled: string }> {
  const type = ev.type ?? '';
  const providerId = ev.data?.email_id;
  const to = recipientOf(ev);

  switch (type) {
    case 'email.delivered':
      if (providerId) await recordEmailDelivery({ providerId, state: 'delivered' });
      return { handled: type };

    case 'email.delivery_delayed':
      if (providerId) await recordEmailDelivery({ providerId, state: 'delayed' });
      return { handled: type };

    case 'email.bounced': {
      const hard = bounceIsHard(ev);
      if (providerId) {
        await recordEmailDelivery({
          providerId, state: hard ? 'hard_bounce' : 'soft_bounce',
        });
      }
      if (hard && to) {
        await suppressEmail({
          email: to,
          reason: 'hard_bounce',
          providerId: providerId ?? null,
          detail: ev.data?.bounce?.message ?? ev.data?.bounce?.subType ?? null,
        });
        log?.info({ to: '[redacted]', providerId }, 'email hard bounce suppressed');
      }
      return { handled: type };
    }

    case 'email.complained': {
      if (providerId) await recordEmailDelivery({ providerId, state: 'complained' });
      if (to) {
        /*
         * 投诉比硬退更强：地址进抑制名单，**并且**关掉这个人的营销订阅。
         * 后者管的是日后人工解除抑制之后的状态 —— 不关的话，解除抑制那天
         * 他会立刻再收到一封推广，然后再投诉一次。
         */
        await suppressEmail({
          email: to, reason: 'complaint', providerId: providerId ?? null, detail: null,
        });
        await optOutMarketingByEmail(to);
        log?.info({ providerId }, 'email complaint suppressed + marketing opted out');
      }
      return { handled: type };
    }

    default:
      // `email.sent` / `email.opened` / `email.clicked` 等：留个返回值，不做事
      return { handled: 'ignored' };
  }
}

export function registerResendWebhook(app: FastifyInstance): void {
  app.post('/v1/webhooks/resend', async (
    req: FastifyRequest<{ Body: unknown }>, reply,
  ) => {
    /*
     * ⚠️ 用原始体验签。本路径已登记在 `RAW_BODY_PREFIXES` 里，因此
     * `req.body` 是 `{ raw }` 而不是解析后的对象。
     *
     * 忘了登记的表现很迷惑：签名永远对不上，而 body 看起来完全正常
     * （`rawBody.ts` 文件头写着这一条）。
     */
    const raw = rawBodyOf(req);
    if (!raw) {
      return reply.status(400).send({ error: 'raw_body_unavailable' });
    }

    const h = req.headers;
    const ok = verifySvixSignature({
      id: h['svix-id'] as string | undefined,
      timestamp: h['svix-timestamp'] as string | undefined,
      signature: h['svix-signature'] as string | undefined,
      rawBody: raw,
    });
    if (!ok) {
      /*
       * ⚠️ 401 而不是 200。这条路由会往抑制名单里写东西 —— 也就是能让
       * 某个地址再也收不到我们的信。不验签就放行等于把那个能力对外开放。
       */
      req.log.warn({ svixId: h['svix-id'] }, 'resend webhook: 验签失败，拒收');
      return reply.status(401).send({ error: 'invalid_signature' });
    }

    try {
      const res = await handleResendEvent(JSON.parse(raw) as ResendEvent, req.log);
      return reply.status(200).send(res);
    } catch (e) {
      /*
       * ⚠️ 处理失败也回 200。
       *
       * Svix 会对非 2xx 重投，而这条路由做的都是幂等的 upsert —— 让它反复
       * 重投一件已经做过或做不成的事没有收益，只会在失败持续时把回调队列
       * 堆起来，届时**真正需要处理的退信也跟着堵住**。
       */
      req.log.warn({ err: e }, 'resend webhook: 处理失败');
      return reply.status(200).send({ handled: 'error' });
    }
  });
}
