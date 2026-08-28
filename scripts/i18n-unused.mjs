#!/usr/bin/env node
/**
 * 未引用词条盘点。
 *
 * ⚠️ **判定必须偏保守：宁可留下几条死词条，也不能删掉一条仍在用的。**
 * 词条被删除时没有任何编译期信号，故障要到用户真的触发那段界面时才暴露。
 *
 * 因此除了 `t('key')` 直接调用，还收集：
 *  - 显式引入了 `TranslationKey` 类型的文件中的全部字符串字面量
 *    （如 `lib/errorMessage.ts` 的错误码映射表、页面里的 key 数组）；
 *  - 以 key 作为属性传递的写法（`titleKey="community"`）。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'apps/web/src';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'i18n') walk(p);
    } else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
})(SRC);

const used = new Set();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) used.add(m[1]);
  for (const m of s.matchAll(/(?:titleKey|labelKey|textKey|descKey)\s*[=:]\s*\{?\s*['"]([A-Za-z0-9_.]+)['"]/g))
    used.add(m[1]);
  // 该文件显式操作文案 key 的类型，其中的字面量按 key 处理
  if (/\bTranslationKey\b/.test(s)) {
    for (const m of s.matchAll(/['"]([A-Za-z0-9_.]+)['"]/g)) used.add(m[1]);
  }
}

const dictDir = path.join(SRC, 'i18n');
const dictFiles = fs.readdirSync(dictDir).filter((f) => !['index.ts', 'types.ts'].includes(f));
const report = {};
let total = 0;
let unusedTotal = 0;
for (const df of dictFiles) {
  const s = fs.readFileSync(path.join(dictDir, df), 'utf8');
  const keys = [...s.matchAll(/^\s{2}['"]?([A-Za-z0-9_.]+)['"]?:\s*\{/gm)].map((m) => m[1]);
  const unused = keys.filter((k) => !used.has(k));
  total += keys.length;
  unusedTotal += unused.length;
  report[df] = unused;
  console.log(`${df}: ${keys.length} 条，未引用 ${unused.length} 条`);
}
console.log(`\n合计 ${total} 条，未引用 ${unusedTotal} 条`);
fs.writeFileSync('/tmp/unused.json', JSON.stringify(report, null, 1));
