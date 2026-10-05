/**
 * 营销邮件的门店发件地址。
 *
 * ```
 * spasite1@mkt.geniefront.com
 * └──────┘ 门店标签（本地部分），每店一个
 *          └───────────────────┘ 所有门店共用的营销域
 * ```
 *
 * ## 划分到哪一层，以及代价
 *
 * 发信信誉**按域名累积**，因此这套划分真正保护的是「营销 vs 事务」这条线：
 * 营销邮件的投诉率天然高于事务性邮件，混用一个域时，一家店的营销投诉会直接
 * 拉低所有门店预约确认邮件的送达率 —— 而「预约确认进了垃圾箱」不会有任何人
 * 来投诉，只表现为到店率下降。
 *
 * ⚠️ **门店之间的营销信誉是共享的**（2026-09-02 店主定）。全部门店共用
 * `mkt.geniefront.com`，收件人看到的门店身份来自本地部分而非子域。一家店的
 * 名单质量差会影响其余门店的营销送达率，而各店对彼此的名单既无从知晓也无从
 * 干预。这是拿「每店一个子域要每店一套 DNS 验证与人工介入」换来的简化。
 *
 * 该判断可逆：真出现某家店拖累整体时，把它单独挪到自己的子域即可 ——
 * `marketing_email_from` 存的是**完整地址**，不是标签，因此挪一家店不影响其余。
 *
 * ## 与 2026-09-01 版本的差别
 *
 * 上一版是「每店一个子域」（`promo@<label>.geniefront.com`），需要三步：
 * 建域名 → 人工加 DNS → 核验。现在营销域是**一个已验证的固定域**，
 * 因此「建域名」与「加 DNS」两步都不存在了 —— 启用一家店只剩两件事：
 *
 * ```
 * 1. 确认 mkt.geniefront.com 在当前供应商处已 verified（核验事实）
 * 2. 把 <label>@mkt.geniefront.com 写进 locations.marketing_email_from
 * ```
 *
 * ⚠️ 第 1 步不能省。跳过它就等于相信「域名当然是好的」，而域名在供应商侧被
 * 停用（欠费、被投诉、密钥换账号）时不会有任何通知 —— 表现是整批营销邮件
 * 退信，而退信率同样计入信誉。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';
import { sesIdentities, SesError } from '@gf/aws';
import { resendListDomains, ResendError } from './resend';
import { emailProvider } from './provider';
import { mailerooDomain } from './maileroo';

/**
 * 营销邮件的发件域。
 *
 * ⚠️ 变量名由 `MARKETING_EMAIL_ROOT_DOMAIN` 改为 `MARKETING_EMAIL_DOMAIN`：
 * 上一版它是「子域挂在哪个**根**域下」（值是 `geniefront.com`），现在它就是
 * 发件域本身（值是 `mkt.geniefront.com`）。沿用旧名字的话，一台没更新的机器
 * 会把营销邮件从 `<label>@geniefront.com` 发出去 —— 那个域没验证，整批退信。
 * 改名使旧值失效而不是被误用。
 */
export function marketingDomain(env = process.env): string {
  return env['MARKETING_EMAIL_DOMAIN'] ?? 'mkt.geniefront.com';
}

/**
 * 把门店 slug 收敛成一个合法的邮箱本地部分。
 *
 * ⚠️ `locations.slug` 末尾带一段随机 hex 用于防重（sql/0030），那是给 URL 用的，
 * 不应出现在顾客可见的发件地址中。
 *
 * ⚠️ 结果**不保证唯一**。两家「Lotus Spa」会算出同一个标签，而同一个域下的
 * 本地部分必须唯一 —— 因此调用方可显式传入 `label`，由人工决定第二家使用何种
 * 标签。自动追加数字后缀不可接受：`lotusspa2@…` 在收件人看来近似仿冒。
 */
