# 交接：开店 / 预约 / 员工 / 沟通 / iPad —— 剩下的「大改动」

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](../qa/TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


给接手的执行者。**小改动已全部完成并 push 到 `main`**（见下「已完成，不要重做」）。
本文档只讲**剩下的大工作包**，每个都给了入口文件、根因、要做什么、验收口径。

- 原始需求分析：`docs/plans/2026-09-07-store-setup-operations-bugfix-plan.md`（U01–U13 → W0–W7，权威文档，逐条读）
- 实施报告（逐批追加）：`docs/plans/2026-09-07-store-setup-operations-bugfix-report.md`
- 套餐子项目独立计划：`docs/plans/2026-09-07-service-bundles-implementation.md`
- 代码审查基线：`580ee91`；本文写时 `main` HEAD = `ac8ec50`

---

## 0. 环境与命令（先做这一步，否则会踩坑）

| 事项 | 说明 |
|---|---|
| 仓库 | 私有 `geniefront/geniefront-os`，工作目录 `/Users/naiyouzhu/siteadmin/geniefront-os`。**是 git 仓库**（外层 `siteadmin/` 不是）。 |
| 分支 | 用户已授权**直接提交 + push 到 `main`**。每个工作包一个（或几个）可单独审查的 commit。 |
| 集成测试库 | 本机 `127.0.0.1:55322` 就是 isolated 测试库。测试前的 `db:seed` 会重置种子。 |
| ⚠️ 迁移陷阱 | `pnpm db:migrate` 默认从**根 `.env`** 读 `MIGRATION_DATABASE_URL`，而根 `.env` 指向 **staging 云库**。跑新迁移到本地必须显式覆盖：<br>`MIGRATION_DATABASE_URL="$(grep -oE '^TEST_MIGRATION_DATABASE_URL=.*' .env \| cut -d= -f2-)" APP_DB_PASSWORD="$(grep -oE '^TEST_APP_DB_PASSWORD=.*' .env \| cut -d= -f2-)" pnpm db:migrate` |
| API 集成测试 | 需要 `MIGRATION_DATABASE_URL` 指向本地（同上）。`pnpm --filter @gf/api test` 全量约 2.5 分钟，有若干 flaky（stripe_down / 限流 / 计时类）—— 单个文件失败先重跑一次确认。 |
| 常用校验 | `pnpm lint:guards`、`pnpm --filter @gf/web exec tsc --noEmit`、`pnpm --filter @gf/api exec tsc --noEmit`、`pnpm --filter @gf/web test`（约 10s / 324 用例）、`pnpm --filter @gf/db test` |
| 下一个迁移号 | `0114`（已用到 `0113`） |
| 提交署名 | commit message 末尾加 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` |

---

## 1. 硬约束（计划 §0，违反直接返工）

- **业务写入走命令总线**：契约校验、权限、事务、幂等、审计。前端**不直接写数据库**。
- **租户 + 门店隔离同时在 API 和 RLS 落实**。不能靠隐藏 UI / 客户电话号码代替归属授权。
- 保留既有线上门店显式设置、历史预约 / 付款 / 表单版本，**不做无差别默认值回填**。
- 预约时间由门店 IANA 时区转换；营业日与日历日分开。金额一律整数分。
- **员工岗位不是账号权限角色**；AI 接听开关不是 AI 改期 / 取消授权。
- UI 用现有多语言体系：`apps/web/src/i18n/*.ts`，**每个 key 必须 5 种语言齐全**
  （`zh-Hans` / `en` / `ko` / `es` / `vi`），非中文不得混入 CJK 字符。
  `src/i18n/i18n.test.ts` 会挡。
- 公共 schema / contracts / RLS 先于消费者部署；数据修复脚本要能只读预览 + 幂等重跑。
- 外部条件（生产配置、号码绑定、评价收费开关）阻塞时：记录阻塞和证据，继续不依赖它的工作，
  不重复询问常规实现细节。

---

## 2. 已完成，不要重做（batches #1–#6，全在 `main` 上）

| commit | 内容 | 明确**没做**、留给你的部分 |
|---|---|---|
| `34af622` | **U09** 入站短信按被叫号归属：`sql/0112` 新增 `gf_sms_line_owner()` SECURITY DEFINER 函数 + 重建 `sms_inbound` SELECT 策略 `inbound_select_own`；`apps/api/src/queries/smsInbound.ts` 同步 | 平台共享号 routingScope 细分（见 §3.7） |
| `9c9f345` | **U11 前半** 时长输入双字段 `durationText`/`durationMin` + `parseDuration`（1–600 整数）+ `seededRef`/`dirtyRef` 草稿不被 refetch 重置；**U03 主因** 新建默认日期从营业日 `currentDate` 改门店日历日（`resolveInitialDateTime` 纯函数）。文件 `apps/web/src/components/CreateAppointmentModal.tsx` + `stepper` 无关、`i18n/schedule.ts` 3 词条 + `CreateAppointmentModal.test.ts` | 跨午夜营业 day-offset（§3.6）；U11 后半生日选择器（§3.4） |
| `a19ab4f` | **U08** AI 电话新线默认不接：`sql/0113` 列默认 `true`→`false`；`handlers/phone.ts` upsert INSERT 兜底 `?? false` + ON CONFLICT 不再覆盖 `ai_answer` + 显式才 update；`telnyx/routes.ts` `?? false` fail-closed；drizzle schema 同步 | §4.2 五态 readiness DTO + 前端展示文案（§3.1 的一部分） |
| `f8fe718` | **U06 两处硬伤** `features/schedule/stepper.ts::deriveDrawerStage`：空工单不再因 `[].every()===true` 显示「已结束」、`cancelled`/`no_show` 不再回落 `initialStatus` 伪装「已预约」而画终态标签。`AppointmentDrawer.tsx` + 3 词条 + `stepper.test.ts` | §6.4 主体 allowedActions DTO（§3.5） |
| `ac8ec50` | **U07** 侧栏拆三组 + `/settings`/`/profile`/`/support` 进侧栏；**U04** Settings 分类筛选栏 `flex-wrap` 不裁切；**U05** `/reviews/sources` 加 `manualSyncEnabled` + 按钮禁用文案；**U02** `DirectorySettings.tsx` 去 sort 数字 + ▲▼ 排序；**U03** Calls 批准草稿日期改 `instantToWallDate` | U02 ID 契约（§3.2）、U04 批量/导入（§3.3）、U05 分状态文案+调查（§3.8）、U12 iPad（§3.9） |

小改动全部完成。**下面 §3 是剩余的全部工作。**

---

## 3. 剩余大工作包

按计划建议顺序：员工目录闭环 → 项目管理 → 开店向导 → 详情动作 → iPad → 套餐。
各包可在共享接口冻结后分开推进；避免多人同时改 `Settings.tsx` / `StepForms.tsx` /
`CreateAppointmentModal.tsx` / blueprint handler。

### 3.1 W1 — 开店向导重构 + 房间门禁 + 健康表首发 + AI 线路状态（U01 / U08 剩余）

**计划**：§2、§4。**优先级**：P1。

**入口**
- 向导：`apps/web/src/pages/SetupWizard.tsx`、`features/setup/flow.ts`、`features/setup/StepForms.tsx`
- 后端：`apps/api/src/handlers/setup.ts` 的 `FinishSetup`；契约 `packages/contracts/src/commands/setup.ts`
- 健康表：`apps/web/src/pages/HealthForms.tsx`、`features/forms/presets.ts`；`apps/api/src/handlers/kiosk.ts` 的 `SaveFormTemplate` / `ShareForm`（现要求 active+published+行业 key 匹配，否则 `no_active_form_templates`）
- 房间：现有房间 CRUD（`pages/Rooms.tsx` / 相关 handler）
- AI 线路：`packages/db/src/schema/phone.ts`、`handlers/phone.ts`、`telnyx/routes.ts`、`ops/bindAiLine.ts`

**根因 / 要做什么**
1. 向导目前只有 store / catalog / team / launch 四步，没有「字典前置」「房间」「功能设置」。
   按 §2 改成 7 个领域步骤：门店资料 → 员工基础设置（岗位/职级/技能，行业预设一键生成可编辑）
   → **房间（至少一间 active、容量正整数）** → 服务项目 → 员工与排班 → 功能设置（AI 电话 / 健康表默认关）
   → 检查并开店。iPad 上「第 N/7 步 + 名称 + 可打开步骤列表」，别把七个长标题挤一行。
2. **`FinishSetup` 服务端补检查**：当前门店有 active 房间且 `capacity>0`；并发停用房间与开店用锁 / 一致性策略。
   「至少一间房」是用户明确要求，不是可选。
3. **健康表首发**：把行业预设抽成前后端共享纯数据（复用 `features/forms/presets.ts` + contracts 行业 key）。
   新增 / 扩展功能配置命令：同一事务内检查现存已发布模板，没有才建默认版并置 enabled；模板首发用
   门店 / key 锁或唯一约束 + 幂等，重复开关 / 多终端只形成一个首次版本，**已有定制发布版优先复用绝不覆盖**。
   健康表编辑页显示「未启用 / 草稿 / 已发布」真实状态。关闭时预约 / 签到不因无模板失败。
4. **AI 电话分两个维度**（§4.2 五态表）：门店启用意愿 vs 平台线路准备状态。
   提供统一 readiness DTO，向导和 Calls 页读同一个；前端展示「AI 电话设置中，等待平台分配号码」等文案。
   号码分配只走现有平台 / 运营授权入口；分配不等于开启（batch #4 已把默认值和覆盖语义修对，
   **还差状态维度和文案**）。
5. **统一 setup readiness 返回**：missing code + 跳转目标。前端不再自己维护另一套开店判断。
6. 迁移先只读统计：新店缺配置、已有发布模板、现有开启线路、房间为零的营业中门店。
   新默认只用于新店；营业中但零房间的店显示修复提示，不改 status。

**验收**：全新门店 AI / 健康表默认关且跨设备一致；零房间不能开店、一间有效房间可通过；
启用健康表一次即生成有效表单且重试不重复版本；关闭时普通预约签到不受阻；
平台未分配电话可开店、分配后仍关闭、显式启用后才接听；其他 AI 权限不变。
对照 `T01`–`T07`（计划 §12）。

---

### 3.2 W2 — 员工目录 ID 契约 + 旧值迁移（U02 剩余）

**计划**：§5。**优先级**：P1。

**入口**
- `apps/web/src/features/staff/DirectorySettings.tsx`（batch #6 已去 sort 数字 + ▲▼）
- `apps/web/src/pages/EmployeePerformance.tsx`（岗位 / 职级 = `Input`+`datalist` 自由文本；
  技能匹配不到目录时保留原始输入，经 `skills` 字段提交 —— 见该文件 337–341 行、413 行）
- 契约 `packages/contracts/src/commands/setup.ts` 的 `staff.saveProfile`（同时接受
  `jobTitle`/`level`/`skills` 和 `levelId`/`skillIds` —— **兼容入口，不能只换前端控件就宣称强校验**）
- `packages/db/sql/0051_staff_directory_enhancements.sql`、`apps/api/src/handlers/staff.ts`、
  `handlers/setup.ts`、`queries/staff.ts`、`queries/staffList.ts`；测试 `apps/api/src/staffDirectory.test.ts`

**要做什么**
1. 定义统一 ID 选择契约：**岗位单选、职级单选、技能多选**。岗位若无 ID 字段，补齐模型 + DTO + 迁移
   （下一个迁移号 `0114`）。显示名只作展示，不作关联主键。
2. 新建 / 修改员工只能从**本店已有启用目录**选。列表为空给「先添加基础设置」入口；未选给字段提示；
   **后端不偷偷创建**。技能用可搜索列表 + 已选摘要 + 清除。
3. 后端校验 ID 同店、类型正确、可用于新关联；跨店 ID / 伪造 ID / 自由文本新值**拒绝**。
4. 停用项不再用于新员工；历史员工已关联项显示「已停用」。只改无关字段（如电话）保留原关联，
   不强制清空；不能给另一个员工新加停用项。
5. **旧值迁移**（只在迁移流程，不恢复运行时自由创建）：旧 `jobTitle`/`level`/`skills` 做只读盘点、
   规范化映射、人工冲突列表；匹配不到的历史值迁为本店历史目录项。
6. **所有 `staff.saveProfile` 调用方同步**：导入员工、Settings 员工编辑、向导员工添加、其他调用者，
   避免旧入口绕过限制。
7. 行业预设（§5.2 的小字典）：静态、版本化、可本地化，不调 AI，不涉执业资格 / 自动提成。
   切换行业不覆盖已有字典，只提供新增预览；重复生成按稳定 preset key 去重。
8. `DirectorySettings` 的 ▲▼ 排序目前是两条串行 `saveDirectoryOption`（batch #6）——
   如需并发安全，加服务端「批量稳定重排 + 版本冲突」端点。

**验收**：预设重复生成不重复；岗位不改系统权限；新建 / 修改员工无法保存任意自由值；
历史停用关联不丢；对照 `T08`–`T11`。

---

### 3.3 W2b — 员工中心信息密度（U13）

**计划**：§5.3 末三条 + §9.3。**优先级**：P2。

`EmployeePerformance.tsx`：两列员工卡片 + 铺开全部技能 / 可做不可做项目 / 收入。
改成默认**紧凑行 / 卡片**：姓名、状态、岗位、职级、可预约状态、技能数量、更多操作；
最多显示 2–3 个技能 + 「另 N 项」。全部技能 / 可做不可做 / 收入细节移到详情或明确展开区。
搜索 / 筛选仍覆盖全部技能（不能因折叠搜不到）。员工编辑分「个人信息 / 工作设置 / 技能」三区，
技能搜索区限高可滚动，底部保存按钮在 iPad 上不用滑完长标签列表就能点到。
**验收**：零 / 三 / 三十项技能与五十名员工场景页面不被标签撑满；`T12`。

---

### 3.4 W6a — 生日日期选择（U11 后半）

**计划**：§9.2。**优先级**：P1 / P2。

**入口**：`apps/web/src/pages/PublicHealthForm.tsx`（客户生日 + 通用日期题）、
`apps/ipad/src/pages/HealthFormPage.tsx`；再搜其他健康表渲染器与客户档案 DOB 输入。

**要做什么**：生日用可直接输入的年 / 月 / 日字段（推荐三个明确字段，年支持 4 位数字输入），
或支持年份直达的选择器，不要逐月点几十年。共用日期验证规则，`YYYY-MM-DD` date-only 存储，
不转 UTC timestamp，不用营业日 cutoff 判生日。支持 1940/1960/2000 直接输入、闰年 2/29、
切月后非法日提示（不静默把 2 月 31 日变 3 月）。不接受未来生日（比较基于门店日历今天，
未加载时不先用设备 / UTC 日期）。可选生日允许留空；已有生日正确回显；隐藏 DOB 字段不留不可见必填错误。
iPad Safari / 外接键盘 / 数字键盘 / VoiceOver 可用，字段关联 label，触摸目标 ≥ 44px。
**验收**：直接输入 `1965-03-12` 无需翻月；`2000-02-29` 成功、`1900-02-29` 拒绝；
留空与未来值处理正确；跨时区保存再打开日期不变；`T35`。

---

### 3.5 W3b — 详情动作与下一步（U06 剩余）

**计划**：§6.4。**优先级**：P1。batch #5 已修顶部进度显示，**这里是动作编排。**

**入口**：`components/AppointmentDrawer.tsx`、`features/schedule/appointmentDetail.ts`、
`apps/api/src/queries/appointmentDetail.ts`、`pages/Queue.tsx`、`pages/queue/model.ts`、
`pages/queue/modals/{CheckInModal,StartServiceModal,CompleteServiceModal,CheckoutModal}.tsx`。

**要做什么**：枚举真实 appointment / queue / ticket / item / payment 状态及看板动作权限，
整理**一张共享状态映射表**（不再加另一套字符串状态机）。后端 DTO 或共享纯函数返回
`allowedActions` + 不可执行原因；**详情与看板共用动作判断、命令和校验**。详情顶部分开显示
履约状态与付款状态，必要时「部分完成 N/M」。优先抽取看板动作编排组件 / hook 再接详情
（避免详情 import 整个 Queue 页产生循环依赖）。房间硬容量、技师技能 / 人数、健康表启用规则、
软冲突放行、原权限全部复用。成功后失效相关 query；失败保持原状态；重复点击 / 双终端竞态用幂等 + 并发控制。
动作目标表见计划 §6.4（已预约→签到 / 已签到→安排房间技师 / 服务中→完成选定项 / 全部完成→结账 /
已收款仍有服务→继续履约不重复收款 / 已结束→查看工单 / 取消爽约→精确状态不默认签到）。
**验收**：`T27`–`T29`。

---

### 3.6 W3c — 跨午夜营业与跨午夜日历格子（U03 剩余）

**计划**：§6.1–§6.2。batch #3 修了「全局新建用哪天」，**这里是跨午夜。**

`resolveInitialDateTime`（`CreateAppointmentModal.tsx`）对「营业到次日凌晨、此刻墙上 01:30
仍属今天营业」会因 `snapped(90) < openMin` 退到 openMin。需要处理 `closeMin > 1440` 的
day-offset 语义、日历格子传真实日期还是明确 offset（不把营业日直接当 `startsAt` 的日期）。
复现矩阵见 §6.2（门店 / 浏览器同异区、00:00–04:00、UTC 日期不同、跨午夜营业、DST、
页面跨午夜保持打开、切换门店、看过昨天后从全局新建）。修复后核对网络提交 `startsAt`、DB 值、
列表显示三者。**验收**：`T13`–`T17`。可扩展 `e2e/specs/business-day.spec.ts`。

---

### 3.7 W0b — 平台共享号短信 routingScope（U09 剩余）

**计划**：§3.3。batch #1 修了**专属线**隔离，**这里是平台共享号。**

需要给 `sms_inbound` **加归属证据列**：`routing_scope`（store / platform / unresolved）、
`bound_line_id`、解析出的 `resolved_org` / `resolved_location`、归属证据。webhook 验签后先规范 E.164
再解析 To、**落库即定归属**（不查询时连「当前号码归属」使新店读到旧店内容）。
所有读路径（入站列表、会话详情、未读数、沟通日志、通知、搜索 / 导出、实时订阅、平台测试收件箱）
共用规则；provider 消息 ID 唯一去重；API 和 RLS 都要求明确 org + location 归属。
无法唯一归属的共享号回复：按用户降级许可**不显示在店铺端**。旧记录只在有可靠证据时回填。
当前已确认 `sms_inbound` 只有 `loadInboundSms` 一条服务端读路径（Messages / CommunicationLogs 都走它），
无实时订阅。**验收**：`T31`–`T34`（`T31` batch #1 已过，`T32`–`T34` 待做）。

---

### 3.8 W5 — Google review 同步分状态 + 调查（U05 剩余）

**计划**：§8。batch #6 加了 `manualSyncEnabled` 开关，**这里是分状态文案 + 根因调查。**

**入口**：`apps/api/src/routes/reviews.ts`（`POST /v1/desk/reviews/sync` 仍有两种本地
`PERMISSION_DENIED`：缺 `settings.manage` / `manualSyncEnabled()` 为 false）、
`apps/api/src/reviews/{config,sync,stats,analyze}.ts`、`packages/contracts/src/commands/reviews.ts`
（内部 reviews 命令要求 `report.view`，`bus.ts` 即使 `systemOrigin` 也检查权限）、
`features/reviews/ReviewSourcesPanel.tsx` / `api.ts` / `types.ts`、`apps/api/src/queries/reviews.ts`。

**要做什么**：**先别改 Google 账号 / 加管理员权限。** 在授权测试环境记录 HTTP 状态、error code、
`details.reason/need/command`、request ID。判别：应用角色缺权限 / 平台手动开关关闭 /
服务内部权限不一致 / Google·Bright Data 外部拒绝 / 缺数据集·Place ID / 运行中或冷却。
配置读接口返回结构化 `disabledReason`；前端分情况显示（平台关闭→「手动同步暂未开放」已做；
缺权限→需要的角色能力；外部未就绪→「评价数据源待配置」）—— **不能所有情况只显示 PERMISSION_DENIED**。
保留 `settings.manage` 入口权限不删鉴权；不给客户端开放 `system:true` 命令。
核对 `REVIEW_SYNC_MANUAL_ENABLED` 等实际环境开关（运行环境关闭不一定要改代码权限，
列为待运营操作，不擅自打开生产收费采集）。长任务 running 时刷新状态，不在超时后显示「同步完成」；
数据源失败不伪装成「没有新评价」。Google 评分刷新与评价正文抓取 / AI 总结分别显示结果。
**验收**：七类状态可区分（有权限+关闭 / 无权限+开启 / 缺配置 / 供应商拒绝 / 已有运行 /
成功有新数据 / 成功无新数据），UI 与 API 一致，测试用 provider stub，不花钱同步；`T25`–`T26`。

---

### 3.9 W4 — 服务导入 / 技师人数 / 网约 / 批量编辑（U04 剩余）

**计划**：§7。**优先级**：P1/P2。batch #6 只修了分类栏溢出。

**入口**
- `apps/api/src/handlers/blueprint.ts`（服务发布 SQL **写死 `online_bookable = false`**）
- 契约 `packages/contracts/src/commands/setup.ts` 的 `SaveService`（已有 `onlineBookable`、
  `staffCount`(1–5)、`requiredSkillIds` —— **不要再发明另一套「人数」字段**）
- `features/setup/StepForms.tsx`（手工新项目只传名称 / 价格 / 时长 / active）
- `pages/Settings.tsx`（在线预约、技能 / 人数编辑；服务列表）
- `components/ui/Tabs.tsx` 的 `ListContainer`（真实 tab 裁切需实测，不能只凭源码断言）

**要做什么**
1. 普通服务新建 / AI 照片导入预览**默认「支持网上预约」**；店主发布前可关，最终尊重显式选择。
   add-on 不能单独预约、默认不进独立网约目录；套餐线上资格按 U10 计划；次卡不因默认值变可预约。
   新默认只作用于新建流程，不打开所有现有 offline 项目。审查 `SaveService` 的 `default(false)`
   在编辑省略时是否覆写旧值 —— **更新要保留未传字段**。
2. 预览每项可改**同时技师人数**（默认 1），支持批量设 1/2 并单项覆盖。命名「同一项目同时需要几位技师」，
   别和「员工可同时接几位客人」混淆。补齐 blueprint schema / 草稿契约 / 编辑保存 / 发布 / 读取 DTO
   的字段传递；AI 无可靠依据不猜双技师，交店主确认；发布不静默丢字段。
3. 开店项目步骤选已有技能（依赖 W2），服务端存稳定 ID；无所需技能是「无技能限制」不是「缺数据」。
4. 服务管理与价目导入视图边界：顶层 tab 控制工作区，分类是过滤器。窄屏分类改可搜索下拉，
   宽屏单行横向滚动（`min-w-0/max-w-full/overflow-x-auto`，按钮 `shrink-0`，外层不裁滚动区）。
   `shared Tabs` 改动要回归其他调用页。
5. **批量编辑**：服务列表加复选框、当前筛选结果全选、清空、选择数量（分页时明确「本页」vs
   「全部筛选结果」）。批量操作：加 / 移除 / 替换所需技能（替换明确覆盖预览）、设网约开关、
   设同时技师人数、分类迁移。底部操作条，提交前展示数量 / 变更字段 / 异常项 / 覆盖影响。
6. **新建批量 PATCH 命令**：字段不传=不改，`false`/`[]` 有明确语义。单请求条数上限，
   服务端逐项校验本店 ID / 类型 / 版本 / 技能 / 人数约束。默认单批事务全成全败；
   若产品要部分成功，返回逐项结果 + 可重试集合，**不用前端 `Promise.all` 循环冒充事务**。
   预览后他人改了服务时拒绝旧版本覆盖或显式合并。审计记录操作人 / 受影响 ID / 字段，幂等重试不重复；
   公开目录 / AI / 预约可用性缓存刷新。
7. `onlineBookable=true` 只表示项目支持；门店整体线上渠道、营业时间、足够合格技师和资源仍独立校验。

**验收**：`T20`–`T24`。与套餐 P1/P2 接口协调（见 §3.10 表）。

---

### 3.10 W7 — 组合套餐（U10）

独立主项目，唯一详细规格：`docs/plans/2026-09-07-service-bundles-implementation.md`（P0–P8 / B01–B32）。
**不要把「plans 文件已存在」当成 U10 已完成。** 与本轮改动的共享契约必须先协调：

| 共享处 | 本轮要求 | 套餐计划需遵守 |
|---|---|---|
| 导入草稿 / 发布 | 新项网约默认、`staffCount`、技能 ID | bundle/package/addon 分流后仍保留这些字段 |
| 项目目录 / 批量操作 | 普通服务选择、字段 PATCH、不支持类型提示 | 套餐模板与执行子项分开；不给父分组设执行技师 |
| 预约时间 / 时长 | 明确日期来源、字符串草稿、避免 refetch 重置 | 套餐子项继承同一规则 |
| 详情状态 / 动作 | 共用看板状态与项目级动作 | 套餐按有效子项进度，不提前完成 / 重收款 |
| 健康表 | 启用时已有发布模板、关闭不阻塞 | 按实际子项目归并需求 |
| 员工技能 / 人数 | 稳定 ID 和同店约束 | 每个子项分别检验 |
| iPad | 列表 / 抽屉 / 选择器可触摸 | 套餐展开 / 加项 / 结账平板闭环 |

---

### 3.11 W6b — 全端 iPad 适配（U12）

**计划**：§9.3–§9.4。**优先级**：P1（核心操作）/ P2（其余）。**工作量最大。**

「适配 iPad」首先是 **`apps/web` 前台在 iPad Safari 上操作**，同时覆盖 `apps/ipad` 顾客自助、
`apps/booking`、公开健康表；`apps/platform` / `apps/marketing` 做页面级平板扫屏；`apps/ios` 是空壳不算。
视口以 CSS 像素：768×1024、820×1180、1024×768、1180×820、1024×1366，另测约 600px 分屏、390px 手机回归。

布局规则（§9.3）：全局内容区不出现无意义横向溢出（宽表 / 时间轴在明确标示的局部容器横滚）；
侧栏按可用空间折叠；`flex`/`grid` 检查 `min-w-0`/`min-h-0`/`shrink`；主列竖屏堆叠、工具条换行；
Modal/Drawer 用动态可视高度 + 内部滚动（保存 / 取消在软键盘弹出时可达，不用 `body overflow-hidden`）；
固定底栏考虑 safe-area；所有 hover 菜单提供点击入口；拖拽排班 / 排序要有点击 / 上移下移替代；
输入字号 ≥ 16px（避免聚焦缩放）；交互目标 ≥ 44px；加载 / 空态 / 错误 / 无权限 / 真实大量数据都测。

逐页清单见计划 §9.4（Setup 七步、Dashboard、Schedule、Queue 全部弹窗、AppointmentDrawer、
Checkout、Tickets、Customers、Rooms、Rotation、EmployeePerformance、Payouts、BusinessData、DayClose、
Calls、Messages、CommunicationLogs、Notifications、Settings 所有 tab、HealthForms、Profile、Support、
StorefrontBuilder、`/tech`、`apps/ipad`、`apps/booking`、`apps/platform`、`apps/marketing`）。
**至少在真实 iPad Safari 走一遍**；Playwright WebKit + 触摸模拟作补充，不能称真机已验收。
中英全流程 + 西 / 韩长文案扫屏。**验收**：`T36`–`T39`。

---

## 4. 交付规范

- 每个工作包提交可单独审查的 commit（或几个），message 说清改了什么、没做什么、验收对照。
- **在 `docs/plans/2026-09-07-store-setup-operations-bugfix-report.md` 追加「批次 #N」小节**：
  改动范围、根因、逐文件说明、验证命令与结果、计划验收对照、明确未覆盖、回退方式。
- 公共 schema / contracts / RLS 的 commit 先于消费者。
- 迁移文件写成全文可重复执行（`create or replace` / `drop ... if exists`）；
  数据修复脚本支持只读预览 + 幂等重跑。
- 完整 `pnpm test` / E2E 用手册规定的 isolated 库（`DATABASE_TEST_TARGET=isolated`、
  `TEST_DATABASE_URL`、`TEST_MIGRATION_DATABASE_URL`），E2E 加 `GF_QA_ALLOW_RESET=1 NODE_ENV=test`。
  **不要在 dev / 生产库跑 reset。**
- 没有真机 / 外部凭据的项写「未验证」，不把跳过当通过。
- 生产外部配置、号码绑定、评价收费开关、真机验收分列操作单，按接手授权决定执行；本文不是生产操作授权。

## 5. 回归验收矩阵

计划 §12 的 `T01`–`T40`（+ 套餐 `B01`–`B32`）。已通过：`T31` 部分（batch #1）、
时长 / 日期 / 详情进度相关的纯函数断言（batches #2/#3/#5）。其余为「未执行」，
执行者在报告里记录测试名、结果、证据、缺口，**不在计划里提前勾**。
