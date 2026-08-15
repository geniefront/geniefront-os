import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 直接读仓库根的 .env —— 免得每次跑测试都要手动 source */
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(resolve(__dirname, '../../.env'), 'utf8').split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m?.[1] && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* CI 用真实环境变量 */ }
  return out;
}

export default defineConfig({
  test: {
    env: loadEnv(),
    hookTimeout: 30000,
    testTimeout: 30000,
    fileParallelism: false,
  },
});
