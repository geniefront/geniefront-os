# apps/web 整改交接

> 交接时间 2026-08-28。上一轮完成了后台管理前端的多语言改造、假数据清除、打包优化与测试补强。
> 本文只写**接手者需要知道的**：待办、必须遵守的约定、以及几个会让人踩坑的地方。

---

## 2026-08-28 · 第 3 批首个真实闭环切片（进行中）

已把运营看板的“本地状态假闭环”改为真实命令链：预约签到写入队列，开始服务创建并
启动真实工单，完成服务推进真实工单项，收银只有拿到真实 `ticketId` 才能成功。预约、
队列和工单状态现在在同一事务链上推进；作废会回到已签到状态，可重新开一张替代单。

迁移 `0056_one_live_ticket_per_appointment.sql` 增加两道并发终极约束：同一预约最多一张
未作废工单、最多一条未离场队列记录。新增 `apps/api/src/core_loop.test.ts` 覆盖签到 →
开工 → 完工 → 现金收银、幂等重放、不同键重复开单拒绝、错客户拒绝和作废重开，并在
用例后清理预约/队列夹具、停放且冲正财务记录。

当前验证：`lint:guards`、11 workspace `typecheck`、389 项无数据库测试、Web 生产构建均通过。
数据库闭环测试尚未执行，因为本机未配置隔离的 `TEST_DATABASE_URL` /
`TEST_MIGRATION_DATABASE_URL`；不得改用 dev 项目代跑。合并前必须在隔离测试项目执行迁移
0000–0056 和 `pnpm --filter @gf/api test -- core_loop.test.ts`。

仍未完成：任意加项目前可在弹窗中编辑，但自由文本加项不会写账，提交完成服务时会明确
拒绝，不再假成功。下一步应把它改成真实服务目录选择并调用 `ticket.addItem`，随后补四角色、
两店跨租户、退款与日结的整链 E2E。

---

## 一、当前高优先级待办

静默假数据清理已经覆盖 `BusinessData`、`Dashboard`、`Payouts`、`EmployeePerformance`、
`Calls`、`Messages`、`CommunicationLogs`、`Checkout`、`Queue` 和 `Settings`，并同步清理了
评价、结算、账单、通知、个人资料、员工目录、经营分析与日结终端查询层的伪造 fallback。
`scripts/lint-guards.sh` 现在会阻止常见经营 Mock 标识重新进入页面和 API query。

尚未接入真实数据模型的功能现在明确返回空值：银行划拨批次、工资批次、提成冲正、
AI 经营摘要、获客渠道拆分，以及服务成本/毛利/评分。后续应实现真实表或第三方同步，
不能重新用估算值把页面填满。

下一步优先：

- 建立独立、带固定测试种子的 Supabase test 项目或临时 branch；
- 为支付服务商同步、薪资批次、提成冲正和评价 AI 分析建立真实数据模型；
- 继续按真实门店核心闭环做角色、跨租户、幂等与清理型 E2E。

统一规则：无数据用 `EmptyState`，请求失败用 `PageError`，无权限用明确禁止态。
销售演示只能使用独立 demo tenant，不得与真实数据静默混合。

---

## 二、接手前必须知道的四个坑

### 1. API 集成测试不得使用 dev 或 prod

部分 API/DB 测试会写数据、改 GRANT 或依赖固定种子。只有配置了独立 test 项目或临时
Supabase branch 后才能运行完整 `pnpm verify`。当前 dev 已完成 0000–0055 迁移，但没有测试种子，
不是测试沙盒；直接运行 `packages/db/src/rls.test.ts` 会因固定 org/location/resource 不存在而失败。
测试配置现在强制要求 `DATABASE_TEST_TARGET=isolated`、`TEST_DATABASE_URL` 和
`TEST_MIGRATION_DATABASE_URL`，并且不会继承普通 `.env` 中的 dev/prod 连接串。

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
pnpm lint:guards                              # 含 i18n、金额与静默假数据关卡，应全绿
pnpm typecheck                                # 11 个 workspace
pnpm test:unit                                # 389 项，不连接数据库
pnpm --filter @gf/web build
```

开发环境：`pnpm --filter @gf/api dev`（:3000）+ `pnpm --filter @gf/web dev`（:5177），
只有在明确的 dev/demo tenant 执行种子流程后，才使用演示账号登录。
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
- **数据库安全**：dev 已正式执行 0000–0055；`withTenant()` 设置 `app.user_id`；
  迁移器强制核对 public 表 FORCE RLS；0055 收紧无 RLS 表、函数 `search_path` 与
  `SECURITY DEFINER` 执行权限。
- **可信经营数据**：财务、评价、通知、沟通、员工、设置和收银不再生成看似真实的
  姓名、电话、银行账户、经营指标或提成比例；无法证明的数据明确为空或不可用。
