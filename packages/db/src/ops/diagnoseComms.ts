/**
 * 通信链路体检 —— 回答「这封信到底卡在哪一步」。
 *
 * 测试收件箱（`COMMUNICATION_DELIVERY_MODE=capture` + 运营台那一页）解决的是
 * 「怎么看见发出去的内容」；这个脚本解决的是另一个问题：**为什么没发出去**。
 * 配置、发件箱、供应商域名三段各自会失败，而三段的失败在门店那头是同一个
 * 现象（客人没收到信），必须分开看：
 *
 *   · 没配 key      → flushEmails() 直接 return，行停在 pending，**没有 last_error**
 *   · 域名没验证    → 供应商返回 4xx，行被标 failed，last_error 里有原文
 *   · SES 在沙箱    → MessageRejected，只有已验证的收件人能收到
 *   · 根本没入队    → 表是空的，问题在业务侧，跟发信这条路无关
 *
 * ⚠️ 供应商由 `EMAIL_PROVIDER` 决定，本脚本**只体检当前那一家** —— 体检另一家
 * 没有意义：不在用的那一家配得再好，邮件也不从它那里出去。
 *
 * ⚠️ 走 admin 连接（postgres 角色，不受 RLS）—— 体检是跨租户的运维动作，
 * 没有单一的 app.org_id 上下文。这也是它必须待在 packages/db 而不是 apps/
 * 的原因（宪法第 5 条，scripts/lint-guards.sh 会拦）。
 *
 * ⚠️ 只读。不发信，也不改动发件箱里的任何一行。
 *
 * 用法：
 *   pnpm diagnose:comms:staging
 *   pnpm diagnose:comms:local
 */

import { adminSql } from '../admin';
import { sesRequest, sesIdentities, awsRegion, SesError } from '@gf/aws';


const env = process.env;
/**
 * ⚠️ 这两项在 `apps/api` 侧各有一份权威实现（`email/provider.ts` 与
 * `email/marketingDomain.ts`），但 `packages/` 不能反向依赖 `apps/`（宪法第 5 条）。
 * 因此这里重复一遍最小逻辑，且**必须与那两处保持一致** —— 不一致的后果是
 * 体检报告说的和实际发信行为对不上，而体检工具存在的意义正是「它说什么就是什么」。
 */
const provider = env['EMAIL_PROVIDER']?.trim().toLowerCase() === 'ses' ? 'ses' : 'resend';
const marketingDomain = env['MARKETING_EMAIL_DOMAIN'] ?? 'mkt.geniefront.com';

const mask = (v: string | undefined): string =>
  !v ? '(未配置)' : `${v.slice(0, 8)}…（共 ${v.length} 字符）`;

function section(title: string): void {
  console.log(`\n===== ${title} =====`);
}

