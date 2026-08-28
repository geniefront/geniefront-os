#!/usr/bin/env node
/**
 * 界面文案抽取工具（apps/web 专用）。
 *
 * ⚠️ **本工具基于 TypeScript AST 改写源码，禁止以正则或 sed 替代。**
 * 中文不存在词边界，任何基于子串匹配的批量替换都会把句子切碎 ——
 * 本轮审核在既有代码中发现了 261 处此类损坏串，形如
 * 「总Duration预计 50 分钟」「左Right Shoulder颈与上背部酸痛」。
 * 该问题的成本远高于其所节省的时间，因此工具层面即予以杜绝。
 *
 * 工作流分两步，中间保留人工复核环节：
 *
 *   1. 生成抽取方案（只读，不改任何文件）
 *      node scripts/i18n-extract.mjs plan --domain queue \
 *        --file apps/web/src/pages/Queue.tsx > /tmp/queue.plan.json
 *
 *   2. 复核并补全 plan.json 中的 key 命名与五种语言译文后应用
 *      node scripts/i18n-extract.mjs apply /tmp/queue.plan.json
 *
 * 分两步而非一步到位，是因为 key 命名与译文质量无法由工具判定：
 * 中文文案不能机械转写为拉丁字母 key，而机器直译在门店术语上
 * （「轮牌」「上钟」「点客」）准确率不足以直接交付。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const CJK = /[一-鿿㐀-䶿豈-﫿]/;

/**
 * 视为界面文案的 JSX 属性。
 *
 * 白名单而非黑名单：属性值中的中文并不必然是给用户看的文案，
 * 例如 `queryKey`、`data-testid`、以及以中文为业务标识的枚举值。
 * 误抽取会把数据当作文案搬进字典，其后果比漏抽取更难发现。
 */
const TEXT_ATTRIBUTES = new Set([
  'title',
  'label',
  'placeholder',
  'desc',
  'description',
  'subtitle',
  'heading',
  'hint',
  'tooltip',
  'confirmText',
  'cancelText',
  'emptyText',
  'errorText',
  'helperText',
  'aria-label',
  'alt',
  'confirmLabel',
  'cancelLabel',
  'submitLabel',
  'actionLabel',
  'primaryLabel',
  'secondaryLabel',
  'buttonLabel',
  'ctaLabel',
  'message',
  'note',
  'caption',
  'dialogTitle',
  'headerTitle',
  'emptyTitle',
  'emptyDescription',
  'loadingText',
  'fallbackTitle',
]);

/** 视为界面文案的函数调用：其字符串实参会直接呈现给用户。 */
const TEXT_CALLS = new Set([
  'toast.success',
  'toast.danger',
  'toast.warning',
  'toast.info',
  'window.alert',
  'window.confirm',
  'alert',
  'confirm',
]);

function callName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const obj = ts.isIdentifier(e.expression) ? e.expression.text : null;
    return obj ? `${obj}.${e.name.text}` : e.name.text;
  }
  return null;
}

/** 取最近的外层函数/组件名，用于生成有语义的 key 提示。 */
function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
  }
  return null;
}

function slugHint(raw) {
  if (!raw) return 'text';
  const s = raw.replace(/^(handle|use|render|on)/, '');
  return (s.charAt(0).toLowerCase() + s.slice(1)) || 'text';
}

