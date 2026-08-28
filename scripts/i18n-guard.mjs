#!/usr/bin/env node
/**
 * 界面文案硬编码关卡。
 *
 * ⚠️ **这道关卡的存在理由是防止回归。** 本轮审核前，`apps/web` 的字典中有
 * 1017 个词条而代码里仍嵌着约 3600 行中文字面量 —— 字典与页面从未对齐过，
 * 且没有任何机制能在改动时发现这一点。人工约定在此类规模下不成立。
 *
 * 判定基于 TypeScript AST（复用抽取工具的识别逻辑），因此中文注释、
 * 业务标识与测试夹具不会被误判。
 *
 * 存量文件的豁免清单已于全量改造完成后移除，本规则现无条件生效：
 * 新增页面从第一天起就必须走字典，不再提供任何绕过方式。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { collect } from './i18n-extract.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCAN_DIRS = ['apps/web/src/pages', 'apps/web/src/components'];
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const violations = [];
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = path.relative(ROOT, file);
    const { items } = collect(file, 'guard');
    if (items.length) violations.push({ rel, items });
  }
}

if (violations.length) {
  const total = violations.reduce((n, v) => n + v.items.length, 0);
  console.log(`界面文案未走多语言字典：${violations.length} 个文件、${total} 处`);
  for (const v of violations.slice(0, 20)) {
    console.log(`  ${v.rel} (${v.items.length} 处)`);
    for (const i of v.items.slice(0, 3)) console.log(`    :${i.line}  ${i.text.slice(0, 40)}`);
  }
  process.exit(1);
}
process.exit(0);
