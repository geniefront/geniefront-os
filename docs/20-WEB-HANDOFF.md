# apps/web 整改交接

> 交接时间 2026-08-28。上一轮完成了后台管理前端的多语言改造、假数据清除、打包优化与测试补强。
> 本文只写**接手者需要知道的**：待办、必须遵守的约定、以及几个会让人踩坑的地方。

---

## 2026-08-28 · 后端与数据库 P0/P1 收口（已完成）

已把运营看板的“本地状态假闭环”改为真实命令链：预约签到写入队列，开始服务创建并
启动真实工单，完成服务推进真实工单项，收银只有拿到真实 `ticketId` 才能成功。预约、
队列和工单状态现在在同一事务链上推进；作废会回到已签到状态，可重新开一张替代单。

迁移 `0056_one_live_ticket_per_appointment.sql` 增加两道并发终极约束：同一预约最多一张
未作废工单、最多一条未离场队列记录。新增 `apps/api/src/core_loop.test.ts` 覆盖签到 →
开工 → 完工 → 现金收银、幂等重放、不同键重复开单拒绝、错客户拒绝和作废重开，并在
用例后清理预约/队列夹具、停放且冲正财务记录。

完成服务弹窗的加项已改为当前门店真实服务目录：前端不再提供硬编码快捷套餐、自由文本名称
或手填金额；每项绑定真实服务和真实技师，通过带稳定幂等键的 `ticket.addItem` 写入后端，
再依次开工、完工，并以后端重算小计为准。闭环测试同时覆盖目录加项和加项后的现金收银。
技师备注现已持久化并按管理层/已分配员工范围过滤；房间状态由开工、完工、换房、作废和
清洁命令在事务中推进，不再依赖前端本地状态。
同一测试文件还会从数据库读取老板、店长、前台、技师的真实权限，锁定调度、工单与作废边界，
并验证另一家店的服务或技师不能混入本店开单和加项。

迁移 `0057_ticket_refund_ledger.sql` 新增强制 RLS、只追加的逐笔退款账本。部分退款会按服务、
税费、附加费和明确指定的小费拆账；原路退款按原支付渠道精确分摊，现金退款写现金负向流水，
店内余额退款写客户预付资产账本。日结净额、卡终端应收、现金抽屉、技师提成和小费分配同步
冲销；全额退款会完整反转技师收入。订单页支持在部分退款后继续退剩余额，不再把部分退款误标
为整单已退。

迁移 `0058` 完成不可变日结事件、封账日数据库写屏障、客户储值消费/退款渠道拆分、服务备注与
资源占用清洁状态机；`0059` 完成支付服务商连接/游标/webhook 事件、商户余额快照、划拨批次、
工资批次、服务成本/毛利、评价事实关联和版本化 AI 经营摘要。没有第三方同步事实时，生产查询
明确返回未配置/未同步或空态，绝不生成银行账户、工资、余额或 AI 结论。

隔离测试使用本机一次性 PostgreSQL 17 容器，从空库执行 0000–0059，加载固定种子，并以
`app_user` 验证 RLS。核心测试覆盖真实 owner/manager/front_desk/technician 权限、跨租户、
幂等、储值并发双花、服务备注越权、房态清洁、并发封账和不可变历史。仓库内可解决的 P0
后端/数据库模型与核心专项闭环已完成。完整 API 历史套件仍有跨文件共享种子状态及旧“假数据应存在”
断言需要逐项隔离/更新；在该套件全绿前，不应把本分支直接合入 main。

---

## 一、当前高优先级待办

静默假数据清理已经覆盖 `BusinessData`、`Dashboard`、`Payouts`、`EmployeePerformance`、
`Calls`、`Messages`、`CommunicationLogs`、`Checkout`、`Queue` 和 `Settings`，并同步清理了
评价、结算、账单、通知、个人资料、员工目录、经营分析与日结终端查询层的伪造 fallback。
`scripts/lint-guards.sh` 现在会阻止常见经营 Mock 标识重新进入页面和 API query。

真实数据模型和同步边界已经建立。仍需外部完成的只有支付/工资 provider 账号、webhook 密钥与
生产凭据配置，以及实际 AI 生成器凭据；在这些配置完成前相应 API 会诚实返回不可用/空态。

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
# 数据库测试还必须显式设置 DATABASE_TEST_TARGET=isolated、
# TEST_DATABASE_URL（app_user）与 TEST_MIGRATION_DATABASE_URL（postgres）。
# CI 会先执行 packages/db/test/bootstrap-postgres.sql，再迁移、种子和全套测试。
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
