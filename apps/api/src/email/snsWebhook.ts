/**
 * AWS SES 的投递回调 —— 退信与投诉的回流入口（经 SNS 投递）。
 *
 * ```
 * POST /v1/webhooks/ses
 * ```
 *
 * ## 为什么必须接
 *
 * 不接的话，系统对一封邮件的最终结果**一无所知**：`email_outbox.status` 停在
 * `sent`，而该状态仅表示 SES 已受理这一封。于是一个早已停用的邮箱每次预约都
 * 再退信一次；一位点击过「举报垃圾邮件」的顾客下个月照样收到营销邮件。
 *
 * 两者都直接扣减发信域名的信誉，而信誉下降后受损的是**所有门店的事务性邮件
 * 送达率** —— 预约确认进入垃圾箱这件事，不会有任何人来投诉。
 *
 * ## ⚠️ 前置条件：配置集 + 事件目标
 *
 * SES **只有绑定了配置集、且该配置集配置了事件目标的邮件**才会产生投递事件。
 * 缺少任一环节时本路由永远收不到任何请求，而表现与「一切正常」完全相同。
 * 部署清单见 `docs/26-OUTBOUND-MESSAGING.md`。
 *
 * ## 验签：SNS 的 X.509 签名，不是 HMAC
 *
 * 与 Resend（Svix，共享密钥 HMAC）不同，SNS 使用**非对称签名**：消息体自带
 * `SigningCertURL`，用该证书的公钥验证 `Signature`。因此本系统不持有任何
 * 与该回调相关的密钥。
 *
 * 三个必须校验的点，缺一不可：
 *
 *   1. **`SigningCertURL` 的主机名必须是 AWS 的 SNS 端点**。不校验的话，
 *      攻击者可指向自己的证书并用自己的私钥签名，验签必然通过 ——
 *      此时验签形同虚设。
 *   2. **待签串的字段顺序与集合由消息类型决定**，且必须使用消息中的原始值。
 *   3. **`TopicArn` 必须是我们自己的主题**。证书校验只能证明「这是一条合法的
 *      SNS 消息」，不能证明「这是发给我们的消息」—— 任何人都可以创建 SNS 主题
 *      并向本端点投递结构合法的通知。
 *
 * ## 没配主题 ARN 时**拒收**，而不是放行
 *
 * 本路由会向抑制名单写入数据，即具备「使某个地址再也收不到我们的邮件」的能力。
 * 一个不校验来源的公开写接口等同于把该能力对外开放。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createVerify } from 'node:crypto';
import {
  suppressEmail, recordEmailDelivery, optOutMarketingByEmail,
} from '@gf/db';
import { rawBodyOf } from '../rawBody';

/** 消息时间戳的容差。超出即视为重放。 */
const TOLERANCE_SEC = 15 * 60;

/**
 * 合法的签名证书主机名。
 *
 * ⚠️ 必须是**完整主机名的精确匹配**，不能用 `endsWith('.amazonaws.com')` ——
 * 后者会放过 `evil-sns.us-east-2.amazonaws.com.attacker.com` 之外的
 * `sns.attacker.amazonaws.com` 这类形式，而攻击者一旦能控制证书 URL，
 * 整个验签就没有意义了。
 */
const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * 该 URL 是否可信 —— 协议为 https 且主机名是 AWS 的 SNS 端点。
 *
 * 签名证书地址与订阅确认地址共用这一条判定：两者都是**由请求体给出的、
 * 会被本服务主动访问的 URL**，任何一处放松都足以使验签失效或引入 SSRF。
 */
export function isTrustedSnsUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!CERT_HOST.test(url.hostname)) return null;
  return url;
}

export interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
  Token?: string;
}

/** SES 事件（配置集事件目标用 `eventType`，身份级通知用 `notificationType`）。 */
export interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[];
  };
  complaint?: {
    complainedRecipients?: { emailAddress?: string }[];
    complaintFeedbackType?: string;
  };
  delivery?: { recipients?: string[] };
  deliveryDelay?: { delayType?: string };
}

