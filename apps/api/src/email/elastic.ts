/** Elastic Email v4. Never expose provider bodies: they may contain credentials or recipients. */
const ACCOUNT_LIMIT_DETAILS = [
  // 账户层面的已知限制。正文只用于识别这一小组固定情况，识别后立即丢弃。
  { code: 'tracking_locked' as const, match: /cannot change the tracking options/i },
];
export type ElasticErrorDetail = (typeof ACCOUNT_LIMIT_DETAILS)[number]['code'];
export class ElasticError extends Error {
  readonly permanent: boolean;
  constructor(readonly status: number, readonly detail: ElasticErrorDetail | null = null) {
    super(`elastic_email_http_${status}`);
    this.permanent = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
  }
}
export function elasticKey(env = process.env): string | undefined {
  return env['ELASTICEMAIL_API_KEY'] || env['ELASTIC_EMAIL_API_KEY'];
}
export async function elasticRequest<T>(
  method: string, path: string, body?: unknown,
  key = elasticKey(), timeoutMs = 15_000,
): Promise<T> {
  if (!key) throw new Error('elastic_email_not_configured');
  const res = await fetch(`https://api.elasticemail.com/v4${path}`, {
    method, headers: { 'X-ElasticEmail-ApiKey': key, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail: ElasticErrorDetail | null = null;
    try {
      const text = (await res.text()).slice(0, 2000);
      detail = ACCOUNT_LIMIT_DETAILS.find(d => d.match.test(text))?.code ?? null;
    } catch { /* 正文不可读不影响状态码判定。 */ }
    throw new ElasticError(res.status, detail);
  }
  const raw = await res.text();
  return (raw ? JSON.parse(raw) : null) as T;
}
export interface ElasticDomain {
  Domain: string; Spf: boolean; Dkim: boolean; DMARC: boolean; Verify: boolean;
  TrackingStatus?: string; ValidationLog?: string;
}
// Verify is an email-identity flag in live responses; authenticated domains can have Verify=false.
export function elasticDomainReady(d: ElasticDomain): boolean {
  return d.Spf === true && d.Dkim === true && d.DMARC === true;
}

/**
 * 是否还按每封邮件关闭追踪。
 *
 * 部分 Elastic Email 账户不允许在发送请求里覆盖追踪设置，此时带 Options 的请求
 * 会被 HTTP 400 拒绝。首次遇到该限制后改为按账户默认设置发送：事务邮件继续送达
 * 优先于关闭追踪，但链接会被账户级点击追踪改写，需要在运维文档中记录。
 */
let trackingOptOut: boolean | null = null;
function trackingOptOutEnabled(): boolean {
  if (trackingOptOut === null) trackingOptOut = process.env['ELASTICEMAIL_TRACKING_LOCKED'] !== '1';
  return trackingOptOut;
}
export function elasticTrackingLocked(): boolean {
  return !trackingOptOutEnabled();
}
export function resetElasticTrackingProbe(): void {
  trackingOptOut = null;
}
export async function elasticSendEmail(msg: {
  from: string; to: string; subject: string; html: string; text: string;
  replyTo?: string | null; outboxId?: string;
}): Promise<{ MessageID: string; TransactionID: string }> {
  const key = process.env['ELASTICEMAIL_SEND_API_KEY'] || elasticKey();
  const payload = (optOut: boolean) => ({
    Recipients: { To: [msg.to] },
    Content: {
      From: msg.from, Subject: msg.subject,
      ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
      ...(msg.outboxId ? { Headers: { 'X-GenieFront-Outbox': msg.outboxId }, Postback: msg.outboxId } : {}),
      Body: [{ ContentType: 'HTML', Content: msg.html, Charset: 'utf-8' },
        { ContentType: 'PlainText', Content: msg.text, Charset: 'utf-8' }],
    },
    // Auth and booking links must not be rewritten; no marketing headers on transactional calls.
    ...(optOut ? { Options: { TrackOpens: false, TrackClicks: false } } : {}),
  });
  try {
    return await elasticRequest('POST', '/emails/transactional', payload(trackingOptOutEnabled()), key);
  } catch (e) {
    if (!(e instanceof ElasticError) || e.detail !== 'tracking_locked' || !trackingOptOutEnabled()) throw e;
    trackingOptOut = false;
    return elasticRequest('POST', '/emails/transactional', payload(false), key);
  }
}
