# apps/web 整改交接

> 交接时间 2026-08-28。上一轮完成了后台管理前端的多语言改造、假数据清除、打包优化与测试补强。
> 本文只写**接手者需要知道的**：待办、必须遵守的约定、以及几个会让人踩坑的地方。

---

## 一、唯一的待办（高危，需要先做产品决策）

### `apps/web/src/pages/BusinessData.tsx` 在接口失败时伪造经营数据

**现象**：前台账号（`mia@example.test`，无 `report.view` 权限）打开经营数据页，
`/v1/desk/analytics/*` 七个接口**全部返回 403**，页面却完整渲染出一套看起来真实的数字：

```
Net GMV $15,890.00    +14.8% 环比
总客流 286            新客 78 / 老客 208
平均客单价 $58.50     复购率 76.5%     工位利用率 84.2%
```

**根因**：页面各处独立硬编码兜底，绕过了顶部的错误态判断。

| 位置 | 问题 |
|---|---|
| `BusinessData.tsx:235` | `totalNetRevenueDollars` 无数据时 `return '15,890.00'` |
| `BusinessData.tsx:397` | `(customersQ.data?.retentionRateBp \|\| 7650) / 100` |
| `BusinessData.tsx:142` 起 | `chartData` 无数据时返回硬编码数组 |
| `BusinessData.tsx:167` 起 | `categoryData` 同上 |
| `BusinessData.tsx:198` | `topServicesList` 回落到常量 `TOP_SERVICES` |
| `BusinessData.tsx:82` | `HEATMAP_DATA` 压根没接接口，全是常量 |
| `BusinessData.tsx:248` | `PageError` 只守 `revenueQ` 一条，其余 KPI 各自绕过 |

**为什么必须处理**：这是老板做经营决策的页面。同类问题上一轮已在
`Tickets.tsx`（假订单）与 `features/profile|notifications`（localStorage 假成功）修掉了，
`BusinessData` 是漏网的一处，且后果最重。

**建议做法**（需店主/产品确认）：删除全部硬编码兜底，改为：
- 403（无权限）→ 明确提示「当前账号没有查看经营报表的权限」，而不是给一份编出来的数字；
- 其他失败 → 走 `PageError`；
- 无数据 → 走 `EmptyState`。

页面已有 `components/ui/EmptyState.tsx`、`components/ui/QueryState.tsx`（`PageError`）、
`components/ui/SampleDataNotice.tsx` 可用。若产品坚持要留演示数据，**必须**挂
`SampleDataNotice`，不得静默呈现。

> ⚠️ 该页的文案已全部走字典（域 `finance`，前缀 `finance.bd*`）。删除兜底时
> 只删数据，不要连带删掉 `t()` 调用，否则会触发 i18n 关卡。

---

## 二、接手前必须知道的四个坑

### 1. `apps/api` 有 18 项测试失败，**与前端无关，不要去修**

`bus / ghostStaff / offHours / phone / public / server / staff` 七个测试文件共 18 项失败，
典型报错是 `Cannot read properties of undefined (reading 'user_id')`（种子数据缺失）。

已用「回退—对比」实证确认：把上一轮的后端改动全部还原后，**同样是 18 失败 / 117 通过**，
与代码改动无关。根因是共用开发库的测试互相清数据，见提交
`016e942 共用开发库的三个坑`。覆盖到实际改动的 6 个测试文件（analytics / marketing /
settings / giftcard / payouts / profile）**68 项全绿**。

### 2. 错误码文案严禁运行期拼 key

`lib/errorMessage.ts` 的 `ERROR_MESSAGE_KEYS` 必须逐条显式列出
`Record<ErrorCode, TranslationKey>`。

**不要**改回 `` t(`error${code}`) ``：拼接出的 key 对静态分析不可见，
`scripts/i18n-unused.mjs` 会把这 30 条词条判为「未引用」并删除，**且删除后没有任何编译期错误**，
故障要到门店真的触发该错误时才暴露。现在的显式映射同时保证：服务端新增错误码缺映射是类型错误，
映射到不存在的词条也是类型错误。

### 3. 金额一律用 `asCents` / `asInt`，不要退回裸 `Number()`

`@gf/contracts` 的 `asInt`（别名 `asCents`）对非整数输入**拒绝并回退**，不做四舍五入。
`scripts/lint-guards.sh` 第 4 条会拦住 `Number(...cents/amount/price/tip/total...)`。