// ── 验签 ────────────────────────────────────────────────────────────────────

/**
 * 待签串。字段集合与顺序由消息类型决定，格式为 `key\nvalue\n` 依次拼接。
 *
 * ⚠️ `Subject` 仅在消息中存在时参与拼接。无条件加入（哪怕值为空串）会使所有
 * 不带 Subject 的通知验签失败，而 SES 的事件通知恰恰通常不带 Subject。
 */
export function snsStringToSign(msg: SnsEnvelope): string | null {
  const keys = msg.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

  let out = '';
  for (const k of keys) {
    const v = (msg as Record<string, unknown>)[k];
    if (v === undefined || v === null) {
      // Subject 可缺省；其余字段缺失意味着这不是一条完整的 SNS 消息
      if (k === 'Subject') continue;
      return null;
    }
    out += `${k}\n${String(v)}\n`;
  }
  return out;
}

/**
 * 证书缓存。
 *
 * SNS 的签名证书极少轮换，而事件通知在退信高峰期可能密集到达 —— 每条都去
 * 取一次证书既拖慢响应，也可能因限流导致合法通知被误拒。
 *
 * ⚠️ 键是完整 URL，而 URL 中含证书指纹；轮换时 URL 随之改变，因此无需失效策略。
 */
const certCache = new Map<string, string>();

async function fetchSigningCert(url: string): Promise<string | null> {
  /*
   * 🔴 见文件头第 1 点。协议、主机名、路径后缀三者全部校验：
   * 只要攻击者能把证书 URL 指向自己控制的主机，验签就完全失效。
   */
  const parsed = isTrustedSnsUrl(url);
  if (!parsed || !parsed.pathname.endsWith('.pem')) return null;

  const cached = certCache.get(parsed.toString());
  if (cached) return cached;

  const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const pem = await res.text();
  certCache.set(parsed.toString(), pem);
  return pem;
}

/**
 * 用给定证书验证一条 SNS 消息。取证书这一步分离在外，便于测试覆盖签名与
 * 时间戳这两条判定，而无需真的去 AWS 取证书。
 *
 * ⚠️ `SignatureVersion` 决定摘要算法：`1` 为 SHA1，`2` 为 SHA256。
 * 硬编码其中之一会在 AWS 侧切换版本时导致全部回调被拒。
 * ⚠️ 版本 `1` / `2` 之外的未知值一律拒绝，不做「按 SHA256 再试一次」的回退 ——
 * 未知版本意味着待签串的构造规则也可能已变，猜测没有意义。
 */
export function verifySnsSignatureWith(
  msg: SnsEnvelope, certPem: string, now = Date.now(),
): boolean {
  if (!msg.Signature || !msg.Type) return false;

  const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256'
    : msg.SignatureVersion === '1' ? 'RSA-SHA1'
    : null;
  if (!algo) return false;

  // ⚠️ 时间戳容差。不校验的话，一条被截获的旧通知可以被无限重放，
  //    而本路由能把任意地址写入抑制名单。
  const ts = Date.parse(msg.Timestamp ?? '');
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SEC * 1000) return false;

  const payload = snsStringToSign(msg);
  if (payload === null) return false;

  try {
    return createVerify(algo)
      .update(payload, 'utf8')
      .verify(certPem, msg.Signature, 'base64');
  } catch {
    // 证书无法解析，或签名不是合法的 base64
    return false;
  }
}

/** 验证一条 SNS 消息（取证书 + 验签）。返回 true 才继续。 */
export async function verifySnsMessage(
  msg: SnsEnvelope, now = Date.now(),
): Promise<boolean> {
  if (!msg.SigningCertURL) return false;
  const cert = await fetchSigningCert(msg.SigningCertURL);
  if (!cert) return false;
  return verifySnsSignatureWith(msg, cert, now);
}

