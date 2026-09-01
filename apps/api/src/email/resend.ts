/**
 * Resend 的 HTTP 传输层。
 *
 * 与 `@gf/aws` 的 SES 客户端并列，由 `email/provider.ts` 按 `EMAIL_PROVIDER`
 * 二选一。本模块只负责「把请求打出去，并把错误规整成统一形状」，不含业务判断。
 *
 * ## 为什么两家供应商同时留着
 *
 * SES 账号在 2026-09-01 时仍处于沙箱（只有已验证的收件地址能收到邮件），
 * 而生产环境需要能给任意顾客发信。因此发信实际走 Resend，SES 的整套实现保留
 * 待用 —— 脱离沙箱后把 `EMAIL_PROVIDER` 改成 `ses` 即可切换，不需要改代码。
 *
 * ⚠️ 两家供应商的**投递回调各走各的路由**（`/v1/webhooks/resend` 走 Svix HMAC，
 * `/v1/webhooks/ses` 走 SNS 的 X.509 签名）。切换 `EMAIL_PROVIDER` 时必须同时
 * 确认对应那一条回调也配好了 —— 否则退信与投诉静默停止回流，而发信一切正常。
 */

const SEND_ENDPOINT = 'https://api.resend.com/emails';
const DOMAINS_ENDPOINT = 'https://api.resend.com/domains';

/** Resend 调用失败时的统一形状，与 `@gf/aws` 的 `SesError` 对齐。 */
export class ResendError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Resend ${status} ${detail}`.trim());
    this.name = 'ResendError';
  }

  /**
   * 该错误是否**重试也不会改变结果**。
   *
   * 4xx 表示请求本身不被接受（地址非法、域名未验证）。⚠️ 429 例外 ——
   * 它描述的是当下的限频状态，稍后重试即可成功。
   */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

function apiKey(): string {
  const key = process.env['RESEND_API_KEY'];
  if (!key) throw new Error('RESEND_API_KEY 未配置');
  return key;
}

async function call<T>(url: string, init: RequestInit, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new ResendError(res.status, text.slice(0, 400));
  return (text ? JSON.parse(text) : {}) as T;
}

export interface ResendSendInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string> | undefined;
}

/** 返回的 `id` 即投递回调里的 `data.email_id`。 */
export async function resendSendEmail(input: ResendSendInput): Promise<{ id: string }> {
  return call<{ id: string }>(SEND_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.headers && Object.keys(input.headers).length > 0
        ? { headers: input.headers }
        : {}),
    }),
  });
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
}

/**
 * 账号下已登记的发信域名。
 *
 * ⚠️ 只用于**核验**（发件域名是否 `verified`），不用于创建。当前的域名布局是
 * 三个固定域（`notify.` / `appointment.` / `mkt.`），全部人工建好并验证 ——
 * 不存在需要程序去建域名的场景（见 `marketingDomain.ts` 文件头）。
 */
export async function resendListDomains(): Promise<ResendDomain[]> {
  const body = await call<{ data?: ResendDomain[] }>(
    DOMAINS_ENDPOINT, { method: 'GET' }, 20_000);
  return body.data ?? [];
}
