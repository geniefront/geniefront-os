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

/** 直接读仓库根的 .env —— 免得每次跑测试都要手动 source */
export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* CI 用真实环境变量 */ }
  return out;
}

export const sharedTestConfig = {
  env: loadEnv(),
  hookTimeout: 30_000,
  testTimeout: 30_000,
  // 测试会真的写库，并行跑会互相干扰容量判断
  fileParallelism: false,
};