/** 期望的 SNS 主题 ARN。未配置时本路由一律拒收（见文件头）。 */
export function expectedTopicArn(env = process.env): string | null {
  return env['SES_SNS_TOPIC_ARN'] ?? null;
}

// ── 事件处理 ────────────────────────────────────────────────────────────────

/**
 * ⚠️ 硬退与软退必须区分处理。
 *
 * 软退是临时性的（对方邮箱已满、服务器暂时拒收）。将其一并纳入抑制名单，
 * 一次对方服务器抖动就会让该顾客**永久**收不到预约确认。
 *
 * SES 在 `bounce.bounceType` 中给出 `Permanent` / `Transient` / `Undetermined`
 * （与迁移前的 Resend 取值一致，此处判定逻辑未变）。
 * ⚠️ `Undetermined` 按**软退**处理：在无法确定时，漏拦比误拦安全 ——
 * 误拦的代价是顾客再也收不到邮件，而该后果是静默的。
 */
export function bounceIsHard(ev: SesEvent): boolean {
  const t = ev.bounce?.bounceType;
  return typeof t === 'string' && t.toLowerCase() === 'permanent';
}

/**
 * 事件中的收件地址。
 *
 * ⚠️ 优先取**事件自身列出的受影响收件人**（`bouncedRecipients` /
 * `complainedRecipients`），而非 `mail.destination`。本系统每封邮件只有一个
 * 收件人，两者通常一致；但当 SES 侧行为变化导致不一致时，把整个 destination
 * 写入抑制名单会误伤未退信的地址，而该误伤是静默且不可察觉的。
 */
export function recipientOf(ev: SesEvent): string | null {
  const bounced = ev.bounce?.bouncedRecipients?.[0]?.emailAddress;
  if (bounced) return bounced;
  const complained = ev.complaint?.complainedRecipients?.[0]?.emailAddress;
  if (complained) return complained;
  return ev.mail?.destination?.[0] ?? null;
}

export async function handleSesEvent(
  ev: SesEvent,
  log?: { info: (o: unknown, m: string) => void },
): Promise<{ handled: string }> {
  const type = ev.eventType ?? ev.notificationType ?? '';
  const providerId = ev.mail?.messageId;
  const to = recipientOf(ev);

  switch (type) {
    case 'Delivery':
      if (providerId) await recordEmailDelivery({ providerId, state: 'delivered' });
      return { handled: type };

    case 'DeliveryDelay':
      if (providerId) await recordEmailDelivery({ providerId, state: 'delayed' });
      return { handled: type };

    case 'Bounce': {
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
          detail: ev.bounce?.bouncedRecipients?.[0]?.diagnosticCode
            ?? ev.bounce?.bounceSubType ?? null,
        });
        log?.info({ to: '[redacted]', providerId }, 'email hard bounce suppressed');
      }
      return { handled: type };
    }

    case 'Complaint': {
      if (providerId) await recordEmailDelivery({ providerId, state: 'complained' });
      if (to) {
        /*
         * 投诉比硬退更强：地址进入抑制名单，**并且**关闭该收件人的营销订阅。
         * 后者管的是日后人工解除抑制之后的状态 —— 不关闭的话，解除抑制当天
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

    /*
     * ⚠️ `Reject` 是 SES 在受理后自行丢弃（例如检出病毒附件），邮件从未发出。
     * 归入软退而非硬退：问题出在我方内容，不在收件地址 ——
     * 把收件人拉进抑制名单是错误的归因。
     */
    case 'Reject':
    case 'RenderingFailure':
      if (providerId) await recordEmailDelivery({ providerId, state: 'soft_bounce' });
      return { handled: type };

    default:
      // `Send` / `Open` / `Click` / `Subscription` 等：保留返回值，不做处理
      return { handled: 'ignored' };
  }
}

// ── 路由 ────────────────────────────────────────────────────────────────────

