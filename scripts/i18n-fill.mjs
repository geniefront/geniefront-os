#!/usr/bin/env node
/**
 * 抽取方案的批量填充与应用。
 *
 * `i18n-extract.mjs plan` 产出的 JSON 结构完整但冗长，逐条编辑成本过高。
 * 本工具接受一份按方案顺序排列的紧凑填充表，合并后调用抽取工具完成改写：
 *
 *   node scripts/i18n-fill.mjs <plan.json> <fills.json>
 *
 * fills.json 为数组，每项对应方案中的同序条目：
 *   ["key 后缀", "en", "ko", "es", "vi"]   —— 正常抽取
 *   null                                    —— 跳过（该条不是界面文案）
 *
 * key 后缀会自动补上域前缀。zh-Hans 取自源码原文，不需要重复填写；
 * 若需改写中文原文（例如修复损坏串），填第 6 项。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [planPath, fillsPath] = process.argv.slice(2);
if (!planPath || !fillsPath) {
  console.error('用法：i18n-fill.mjs <plan.json> <fills.json>');
  process.exit(2);
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const fills = JSON.parse(fs.readFileSync(fillsPath, 'utf8'));

if (fills.length !== plan.items.length) {
  console.error(`填充表长度 ${fills.length} 与方案条目数 ${plan.items.length} 不一致`);
  process.exit(1);
}

let filled = 0;
let skipped = 0;
plan.items.forEach((item, i) => {
  const f = fills[i];
  if (!f) {
    item.skip = true;
    skipped += 1;
    return;
  }
  const [suffix, en, ko, es, vi, zhOverride] = f;
  item.key = `${plan.domain}.${suffix}`;
  item.translations = {
    'zh-Hans': zhOverride ?? item.text,
    en,
    ko,
    es,
    vi,
  };
  filled += 1;
});

const merged = `${planPath}.merged.json`;
fs.writeFileSync(merged, JSON.stringify(plan, null, 2));
execFileSync('node', ['scripts/i18n-extract.mjs', 'apply', merged], { stdio: 'inherit' });
console.log(`填充 ${filled} 条，跳过 ${skipped} 条`);
