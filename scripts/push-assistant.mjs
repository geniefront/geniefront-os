#!/usr/bin/env node
/**
 * 把 `create_assistant.json` 推到 Telnyx 的某个 AI Assistant 上。
 *
 * ## 为什么要有它
 *
 * assistant 那边的工具定义和这个仓库里的接口**必须一字不差**，而
 * 「人工在控制台里逐个字段敲」是这条链路上最容易出错、也最不容易发现的
 * 一步：少一个参数，模型就永远不会传它；URL 少一个字母，那通电话在
 * 报价那步静默失败。所以这份配置以文件为准，用脚本推。
 *
 * 推之前**先把当前配置备份到本地**，出问题能一条命令还原。
 *
 * ## 用法
 *
 *   # 先看会改成什么样，不写
 *   node scripts/push-assistant.mjs assistant-b694… --dry-run
 *
 *   # 真推（默认指向 https://api.geniefront.com）
 *   node scripts/push-assistant.mjs assistant-b694… --token st_…
 *
 *   # 指向本地 ngrok（部署新代码之前想真打电话测就用这个）
 *   node scripts/push-assistant.mjs assistant-b694… --token st_… \
 *     --base https://xxx.ngrok-free.dev
 *
 *   # 还原成推之前的样子
 *   node scripts/push-assistant.mjs assistant-b694… --restore .assistant-backups/xxx.json
 *
 * `--token` 是那家店的 `shop_token`（`ops/bindAiLine.ts` 绑号码时给的
 * `st_…`，只出现一次）。不传就把 `shop_token` 参数留给你手工填 ——
 * 但**不填的话，等新代码上线那天那家店的电话会全部 401**。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'create_assistant.json');
const BACKUP_DIR = join(ROOT, '.assistant-backups');

const args = process.argv.slice(2);
const assistantId = args.find((a) => a.startsWith('assistant-'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const API_KEY = process.env.TELNYX_API_KEY;
const BASE = (flag('base') ?? 'https://api.geniefront.com').replace(/\/$/, '');
const SHOP_TOKEN = flag('token') ?? process.env.SHOP_TOKEN ?? '';

if (!assistantId || !API_KEY) {
  console.error('用法：node scripts/push-assistant.mjs assistant-… [--token st_…] [--base https://…] [--dry-run|--restore <file>]');
  console.error(API_KEY ? '' : '⚠️ 没有 TELNYX_API_KEY —— 先 `set -a && . ./.env && set +a`');
  process.exit(1);
}

const tg = async (method, path, body) => {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
};

/**
 * 文件里的配置 → 这次要推的载荷（换 URL、填 token）。
 *
 * ⚠️ `keep` 是 assistant 上原有的**非 webhook** 工具（`hangup` /
 * `skip_turn` 这类 Telnyx 内置的）。它们不在我们这份文件里，但推的时候
 * 不带上就等于把它们删了 —— 而 `hangup` 没了，AI 说完再见挂不掉电话。
 */
function payloadFrom(config, keep = []) {
  const tools = config.tools.map((t) => {
    if (t.type !== 'webhook') return t;
    const w = { ...t.webhook };
    w.url = w.url.replace(/^https?:\/\/[^/]+/, BASE);

    /*
     * ⭐ Telnyx 读的是 `body_parameters`，不是 `parameters`。
     *
     * 它的 API **会把 `parameters` 原样收下再还给你** —— 于是推完 GET 回来
     * 一看「参数都在」，而控制台和运行时看的是另一个字段：那些工具在
     * Telnyx 眼里一个入参都没有，模型连 `to` 都不会传，每个工具 404。
     * （踩过。判断依据是控制台自己建的模板 assistant：`parameters` 是空的，
     * 内容全在 `body_parameters` 里。）
     *
     * 两个都发：新字段是真正生效的那个，旧字段留着兼容老 assistant。
     */
    if (w.parameters) {
      w.body_parameters = w.parameters;
      w.path_parameters = { type: 'object', properties: {} };
      w.query_parameters = { type: 'object', properties: {} };
    }
    if (SHOP_TOKEN && w.parameters?.properties?.shop_token) {
      // ⚠️ 下面这一句改的是 w.parameters.properties —— 而 body_parameters
      // 指向同一个对象，所以两边一起生效。别把它挪到上面那段之前
      /*
       * ⚠️ Telnyx 的 webhook tool **不支持固定 header**（字段只有
       * name/description/url/method/parameters），所以这串东西只能由模型
       * 填进 body。把它写死在参数的 description 里是目前唯一能让它
       * 每次都传对的办法 —— 配上 instructions 里那句「原样带上、不要念出来」。
       */
      w.parameters.properties.shop_token = {
        ...w.parameters.properties.shop_token,
        description: `Always send exactly this constant value: ${SHOP_TOKEN}`
          + ' — it identifies the salon. Never change it, never say it out loud.',
      };
    }
    return { ...t, webhook: w };
  });

  return {
    name: config.name,
    instructions: config.instructions,
    greeting: config.greeting,
    tools: [...keep, ...tools],
  };
}