/**
 * 订阅确认。
 *
 * SNS 在订阅一个 HTTPS 端点时先投递一条 `SubscriptionConfirmation`，端点访问
 * 其中的 `SubscribeURL` 才算订阅成功。
 *
 * ⚠️ 自动访问一个由请求体给出的 URL 属于 SSRF 面。此处的约束是：签名已验证
 * 通过、`TopicArn` 与配置一致、且该 URL 的主机名同样是 AWS 的 SNS 端点。
 * 三者同时满足时，该 URL 只可能指向我们自己的主题。
 */
async function confirmSubscription(
  msg: SnsEnvelope, log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void },
): Promise<boolean> {
  const url = isTrustedSnsUrl(msg.SubscribeURL);
  if (!url) {
    log.warn({ url: msg.SubscribeURL }, 'ses webhook: SubscribeURL 不可信，拒绝访问');
    return false;
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  log.info({ ok: res.ok, topic: msg.TopicArn }, 'ses webhook: 订阅确认');
  return res.ok;
}

export function registerSesWebhook(app: FastifyInstance): void {
  app.post('/v1/webhooks/ses', async (req: FastifyRequest<{ Body: unknown }>, reply) => {
    /*
     * ⚠️ 用原始请求体解析。本路径已登记在 `RAW_BODY_PREFIXES` 中，因此
     * `req.body` 是 `{ raw }` 而非解析后的对象。
     *
     * ⚠️ SNS 投递时的 `Content-Type` 是 `text/plain`，正文却是 JSON ——
     * 不走原始体的话，Fastify 的 JSON 解析器根本不会被触发，`req.body` 会是
     * 一个字符串或空值，而该失败看起来像「SNS 发了空请求」，排查方向会跑偏。
     */
    const raw = rawBodyOf(req);
    if (!raw) return reply.status(400).send({ error: 'raw_body_unavailable' });

    let msg: SnsEnvelope;
    try {
      msg = JSON.parse(raw) as SnsEnvelope;
    } catch {
      return reply.status(400).send({ error: 'invalid_json' });
    }

    /*
     * 🔴 见文件头第 3 点。证书校验只能证明「这是一条合法的 SNS 消息」，
     * 不能证明「这是发给我们的消息」—— 任何人都能创建 SNS 主题并向本端点
     * 投递结构合法的通知，而本路由会写抑制名单。
     */
    const expected = expectedTopicArn();
    if (!expected || msg.TopicArn !== expected) {
      req.log.warn(
        { topicArn: msg.TopicArn, configured: Boolean(expected) },
        'ses webhook: TopicArn 不匹配或未配置 SES_SNS_TOPIC_ARN，拒收',
      );
      return reply.status(401).send({ error: 'topic_mismatch' });
    }

    if (!await verifySnsMessage(msg)) {
      // ⚠️ 401 而不是 200，理由同上：这条路由能让某个地址再也收不到我们的邮件。
      req.log.warn({ messageId: msg.MessageId }, 'ses webhook: 验签失败，拒收');
      return reply.status(401).send({ error: 'invalid_signature' });
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      const ok = await confirmSubscription(msg, req.log);
      return reply.status(200).send({ handled: ok ? 'subscribed' : 'subscribe_failed' });
    }
    if (msg.Type !== 'Notification') {
      return reply.status(200).send({ handled: 'ignored' });
    }

    try {
      const ev = JSON.parse(msg.Message ?? '{}') as SesEvent;
      return reply.status(200).send(await handleSesEvent(ev, req.log));
    } catch (e) {
      /*
       * ⚠️ 处理失败同样返回 200。
       *
       * SNS 对非 2xx 响应会重投，而本路由做的都是幂等 upsert —— 让它反复重投
       * 一件已完成或无法完成的操作没有收益，只会在故障持续期间堆积回调队列，
       * 届时**真正需要处理的退信也会一并阻塞**。
       */
      req.log.warn({ err: e }, 'ses webhook: 处理失败');
      return reply.status(200).send({ handled: 'error' });
    }
  });
}
