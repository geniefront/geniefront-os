/**
 * 营销邮件的门店专属发件域名（2026-09-01 店主定）。
 *
 * ```
 * promo@oasisspa.geniefront.com
 *       └────────┘ 每家店一个子域，在 Resend 里各自验证
 * ```
 *
 * ## 为什么一店一个子域，而不是共用一个
 *
 * 发信域名的**信誉是按域名累积的**。所有门店共用 `promo.geniefront.com`
 * 的话，一家店的营销邮件被大量举报，会拖垮其余全部门店的营销送达率；
 * 而门店对彼此的名单质量既无从知晓，也无从干预。
 *
 * ⚠️ 事务性邮件（预约四类、计费三封）**不走这一条路**，仍用平台的
 * `FROM_EMAIL`。事务性邮件的投诉率天然极低，且必须在门店完成任何配置
 * 之前就能发出去 —— 把它们也绑上门店域名，等于让一家新店在 DNS 验证
 * 通过之前连预约确认都发不了。
 *
 * ## 三步，中间那步不在我们手里
 *
 * ```
 * 1. createDomain()   调 Resend 建 domain，拿回要加的 DNS 记录
 * 2. （人工）          在 Cloudflare 加 SPF / DKIM / DMARC 三条记录
 * 3. verifyDomain()   调 Resend 验证；通过后写 locations.marketing_email_from
 * ```
 *
 * 第 2 步需要 DNS 管理权限，不在本服务的能力范围内。因此第 1 步只**记录
 * 待办**，不写 `marketing_email_from` —— 那一列的语义是「已就绪」，
 * 提前写进去会让营销邮件在 DNS 还没生效时就发出去，全部退信。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';

const ENDPOINT = 'https://api.resend.com/domains';

/**
 * 子域挂在哪个根域下。与 `FROM_EMAIL` 的域名保持一致即可，
 * 但**必须是我们能改 DNS 的那个**。
 */
export function marketingRootDomain(env = process.env): string {
  return env['MARKETING_EMAIL_ROOT_DOMAIN'] ?? 'geniefront.com';
}

/** 发件本地部分。所有门店一致 —— 收件人看到的辨识度来自子域，不是这里。 */
export const MARKETING_MAILBOX = 'promo';

/**
 * 把门店 slug 收敛成一个合法的 DNS 标签。
 *
 * ⚠️ `locations.slug` 末尾带一段随机 hex 防重（sql/0030），那是给 URL 用的，
 * 不该出现在顾客看到的发件地址里。
 *
 * ⚠️ 结果**不做唯一性保证**。两家「Lotus Spa」会算出同一个标签，而域名
 * 必须唯一 —— 因此调用方可以显式传 `label`，由人来决定第二家叫什么。
 * 自动加数字后缀是错的：`lotusspa2@…` 看起来就像仿冒。
 */
export function domainLabelFromSlug(slug: string): string {
  return slug
    .replace(/-[0-9a-f]{6,}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
}

export function marketingDomainFor(label: string, env = process.env): string {
  return `${label}.${marketingRootDomain(env)}`;
}

export function marketingAddressFor(label: string, env = process.env): string {
  return `${MARKETING_MAILBOX}@${marketingDomainFor(label, env)}`;
}

export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  ttl?: string;
  value: string;
  priority?: number;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records: DnsRecord[];
}

function apiKey(): string {
  const key = process.env['RESEND_API_KEY'];
  if (!key) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'resend_not_configured' },
    });
  }
  return key;
}

/**
 * Resend domains 接口的三个调用。抽成一个可替换的对象，理由与
 * `signup/checkout.ts` 的 `__setSignupCheckoutCreatorForTests` 一致：
 * 测试要覆盖「验过了 / 还没验过 / 域名不存在」三条分支，而这三条都不该
 * 真的打出去。
 */
export interface ResendDomainClient {
  create(name: string): Promise<ResendDomain>;
  verify(id: string): Promise<{ id: string; status?: string }>;
  get(id: string): Promise<ResendDomain>;
  list(): Promise<{ data: ResendDomain[] }>;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  /*
   * 🔴 **测试进程里一个域名都不许真建。**
   *
   * `.env` 在测试进程里是加载的（vitest.shared 的 loadEnv），所以
   * `RESEND_API_KEY` 在测试里是有值的 —— 不拦的话，跑一遍测试就在真实
   * Resend 账号里建出一批对不上任何门店的域名，而删它们要一个个手点。
   *
   * 拦在这里而不是拦在调用方：入参组装、状态分支、写库那几步照常被测到，
   * 只有「真的打出去」这一下必须由测试显式替换（`__setResendClientForTests`）。
   */
  if (process.env['NODE_ENV'] === 'test') {
    throw new Error('测试进程里禁止直连 Resend —— 用 __setResendClientForTests 装替身');
  }
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'resend', status: res.status, body: body.slice(0, 400) },
    });
  }
  return JSON.parse(body || '{}') as T;
}

const httpClient: ResendDomainClient = {
  /**
   * 第 1 步：在 Resend 建一个 domain，拿回要加的 DNS 记录。
   *
   * `region` 固定 `us-east-1`：门店与顾客都在美东，跨区只会增加投递延迟。
   */
  create: (name) => call<ResendDomain>('', {
    method: 'POST',
    body: JSON.stringify({ name, region: 'us-east-1' }),
  }),
  /** 第 3 步：让 Resend 去查 DNS。DNS 刚加完通常要等几分钟到几十分钟。 */
  verify: (id) => call(`/${id}/verify`, { method: 'POST' }),
  get: (id) => call<ResendDomain>(`/${id}`, { method: 'GET' }),
  list: () => call<{ data: ResendDomain[] }>('', { method: 'GET' }),
};

let client: ResendDomainClient = httpClient;

export function __setResendClientForTests(fn: ResendDomainClient | null): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__setResendClientForTests 只能在测试环境用');
  }
  client = fn ?? httpClient;
}

/**
 * ⚠️ 以下四个都**不写 `locations.marketing_email_from`**。那一列的语义是
 * 「已就绪」，而建完域名时 DNS 还没加，写进去会让营销邮件全部退信。
 * 写库只发生在 `platform.setMarketingEmail` 拿到 `verified` 之后。
 */
export const createDomain = (name: string): Promise<ResendDomain> => client.create(name);
export const verifyDomain = (id: string): Promise<{ id: string; status?: string }> =>
  client.verify(id);
export const getDomain = (id: string): Promise<ResendDomain> => client.get(id);
export const listDomains = (): Promise<{ data: ResendDomain[] }> => client.list();

/**
 * 把 Resend 给的记录排成一张能照着往 Cloudflare 里填的表。
 *
 * ⚠️ `name` 原样输出，不做「补根域」或「去根域」的加工 —— 两家 DNS 服务商
 * 对相对/绝对名的处理不一致，加工过的值填错了不会报错，只会验证不通过，
 * 而排查这件事要等 DNS 传播。
 */
export function formatDnsInstructions(d: ResendDomain): string {
  const lines = [
    `域名：${d.name}   （Resend id: ${d.id}，当前状态 ${d.status}）`,
    '',
    '在 Cloudflare 里加下面这几条记录，⚠️ Proxy 一律关掉（DNS only）：',
    '',
  ];
  for (const r of d.records) {
    lines.push(`  ${r.type.padEnd(5)} ${r.name}`);
    lines.push(`        value: ${r.value}`);
    if (r.priority !== undefined) lines.push(`        priority: ${r.priority}`);
    lines.push('');
  }
  lines.push('加完之后跑一次 verify；通过后才把发件地址写进 locations。');
  return lines.join('\n');
}
