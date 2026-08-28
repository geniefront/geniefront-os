#!/usr/bin/env node
/**
 * 为调用了 `t()` 但尚未取用 `useLanguage()` 的组件补上该 hook。
 *
 * 抽取工具只负责把字面量换成 `t('key')`，是否已经持有 `t` 由组件自身决定；
 * 逐文件人工补充容易遗漏，且遗漏的表现是编译期报错而非运行期问题，
 * 因此以脚本统一处理。
 *
 *   node scripts/i18n-ensure-hook.mjs <文件…>
 */
import fs from 'node:fs';
import ts from 'typescript';

for (const file of process.argv.slice(2)) {
  let src = fs.readFileSync(file, 'utf8');
  if (!/\bt\(['"`]/.test(src)) continue;
  if (!src.includes('useLanguage')) {
    const m = src.match(/^import .*from '@\/[^']+';$/m) || src.match(/^import .*$/m);
    src = src.replace(m[0], m[0] + "\nimport { useLanguage } from '@/LanguageContext';");
  }

  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't') {
      for (let p = n.parent; p; p = p.parent) {
        const isFn =
          ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p);
        if (!isFn || !p.body || !ts.isBlock(p.body)) continue;
        let name = null;
        if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text;
        else if (p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name))
          name = p.parent.name.text;
        if (name && /^[A-Z]/.test(name)) {
          // 组件内已有 t 则不重复声明
          if (!/const \{[^}]*\bt\b[^}]*\} = useLanguage\(\)/.test(p.body.getText(sf))) {
            bodies.add(p.body.getStart(sf) + 1);
          }
          break;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);

  let out = src;
  for (const pos of [...bodies].sort((a, b) => b - a)) {
    out = out.slice(0, pos) + '\n  const { t } = useLanguage();' + out.slice(pos);
  }
  if (out !== src) {
    fs.writeFileSync(file, out);
    console.log(`${file}：补入 ${bodies.size} 处`);
  }
}
