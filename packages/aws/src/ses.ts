/**
 * AWS SES v2 的 HTTP 传输层。
 *
 * 本模块只负责「把一个已签名的请求打出去，并把错误规整成统一形状」，
 * 不含任何业务判断。业务侧的两个入口分别是 `apps/api/src/email/send.ts`（发送）与
 * `apps/api/src/email/marketingDomain.ts`（发件域名管理）。
 *
 * ## 为什么不引 AWS SDK
 *
 * 见 `sigv4.ts` 文件头。概括为：本系统对 SES 的使用面仅两类接口，
 * 均为普通 JSON over HTTPS，引入 SDK 带来的传递依赖与构建体积不成比例。
 *
 * ## 区域与端点
 *
 * 端点固定为 `email.{region}.amazonaws.com`。区域取 `AWS_REGION`，缺省
 * `us-east-1` —— ⚠️ SES 的**发件身份、抑制名单、配置集与发送配额均按区域
 * 独立**。在 A 区验证过的域名在 B 区并不存在，切换区域等于从零开始，
 * 因此该值一经确定不应变更。
 */

import { signRequest, credentialsFromEnv, awsRegion, encodePath } from './sigv4';

/** SES 调用失败时的统一形状。调用方据此区分「重试无意义」与「可重试」。 */
export class SesError extends Error {
  constructor(
    readonly status: number,
    readonly awsErrorType: string | null,
    readonly detail: string,
  ) {
    super(`SES ${status} ${awsErrorType ?? ''} ${detail}`.trim());
    this.name = 'SesError';
  }

  /**
   * 该错误是否为**重试也不会改变结果**的错误。
   *
   * 4xx 表示请求本身不被接受（地址非法、域名未验证、身份不存在），
   * 重投只会重复消耗配额并延长队首阻塞时间。
   *
   * ⚠️ 429（`TooManyRequestsException`，即超出发送速率）例外 —— 它描述的是
   * 当下的瞬时状态，稍后重试即可成功。
   */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export function sesHost(env = process.env): string {
  return `email.${awsRegion(env)}.amazonaws.com`;
}

/**
 * 发起一次已签名的 SES 调用。
 *
 * @param method HTTP 方法
 * @param path   以 `/v2/email` 开头的绝对路径，**未编码**（路径中的身份名
 *               由签名器逐段编码，调用方不要预先编码）
 * @param body   请求体对象。GET / DELETE 传 `undefined`
 *
 * @throws SesError 非 2xx 响应
 * @throws Error    未配置凭据，或网络层失败
 */
export async function sesRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const env = opts.env ?? process.env;
  const creds = credentialsFromEnv(env);
  if (!creds) throw new Error('AWS 凭据未配置（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）');

  const host = sesHost(env);
  const payload = body === undefined ? '' : JSON.stringify(body);

  /*
   * ⚠️ 必须先序列化再签名：载荷哈希取的是最终发送的字节序列。
   * 若在签名后重新序列化（例如把对象再交给 fetch 自行处理），键序与空白
   * 可能改变，签名必然失配，而失败信息只有 `SignatureDoesNotMatch`。
   */
  const headers = signRequest({
    method,
    path,
    host,
    service: 'ses',
    region: awsRegion(env),
    ...(payload ? { headers: { 'content-type': 'application/json' } } : {}),
    body: payload,
  }, creds);