async function main(): Promise<void> {
  // ── 1. 配置 ──────────────────────────────────────────────────────────────
  section('配置');
  console.log(`GF_ENV                        ${env['GF_ENV'] ?? '(未设置)'}`);
  console.log(`COMMUNICATION_DELIVERY_MODE   ${env['COMMUNICATION_DELIVERY_MODE'] ?? 'live（默认）'}`);
  console.log(`EMAIL_PROVIDER                ${provider}${env['EMAIL_PROVIDER'] ? '' : '（默认）'}`);
  if (provider === 'ses') {
    console.log(`AWS_ACCESS_KEY_ID             ${mask(env['AWS_ACCESS_KEY_ID'])}`);
    console.log(`AWS_REGION                    ${awsRegion(env)}`);
    console.log(`SES_CONFIGURATION_SET         ${env['SES_CONFIGURATION_SET'] ?? '(未配置)'}`);
    console.log(`SES_SNS_TOPIC_ARN             ${env['SES_SNS_TOPIC_ARN'] ?? '(未配置)'}`);
  } else {
    console.log(`RESEND_API_KEY                ${mask(env['RESEND_API_KEY'])}`);
    console.log(`RESEND_WEBHOOK_SECRET         ${env['RESEND_WEBHOOK_SECRET'] ? '已配置' : '(未配置)'}`);
  }
  console.log(`FROM_EMAIL                    ${env['FROM_EMAIL'] ?? '(未配置)'}`);
  console.log(`CUSTOMER_FROM_EMAIL           ${env['CUSTOMER_FROM_EMAIL'] ?? '(未配置，回落到 FROM_EMAIL)'}`);
  console.log(`MARKETING_EMAIL_DOMAIN        ${marketingDomain}`);
  console.log(`TELNYX_API_KEY                ${mask(env['TELNYX_API_KEY'])}`);
  console.log(`TELNYX_SMS_FROM               ${env['TELNYX_SMS_FROM'] ?? '(未配置)'}`);
  console.log(`STAGING_OTP_CODE              ${env['STAGING_OTP_CODE'] ? '已配置' : '(未配置)'}`);

  const credsOk = provider === 'ses'
    ? Boolean(env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY'])
    : Boolean(env['RESEND_API_KEY']);
  if (!credsOk || !env['FROM_EMAIL']) {
    console.log('\n[x] emailConfigured() 为 false —— flushEmails() 会直接 return。'
      + '发件箱里的信永远停在 pending，且不会留下任何 last_error。');
  }
  // 回调没配 = 退信与投诉永远不回流，而现象与「一切正常」完全相同
  if (provider === 'ses' && !env['SES_CONFIGURATION_SET']) {
    console.log('\n[x] 未配置 SES_CONFIGURATION_SET —— 发出的邮件不会产生投递事件，'
      + '退信与投诉永远不会回流。');
  }
  if (provider === 'ses' && !env['SES_SNS_TOPIC_ARN']) {
    console.log('\n[x] 未配置 SES_SNS_TOPIC_ARN —— POST /v1/webhooks/ses 一律回 401。');
  }
  if (provider === 'resend' && !env['RESEND_WEBHOOK_SECRET']) {
    console.log('\n[x] 未配置 RESEND_WEBHOOK_SECRET —— POST /v1/webhooks/resend 一律回 401，'
      + '退信与投诉永远不会回流，而现象与「一切正常」完全相同。');
  }

  /*
   * 发件域名必须都是 SES 中已验证的身份，否则每一封都是 4xx。
   * ⚠️ 拆分后有两个事务性发件域，两个都要查 —— 只查 FROM_EMAIL 的话，
   * 顾客侧邮件全部退信而体检报告全绿。
   */
  const domainOf = (v: string | undefined): string | null =>
    /@([^>\s]+)/.exec(v ?? '')?.[1]?.toLowerCase() ?? null;
  const fromDomains = [
    ['FROM_EMAIL', domainOf(env['FROM_EMAIL'])],
    ['CUSTOMER_FROM_EMAIL', domainOf(env['CUSTOMER_FROM_EMAIL'])],
    ['MARKETING_EMAIL_DOMAIN', marketingDomain],
  ].filter((e): e is [string, string] => e[1] !== null);
  for (const [k, d] of fromDomains) console.log(`${k.padEnd(29)} 域名 ${d}`);

  // ── 2. 发件箱 ────────────────────────────────────────────────────────────
  section('发件箱（只读）');
  for (const table of ['email_outbox', 'sms_outbox'] as const) {
    console.log(`\n${table}:`);
    const counts = await adminSql.unsafe<{ status: string; n: number; latest: string }[]>(
      `select status, count(*)::int as n, max(created_at)::text as latest
         from ${table} group by status order by n desc`);
    if (counts.length === 0) console.log('  （空表 —— 业务侧根本没有入队，问题不在发信这条路上）');
    for (const c of counts) {
      console.log(`  ${c.status.padEnd(10)} ${String(c.n).padStart(5)}  最近 ${c.latest}`);
    }

    const recent = await adminSql.unsafe<{
      kind: string; status: string; attempts: number; err: string | null; created_at: string;
    }[]>(
      `select kind, status, attempts, left(last_error, 240) as err, created_at::text as created_at
         from ${table} order by created_at desc limit 8`);
    for (const r of recent) {
      console.log(`  - ${r.created_at} ${r.kind} ${r.status} attempts=${r.attempts}`
        + (r.err ? `\n      last_error: ${r.err}` : ''));
    }
  }

  // ── 3. 发信供应商 ───────────────────────────────────────────────────────
  //
  // ⚠️ 只查当前 EMAIL_PROVIDER 那一家。另一家配得再好，邮件也不从它那里出去。
  if (provider === 'resend') {
    section('Resend');
    if (!env['RESEND_API_KEY']) {
      console.log('没有 API key，跳过。');
    } else {
      try {
        const res = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${env['RESEND_API_KEY']}` },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await res.json().catch(() => ({})) as {
          data?: { name?: string; status?: string }[];
        };
        if (!res.ok) {
          console.log(`[x] ${res.status} —— API key 本身无效或已被吊销。`);
        } else {
          const domains = body.data ?? [];
          if (domains.length === 0) {
            console.log('[x] 这个账号下一个域名都没有：所有业务邮件都会被拒绝。');
          }
          for (const d of domains) {
            /*
             * ⚠️ 精确匹配域名，不做后缀匹配 —— `endsWith` 会让
             * `evil-mkt.geniefront.com` 匹配上 `mkt.geniefront.com`，
             * 而那是两个不同的域，验证状态与信誉都不共享。
             */
            const hit = fromDomains
              .filter(([, dom]) => d.name && dom === d.name.toLowerCase())
              .map(([k]) => k);
            console.log(`  ${d.status === 'verified' ? '[ok]' : '[x] '} ${d.name} (${d.status})`
              + (hit.length > 0 ? `  <- ${hit.join(' / ')} 用的就是它` : ''));
          }
          for (const [k, dom] of fromDomains) {
            if (!domains.some((d) => d.name && d.name.toLowerCase() === dom)) {
              console.log(`\n[x] ${k} 的域名 ${dom} 不在这个 Resend 账号里 —— `
                + '这正是「发件箱一直 failed，而供应商后台什么都看不到」的样子。');
            }
          }
        }
      } catch (e) {
        console.log(`[x] 连不上 Resend：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    section(`SES（${awsRegion(env)}）`);
    if (!env['AWS_ACCESS_KEY_ID']) {
      console.log('没有 AWS 凭据，跳过。');
    } else {
      try {
        /*
         * ⚠️ 沙箱状态必须显式打出来。沙箱下只有**已验证的收件地址**能收到邮件，
         * 其余一律 `MessageRejected` —— 而域名身份可以全绿，配置也可以全对。
         * 不查这一项的话，体检报告会在账号根本发不出信时显示一切正常。
         */
        const acct = await sesRequest<{
          ProductionAccessEnabled?: boolean;
          SendingEnabled?: boolean;
          EnforcementStatus?: string;
          SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number };
        }>('GET', '/v2/email/account');

        console.log(`  发送开关     ${acct.SendingEnabled ? '[ok] 已启用' : '[x] 已停用'}`);
        console.log(`  账号状态     ${acct.EnforcementStatus ?? '(未知)'}`);
        console.log(`  24 小时配额  ${acct.SendQuota?.SentLast24Hours ?? '?'}`
          + ` / ${acct.SendQuota?.Max24HourSend ?? '?'}`
          + `（峰值 ${acct.SendQuota?.MaxSendRate ?? '?'} 封/秒）`);
        if (acct.ProductionAccessEnabled === false) {
          console.log('  [x] **账号仍处于沙箱**：只有已在 SES 验证过的收件地址能收到邮件，'
            + '发往其余地址一律 MessageRejected。需在 AWS 控制台申请生产访问权限。');
        } else {
          console.log('  [ok] 已获生产访问权限');
        }

        const ids = (await sesIdentities.list()).EmailIdentities ?? [];
        console.log('');
        if (ids.length === 0) {
          console.log('  [x] 该区域下一个域名身份都没有：所有业务邮件都会被拒绝。'
            + '⚠️ SES 的身份按区域独立，请先确认 AWS_REGION 是否指向了正确的区域。');
        }
        for (const d of ids) {
          const hit = fromDomains
            .filter(([, dom]) => d.IdentityName && dom.endsWith(d.IdentityName))
            .map(([k]) => k);
          const ok = d.VerificationStatus === 'SUCCESS' && d.SendingEnabled !== false;
          console.log(`  ${ok ? '[ok]' : '[x] '} ${d.IdentityName} (${d.VerificationStatus})`
            + (hit.length > 0 ? `  <- ${hit.join(' / ')} 用的就是它` : ''));
        }
        for (const [k, dom] of fromDomains) {
          if (!ids.some((d) => d.IdentityName && dom.endsWith(d.IdentityName))) {
            console.log(`\n[x] ${k} 的域名 ${dom} 不在这个 SES 账号的 ${awsRegion(env)} 区域里 —— `
              + '这正是「发件箱一直 failed，而供应商后台什么都看不到」的样子。');
          }
        }

        // 事件目标：没有它，退信与投诉永远不会回流（见 apps/api/src/email/snsWebhook.ts）
        const csName = env['SES_CONFIGURATION_SET'];
        if (csName) {
          const dest = await sesRequest<{ EventDestinations?: { Name?: string; Enabled?: boolean }[] }>(
            'GET', `/v2/email/configuration-sets/${csName}/event-destinations`);
          const list = dest.EventDestinations ?? [];
          console.log('');
          if (list.length === 0) {
            console.log(`  [x] 配置集 ${csName} 没有任何事件目标 —— `
              + '退信与投诉不会回流，抑制名单永远是空的。');
          } else {
            for (const d of list) {
              console.log(`  ${d.Enabled ? '[ok]' : '[x] '} 事件目标 ${d.Name}`);
            }
          }
        }
      } catch (e) {
        const detail = e instanceof SesError ? `${e.status} ${e.awsErrorType} ${e.detail}`
          : e instanceof Error ? e.message : String(e);
        console.log(`[x] 调用 SES 失败：${detail}`);
      }
    }
  }

  console.log('\n注意：Supabase Auth 的激活/重置邮件**不走 email_outbox**。'
    + '上面全绿也不代表激活信能收到 —— 那条路只能看 Supabase 项目的 Auth Logs 与 SMTP 设置。');
}

await main();
await adminSql.end();
