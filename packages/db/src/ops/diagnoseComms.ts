/**
 * 通信链路体检 —— 回答「这封信到底卡在哪一步」。
 *
 * 测试收件箱（`COMMUNICATION_DELIVERY_MODE=capture` + 运营台那一页）解决的是
 * 「怎么看见发出去的内容」；这个脚本解决的是另一个问题：**为什么没发出去**。
 * 配置、发件箱、供应商域名三段各自会失败，而三段的失败在门店那头是同一个
 * 现象（客人没收到信），必须分开看：
 *
 *   · 没配 key      → flushEmails() 直接 return，行停在 pending，**没有 last_error**
 *   · 域名没验证    → Resend 返回 4xx，行被标 failed，last_error 里有原文
 *   · 根本没入队    → 表是空的，问题在业务侧，跟发信这条路无关
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

const env = process.env;
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
  console.log(`RESEND_API_KEY                ${mask(env['RESEND_API_KEY'])}`);
  console.log(`FROM_EMAIL                    ${env['FROM_EMAIL'] ?? '(未配置)'}`);
  console.log(`TELNYX_API_KEY                ${mask(env['TELNYX_API_KEY'])}`);
  console.log(`TELNYX_SMS_FROM               ${env['TELNYX_SMS_FROM'] ?? '(未配置)'}`);
  console.log(`STAGING_OTP_CODE              ${env['STAGING_OTP_CODE'] ? '已配置' : '(未配置)'}`);

  if (!env['RESEND_API_KEY'] || !env['FROM_EMAIL']) {
    console.log('\n[x] emailConfigured() 为 false —— flushEmails() 会直接 return。'
      + '发件箱里的信永远停在 pending，且不会留下任何 last_error。');
  }

  // FROM_EMAIL 的域名必须是 Resend 里验证过的域，否则每一封都是 4xx
  const fromDomain = /@([^>\s]+)/.exec(env['FROM_EMAIL'] ?? '')?.[1]?.toLowerCase() ?? null;
  console.log(`FROM_EMAIL 域名               ${fromDomain ?? '(解析不出)'}`);

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

  // ── 3. Resend 域名验证 ──────────────────────────────────────────────────
  section('Resend 域名');
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
          const hit = d.name && fromDomain?.endsWith(d.name) ? '  <- FROM_EMAIL 用的就是它' : '';
          console.log(`  ${d.status === 'verified' ? '[ok]' : '[x] '} ${d.name} (${d.status})${hit}`);
        }
        if (fromDomain && !domains.some((d) => d.name && fromDomain.endsWith(d.name))) {
          console.log(`\n[x] FROM_EMAIL 的域名 ${fromDomain} 不在这个 Resend 账号里 —— `
            + '这正是「发件箱一直 failed，而供应商后台什么都看不到」的样子。');
        }
      }
    } catch (e) {
      console.log(`[x] 连不上 Resend：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('\n注意：Supabase Auth 的激活/重置邮件**不走 email_outbox**。'
    + '上面全绿也不代表激活信能收到 —— 那条路只能看 Supabase 项目的 Auth Logs 与 SMTP 设置。');
}

await main();
await adminSql.end();
