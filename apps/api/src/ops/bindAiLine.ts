/**
 * 把一个真号绑到一家店的 AI 接听线（运维用，跑一次）。
 *
 * ## 为什么要有这个脚本
 *
 * 绑 AI 线这件事**不在前台界面里**：店家自己配的是「店里对外公布的号」和
 * 「人工客服号」，而我们买的这条落地号是开户时由我们绑的（docs/09 §2）。
 *
 * 而且它会返回一样**只出现一次**的东西 —— 这条线的工具 token
 * （`st_…`，sql/0036）。它要填进 Telnyx 那家店 assistant 的每个 tool 参数里，
 * 错过了就只能轮换重来。
 *
 * ## 用法
 *
 *   pnpm exec tsx apps/api/src/ops/bindAiLine.ts +17579999968 pk_bbbb…
 *   pnpm exec tsx apps/api/src/ops/bindAiLine.ts +17579999968 pk_bbbb… --rotate
 *
 * 第二个参数是门店的**公开 key**（`pk_…`，前台「官网对接」那一页上有，
 * 种子店的由 `pnpm db:seed` 打印）。用它认门店是因为这条路
 * **不需要绕过 RLS**：`withPublicKey` 只放行 key 恰好相等的那一行
 * （和公开预约页同一条路，宪法第 5 条）。
 *
 * `--rotate` 换一串新 token（⚠️ 换完必须同步到 Telnyx，
 * 否则那家店的电话当场全 401）。
 *
 * ⚠️ 一家店只有**一条** active 的 ai_voice 线：绑新号会顶掉旧的那条。
 */

import { withTenant, withPublicKey, closeDb } from '@gf/db';
import { pickText } from '@gf/contracts';
import { buildContext } from '../actor';
import { dispatch } from '../bus';
import '../handlers/phone';

const [e164, publicKey, ...flags] = process.argv.slice(2);
const rotate = flags.includes('--rotate');

if (!e164 || !publicKey) {
  console.error('用法：tsx apps/api/src/ops/bindAiLine.ts <+1…> <pk_…> [--rotate]');
  process.exit(1);
}

async function main(): Promise<void> {
  const shop = await withPublicKey(publicKey!);
  if (!shop) throw new Error(`找不到门店（这个 public key 不对）：${publicKey}`);
  const loc = { id: shop.locationId, org_id: shop.orgId, name: pickText(shop.name, 'en') };

  // 一个有 settings.manage 的人。绑号码是一条具名命令，
  // 走的是和界面上完全一样的那条路（宪法第 1 条）
  const [m] = await withTenant(
    { orgId: loc.org_id, locationId: loc.id, membershipId: null },
    (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where m.location_id = ${loc.id} and m.status = 'active'
        and m.user_id is not null and r.key in ('owner','manager')
      limit 1`);
  if (!m) throw new Error(`${loc.name} 没有能改设置的人（owner/manager）`);

  const ctx = await buildContext({ userId: m.user_id, membershipId: m.id });
  const out = await dispatch<{ e164: string; toolToken: string | null }>(
    'location.savePhoneLine',
    { e164, purpose: 'ai_voice', rotateToolToken: rotate },
    ctx,
    // `location.savePhoneLine` 是平台自有命令（S1 §5）：绑号 / 铸 token 不对
    // 店主与泛化 HTTP 入口开放。这条 CLI 经可信 server-origin 显式声明来源。
    { idempotencyKey: crypto.randomUUID(), systemOrigin: 'ops_bind_ai_line' },
  );

  console.log(`\n✓ ${e164}  →  ${loc.name}`);
  console.log(`  locationId: ${loc.id}`);
  if (out.result.toolToken) {
    console.log('\n  ⭐ 工具 token（**只出现这一次**，填进 Telnyx assistant 的每个 tool）：');
    console.log(`     ${out.result.toolToken}\n`);
  } else {
    console.log('\n  这条线本来就有 token，没换。要换：加 --rotate\n');
  }
}

main()
  .catch((e) => { console.error('\n失败：', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => closeDb());
