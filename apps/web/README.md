# @gf/web — 统一 Web 前端

门店统一 Web 客户端（覆盖 PC 浏览器桌面端、移动端 Web、平板 Web，按账号权限自适应呈现工作台）。
技术栈：Vite + React 19 + TypeScript + Tailwind v4 + HeroUI + TanStack Query。

> **⭐ 详细架构、避坑指南与开发契约请直接阅读：[`docs/16-FRONTEND-GUIDE.md`](../../docs/16-FRONTEND-GUIDE.md)。**

## 快速启动

```bash
# 1. 后端 API（http://127.0.0.1:3000）
pnpm --filter @gf/api dev

# 2. 统一 Web 前端（http://localhost:5177）
pnpm --filter @gf/web dev
```

- 种子账号：`mia@maildrop.cc` / `GenieDev!2026`（Lotus Nails 前台）
- 数据重置：`pnpm db:tidy`（勿用 `db:seed`）
- 质量检查：`pnpm --filter @gf/web typecheck && pnpm --filter @gf/web test`


## 多语言

界面文案一律经 `useLanguage()` 的 `t()` 取用，**不得在页面中写中文字面量**。
服务端返回的多语言字段（服务名、门店名等 i18n JSONB）走 `pickI18nText()`，
其回退顺序由 `@gf/contracts` 的 `pickText` 统一实现，前后端共用一份。

### 语言代码

与服务端契约 `LOCALES` 对齐：`en` / `zh-Hans` / `zh-Hant` / `ko` / `vi` / `es`。
其中 `zh-Hant` 目前仅作为**数据语言**存在——服务端可存储并回显繁体内容，
但界面文案尚无繁体译本，故不进入语言切换器。补齐译本后将其加入
`i18n/types.ts` 的 `UI_LANGUAGES` 即可，类型系统会立即列出全部缺失词条。

### 字典结构

```
src/i18n/
  index.ts     合并入口，导出 translations / TranslationKey
  types.ts     Language、UI_LANGUAGES、DomainDict
  common.ts    跨页面复用词条与历史扁平 key（不要往这里加新词条）
  schedule.ts  排班与预约      queue.ts     运营看板与房间
  rotation.ts  轮牌与绩效      checkout.ts  收银、订单与日结
  finance.ts   资金与经营数据  crm.ts       客户、营销与通知
  settings.ts  系统设置与个人中心
```

按域分文件的直接理由是并行改造：多人同时向单一字典追加词条必然产生合并冲突。
新词条一律带域前缀，如 `schedule.conflictTitle`。

### 抽取工具

```bash
# 1. 生成抽取方案（只读，不改文件）
node scripts/i18n-extract.mjs plan --domain queue \
  --file apps/web/src/pages/Rooms.tsx > /tmp/rooms.plan.json

# 2. 复核 plan 中的 key 命名、补全五种译文，标记 "skip": true 排除非文案项
# 3. 应用（AST 精确改写 + 词条写入域字典）
node scripts/i18n-extract.mjs apply /tmp/rooms.plan.json
```

⚠️ **禁止用 sed / 正则批量替换中文。** 中文没有词边界，子串替换会把句子切碎——
本轮审核在既有代码中发现 261 处此类损坏串，形如「总Duration预计 50 分钟」。

### 关卡

`pnpm lint:guards` 会以 AST 扫描 `pages/` 与 `components/`，命中中文界面文案即失败。
存量改造已全部完成，该规则**无条件生效**，不提供豁免清单。

`node scripts/i18n-unused.mjs` 盘点未被引用的词条。其判定刻意偏保守
（显式引入 `TranslationKey` 的文件中的字面量一律视为在用），因为删除词条
不会产生任何编译期信号，故障要到用户触发那段界面时才暴露。

### 错误提示

不得直接展示 `err.message`（其值即服务端错误码，如 `STAFF_OVER_CAPACITY`）。
统一使用 `useErrorMessage()`。

⚠️ 其内部的 `ERROR_MESSAGE_KEYS` 必须逐条显式列出错误码与词条的对应关系，
**不得写成 `` t(`error${code}`) `` 这类运行期拼接**——拼接出的 key 对静态分析
不可见，字典瘦身脚本会把这些词条判为未引用并删除，且删除后没有编译期错误。
显式映射的类型是 `Record<ErrorCode, TranslationKey>`：服务端新增错误码时
缺少映射是类型错误，映射到不存在的词条同样是类型错误。

### 缺失词条

`t()` 在词条缺失时返回 key 原文，因此 `t('x') || '兜底文案'` 这一写法**无效**——
逻辑或的右侧永远不会执行。开发环境下缺词条会 `console.error` 并渲染 `⟦key⟧`。