export function domainLabelFromSlug(slug: string): string {
  return slug
    .replace(/-[0-9a-f]{6,}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
}

export function marketingAddressFor(label: string, env = process.env): string {
  return `${label}@${marketingDomain(env)}`;
}

/** 供上层使用的域名状态视图。`status` 为 `'verified'` 才算就绪。 */
export interface SendingDomain {
  name: string;
  status: string;
}

/**
 * 营销域在当前供应商处的状态。抽成可替换对象，理由与
 * `signup/checkout.ts` 的 `__setSignupCheckoutCreatorForTests` 一致：
 * 测试要覆盖「已验证 / 未验证 / 域名不存在」三条分支，而这三条都不应真实发出。
 */
export interface SendingDomainClient {
  status(name: string): Promise<SendingDomain>;
}

/**
 * 🔴 **测试进程中不得直连任何邮件供应商。**
 *
 * `.env` 在测试进程中是被加载的（`vitest.shared` 的 `loadEnv`），因此两家的
 * 凭据在测试里都有值 —— 不拦截的话，跑一遍测试就往真实账号打一批请求。
 *
 * 拦截点设在此处而非调用方：入参组装、状态分支、写库等步骤照常被覆盖，
 * 仅「实际发出」这一步必须由测试显式替换（`__setSendingDomainClientForTests`）。
 */
function assertNotTestProcess(): void {
  if (process.env['NODE_ENV'] === 'test') {
    throw new Error('测试进程中禁止直连邮件供应商 —— 请使用 __setSendingDomainClientForTests 注入替身');
  }
}

/** 供应商调用失败时转成本系统的上游错误，保留状态码与原文供排查。 */
function rethrow(e: unknown): never {
  if (e instanceof SesError) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'ses', status: e.status, type: e.awsErrorType, body: e.detail },
    });
  }
  if (e instanceof ResendError) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'resend', status: e.status, body: e.detail },
    });
  }
  throw e;
}

const httpClient: SendingDomainClient = {
  status: async (name) => {
    assertNotTestProcess();
    try {
      if (emailProvider() === 'maileroo') {
        const domain = await mailerooDomain(name);
        return { name, status: domain ? domain.status ? 'verified' : 'pending' : 'not_found' };
      }
      if (emailProvider() === 'ses') {
        const d = await sesIdentities.get(name);
        /*
         * ⚠️ 判据是 `VerifiedForSendingStatus`，而非仅看 `DkimAttributes.Status`。
         * 后者为 SUCCESS 时域名仍可能因账号级限制而不可发送，此时写入
         * `marketing_email_from` 会导致整批邮件被拒。
         */
        return { name, status: d.VerifiedForSendingStatus === true ? 'verified' : 'pending' };
      }
      const found = resolveDomain(await resendListDomains(), name);
      return { name, status: found?.status ?? 'not_found' };
    } catch (e) { return rethrow(e); }
  },
};

/**
 * 在供应商返回的域名列表里找出这一个。
 *
 * ⚠️ **精确匹配域名，不做后缀匹配。** `endsWith` 会让
 * `evil-mkt.geniefront.com` 匹配上 `mkt.geniefront.com`，而那是两个不同的域，
 * 信誉与验证状态都不共享。
 */
function resolveDomain(
  list: { name: string; status: string }[], name: string,
): { name: string; status: string } | undefined {
  const want = name.toLowerCase();
  return list.find((d) => d.name.toLowerCase() === want);
}

let client: SendingDomainClient = httpClient;

export function __setSendingDomainClientForTests(fn: SendingDomainClient | null): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__setSendingDomainClientForTests 只能在测试环境使用');
  }
  client = fn ?? httpClient;
}

/**
 * ⚠️ 本函数**不写 `locations.marketing_email_from`**。该列的语义是「已就绪」，
 * 写库只发生在 `platform.setMarketingEmail` 拿到 `verified` 之后。
 */
export const marketingDomainStatus = (env = process.env): Promise<SendingDomain> =>
  client.status(marketingDomain(env));

/**
 * 营销域没通过核验时给运维看的说明。
 *
 * ⚠️ 这里**不再打印 DNS 记录**。上一版每店一个子域，需要人照着加三条 DKIM；
 * 现在营销域是一个固定的、已验证的域，验不过的原因只可能是供应商侧的账号
 * 问题（域名被删、密钥指向了另一个账号、域名被停用）—— 那些不是加 DNS 能解决的，
 * 打一张 DNS 表反而会把排查方向引偏。
 */
export function explainDomainProblem(d: SendingDomain, env = process.env): string {
  const provider = {ses:'AWS SES',resend:'Resend',elasticemail:'Elastic Email',maileroo:'Maileroo'}[emailProvider(env)];
  const lines = [
    `营销发件域 ${d.name} 在 ${provider} 侧的状态是 ${d.status}，未达到 verified。`,
    '',
  ];
  if (d.status === 'not_found') {
    lines.push(
      `${provider} 账号里根本没有这个域名。请依次确认：`,
      `  · EMAIL_PROVIDER 是不是指到了预期的那一家（当前 ${emailProvider(env)}）`,
      '  · API 密钥是不是指向了另一个账号',
      `  · MARKETING_EMAIL_DOMAIN 的值（当前 ${marketingDomain(env)}）有没有写错`,
    );
  } else {
    lines.push(
      '域名存在但未验证通过。请在供应商控制台确认 DKIM 记录仍然解析正常，',
      '并检查该域名有没有被停用（欠费、投诉率超标都会导致停用，且不会有通知）。',
    );
  }
  lines.push('', '⚠️ 未通过核验前不会写库 —— 提前写入会让营销邮件整批退信，而退信率同样计入信誉。');
  return lines.join('\n');
}