async function main() {
  const restore = flag('restore');
  if (restore) {
    const saved = JSON.parse(readFileSync(restore, 'utf8'));
    const res = await tg('POST', `/ai/assistants/${assistantId}`, {
      name: saved.name, instructions: saved.instructions,
      greeting: saved.greeting, tools: saved.tools,
    });
    console.log(res.status === 200 ? `✓ 已还原成 ${restore}` : `✗ ${res.status}`, res.status === 200 ? '' : JSON.stringify(res.json).slice(0, 400));
    return;
  }

  const before = await tg('GET', `/ai/assistants/${assistantId}`);
  if (before.status !== 200) {
    console.error(`✗ 读不到这个 assistant（${before.status}）`, JSON.stringify(before.json).slice(0, 300));
    process.exit(1);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `${assistantId}-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
  writeFileSync(backup, JSON.stringify(before.json, null, 2));

  /*
   * 内置工具（`skip_turn` / `hangup` 这类）不在我们这份文件里，
   * 但推的时候不带上就等于删了它们 —— `hangup` 没了，AI 说完再见挂不掉电话。
   *
   * ⚠️ **但 `hangup` 不能再发一遍**：Telnyx 每种内置工具只允许一个（10015），
   * 而它会自己把 `hangup` 补回来 —— 原样送过去就成了两个，整个推送 400。
   * 所以：`hangup` 交给它，其余原样带上。
   */
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  /*
   * ⚠️ 每种内置工具只允许一个（10015）。要去重的有两种：
   *   · `hangup` —— Telnyx 自己会补，我们发就是第二个
   *   · 配置文件里已经写了的（`skip_turn`）—— assistant 上那个就别再带一遍
   */
  const inConfig = new Set(config.tools.map((t) => t.type).filter((t) => t !== 'webhook'));
  const keep = (before.json.tools ?? [])
    .filter((t) => t.type !== 'webhook' && t.type !== 'hangup' && !inConfig.has(t.type))
    .map(({ tool_id: _id, ...rest }) => rest);
  const payload = payloadFrom(config, keep);
  const names = (t) => (t.tools ?? []).map((x) => x.webhook?.name ?? x.type).join(', ');

  console.log(`\n  assistant  ${assistantId}`);
  console.log(`  备份       ${backup}`);
  console.log(`  名字       ${before.json.name}  →  ${payload.name}`);
  console.log(`  工具       ${names(before.json)}`);
  console.log(`         →   ${names(payload)}`);
  console.log(`  接口地址   ${BASE}`);
  console.log(`  shop_token ${SHOP_TOKEN ? `已填（${SHOP_TOKEN.slice(0, 6)}…）` : '⚠️ 没填 —— 上线那天这家店会全部 401'}`);

  if (has('dry-run')) { console.log('\n  --dry-run：什么都没写\n'); return; }

  const res = await tg('POST', `/ai/assistants/${assistantId}`, payload);
  if (res.status !== 200) {
    console.error(`\n✗ 推失败（${res.status}）`, JSON.stringify(res.json).slice(0, 600));
    console.error(`  原样还原：node scripts/push-assistant.mjs ${assistantId} --restore ${backup}\n`);
    process.exit(1);
  }
  console.log(`\n✓ 推上去了。要退回：node scripts/push-assistant.mjs ${assistantId} --restore ${backup}\n`);
}

await main();
