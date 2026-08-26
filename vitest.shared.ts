/**
 * 各包共用的 vitest 配置。
 *
 * 关于 Date 参数：vitest 把依赖放在 Node 原生 realm、测试代码放在 vite-node
 * 的 VM realm，两边的 Date 不是同一个构造函数，postgres.js 的
 * `x instanceof Date` 因此失效。deps.inline 试过，压不住。
 *
 * 结论是不靠配置解决：时间参数一律走 @gf/db 的 ts() 转 ISO 字符串 +
 * SQL 里显式 ::timestamptz。见 packages/db/src/client.ts。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * 直接读仓库根的 .env —— 免得每次跑测试都要手动 source。
 *
 * ## ⛔ 但 `NODE_ENV` 一个字都不能从 .env 里带进来
 *
 * 根 `.env` 里写着 `NODE_ENV=development`（本地跑 `pnpm dev:api` 要它）。
 * 原样注进测试进程的话，`NODE_ENV === 'test'` 那几道**测试专用的替身
 * 全部失效**，而且失效得悄无声息：
 *
 *   · `sms/send.ts` —— 真往 `+1617555xxxx` 那批随机号**发短信**。
 *     真花钱，而且给运营商刷一批投递失败，10DLC 的号码信誉扛不住这个
 *   · `public/rateLimit.ts` —— 计数打进**真实的、共享的** Upstash。
 *     跑一次测试就在生产计数器上留下痕迹，第二次跑撞上第一次的上限，
 *     表现是「代码没改，测试自己红了」
 *   · `public/turnstile.ts` —— 测试替身直接抛错，装不上
 *
 * 这三处的注释都写着「测试里不会真的发生」，而那句话的前提就是这里。
 * `public.test.ts` 里那句手写的 `process.env['NODE_ENV'] = 'test'`
 * 是踩过之后在**一个文件里**打的补丁 —— 根因在这。
 *
 * vitest 自己会把 NODE_ENV 设成 `test`，我们只要别覆盖它。
 */
const NEVER_FROM_DOTENV = new Set(['NODE_ENV']);

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m?.[1] && m[2] && !NEVER_FROM_DOTENV.has(m[1])) {
        out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* CI 用真实环境变量 */ }
  // 兜底：就算哪天 vitest 改了默认值，替身也不能失效
  out['NODE_ENV'] = 'test';
  return out;
}

export const sharedTestConfig = {
  env: loadEnv(),
  hookTimeout: 30_000,
  testTimeout: 30_000,
  // 测试会真的写库，并行跑会互相干扰容量判断
  fileParallelism: false,
};
