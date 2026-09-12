/**
 * 权限对账：前端画出来的写入口 vs 服务端对同一条命令的判定。
 *
 * 服务端是单点判定 —— `apps/api/src/bus.ts` 在执行前按 `COMMAND_REGISTRY`
 * 中该命令声明的 `permission` 查库。因此**注册表就是唯一事实来源**，
 * 本脚本不去读 handler，只把前端的门禁与注册表对齐。
 *
 * 判定的是三类不一致：
 *   漏门禁 —— 前端发这条命令，但全站没有任何地方检查它要求的权限。
 *             后果：没权限的人看到一个亮着的按钮，点下去 403，
 *             而用户对 403 的解读是「系统坏了」，不是「我没权限」。
 *   错门禁 —— 守的权限与服务端要求的不是同一条。
 *   死权限 —— 权限清单里声明了，但**全仓没有任何一处判定**。这一类最坏：
 *             店主在设置页取消勾选，以为限住了某项能力，实际什么也没发生。
 *             `ticket.discount` 与 `appointment.overbook` 就是这样空转的
 *             （能力藏在别的命令的入参字段里），已由 AUD-02 的字段级权限补上。
 *   孤儿权限 —— 前端检查了某条权限，但没有任何命令要求它。
 *             要么是该权限只用于控制读的显隐（合理），要么是拼错了（危险，
 *             `can()` 对未知权限返回 false，会静默把功能藏起来）。
 *
 * ⚠️ 判定的粒度是**全站**，不是每个调用点：只要有任意一处检查过某条权限，
 *    要求该权限的命令就算「守住了」。这挡得住「整类能力完全没人守」，
 *    挡不住「A 页守了、B 页忘了」。后者要靠逐页走查，本脚本只负责把
 *    最粗的那一层漏洞挑干净。
 *
 * ⚠️ 本脚本**不是安全边界**。它检查的是界面是否诚实，不是服务端是否拦得住。
 *    服务端拦不拦得住由 `apps/api` 的测试保证。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_SRC = join(ROOT, 'apps/web/src');

/* ---------- 事实来源：注册表 ---------- */

const { COMMAND_REGISTRY } = await import(
  new URL('../packages/contracts/src/registry.ts', import.meta.url).href
);

const { PERMISSIONS } = await import(
  new URL('../packages/contracts/src/permissions.ts', import.meta.url).href
);

/** 命令名 → 所需权限（undefined 表示该命令未声明权限） */
const commandPermission = new Map();
for (const [name, def] of COMMAND_REGISTRY) commandPermission.set(name, def.permission);

/* 命令级 + 字段级（AUD-02）都算「注册表要求了这条权限」 */
const enforcedByRegistry = new Set();
for (const def of COMMAND_REGISTRY.values()) {
  if (def.permission) enforcedByRegistry.add(def.permission);
  for (const rule of def.fieldPermissions ?? []) enforcedByRegistry.add(rule.need);
}

/* ---------- 扫描前端 ---------- */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(WEB_SRC);

/*
 * 读权限不经命令总线 —— 它们在查询层判定（`ctx.permissions.has('…')`）。
 * 不扫这一侧的话，每一条只管读的权限都会被误报成死权限。
 *
 * 这里刻意扫「服务端源码里出现过这个权限字面量」而不是只认
 * `permissions.has('…')`：判定的写法不止一种（`targetOf(ctx, id,
 * 'timeclock.punch_others')` 把权限名当参数传进去），只认一种写法会把
 * 真的有判定的权限误报成死权限，而误报会让整份报告失去可信度。
 * 代价是可能漏报 —— 权限名只出现在注释里也算数。这个方向是对的：
 * 死权限的结论应当由人复核，脚本负责把候选缩到个位数。
 */