  /*
   * ⚠️ 实际请求行用 `encodePath`（单次编码），而签名用的规范路径是它再编码
   * 一次的结果（`canonicalPath`，见该函数注释）。两者必须成对使用 ——
   * 任一侧写错都只会得到 `InvalidSignatureException`，无法反推出错环节。
   */
  const res = await fetch(`https://${host}${encodePath(path)}`, {
    method,
    headers,
    ...(payload ? { body: payload } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  const text = await res.text();
  if (!res.ok) {
    /*
     * SES 把错误类型放在 `x-amzn-errortype` 头里（形如
     * `MessageRejected:http://internal.amazon.com/...`），正文里是可读描述。
     * 两者都保留：类型用于分支判断，描述用于运维排查。
     */
    const type = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? null;
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { message?: string; Message?: string };
      detail = (parsed.message ?? parsed.Message ?? detail).slice(0, 400);
    } catch {
      // 非 JSON 正文（网关层错误页）时保留原文片段
    }
    throw new SesError(res.status, type, detail);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

// ── 发送 ────────────────────────────────────────────────────────────────────

export interface SesSendInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** 附加头部（当前仅用于 RFC 8058 的一键退订）。 */
  headers?: Record<string, string> | undefined;
  /**
   * 配置集名称。SES 的投递事件（送达、退信、投诉）**只有绑定了配置集的
   * 邮件才会发出**，未绑定时系统对一封信的下场一无所知。
   */
  configurationSet?: string | undefined;
}

/** SES `SendEmail` 的返回。`MessageId` 与投递事件里的 `mail.messageId` 同值。 */
export async function sesSendEmail(input: SesSendInput): Promise<{ MessageId: string }> {
  return sesRequest<{ MessageId: string }>('POST', '/v2/email/outbound-emails', {
    FromEmailAddress: input.from,
    Destination: { ToAddresses: [input.to] },
    ...(input.configurationSet ? { ConfigurationSetName: input.configurationSet } : {}),
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: input.html, Charset: 'UTF-8' },
          Text: { Data: input.text, Charset: 'UTF-8' },
        },
        ...(input.headers && Object.keys(input.headers).length > 0
          ? {
              Headers: Object.entries(input.headers)
                .map(([Name, Value]) => ({ Name, Value })),
            }
          : {}),
      },
    },
  });
}

// ── 发件身份（域名）────────────────────────────────────────────────────────

/** SES 的 DKIM 验证状态。`SUCCESS` 之外的任何值都不算就绪。 */
export type SesDkimStatus =
  | 'PENDING' | 'SUCCESS' | 'FAILED' | 'TEMPORARY_FAILURE' | 'NOT_STARTED';

export interface SesIdentityDetail {
  IdentityType?: string;
  VerifiedForSendingStatus?: boolean;
  DkimAttributes?: {
    SigningEnabled?: boolean;
    Status?: SesDkimStatus;
    /** Easy DKIM 的三个令牌，用于拼出三条 CNAME 记录。 */
    Tokens?: string[];
  };
  MailFromAttributes?: {
    MailFromDomain?: string;
    MailFromDomainStatus?: string;
    BehaviorOnMxFailure?: string;
  };
  ConfigurationSetName?: string;
}

export interface SesIdentitySummary {
  IdentityType?: string;
  IdentityName?: string;
  SendingEnabled?: boolean;
  VerificationStatus?: SesDkimStatus;
}

export const sesIdentities = {
  /**
   * 创建域名身份并启用 Easy DKIM。
   *
   * ⚠️ 不传 `DkimSigningAttributes` 即为 Easy DKIM（由 SES 托管密钥并返回
   * 三个 CNAME 令牌）。传入自备密钥（BYODKIM）会要求调用方管理私钥轮换，
   * 对本系统的自动化程度而言得不偿失。
   *
   * `ConfigurationSetName` 在此处绑定，使该身份发出的邮件默认带上配置集 ——
   * 否则每一次发送都必须记得显式传参，漏传时的表现是「投递事件静默缺失」。
   */
  create: (name: string, configurationSet?: string) =>
    sesRequest<SesIdentityDetail>('POST', '/v2/email/identities', {
      EmailIdentity: name,
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    }, { timeoutMs: 20_000 }),

  get: (name: string) =>
    sesRequest<SesIdentityDetail>(
      'GET', `/v2/email/identities/${name}`, undefined, { timeoutMs: 20_000 }),

  list: () =>
    sesRequest<{ EmailIdentities?: SesIdentitySummary[] }>(
      'GET', '/v2/email/identities', undefined, { timeoutMs: 20_000 }),

  delete: (name: string) =>
    sesRequest<Record<string, never>>(
      'DELETE', `/v2/email/identities/${name}`, undefined, { timeoutMs: 20_000 }),
};