export function collect(filePath, domain) {
  const src = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const seen = new Set();

  const push = (node, text, kind, hint) => {
    const trimmed = text.trim();
    if (!trimmed || !CJK.test(trimmed)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const id = `${node.getStart(sf)}:${node.getEnd()}`;
    if (seen.has(id)) return;
    seen.add(id);
    found.push({
      line: line + 1,
      kind,
      start: node.getStart(sf),
      end: node.getEnd(),
      text: trimmed,
      // 前后空白在 JSX 文本中影响排版，回填时需原样保留
      leading: kind === 'jsx-text' ? text.slice(0, text.length - text.trimStart().length) : '',
      trailing: kind === 'jsx-text' ? text.slice(text.trimEnd().length) : '',
      suggestedKey: `${domain}.${slugHint(hint)}${found.length + 1}`,
      translations: { 'zh-Hans': trimmed, en: '', ko: '', es: '', vi: '' },
    });
  };

  /**
   * 收集一段 JSX 子表达式中的全部中文字符串字面量。
   *
   * 形如 `{cond ? '空闲' : '占用'}`、`{list.map(x => <b>{x ? '是' : '否'}</b>)}`
   * 的写法在页面中大量存在，其字面量同样会呈现给用户，但既不是 JsxText
   * 也不是属性值。此处按子树遍历补齐，并排除 `t('...')` 自身的实参
   * 与对象字面量的键名 —— 前者已经是文案调用，后者是标识符而非文案。
   */
  const collectInExpression = (root, hint) => {
    const walk = (n) => {
      if (ts.isCallExpression(n) && callName(n) === 't') return; // 已走字典
      if (ts.isPropertyAssignment(n) && n.name === n.name && ts.isStringLiteral(n.name)) {
        // 仅跳过键名，值继续遍历
        walk(n.initializer);
        return;
      }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        push(n, n.text, 'expr-literal', hint);
        return;
      }
      if (ts.isTemplateExpression(n)) {
        pushTemplate(n, hint);
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
  };

  /**
   * 模板字符串。
   *
   * 形如 `技师【${name}】已跳过` 的文案含运行期变量，抽取时转成占位符
   * `技师【{p0}】已跳过`，回填为 `t('key', { p0: name })` ——
   * 若按普通字符串处理会把变量一并写进字典，得到一条永远对不上的词条。
   */
  const pushTemplate = (node, hint) => {
    const parts = [node.head.text];
    const exprs = [];
    node.templateSpans.forEach((span, i) => {
      exprs.push(span.expression.getText(sf));
      parts.push(`{p${i}}`, span.literal.text);
    });
    const text = parts.join('');
    if (!CJK.test(text)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const id = `${node.getStart(sf)}:${node.getEnd()}`;
    if (seen.has(id)) return;
    seen.add(id);
    found.push({
      line: line + 1,
      kind: 'template',
      start: node.getStart(sf),
      end: node.getEnd(),
      text: text.trim(),
      leading: '',
      trailing: '',
      params: exprs,
      suggestedKey: `${domain}.${slugHint(hint)}${found.length + 1}`,
      translations: { 'zh-Hans': text.trim(), en: '', ko: '', es: '', vi: '' },
    });
  };

  const visit = (node) => {
    // 导入路径、导出声明不属于界面文案
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;

    if (ts.isJsxText(node)) {
      push(node, node.text, 'jsx-text', enclosingName(node));
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      collectInExpression(node.expression, enclosingName(node));
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const attr = node.name.getText(sf);
      if (TEXT_ATTRIBUTES.has(attr)) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) {
          push(init, init.text, 'attr-literal', attr);
        } else if (ts.isJsxExpression(init) && init.expression) {
          collectInExpression(init.expression, attr);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name && TEXT_CALLS.has(name)) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            push(arg, arg.text, 'call-arg', name.split('.').pop());
          } else if (ts.isTemplateExpression(arg)) {
            pushTemplate(arg, name.split('.').pop());
          } else {
            collectInExpression(arg, name.split('.').pop());
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return { file: filePath, domain, items: found };
}

function apply(planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const src = fs.readFileSync(plan.file, 'utf8');

  const items = [...plan.items]
    .filter((i) => !i.skip)
    .sort((a, b) => b.start - a.start); // 自后向前改写，避免偏移量失效

  let out = src;
  for (const item of items) {
    if (!item.key) throw new Error(`第 ${item.line} 行的条目缺少 key：${item.text}`);
    const params = (item.params ?? []).map((e, i) => `p${i}: ${e}`).join(', ');
    const call = params ? `t('${item.key}', { ${params} })` : `t('${item.key}')`;
    let replacement;
    if (item.kind === 'jsx-text') {
      replacement = `${item.leading}{${call}}${item.trailing}`;
    } else if (item.kind === 'attr-literal') {
      replacement = `{${call}}`;
    } else if (src[item.start - 1] === '=') {
      // 字面量本身即属性值（`placeholder="…"`），回填后必须仍是合法的 JSX 属性
      replacement = `{${call}}`;
    } else if (item.kind === 'template') {
      replacement = call;
    } else {
      replacement = call;
    }
    out = out.slice(0, item.start) + replacement + out.slice(item.end);
  }
  fs.writeFileSync(plan.file, out);

  // 词条追加到域字典。字典按域分文件，因此此处不存在并发写入同一文件的问题。
  const dictPath = path.join('apps/web/src/i18n', `${plan.domain}.ts`);
  let dict = fs.readFileSync(dictPath, 'utf8');
  const lines = plan.items
    .filter((i) => !i.skip && i.key)
    .map((i) => {
      const tr = i.translations;
      const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `  '${i.key}': { 'zh-Hans': '${esc(tr['zh-Hans'])}', en: '${esc(tr.en)}', ko: '${esc(tr.ko)}', es: '${esc(tr.es)}', vi: '${esc(tr.vi)}' },`;
    });
  /*
   * ⚠️ 必须传入替换函数而非替换字符串。
   * String.replace 的字符串形态会把 `$'`、`$&`、`` $` `` 解释为特殊记号，
   * 而文案中 `$` 是金额符号，`'小费总计: $'` 这类词条会被静默改写为
   * 一段错误内容并导致字典无法编译。
   */
  dict = dict.replace('\n} satisfies DomainDict;', () => `\n${lines.join('\n')}\n} satisfies DomainDict;`);
  fs.writeFileSync(dictPath, dict);

  console.log(`已改写 ${plan.file}：${items.length} 处；词条写入 ${dictPath}`);
}

// 仅在直接执行时进入命令行分发 —— 本模块同时被 i18n-guard.mjs 作为库引用
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'plan') {
    const fileIdx = rest.indexOf('--file');
    const domIdx = rest.indexOf('--domain');
    if (fileIdx < 0 || domIdx < 0) {
      console.error('用法：i18n-extract.mjs plan --domain <域> --file <文件路径>');
      process.exit(2);
    }
    const result = collect(rest[fileIdx + 1], rest[domIdx + 1]);
    if (rest.includes('--compact')) {
      // 紧凑清单：供人工/模型逐条填写 key 与译文，避免通读完整 JSON
      result.items.forEach((i, n) => console.log(`${n}\t${i.line}\t${i.kind}\t${i.text.replace(/\s+/g, ' ')}`));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (cmd === 'apply') {
    apply(rest[0]);
  } else {
    console.error('用法：i18n-extract.mjs plan|apply');
    process.exit(2);
  }
}