分转美元的**呈现**用 `features/checkout/api.ts` 的 `toDisplayDollars()`，
不要写 `Number(centsToDollars(x))`（字符串来回转换，且会触发第 4 条）。
**任何金额的加减乘除仍必须在整数分上进行。**

### 4. 词条的空串只对量词成立

`i18n/i18n.test.ts` 允许英文等语言把中文量词（「次」「名」「单」）渲染为空串，
判定条件是**中文原文不超过两个字**。超过两个字仍为空串会判定为漏译。
不要为了让测试过而随便填空格。

---

## 三、必须遵守的约定（改动前先读 `apps/web/README.md` 多语言小节）

- **界面文案一律走 `t()`**，`pnpm lint:guards` 无条件拦截页面中的中文字面量，**没有豁免清单**。
- 新词条写进对应域文件 `src/i18n/<域>.ts`，带 `<域>.` 前缀；`common.ts` 不再接受新词条。
- 语言代码与服务端契约一致：`en / zh-Hans / zh-Hant / ko / vi / es`。
  `zh-Hant` 目前只作数据语言，界面无译本，不在切换器里。
- 服务端返回的多语言字段用 `pickI18nText()`（内部走契约的 `pickText`），不要另写回退顺序。
- **禁止用 sed / 正则批量替换中文**。上一轮就是这么做的，产出 261 处
  「总Duration预计 50 分钟」这类损坏串。要改用 `scripts/i18n-extract.mjs`（AST）。
- 时间显示用 `lib/time.ts` 的 `useStoreTime()`，不要 `new Date(x).toLocaleString()`
  （用的是浏览器时区与浏览器语言）。
- 写操作按钮用 `GuardedButton`，不要直接用 `Button`。

### 可用工具

```bash
node scripts/i18n-extract.mjs plan --domain <域> --file <文件> --compact  # 列出待抽取文案
node scripts/i18n-extract.mjs plan --domain <域> --file <文件> > /tmp/p.json
node scripts/i18n-fill.mjs /tmp/p.json /tmp/fills.json    # 按顺序填 key 与译文后回填
node scripts/i18n-ensure-hook.mjs <文件…>                  # 补 useLanguage()
node scripts/i18n-guard.mjs                                # 关卡
node scripts/i18n-unused.mjs                               # 未引用词条盘点
```

`fills.json` 每项格式：`["key后缀", "en", "ko", "es", "vi"]`，
第 6 项可选，用于改写中文原文（修损坏串时用）；`null` 表示跳过该条。

---

## 四、验证命令

```bash
cd /Users/naiyouzhu/siteadmin/geniefront-os
pnpm lint:guards                              # 含 i18n 关卡与金额检查，应全绿
npx tsc --noEmit -p apps/web/tsconfig.json
cd apps/web && npx vitest run                 # 58 项
npx vitest run packages/contracts/src/money.test.ts   # 6 项
cd apps/web && npx vite build
```

开发环境：`pnpm --filter @gf/api dev`（:3000）+ `pnpm --filter @gf/web dev`（:5177），
登录 `mia@example.test` / `GenieDev!2026`。
开发环境下缺词条会渲染成 `⟦key⟧` 并在控制台告警，自测时留意。

---

## 五、上一轮已完成的内容（背景，无需重做）

- **多语言**：字典拆为 8 个域文件；26 个文件 **3,031 处**文案抽取完毕，五种语言；
  修复 261 处盲替换损坏串；字典 4,070 → 3,421 条，零冗余；关卡无条件生效。
- **假数据**：删除 Tickets 假订单回退与写死的 8.875% 税率；
  profile / notifications 去掉 localStorage 假成功（后端接口本就已实现）；
  五个未接后端的页面挂上 `SampleDataNotice`。
- **跨页面**：67 处 `err.message` 接错误码文案；18 处浏览器时区改门店时区。
- **打包**：路由改 `React.lazy`，入口包 3,997 kB → 1,735 kB（gzip 912 → 511 kB）。
- **删除**：`pages/Subscription.tsx`（路由已重定向到 `/settings?tab=billing`，页面不可达）。
- **测试**：web 29 → 58 项（新增 i18n 完整性、错误码覆盖、权限标识有效性、
  GuardedButton、LanguageContext、ErrorBoundary）；contracts 新增 6 项金额测试。
  已装 `jsdom` + `@testing-library/react` + `user-event` + `jest-dom`。
