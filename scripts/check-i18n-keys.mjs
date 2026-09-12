/**
 * 文案 key 必须存在于字典（AUD-07）。
 *
 * `t()` 的签名是 `TranslationKey | string` —— 那个 `| string` 是个逃生口，
 * 于是拼错或取错命名空间的 key **没有任何编译期错误**。运行时的后果分两档：
 *
 *   开发环境 → 渲染成 `⟦settings.manage⟧` 并打一条 console.error
 *   生产环境 → **原样把 key 显示给用户**
 *
 * 所以这类故障恰好在最不可能被发现的地方暴露：开发时一眼就看见，
 * 上线后变成前台屏幕上一行 `settings.manage`，而没人会去看她的浏览器控制台。
 *
 * 已知实例：无权限页显示 `settings.manage`、健康表禁忌横幅显示 `skinAllergies`。
 *
 * ⚠️ 只判定**字面量** key。运行期拼接（`t(\`x.${kind}\`)`）本脚本看不见，
 *    而那种写法对字典瘦身脚本同样不可见（会被当作未引用词条删掉），
 *    因此它本身就是不该出现的写法 —— 见 `lib/validationMessage.ts` 的做法：
 *    把 reason → key 的映射写成显式的 Record。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { ALL_TRANSLATION_KEYS } = await import(new URL('../apps/web/src/i18n/index.ts', import.meta.url).href);
const KNOWN = new Set(ALL_TRANSLATION_KEYS);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/* `t('x')`、`t("x", {...})`、`tt('x')` 之类。只认单引号/双引号字面量。 */
const CALL = /\bt\(\s*(['"])([^'"]+)\1/g;

const missing = new Map();
for (const file of walk(join(ROOT, 'apps/web/src'))) {
  /* 注释里的用法示例不是调用点 —— formFeedback.ts 的文档注释里就有
     `t('nameRequired')` 这样的示例 */
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  for (const m of src.matchAll(CALL)) {
    const key = m[2];
    /* 只看长得像 key 的：含点号或驼峰，且没有空格。带空格的多半是别的函数 */
    if (/\s/.test(key) || !/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(key)) continue;
    if (KNOWN.has(key)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!missing.has(key)) missing.set(key, []);
    missing.get(key).push(`${relative(ROOT, file)}:${line}`);
  }
}

if (missing.size) {
  console.log(`字典里没有的文案 key：${missing.size} 个`);
  for (const [key, where] of [...missing].sort()) {
    console.log(`  ${key}\n    ${where.join(', ')}`);
  }
  process.exit(1);
}
console.log(`✓ 文案 key 检查通过（字典 ${KNOWN.size} 条）`);