const API_SRC = join(ROOT, 'apps/api/src');
const enforcedByQueries = new Set();
for (const file of walk(API_SRC)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/['"`]([a-z_]+\.[a-z_]+)['"`]/g)) enforcedByQueries.add(m[1]);
}

/** 前端实际发出的命令：命令名 → 出现的文件集合 */
const dispatched = new Map();
/** 前端检查过的权限：权限名 → 出现的文件集合 */
const gated = new Map();

const DISPATCH = /runCommand\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
/* `useCan('x')` / `useCanAny('x','y')` / `useCanWrite('x')` / `blockReason('x')`
 * / `can('x')` / `<GuardedButton permission="x">` 六种写法 */
const GATE = /(?:useCanAny|useCanWrite|useCan|blockReason|\bcan)\s*\(\s*((?:['"`][^'"`]+['"`]\s*,?\s*)+)\)|permission=(\{[^}]*\}|['"`][^'"`]+['"`])/g;

function add(map, key, file) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(relative(ROOT, file));
}

/* 注释里的用法示例不是门禁。asyncAction.ts 的文档注释里有一行
   `<GuardedButton permission="…">`，不剔掉会被当成守着一条叫「…」的权限。 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

for (const file of files) {
  const src = stripComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(DISPATCH)) add(dispatched, m[1], file);
  for (const m of src.matchAll(GATE)) {
    /* `permission={cond ? 'a' : 'b'}` 也要把两支都算进来 */
    for (const lit of (m[1] ?? m[2]).matchAll(/['"`]([^'"`]+)['"`]/g)) add(gated, lit[1], file);
  }
}

/* ---------- 对账 ---------- */

/*
 * 已知漏门禁，留待口径决定（见报告 §A-4）。
 *
 * 这三条要求的都是 `appointment.read` —— 每个角色预设都有，所以「守不守」
 * 在今天没有实际差别。但要求本身是可疑的：把通知标为已读、改自己的界面语言，
 * 与「能不能看预约」没有任何关系。看起来是当初随手填了一条人人都有的权限。
 * 该定的是这些命令到底该要求什么，而不是在界面上补一道守着 appointment.read 的门。
 */
const GATE_PENDING_DECISION = {
  'notification.markRead': '要求 appointment.read 与语义无关，应重新定权限',
  'notification.markAllRead': '同上',
  'staff.setLocale': '改自己的界面语言不该与看预约挂钩',
};

const unknownCommands = [];   // 前端发的命令注册表里没有 → 必然 404
const missingGate = [];       // 需要权限，但全站没检查过
const undeclared = [];        // 注册表里没声明 permission 的命令，前端在用
const orphanGates = new Map();// 检查了但没有命令要求的权限

const requiredPermissions = new Set();

for (const [name, where] of dispatched) {
  if (!commandPermission.has(name)) { unknownCommands.push({ name, where }); continue; }
  /* 字段级权限也是「这条命令可能要求的权限」，否则守它的门禁会被误判为孤儿 */
  for (const rule of COMMAND_REGISTRY.get(name).fieldPermissions ?? []) requiredPermissions.add(rule.need);
  const perm = commandPermission.get(name);
  if (!perm) { undeclared.push({ name, where }); continue; }
  requiredPermissions.add(perm);
  if (!gated.has(perm) && !(name in GATE_PENDING_DECISION)) missingGate.push({ name, perm, where });
}

for (const [perm, where] of gated) {
  if (!requiredPermissions.has(perm)) orphanGates.set(perm, where);
}

/* ---------- 报告 ---------- */

const list = (s) => [...s].sort().join(', ');
let failed = false;

console.log(`命令注册表：${COMMAND_REGISTRY.size} 条`);
console.log(`前端发出：${dispatched.size} 条命令，检查过 ${gated.size} 种权限\n`);

if (unknownCommands.length) {
  failed = true;
  console.log(`✗ 前端发出注册表里不存在的命令（${unknownCommands.length}）—— 必然 404：`);
  for (const { name, where } of unknownCommands) console.log(`   ${name}\n     ${list(where)}`);
  console.log();
}

if (missingGate.length) {
  failed = true;
  console.log(`✗ 漏门禁（${missingGate.length}）—— 发这条命令但全站从未检查它要求的权限：`);
  for (const { name, perm, where } of missingGate.sort((a, b) => a.perm.localeCompare(b.perm)))
    console.log(`   ${name}  需要 ${perm}\n     ${list(where)}`);
  console.log();
}

if (undeclared.length) {
  console.log(`⚠ 注册表未声明 permission 的命令，前端在用（${undeclared.length}）—— 逐条复核是否真的公开：`);
  for (const { name, where } of undeclared) console.log(`   ${name}\n     ${list(where)}`);
  console.log();
}

/*
 * 已知死权限，等店主拍板（见 docs/reviews/2026-09-11-permission-matrix.md §A-3）。
 *
 * 留这份清单而不是让脚本长期红着：一个永远失败的检查会被忽略，
 * 于是**新**出现的死权限也跟着被忽略 —— 那正是这个检查要防的事。
 * 每一条都写明为什么还没定，定了就从这里删掉。
 */
const DEAD_PENDING_DECISION = {
  'marketing.manage': '营销命令实际要求 settings.manage。两套分类没对齐，待定口径',
  'package.manage': '套餐命令实际要求 catalog.manage / ticket.write。同上',
  'ai.execute_without_confirm': '无代码路径读取，且与「每条 AI 命令都要确认」的断言相矛盾。建议删除',
};

const dead = PERMISSIONS.filter(
  (p) => !enforcedByRegistry.has(p) && !enforcedByQueries.has(p) && !(p in DEAD_PENDING_DECISION),
);
if (dead.length) {
  failed = true;
  console.log(`✗ 死权限（${dead.length}）—— 声明了，但全仓没有任何一处判定：`);
  console.log('  店主在设置页取消勾选时以为限住了，实际什么也没发生。');
  console.log('  要么补上判定（命令级或 fieldPermissions），要么从清单里删掉。');
  for (const p of dead) console.log(`   ${p}`);
  console.log();
}

if (orphanGates.size) {
  console.log(`⚠ 孤儿门禁（${orphanGates.size}）—— 检查了但没有命令要求它。`);
  console.log(`  只读显隐属正常；拼错的话 can() 静默返回 false，功能会无声消失：`);
  for (const [perm, where] of [...orphanGates].sort()) console.log(`   ${perm}\n     ${list(where)}`);
  console.log();
}

const gatePending = Object.entries(GATE_PENDING_DECISION).filter(
  ([name]) => dispatched.has(name) && !gated.has(commandPermission.get(name)),
);
if (gatePending.length) {
  console.log(`ℹ 已知漏门禁，等口径决定（${gatePending.length}）：`);
  for (const [name, why] of gatePending) console.log(`   ${name} —— ${why}`);
  console.log();
}

const pending = Object.entries(DEAD_PENDING_DECISION).filter(
  ([p]) => !enforcedByRegistry.has(p) && !enforcedByQueries.has(p),
);
if (pending.length) {
  console.log(`ℹ 已知死权限，等店主拍板（${pending.length}）：`);
  for (const [p, why] of pending) console.log(`   ${p} —— ${why}`);
  console.log();
}

console.log(failed ? '✗ 权限对账发现不一致' : '✓ 权限对账通过');
process.exit(failed ? 1 : 0);
