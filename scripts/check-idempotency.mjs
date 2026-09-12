/**
 * 幂等键的稳定性（AUD-05）。
 *
 * 门店的网不稳，超时是常态 —— 而**超时不代表没写进去**：请求可能已经落库，
 * 只是回程丢了。前台看到报错会再按一次，这时唯一能防住重复写入的就是幂等键。
 *
 * 因此键必须**随「这一次意图」走，而不是随「这一次调用」走**。
 * `crypto.randomUUID()` 写在调用处（或 `mutationFn` 里）时，每一次重按都是
 * 一个新键，服务端看到的是两条互不相干的命令：
 *
 *   dayclose.payTips          → 现金小费发两遍
 *   rotation.assign           → 同一位技师被派两次
 *   staff.recordDirectCashTip → 小费记两笔
 *   ticket.moveItemResource   → 房间占用写两条
 *
 * 而 `idempotency: 'required'` 这个声明的全部意义就是防住这件事。
 *
 * 正确写法：`lib/idempotency.ts` 的 `useAttemptKey`（失败沿用、成功换新），
 * 或按业务身份拼一个稳定串（`queue-pay-${ticketId}-${stage}`）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { COMMAND_REGISTRY } = await import(new URL('../packages/contracts/src/registry.ts', import.meta.url).href);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, 'apps/web/src'));

/* ── ① 数据层：runCommand 的第四个实参 ─────────────────────────────────── */

const unstable = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const re = /runCommand\s*(?:<[\s\S]*?>)?\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++; else if (c === ')') depth--;
      i++;
    }
    const args = src.slice(m.index + m[0].length, i);
    /* 命令名只能取自左括号之后 —— 泛型里也会有字符串字面量
       （`'no_tip' | 'received_direct'`），从整段里取会取到它 */
    const name = args.match(/^\s*['"`]([a-z][a-zA-Z0-9_.]*)['"`]/)?.[1];
    if (!name) continue;
    if (COMMAND_REGISTRY.get(name)?.idempotency !== 'required') continue;
    if (/crypto\.randomUUID\(\)/.test(args)) {
      unstable.push(`${relative(ROOT, file)}  ${name}  —— 调用处现生成 randomUUID`);
    }
  }
}

/* ── ② 页面层：直接传给 mutation 调用的 idempotencyKey ─────────────────── */

/*
 * ⚠️ 只看**传给 mutation 调用**的那些，不看所有 `idempotencyKey: randomUUID()`。
 *
 * 「铸一次、存进 state、提交时复用」是**正确**写法 —— 排队页把加项先攒在
 * `addedAddOns` 里、每条带自己的键，提交时原样带上，正是这个模式。
 * 不区分的话，这条检查会把对的写法一起报红，然后它就会被整个忽略。
 */
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const re = /\.\s*mutate(?:Async)?\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++; else if (c === ')') depth--;
      i++;
    }
    const args = src.slice(m.index, i);
    if (!/idempotencyKey:\s*crypto\.randomUUID\(\)/.test(args)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    unstable.push(`${relative(ROOT, file)}:${line}  —— 提交时才现生成 idempotencyKey`);
  }
}

if (unstable.length) {
  console.log(`幂等键不稳定：${unstable.length} 处`);
  for (const u of [...new Set(unstable)].sort()) console.log(`  ${u}`);
  process.exit(1);
}
console.log('✓ 幂等键稳定性检查通过');
