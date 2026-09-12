/**
 * 钱路径上的「宽容解析器当验证器用」（AUD-04）。
 *
 * 这一类写法长得像校验，实际是**静默纠正**：
 *
 *   dollarsToCents('abc')          → 0        目录项目以 $0.00 上架
 *   parseFloat(taxRate) || 0       → 0        营业税从此变成 0%
 *   parseInt(validDays, 10) || 365 → 365      客人买到的次卡不是他看到的那张
 *   Math.round(parseFloat(x) * 100)           浮点乘法，1.005 少一分
 *
 * 共同点是**用户永远不会知道**：界面提示保存成功，数字看起来也合理，
 * 要到对账、报税、或者客人来问的时候才暴露。
 *
 * 判定的是「金额/比率/数量字段上出现了这些写法」，而不是「文件里出现过
 * parseInt」—— 纯 UI 的步进器把 `parseInt(e.target.value) || 1` 夹在
 * Math.max 里是合理的，那是控件语义，不是校验。因此本脚本按**赋值的字段名**
 * 判定，并保留一份写明理由的豁免清单。
 *
 * 正确写法见 `apps/web/src/lib/validation.ts`：一律返回判定结果，
 * 失败带可区分的 reason，由 `useValidationMessage` 翻成母语。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_SRC = join(ROOT, 'apps/web/src');

/** 一眼能看出「这是钱/比率/数量」的字段名。 */
const MONEY_FIELD = /\b\w*(?:Cents|Dollars|Price|Amount|Rate|RateBp|Percent|Tip|Fee|Tax|Discount|Refund|Points|Sessions|ValidDays|Units)\b\s*:/;

/** 静默纠正的三种写法。 */
const LENIENT = [
  { re: /parse(?:Int|Float)\([^;]*?\)\s*\|\|/, why: 'parseInt/parseFloat + || 默认值：打错字就悄悄换个值' },
  { re: /Number\.parse(?:Int|Float)\([^;]*?\)\s*\|\|/, why: '同上' },
  { re: /dollarsToCents\(/, why: 'dollarsToCents 是结账用的宽容解析器，会剔掉非数字再算' },
  { re: /Math\.round\(\s*parseFloat\([^;]*?\)\s*\*\s*100\s*\)/, why: '浮点乘法转分：1.005 会少一分' },
];

/**
 * 豁免。每一条都写明为什么这样是对的 —— 豁免必须是有人看过并写下理由的决定，
 * 不是「先加进来让脚本闭嘴」。
 */
/**
 * 行级豁免：文件 → 该行必须同时命中的模式。
 *
 * 比整文件豁免窄一档 —— 整文件豁免会把这个文件里**将来**写错的地方一起放过，
 * 而那正是这类缺陷最容易复发的地方。
 */
const EXEMPT_LINES = new Map([
  [
    'apps/web/src/pages/Checkout.tsx',
    /*
     * 收款行的金额是**边输边改**的：严格解析会在打到「5.」的那一刻判定失败，
     * 对着收银台的人是敌意行为。这两格由服务端兜底 —— `ticket.pay` 会把
     * 各行合计与自己算出的应收逐分比对，不等就 PAYMENT_MISMATCH，
     * 而界面上「还差 $XX」是当场可见的，不存在静默错下去。
     */
    /patchLine\(index, \{ (?:base|tip)Cents: dollarsToCents/,
  ],
]);

const EXEMPT = new Map([
  ['apps/web/src/features/checkout/api.ts', 'dollarsToCents 的定义处'],
  ['apps/web/src/lib/validation.ts', '正确写法的实现处，注释里引用了错误写法作对照'],
  ['apps/web/src/features/queue/checkoutMath.ts', '结账总额的唯一实现，入参已由调用方判定'],
  ['apps/web/src/pages/Settings.tsx', '注释里引用了错误写法作对照；实际取值已改为 parse* 判定'],
  ['apps/web/src/pages/Marketing.tsx', '同上'],
  ['apps/web/src/pages/DayClose.tsx', '同上'],
  /*
   * 收款行的金额是**边输边改**的：严格解析会在打到「5.」的那一刻判定失败，
   * 对着收银台的人是敌意行为。这两格由服务端兜底 —— `ticket.pay` 会把
   * 各行合计与自己算出的应收逐分比对，不等就 PAYMENT_MISMATCH，
   * 而界面上那一行「还差 $XX」是当场可见的，不存在「静默错下去」。
   */

]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const hits = [];
for (const file of walk(WEB_SRC)) {
  const rel = relative(ROOT, file);
  if (EXEMPT.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\*.*?\*\//g, '');
    if (/^\s*[*/]/.test(code)) return;              // 注释行
    if (!MONEY_FIELD.test(code)) return;             // 不是钱字段
    const lineExempt = EXEMPT_LINES.get(rel);
    if (lineExempt?.test(code)) return;
    for (const { re, why } of LENIENT) {
      if (re.test(code)) { hits.push(`${rel}:${i + 1}  ${why}\n    ${code.trim().slice(0, 120)}`); break; }
    }
  });
}

if (hits.length) {
  console.log(`钱路径上有 ${hits.length} 处静默纠正：`);
  for (const hit of hits) console.log(`  ${hit}`);
  process.exit(1);
}
console.log('✓ 钱路径解析检查通过');
