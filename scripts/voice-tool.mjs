#!/usr/bin/env node
/**
 * 在本机打一通「假电话」—— 不经过 Telnyx，直接调那六个电话工具。
 *
 * ## 为什么需要它
 *
 * 那六个接口和仓库里所有别的接口都不一样：**没有登录用户**，
 * 身份证明只有一个 Ed25519 签名。所以你没法用 curl 随手试一下 ——
 * 少了签名头一律 401，而 401 不告诉你是哪一步错了（那是故意的，verify.ts）。
 *
 * 这个脚本自带一对**开发用**的密钥：拿它的公钥去喂 API，
 * 然后它就能像 Telnyx 一样签名并 POST。
 *
 * ## 用法
 *
 *   node scripts/voice-tool.mjs pubkey            # 打印公钥（喂给 API）
 *   node scripts/voice-tool.mjs flow              # 跑完整一通电话
 *   node scripts/voice-tool.mjs find_slots '{"party_size":2}'
 *   TO=+13235550123 node scripts/voice-tool.mjs list_staff '{"gender":"male"}'
 *
 * 每个请求都会带上那家店的 `shop_token`（sql/0036 的第二道门）。种子店的
 * token 在脚本里写死了；换真号测试时 `SHOP_TOKEN=st_… ` 覆盖。
 *   node scripts/voice-tool.mjs list_services '{"category":"add"}'
 *
 * 起 API 的时候把公钥带上（**别改 .env** —— 那里放的是 Telnyx 的真公钥，
 * 换掉之后真 webhook 就验不过了）：
 *
 *   TELNYX_PUBLIC_KEY=$(node scripts/voice-tool.mjs pubkey) pnpm --filter @gf/api dev
 *
 * ⚠️ 这把私钥是**开发专用**的，落在 .dev-telnyx-key.json（已 gitignore）。
 * 它能签出合法请求，所以生产环境的 TELNYX_PUBLIC_KEY 永远不能是它。
 */

import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_FILE = join(ROOT, '.dev-telnyx-key.json');

const API = process.env.VOICE_API ?? 'http://localhost:3000';
/** 种子里美甲店的 AI 号（packages/db/src/seed.ts）。灌了别的号就用 TO= 覆盖 */
const TO = process.env.TO ?? '+12125550123';
const FROM = process.env.FROM ?? '+19175550142';   // 种子客户 Lisa Chen

/**
 * 工具 token（sql/0036）—— 验签之后的第二道门。
 *
 * 种子店的这串东西是从门店 uuid 推出来的（重灌不变），所以脚本这边
 * 按号码查一张表就行。换成真号测试时用 `SHOP_TOKEN=st_… ` 覆盖。
 * 线上没配 token 的号照旧只验签名，多带一个字段也无妨。
 */
const SEED_TOKENS = {
  '+12125550123': 'st_dev_aaaaaaaa111141118111aaaaaaaaaaaa',   // 莲花美甲
  '+13235550123': 'st_dev_bbbbbbbb222242228222bbbbbbbbbbbb',   // 金足足疗
  // ⚠️ 真号（+17579999968，绑在金足足疗上、Telnyx 那个 assistant 指着它）的
  // token 是随机的，**只在绑号码那次出现过一次** —— 不在这里，也不在库里。
  // 拿真号在本地测：SHOP_TOKEN=st_… TO=+17579999968 node scripts/voice-tool.mjs …
};
const SHOP_TOKEN = process.env.SHOP_TOKEN ?? SEED_TOKENS[TO] ?? '';

// ── 密钥：第一次跑时生成，之后复用（公钥变了每次都要重启 API）────────────
function keys() {
  if (!existsSync(KEY_FILE)) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(KEY_FILE, JSON.stringify({
      // 裸 32 字节公钥（去掉 SPKI 那 12 字节头）—— Telnyx 控制台给的就是这个形状
      publicKeyB64: publicKey.export({ type: 'spki', format: 'der' })
        .subarray(12).toString('base64'),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }, null, 2), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(KEY_FILE, 'utf8'));
}

