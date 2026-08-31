/**
 * AUD-03 可执行检查：**每一次模型调用之前都必须有准入闸门**。
 *
 * 原来的顺序是「查权限 → 调 Anthropic → 记账」，于是三件事同时成立：
 * 欠费的店照样烧真钱、余额可以无限扣成负数、AI 路由一条限频都没有。
 *
 * 这个脚本盯的是「以后又加了一个模型调用但忘了加闸门」。
 * 判据是**位置**而不是数量：闸门必须出现在调用点上方 LOOKBACK 行以内，
 * 中间不允许再夹一次别的模型调用。按数量比对（调用数 vs 闸门数）
 * 会被「同一个路由加了两道闸门、另一个路由一道都没有」骗过去。
 */

import { readFileSync } from 'node:fs';

const FILES = ['apps/api/src/routes/ai.ts', 'apps/api/src/copilot/routes.ts'];

/** 会真的产生 Anthropic 费用的调用。加新的模型封装时要同步加到这里。 */
const MODEL_CALLS = [
  'extractPriceList',
  'generateStorefrontDrafts',
  'generateHealthFormQuestions',
  'extractWebsite',
  'translateNames',
  'planRegions',
  'askCopilot',
];

const LOOKBACK = 20;
const problems = [];

for (const file of FILES) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    problems.push(`${file}: 读不到（文件被挪了？检查这个脚本的 FILES 列表）`);
    continue;
  }

  lines.forEach((line, i) => {
    // import 行不是调用点
    if (/^\s*import\b/.test(line)) return;
    const hit = MODEL_CALLS.find((fn) => line.includes(`await ${fn}(`));
    if (!hit) return;

    const window = lines.slice(Math.max(0, i - LOOKBACK), i);
    if (!window.some((l) => l.includes('assertAiAdmission('))) {
      problems.push(`${file}:${i + 1}: ${hit}() 之前 ${LOOKBACK} 行内没有 assertAiAdmission`);
    }
  });
}

if (problems.length > 0) {
  console.log(problems.join('\n'));
  process.exit(1);
}