async function callTool(name, body) {
  const { privateKeyPem } = keys();
  const raw = JSON.stringify({
    to: TO, from: FROM, ...(SHOP_TOKEN ? { shop_token: SHOP_TOKEN } : {}), ...body,
  });
  const ts = Math.floor(Date.now() / 1000);
  // 签的是 `${timestamp}|${rawBody}`，而且必须是**发出去的那串字节**
  const sig = edSign(null, Buffer.from(`${ts}|${raw}`, 'utf8'),
                     createPrivateKey(privateKeyPem)).toString('base64');

  const res = await fetch(`${API}/v1/telnyx/tools/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'telnyx-signature-ed25519': sig,
      'telnyx-timestamp': String(ts),
    },
    body: raw,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (res.status === 401) {
    // 401 有两种成因，分开说 —— 不然要在两个方向上瞎试
    console.error(json?.details?.reason === 'shop_token_invalid'
      ? `\n401 shop_token 不匹配。这个号的 token 跟库里对不上（重灌过种子？）。\n`
        + `  查一下：pnpm db:seed 的输出里有每个号的 shop_token，或 SHOP_TOKEN=st_… 覆盖\n`
      : '\n401 —— API 那边的 TELNYX_PUBLIC_KEY 不是这把开发公钥。这样起：\n'
        + '  TELNYX_PUBLIC_KEY=$(node scripts/voice-tool.mjs pubkey) pnpm exec tsx apps/api/src/main.ts\n');
  }
  return { status: res.status, json };
}

const show = (label, out) => {
  // 每个工具的返回都带 shop —— 一眼看得出这通电话落到了哪家店
  const shop = out.json?.shop ? `  ${out.json.shop.name} (${out.json.shop.timezone})` : '';
  console.log(`\n── ${label}  [${out.status}]${shop}`);
  console.log(JSON.stringify(out.json, null, 2));
};

/** 一通电话从头走到尾，顺序和 docs/14 §7 那张时序图一致 */
async function flow() {
  const callId = `dev-${Date.now()}`;

  // 接通那一下：客人是谁 / 价目表 / 加项 / 今天谁在班 / 一周营业时间，一次拿全
  show('start_call', await callTool('start_call', {}));
  // 下面这两个已经被 start_call 包含了，留着是给「菜单特别大」和「问别的日子」用的
  show('list_staff（只要女技师）', await callTool('list_staff', { gender: 'female' }));

  // 明天下午三点，深层按摩 + 热石（多项目连做 → 时长是各项之和）
  const around = new Date(Date.now() + 24 * 3600_000);
  around.setUTCHours(19, 0, 0, 0);
  const slots = await callTool('find_slots', {
    around: around.toISOString(),
    services: ['Gel Manicure', 'Gel Removal'],
    gender_preference: 'female',
  });
  show('find_slots', slots);

  const slot = slots.json?.slots?.[0];
  if (!slot) {
    console.log('\n没有空档 —— 上面的 guidance 就是 AI 该说的话。'
      + '（种子数据里今天起 7 天都有班，返回空多半是号码没绑对门店。）');
    return;
  }

  show('book_appointment', await callTool('book_appointment', {
    call_session_id: callId,
    caller_name: 'Lisa Chen',
    services: ['Gel Manicure', 'Gel Removal'],
    slot_starts_at: slot.startsAt,
    duration_min: slots.json.durationMin,
  }));

  // 幂等：同一个 call_session_id 再来一次，不该多出一条预约、不该多发一条短信
  show('book_appointment（重放同一个 call id）', await callTool('book_appointment', {
    call_session_id: callId,
    caller_name: 'Lisa Chen',
    services: ['Gel Manicure', 'Gel Removal'],
    slot_starts_at: slot.startsAt,
    duration_min: slots.json.durationMin,
  }));
}

const [cmd, jsonArg] = process.argv.slice(2);

if (!cmd || cmd === 'help') {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''));
} else if (cmd === 'pubkey') {
  process.stdout.write(keys().publicKeyB64);
} else if (cmd === 'flow') {
  await flow();
} else {
  show(cmd, await callTool(cmd, jsonArg ? JSON.parse(jsonArg) : {}));
}
