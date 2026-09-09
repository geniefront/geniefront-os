# 开店、预约、员工、沟通与 iPad：13 项问题实施报告

配套计划：`docs/plans/2026-09-07-store-setup-operations-bugfix-plan.md`
代码基线：`580ee91`（与计划一致）
本报告随实施推进逐条追加。每次只推进一个可单独审查的修复，做完就在此交接。

---

## 进度总览

| 用户项 | 工作包 | 状态 | 交接批次 |
|---|---|---|---|
| U09 平台短信串店 | W0 / W0b | **完成**：专属线归属隔离（#1）+ 平台共享号 routingScope 落库、换绑冻结、重放去重（#12，`sql/0115`）。剩：平台运营只读收件箱（`platform`/`unresolved` 行现对所有租户不可见） | #1 #12 |
| U01/U08 默认设置、健康表首发、房间门禁、AI 线路 | W1 | **部分完成**：AI 电话新线默认不接（U08，#4）已修；健康表首发、房间门禁、setup readiness DTO 未开始 | #4 |
| U02/U13 员工目录与员工中心 | W2 / W2b | **U02 主体 + U13 完成**：岗位 / 职级 / 技能改 ID 契约，服务端不再据自由文本新建目录项、跨店 / 伪造 / 未知值拒绝、停用项只对已关联者保留；`sql/0114` 补 `job_title_id` + 回填 + 只读盘点视图；新增 `staff.reorderDirectoryOptions` 原子重排（#7）。员工中心改默认紧凑卡片 + 单卡展开明细，编辑弹窗技能区可搜索 + 限高滚动（#8）。剩：行业预设生成（属 W1）、`user.updateProfile` 自助技能自由文本、真机 iPad 扫屏（W6b） | #6 #7 #8 |
| U03/U06/U11 预约日期、时长、详情状态 | W3 | **U06 + U11 前半完成**：时长输入（#2）、新建默认日期不取营业日（#3）、详情顶部进度不误报（#5）；详情复用看板 `queueNextAction`/`paymentStageFor` 显示当前状态 + 履约/付款分列 + 部分完成 N/M + 下一步深链（#11）；U03 跨午夜 day-offset（#13，`resolveInitialDateTime` 尾段 + `wallSlotTarget`）。剩：看板动作编排 hook 完整抽取 | #2 #3 #5 #11 #13 |
| U04 服务导入、技师人数、网约、批量编辑 | W4 | **完成**：导入 / 新建普通项默认网约、加项强制不网约（#9）；`SaveService` PATCH 语义；`catalog.bulkUpdateServices` + Settings 多选批量条（#6 #9）；draft 级人数编辑（#16，`sql/0116`）；分类栏窄屏下拉（#15）；批量编辑乐观锁（#18，`sql/0117` + `expectedVersions` + `stale_services`） | #6 #9 #15 #16 #18 |
| U05 Google review 同步权限 | W5 | **小修**：配置读接口带 `manualSyncEnabled`，未开放时按钮禁用+提示，不再显示成权限不足（#6）；分状态文案与调查未做 | #6 |
| U07/U11/U12 导航、生日选择、全端 iPad | W6 | **U07 + U11 完成**：侧栏三分组 + 账号入口进侧栏（#6）；生日改「年直输 + 月日下拉」，`@gf/contracts.parseBirthdate` 共用校验（闰年 / 非法日 / 未来日 / date-only），接入公开健康表 / iPad 自助 / 客户档案（#10）。U12 全端 iPad 未做 | #6 #10 |
| U10 组合套餐 | W7 | 未开始（独立主项目） | — |

---

## 批次 #1 — W0：入站短信按被叫号码归属（U09 的第一刀）

**日期**：2026-09-07
**改动范围**：1 个新迁移 + 1 个查询文件 + 2 个集成测试。未碰前端、未碰 webhook 写入路径、未加数据列、未回填历史数据。

### 这一刀解决了什么

计划 §3.1 说「代码能够证明『同号客户跨店共享正文』的路径存在」。`sql/0079`
把 `sms_inbound` 的 SELECT 收成「发件号码是本店客户」，并**明确认下一个代价**：
同一手机号在 A、B 两店都登记成客户时，两店都能读到他发来的短信正文。

这个代价对**平台共享发送号**是不得已（那条短信确实不属于任何一家店），
但对**门店自己的号**站不住：`phone_lines` 里 `purpose in ('ai_voice','sms')`
的号码是全局唯一的（`sql/0025` 的 `phone_lines_e164_routable_key`），
webhook 正是拿被叫号码反查门店。短信发到这种号上，归属是确定的。

### 改了什么

**1. `packages/db/sql/0112_sms_inbound_route_by_recipient.sql`（新）**

- 新增 `gf_sms_line_owner(p_to_e164 text) → (org_id, location_id)`：
  一个极窄的 `SECURITY DEFINER` 只读函数，跨 org 反查「这个被叫号是不是
  某家店的 `ai_voice` / `sms` 专属线」。只对 `app_user` 开放，`revoke ... from
  public, anon, authenticated`，`set search_path = public`。套路同 `sql/0088`
  的 `gf_appointments_due_for_reminder`。
  - **不按 `active` 过滤**：让停用线的历史短信仍锁在原 (org, location)，
    是「号码转让后历史归属冻结」这个方向上不加列能做到的最小缓解。
- 用它重建 `sms_inbound` 的 SELECT 策略 `inbound_select_own`（替换
  `inbound_select_own_customers`）：
  - `to_e164` 命中本店专属线 → 只有 `org_id = app_org_id() AND
    location_id = app_location_id()` 的那家店可读（org **且** location）；
  - `to_e164` 是平台共享号（`gf_sms_line_owner` 返回空）→ 回落到 `sql/0079`
    口径「发件号码是本店客户」。
- INSERT 策略 `inbound_insert_platform`（`sql/0079`）**未改动**：入站 webhook
  到达时没有租户上下文，照旧 `with check (true)`。

**2. `apps/api/src/queries/smsInbound.ts`**

`loadInboundSms` 按同一套规则重写（纵深防御第二道，RLS 已经保证一次）：

- 先取本店 `phone_lines` 里 `ai_voice` / `sms` 的号 → 发到这些号的短信一律纳入，
  **包括还没建档的新客咨询**（计划 §3.2 规则 1 明确要求）；
- 平台共享号的回落分支保留原来的「发件人是本店客户且在本店有过预约」，
  并加 `not exists (gf_sms_line_owner(to_e164))` 排除掉发给别家专属线的行；
- 空集短路：两条来源都空才 return。

后续 `customers` / `upcoming` 的推导逻辑未动——发给本店号的未知号码，
两者自然为空数组，前台看到一条「陌生号 + 原文」，符合预期。

**3. `apps/api/src/sms.test.ts`**

- 新增 `deskCtx(loc)` 辅助 + `SPA_ORG` / `SPA_LOC` 常量。
- 新增用例「发到本店专属线的短信只有本店可读」：同一手机号在 NAIL / SPA
  都是客户，给 NAIL 的 `ai_voice` 号发一条 → NAIL 的 `loadInboundSms` 能读到，
  SPA 的读不到（查询层），SPA 直接 `select ... from sms_inbound` 也是 0 行（RLS）。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移应用（本机 55322 隔离库） | `MIGRATION_DATABASE_URL=<local> pnpm db:migrate` | `0112 ... OK`；`✓ RLS 覆盖检查通过` |
| 短信套件 | `pnpm --filter @gf/api exec vitest run src/sms.test.ts` | 35 passed（含 2 个新增） |
| 相邻套件 | `vitest run src/sms_direct.test.ts src/telnyx` | 24 passed |
| 守卫 | `pnpm lint:guards` | ✓ 全部通过 |
| 类型 | `pnpm --filter @gf/api exec tsc --noEmit` | 通过 |

未运行：完整 `pnpm test` / E2E（本批不涉及浏览器路径；按计划 §12 由集成
阶段统一跑）。未在 staging/生产执行迁移。

### 计划 §3 验收对照

| 计划 §3.4 验收点 | 本批状态 |
|---|---|
| 同号在 A/B 建客户，给 A 独立号发消息，仅 A 能读 | ✅ 已覆盖（新测试 + RLS 直查断言） |
| 同 org 的 A1/A2 两店隔离 | ⚠️ **未做**：回落分支仍按 `org_id` 判定，同 org 两店共享 `customers`。需要 routingScope 证据列后再收 |
| 客户没有预约仍能给店铺号发咨询并被正确店看到 | ✅ 对**专属线**成立（不再要求 `exists(appointments)`）；对平台共享号仍要求有预约 |
| 向平台号发 START，所有门店正文列表/计数/日志都不出现 | ✅ 未变差：`STOP`/`START` 发件人若不是任何店的客户，本就不显示；`sms_consent` 平台级处理未动。**但**「同号客户 + 平台号」的 START 仍会落进那家店列表——属下条 routingScope 范围 |
| 平台号回复无法唯一归属时各店不可见 | ❌ **未做**：平台共享号回复仍走「发件人是本店客户」，未实现 unresolved 降级隐藏 |
| A 店猜 B 消息 ID / 受限角色 / 实时监听均拿不到 B 正文 | ✅ 对专属线成立（RLS 用 `SECURITY DEFINER` 函数，跨 org 判定）；实时订阅见下「未覆盖」 |
| webhook 重试、未知号码、换绑、历史回填不串店 | 🔸 部分：`provider_id` 去重是 `sql/0034` 既有；换绑/历史回填**未做**（见未覆盖） |

### 明确未覆盖 / 交接给下一位

1. **平台共享号的细分（routingScope）** — 计划 §3.3 的核心。需要给 `sms_inbound`
   加归属列（`routing_scope` store/platform/unresolved、`bound_line_id`、
   解析出的 `resolved_org` / `resolved_location`、归属证据），webhook 验签后
   规范 E.164 再解析 To、落库即定归属。本批**没有加任何列**。做完之前：
   - 同 org 两店在共享号上仍不隔离；
   - 「回复平台号但无可靠归属」仍按旧口径显示给「有该客户的店」，
     未实现降级隐藏。
2. **号码转让 / 重新分配** — 现在 `phone_lines` 换绑是就地 `UPDATE`，
   `gf_sms_line_owner` 会让历史短信跟着新归属走。`不按 active 过滤` 只挡住
   「停用」不挡「换绑」。完整方案要在收信那一刻把 `line_id` / 归属写进
   `sms_inbound` 行（见第 1 点的列）。
3. **实时订阅 / broadcast** — 已确认 `sms_inbound` 目前**没有**实时订阅或
   搜索/导出消费者（`grep` 全仓只有 `loadInboundSms` 一条服务端读路径，
   Messages / CommunicationLogs 两个页面都走它）。若之后新增实时通道，
   必须套用 `inbound_select_own` 同款判定，不能另写 `using (true)`。
4. **派生通知 / 未读计数** — 未读数 (`needsAttention`) 由 `loadInboundSms`
   现场算，已随本批收窄。没有独立的通知写入路径引用 `sms_inbound`。
5. **E.164 规范化** — `recordInboundSms` 直接存 `str(payload['to'])` 原值，
   `gf_sms_line_owner` 用字符串精确相等匹配 `phone_lines.e164`（与 `sql/0015`
   的 `phone_line_lookup` 策略同款）。Telnyx 目前发的是带 `+` 的 E.164，
   一致；若上游格式漂移需要在写入侧规范化。
6. **历史数据只读盘点** — 计划 §13.1 要求的「proposed mapping」未产出。
   本批是纯策略/查询收窄，对既有 `sms_inbound` 行的效果是：发到某店专属线的
   历史行现在起只有该店可读（收窄，安全方向）；发到平台号的行行为不变。

### 回退

`drop policy inbound_select_own on sms_inbound;` 再重建 `sql/0079` 的
`inbound_select_own_customers`，并 `drop function gf_sms_line_owner(text)`；
查询文件 `git revert`。不涉及数据变更，可安全回退。回退会**重新打开**
专属线上的同号跨店可见——按计划 §13.1 第 6 条，这是明确不希望的方向，
回退仅用于该策略本身出现回归时的止血。

---

## 批次 #2 — W3：预约项时长输入 + 草稿不被 refetch 重置（U11 前半 / §6.3，含 §6.2 的一条）

**日期**：2026-09-07
**改动范围**：`apps/web/src/components/CreateAppointmentModal.tsx` 一个文件 + 3 条 i18n 词条。纯前端，无契约 / DB 改动。

### 这一刀解决了什么

计划 §6.3 已确认的根因：时长输入 `onChange` 用 `parseInt(e.target.value) || 30`。
清空立即变 30、输入 0 变 30、`"60abc"` 静默截成 60；再叠加初始化 effect
在 `services`/`staff` 每次后台 refetch 时重跑（依赖数组里有这两个新引用），
就表现为「打不进去 / 数字跳回去」。

### 改了什么（都在 `CreateAppointmentModal.tsx`）

**1. 时长改成「字符串草稿 + 已确认值」双字段**

- `AppointmentItemDraft` 新增 `durationText: string`（正在编辑的原文），
  保留 `durationMin: number`（已确认的合法整数，预约起止 / 价格预览 / 提交都读它）。
- 新增模块级 `parseDuration(text)`：`trim` → 空判 `empty` → `/^\d{1,4}$/`
  不过判 `format` → 越界判 `range`（`1–600`，对齐
  `packages/contracts/src/commands/appointment.ts` 的
  `z.number().int().positive().max(600)`；目录 SaveService 的 5 分钟下限是
  目录侧约束，不套到预约 override —— 计划 §6.3 明确「不擅自增加必须为 5 的倍数」）。
- 输入框 `type="number"` → `type="text" inputMode="numeric" pattern="[0-9]*"`
  （iPad 数字键盘，且不再受 `type=number` 的本地化 / 空值怪癖影响），
  `value={item.durationText}`，`onChange` 只透传原文、**不做任何回填**。
- `onBlur`（`handleDurationBlur`）：合法则规范化（`" 090 "` → `"90"`）并提交
  `durationMin`；非法则原样留着，让行内红字错误显示。
- 切换服务时，目录默认时长同时写入 `durationMin` 和 `durationText`；之后
  店主手改的值不被目录刷新 / 技师变动冲掉（§6.3 第 3 条）。
- 提交（`handleSubmit` 与 `handleInitialSubmit`）前逐项 `parseDuration`，
  有非法项就 toast 具体原因并中止 —— 不把空值当 30 分钟提交、不把 `"60abc"`
  截成 60（§6.3 第 4 条）。
- 依赖时长的预览（`summary` / `activeAlignMode` / 顺次接力 / `itemEnd`）仍只读
  `durationMin`（永远合法），编辑非法期间显示的是上一个合法值而非 NaN（§6.3 第 5 条）。

**2. 草稿生命周期：一次「打开」只播种一次**

- 新增 `seededRef` / `dirtyRef`（`React.useRef`）。初始化 effect 改为：
  `!isOpen` → 清两个标记并 return；`seededRef && dirtyRef` → 直接 return
  （用户动过草稿，后台 refetch / 切日期都不再重置）；否则（重新）播种。
- `markDirty()` 挂在所有用户改动入口：`handleAddItem` / `handleRemoveItem` /
  `handleUpdateItem` / 两个一键编排 / 姓名 / 电话 / 日期 / 备注 的 `onChange`。
- 未编辑时 refetch 仍会重新播种（让首屏默认值跟上刚加载好的 services），
  一旦编辑就锁定。关闭再打开 → 重新播种。

**3. i18n**（`apps/web/src/i18n/schedule.ts`，5 语言齐全）

`schedule.apptDurationRequired` / `apptDurationRange` / `apptDurationInvalid`。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter @gf/web exec tsc --noEmit` | exit 0 |
| 多语言完整性 | `vitest run src/i18n` | 7 passed（含「每词条全语言非空」「非中文无 CJK」） |
| Web 全量单测 | `pnpm --filter @gf/web test` | 57 files / 307 passed |
| 守卫 | `pnpm lint:guards` | ✓ 全部通过 |

**未做**：浏览器 / 真机交互验证。需要 api-local + web dev + 登录 + 进 Schedule
开弹窗，成本与本批不成比例；计划 §12 / H 阶段本就把浏览器与 iPad 回归单列。
下面给出可手动跑的验收步骤。

### 计划 §6.3「输入验收」对照（待人工在浏览器确认）

| 场景 | 预期 | 代码层面已保证 |
|---|---|---|
| 清空后输入 90 | 不回填 30，提交 90 | ✅ `onChange` 不回填；`""` 显示 required 错误直到输入 |
| 选中替换 120 | 提交 120 | ✅ |
| 逐位退格 | 中途可为空 / 单字符，不跳回 | ✅ |
| 粘贴 45 | 提交 45 | ✅ |
| 输入非法值（`60abc` / `-5` / `4.5`） | 行内错误 + 阻止提交 | ✅ `/^\d{1,4}$/` |
| iPad 数字键盘 | 弹数字键盘 | ✅ `inputMode="numeric"`（需真机确认） |
| 弹窗打开期间 refetch | 不跳回默认 | ✅ `dirtyRef` 守卫（需浏览器确认 refetch 时机） |
| 提交值和预约起止一致 | `durationMin === parseDuration(durationText).value` 不变量 | ✅（合法时二者恒等） |

### 明确未覆盖 / 交接给下一位

1. **U03 日期语义（§6.1 / §6.2）完全没动** —— 这是 W3 里更重的一半：
   营业日 vs 日历日、`getHours()` 取浏览器钟点、跨午夜格子的 day offset、
   DST、复现矩阵（§6.2 列了 7 个维度）。`dirtyRef` 守卫顺带保护了 `date`
   字段不被 refetch 重置，但**没有**改「全局新建预约用哪个日期」的语义。
2. **U06 详情状态与下一步（§6.4）没动**。
3. **`parseDuration` 与目录侧 SaveService（5–600）的口径差异**：本批按预约
   override 契约取 `1–600`。若产品要统一成 5–600 或「5 的倍数」，需先明确
   语义再改（§6.3 第 2 条），两处目前有意不一致。
4. **没有为该组件加单测**：仓库里 `CreateAppointmentModal` 无既有测试文件。
   建议后续补一个纯函数测试覆盖 `parseDuration` 的边界（空 / `"0"` / `"600"` /
   `"601"` / `"60abc"` / `" 090 "` / `"4.5"`）。

### 回退

单文件 `git checkout apps/web/src/components/CreateAppointmentModal.tsx` +
移除 `schedule.ts` 里的 3 条词条即可。无数据 / 契约影响。

---

## 批次 #3 — W3：新建预约默认日期不再取营业日（U03「预约偶尔变昨天」/ §6.1）

**日期**：2026-09-07
**改动范围**：`apps/web/src/components/CreateAppointmentModal.tsx` + 新增 `CreateAppointmentModal.test.ts`。纯前端，无契约 / DB 改动。

### 这一刀解决了什么

计划 §6.1 的核心线索，本批锁定为确切根因：

- `CreateAppointmentModal` 的初始化用 `setDate(defaultDate || currentDate)`。
  `currentDate` 来自 `ScheduleContext`，是 **`useBusinessDay().today`（营业日）**。
  营业日在 `business_day_cutoff`（多数店 03:00–04:00）前 = **昨天的日历日**。
- 无 `defaultDate` 的入口（`Layout` 全局「新建预约」按钮、`Queue` 空态按钮、
  `Calls` 详情「带号码新建」）因此在打烊后到 cutoff 之间，把「现在」的预约
  默认排到**昨天**。
- 且无 `defaultTime` 时用 `new Date().getHours()` —— 浏览器钟点，不是门店墙上
  钟点；出差中的老板浏览器时区与门店不一致时也会偏。

调用点清单（§6.2 第 1 项）：

| 调用点 | defaultDate | defaultTime | 本批是否受影响 |
|---|---|---|---|
| `Layout.tsx` 全局「新建预约」 | 无 | 无 | ✅ 修正（日历日 + 门店墙上钟点） |
| `Queue.tsx:2291` 空态按钮 | 无 | 无 | ✅ 修正 |
| `Calls.tsx:764` 详情带号码 | 无 | 无 | ✅ 修正 |
| `Schedule.tsx:348` 日历页顶部新建 | `targetDate \|\| currentDate` | 无 | 日期按其明确传值（用户正看哪天就用哪天，§6.1）；时间改由 helper 处理 |
| `Schedule.tsx:357` 点击日历格子 | `date \|\| currentDate` | `timeString` | 日期、时间都显式传入，不变 |
| `Calls.tsx:204` 批准通话草稿 | `new Date(iso).toISOString().split('T')[0]` | 无 | ⚠️ **未修**：这是 UTC 日期，不是门店墙上日期，见「未覆盖」 |

### 改了什么（都在 `CreateAppointmentModal.tsx`）

**1. 新增纯函数 `resolveInitialDateTime()`**（已 `export`，便于单测）

入参：`defaultDate?` / `defaultTime?` / `calendarToday`（门店日历日，调用方算好）/
`nowWallMinutes`（门店墙上钟点分钟数）/ `openMin` / `closeMin`。规则：

- 有 `defaultDate` → 用它；否则用 `calendarToday`（**日历日**，不是营业日）。
- 有 `defaultTime` → 用它。
- 目标日期 = 今天 → `nowWallMinutes` 按 30 分钟向上取整，落在
  `[openMin, closeMin-30)` 内才用，否则退到 `openMin`。
- 目标日期 ≠ 今天（未来日 / 历史补录）→ 一律 `openMin`，不把「现在」的钟点
  套到别的日期上（§6.1 最后一行）。

**2. 初始化 effect**：时区换算（不纯的部分）留在 effect —— 
`instantToWallDate(now, timezone)` 得 `calendarToday`、`nowWallHhMm(timezone)`
得门店墙上钟点 —— 再调 `resolveInitialDateTime`。`timezone` 加进 effect 依赖。
`timezone` 尚未就绪时退回旧行为（`currentDate` + 浏览器钟点），且因 `dirtyRef`
未置位会在 timezone 到位后重新播种。

**3. `CreateAppointmentModal.test.ts`（新）** —— 11 个纯函数断言：
`resolveInitialDateTime` 的 7 种入口场景 + `parseDuration`（批次 #2 遗留的
测试缺口，一并补上）的边界（空 / `"0"` / `"600"` / `"601"` / `"60abc"` /
`"4.5"` / `" 090 "` / `"1e3"`）。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter @gf/web exec tsc --noEmit` | exit 0 |
| 新单测 | `vitest run src/components/CreateAppointmentModal.test.ts` | 11 passed |
| Web 全量单测 | `pnpm --filter @gf/web test` | 58 files / 318 passed |
| 守卫 | `pnpm lint:guards` | ✓ |

**未做**：浏览器 / 真机验证（需登录整套栈；计划 §12 / H 阶段单列）。
`e2e/specs/business-day.spec.ts` 已存在，建议在 H 阶段补一条「cutoff 前从全局
入口新建 → 日期是日历日今天」的用例。

### 计划 §6.1 入口语义对照

| 入口 | 计划要求 | 本批状态 |
|---|---|---|
| 点击日历格子 | 格子的真实门店日期与钟点 | ✅ 不变（显式传入） |
| 日历页顶部新建 | 当前选中日期，不偷偷改今天 | ✅ 保留 Schedule 传的日期；时间走 helper |
| Dashboard / 全局新建 | 门店当前**日历**日期与门店当前时间，按步长取整 | ✅ 修正 |
| 历史补录 | 用户明确选择的过去日期 | ✅ helper 对过去日期用 openMin，保留既有补录确认流程 |
| 未来日期 | 用当天营业时间，不套浏览器今天的钟点 | ✅ 修正 |

### 明确未覆盖 / 交接给下一位

1. **`Calls.tsx:204`（批准通话草稿 → 新建预约）仍用 `new Date(iso).toISOString().split('T')[0]`** ——
   即槽位时刻的 **UTC 日期**。LA 晚 8 点的槽位会算成 UTC 次日。修法：拿门店
   时区（`useStoreTime().timeZone` 或 session context）走 `instantToWallDate`。
   本批没碰是因为它需要给 `Calls.tsx` 引入时区依赖，超出「一处默认值」的范围。
2. **跨午夜营业的门店 / 跨午夜日历格子**（§6.2 第 4 项）没处理：
   `resolveInitialDateTime` 对「营业到次日凌晨、此刻墙上 01:30 仍属今天营业」
   的情形，会因 `snapped(90) < openMin` 退到 openMin，而不是排在 01:30。
   `closeMin > 1440` 的 day-offset 语义、格子传真实日期还是 offset，仍待做。
3. **DST 边界**：`resolveInitialDateTime` 只做分钟算术，真正的时刻构造在提交时
   由 `wallMinutesToInstant`（二分逼近，已覆盖 DST）完成，本批未改这条路径。
4. **换店时的草稿隔离**（§6.2 第 6 项）：批次 #2 的 `dirtyRef` 会在「已编辑」
   时连切店也不重置草稿 —— 对「别把 A 店项目提交到 B 店」是偏保守的方向
   （宁可用户看到旧草稿也不静默串店），但没有做「切店时按新店时区/项目清理并
   重新播种」。若要更精细，需要在 effect 里把 `orgId`/`locationId` 纳入播种签名。
5. **U06 详情状态与下一步（§6.4）** 仍未开始。

### 回退

`git checkout apps/web/src/components/CreateAppointmentModal.tsx` +
删除 `CreateAppointmentModal.test.ts`。无数据 / 契约影响。

---

## 批次 #4 — W1：AI 电话新线默认不接（U08 / §4.2-4.3）

**日期**：2026-09-07
**改动范围**：1 个新迁移 + `handlers/phone.ts` + `telnyx/routes.ts` + drizzle schema + 3 个集成测试。

### 这一刀解决了什么

计划 §1/§4.1 静态确认：`phone_lines.ai_answer` 三处叠加默认「开」——

1. 建列时（`sql/0041`）`default true`；
2. `handlers/phone.ts` 的 `upsertLine` 没传 `aiAnswer` 时 INSERT 写 `true`，
   且 `on conflict ... do update set ai_answer = excluded.ai_answer` **每次都覆盖**；
3. `telnyx/routes.ts` 取通话上下文时 `line?.ai_answer ?? true` 兜底。

结果：平台运营用 `ops/bindAiLine.ts`（走 `location.savePhoneLine`，不带
`aiAnswer`）把号绑给新店的那一刻，AI 就开始接听了 —— 店主还没设开场白、
还没确认要开。而且前台之后在设置里改个转接方式（不碰 aiAnswer），第 2 点
的 `excluded.ai_answer` 会把它按 INSERT 兜底值重新写一遍。

店主诉求（§4.2）：**分配号码 ≠ 开启接听**。开启由店主 / 运营的显式动作完成。

### 改了什么

**1. `packages/db/sql/0113_phone_line_ai_answer_default_off.sql`（新）**

`alter table phone_lines alter column ai_answer set default false`。
`SET DEFAULT` **不回写历史行** —— 已在营业、已开着 AI 接听的线一条不动
（§4.4：新默认只用于新店，不全量强制关闭）。同步更新列注释。

**2. `apps/api/src/handlers/phone.ts` `upsertLine`**

- INSERT 值 `${'aiAnswer ?? true'}` → `${'aiAnswer ?? false'}`：新建行默认不接。
- ON CONFLICT 的 SET 列表里**删掉** `ai_answer = excluded.ai_answer`：换号 /
  改配置时没传 `aiAnswer` 就保留旧值（和 `assistant_name` / `tool_token_digest`
  同一条纪律）。
- upsert 之后，仅当 `line.aiAnswer !== undefined` 才 `update phone_lines set
  ai_answer = ${'…'}` —— true / false 都照写，undefined = 没动这个开关。

**3. `apps/api/src/telnyx/routes.ts`**（start_call 上下文）

`aiAnswer: line?.ai_answer ?? true` → `?? false`。查不到 active 的 ai_voice
线（线路没配好 / 被停用）时 fail closed，不回填 true。

**4. `packages/db/src/schema/phone.ts`**：drizzle 的 `.default(true)` → `.default(false)`，
与 SQL 迁移保持一致。

**5. `apps/api/src/phone.test.ts`**：新 describe「AI 接听默认关闭」3 条 ——
没传 aiAnswer → `greeting.aiAnswer === false`；显式开启后改无关字段仍为 true；
显式 `aiAnswer: false` 落库。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移（本机 55322） | `MIGRATION_DATABASE_URL=<local> pnpm db:migrate` | `0113 ... OK`；`✓ RLS 覆盖检查通过` |
| 电话链路 | `vitest run src/phone.test.ts` | 76 passed（含 3 新增） |
| DB 套件 | `pnpm --filter @gf/db test` | 9 files / 91 passed |
| 类型 | `@gf/api` + `@gf/db` `tsc --noEmit` | exit 0 |
| 守卫 | `pnpm lint:guards` | ✓ |

### 计划 §4 对照

| §4.3 / §4.4 要求 | 本批状态 |
|---|---|
| 电话新绑定 aiAnswer 默认 false | ✅ DB 默认 + handler INSERT 兜底 |
| 更新线路时字段省略保留旧值，显式 false 必须保存 | ✅ upsert 不再覆盖 + 显式 update |
| DB 默认、handler fallback、电话实际接入路径一起修 | ✅ 三处（0113 / phone.ts / routes.ts） |
| 电话未就绪时后端 fail closed，不回填 true | ✅ routes.ts `?? false` |
| 已有开启线路没有被迁移无故关闭 | ✅ `SET DEFAULT` 不动历史行 |
| 号码撤销后不能继续接听 | 🔸 `active=false` 的线在 routes.ts 的 `where ... and active` 已被过滤，`?? false` 兜底；未单独测 |

### 明确未覆盖 / 交接给下一位

1. **「AI 电话准备状态」的独立 DTO / 状态机（§4.2 的五态表、§4.3 倒数两项）没做**：
   计划要把「门店启用意愿」和「平台线路准备状态」分成两个维度，向导与
   Calls 页读同一个 readiness DTO（`未启用/未分配`、`配置中`、`已就绪未开`、
   `已开`、`配置失败`）。本批只把默认值和覆盖语义修对，没有引入新状态维度，
   也没碰前端展示文案（「AI 电话设置中，等待平台分配号码」等）。
2. **`ops/bindAiLine.ts` 未改**：它本来就没传 `aiAnswer`，改完后行为自动
   变成「绑号但不接」，符合预期，无需改动；但如果将来要「绑号即开」需求，
   应加显式 flag，不要改回默认值。
3. **seed / 测试库**：`db:seed` 建的 ai_voice 线现在也是 `ai_answer=false`。
   现有测试没有依赖它为 true（`phone.test.ts` 自己 savePhoneLine）；若之后有
   E2E 依赖种子店「AI 在接」，需在种子里显式设 true。
4. **W1 的其余部分**（健康表首发、房间门禁、setup readiness 统一 DTO）未开始。

### 回退

`alter table phone_lines alter column ai_answer set default true` +
`git checkout apps/api/src/handlers/phone.ts apps/api/src/telnyx/routes.ts
packages/db/src/schema/phone.ts` + 删测试。`SET DEFAULT` 回退不影响已落库的
行，历史 true/false 都保留。

---

## 批次 #5 — W3：预约详情顶部进度不再误报（U06 / §6.4 的两处硬伤）

**日期**：2026-09-07
**改动范围**：`apps/web/src/features/schedule/stepper.ts` + `AppointmentDrawer.tsx` + 3 条 i18n + `stepper.test.ts`。纯前端。

### 这一刀解决了什么

计划 §6.4：「用 `activeTicket.items.every(finishedAt)` 推导完成，需要补查空数组
`every=true`、已作废单……取消/no_show 等非正常阶段不能伪装成已预约」。本批取
其中两处能一句话说清、且明确误导前台的：

1. **空工单显示成「已结束」**：`AppointmentDrawer.tsx` 里
   `activeTicket.items.every((i) => i.finishedAt) ? 'done' : 'in_service'`。
   `[].every(...)` 返回 `true` —— 一张工单已开、服务项全被移除 / 作废的预约，
   顶部四步进度会画成 4/4 全勾，并据此给出结账入口。
2. **取消 / 爽约伪装成「已预约」**：`appointment.status` 为 `cancelled` /
   `no_show` 时不在 `knownStatus` 白名单里，回落到上次打开残留的
   `initialStatus`（默认 `booked`），终态被画成进度条第 1 步。

### 改了什么

**`features/schedule/stepper.ts`** — 新增纯函数 `deriveDrawerStage()`：
- `cancelled` / `no_show` → `{ stage, terminal: 'cancelled' | 'no_show' }`，终态优先于
  一切（哪怕还挂着活动工单）。
- 有活动工单：`items.length === 0` → `checked_in`（工单已开、无服务项，**不是**完成）；
  否则 `every(finishedAt) ? 'done' : 'in_service'`（原逻辑，但现在保证非空）。
- 没有活动工单：认识的 `appointment.status` 用它，不认识的才回落 `initialStatus`。

**`components/AppointmentDrawer.tsx`**：
- 用 `deriveDrawerStage` 替掉内联三元；`statusRank` 消费它的 `stage`。
- `terminal` 非空时，顶部四步进度换成一个终态标签
  （`schedule.adStatusCancelled` / `adStatusNoShow` + `adStatusTerminalHint`
  “该预约已结束，仅可查看”），不再画会让人以为还能推进的进度条。

**`i18n/schedule.ts`**：3 条新词条（5 语言）。
**`stepper.test.ts`**：`deriveDrawerStage` 5 组断言（空工单、全/部分完成、
取消/爽约终态、终态压过工单、回落语义）。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter @gf/web exec tsc --noEmit` | exit 0 |
| stepper + i18n | `vitest run src/features/schedule/stepper.test.ts src/i18n` | 19 passed |
| Web 全量单测 | `pnpm --filter @gf/web test` | 58 files / 323 passed |
| 守卫 | `pnpm lint:guards` | ✓ |

未做浏览器验证（需登录整套栈）。

### 明确未覆盖 / 交接给下一位（§6.4 的其余部分）

1. **`allowedActions` DTO / 共享状态映射表没做** —— 计划 §6.4 的主体：后端
   或共享纯函数返回「当前业务状态 → 允许的主操作 + 不可执行原因」，抽屉与
   看板共用同一套判断、命令和校验。本批只修了顶部进度的显示，抽屉里的
   动作按钮仍是各自的老逻辑。
2. **部分完成 N/M 展示**、履约状态与付款状态分列 —— 未做。
3. **过期 `initialStatus`、已作废关联单的精确恢复操作** —— `deriveDrawerStage`
   现在把不认识的状态稳妥回落，但没有「恢复 / 查看收据」这类终态专属动作。
4. **看板与抽屉的动作编排抽取**（§6.4「优先抽取看板动作编排组件/hook」）未做。

### 回退

`git checkout apps/web/src/features/schedule/stepper.ts apps/web/src/components/AppointmentDrawer.tsx` +
移除 `stepper.test.ts` 新增 describe 与 `schedule.ts` 的 3 条词条。

---

## 批次 #6 — 一批「小改动」（U07 / U04 分类栏 / U05 同步开关 / U02 排序 / U03 尾巴）

**日期**：2026-09-07
**范围**：都是各工作包里不依赖大重构、能独立审查的小修。大改动（U01 向导重构、
U02 的 ID 契约与迁移、U04 批量编辑与导入契约、U12 全端 iPad、U10 套餐）留给下一位。

### 1. U07 — 侧栏分组 + 账号入口进侧栏（§9.1）

`components/Layout.tsx`：把原「AI 与系统配置」拆成三组，保留全部路由与深链接：

- **沟通与客服**（`groupComms`）：`/calls`、`/messages`、`/communication-logs`
- **系统与配置**（`groupConfig`）：`/storefront-builder`、`/health-forms`，以及
  **系统设置 `/settings`**（此前只在头像菜单里；`canManageSettings =
  settings.manage || staff.manage` 时才显示，侧栏可见性与路由权限一致）
- **账号与帮助**（`groupAccount`）：`/profile`、`/support`

`navGroups` 末尾 `.filter((g) => g.items.length > 0)`，`/settings` 被权限隐藏后
不会留下空标题。头像菜单的快捷入口保留不动（§9.1 允许）。
i18n：`common.ts` 加 `groupComms` / `groupConfig` / `groupAccount`（5 语）。

### 2. U04 — 服务项目「分类筛选」栏不再把主操作挤出屏幕（§7.2 的小修）

`pages/Settings.tsx` 服务项目 tab 的分类 chip 行：`flex` 无换行无滚动 →
`flex flex-wrap ... min-w-0`，每个 chip 加 `shrink-0 whitespace-nowrap`。
窄屏 / 分类多 / 名称长时换行，不再溢出裁切。§7.2 里「窄屏改可搜索下拉」的
完整响应式方案未做。

### 3. U05 — Google/Yelp 手动同步：区分「平台未开放」与「配置/权限问题」（§8.2）

不新增错误码（那要动 contracts + 全语言错误词条）。改成配置读接口直接带状态：

- `apps/api/src/queries/reviews.ts`：`ReviewSourcesDto` 加 `manualSyncEnabled`；
  `loadReviewSources(tx, ctx, manualSyncEnabled)` 多一个入参。
- `apps/api/src/routes/reviews.ts`：`GET /v1/desk/reviews/sources` 传入
  `manualSyncEnabled()`（原来只在 POST /sync 里判，判完抛 `PERMISSION_DENIED`
  + `reason=manual_review_sync_disabled`，前端只能显示成「权限不足」）。
- `features/reviews/`：`types.ts` 同步加字段；`ReviewSourcesPanel.tsx` 同步
  按钮在 `manualSyncEnabled === false` 时禁用，并显示
  `reviews.syncNotOpen`「手动同步暂未开放，评价评分仍会自动刷新」——
  不再发一个必然 403 的请求。
- 测试：`ReviewSourcesPanel.test.tsx` 加一条「未开放 → 按钮禁用 + 文案」。

`POST /sync` 的 `PERMISSION_DENIED`（缺 `settings.manage`）分支未动；§8.2 里
「缺权限显示需要的角色能力 / 外部配置未就绪显示待配置」等更细的分状态文案、
以及 §8 的调查（真实环境 HTTP 状态、error code、`REVIEW_SYNC_MANUAL_ENABLED`
实际取值）仍待做。

### 4. U02 — 员工基础设置不再外露 DB 排序数字（§5.3 的小修）

`features/staff/DirectorySettings.tsx`：
- 新增/编辑表单去掉「排序」数字输入框；新项 `sort = max(existing) + 1` 追加末尾。
- 列表行的裸 `{option.sort}` 换成 ▲▼ 上移/下移按钮（和相邻项互换 sort 值，
  写 index 而非 ±1，legacy 全 0 的列表移几次即归位）。
- 加说明「显示顺序仅影响列表位置，不影响排班、轮牌或提成」。

未做：服务端「批量稳定重排 + 版本冲突处理」端点（§5.3）—— 现在一次移动是
两条串行 `saveDirectoryOption`，并发重排没有原子保证；legacy 全 0 数据要移动
几次才逐步分出顺序。

### 5. U03 尾巴 — Calls「批准通话草稿 → 新建预约」的日期

`pages/Calls.tsx` `handleDirectApproveDraft`：
`new Date(slotStartsAt).toISOString().split('T')[0]`（UTC 日期）→
`instantToWallDate(slotStartsAt, storeTime.timeZone)`（门店墙上日期）。
洛杉矶晚 8 点的槽位不再落到次日。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `@gf/web` + `@gf/api` `tsc --noEmit` | exit 0 |
| Web 全量单测 | `pnpm --filter @gf/web test` | 58 files / 324 passed（+1 review 用例） |
| API 评价套件 | `vitest run src/reviews.test.ts` | 12 passed |
| API 全量套件 | `pnpm --filter @gf/api test` | 见提交时的运行记录 |
| 守卫 | `pnpm lint:guards` | ✓ |

未做浏览器 / 真机验证。

### 交接：剩下的都是「大改动」

| 项 | 为什么大 |
|---|---|
| U01 开店向导 | 7 步领域化重构 + 字典前置 + 房间门禁（前后端 FinishSetup 检查）+ 健康表首发全链路（模板锁、幂等、发布服务复用） |
| U02 / U13 员工目录 | job/level/skill 从自由文本 datalist 改 ID 选择：补岗位 ID 模型 + DTO、后端同店校验、旧自由值只读盘点与迁移、所有 `saveProfile` 调用方同步；员工中心紧凑卡片重排 |
| U04 项目导入 / 批量编辑 | blueprint 发布写死 `online_bookable=false` 要改默认 + 字段透传；新建批量 PATCH 命令（契约、逐项校验、事务/部分成功语义、审计） |
| U11 后半 生日选择器 | 三字段（年直输/月日选）新组件 + 闰年/未来日/留空校验，接入 PublicHealthForm、apps/ipad、客户档案 DOB 三处 |
| U12 全端 iPad | 系统性逐页扫屏 + 真机验收，跨 apps/web、apps/ipad、apps/booking、apps/platform、apps/marketing |
| U10 套餐 | 独立主项目，`docs/plans/2026-09-07-service-bundles-implementation.md`（P0–P8 / B01–B32） |
| U06 剩余 | allowedActions DTO / 看板-抽屉共用状态映射、部分完成 N/M |
| U09 剩余 | 平台共享号 routingScope（`sms_inbound` 加归属证据列） |
| U03 剩余 | 跨午夜营业 day-offset |

---

## 批次 #7 — W2：员工目录 ID 契约 + 旧值迁移（U02 主体）

**日期**：2026-09-07
**改动范围**：1 个新迁移 + 1 个 drizzle schema + 2 个契约命令 + `handlers/staff.ts` + `queries/staffList.ts` + 3 个前端文件 + 4 条 i18n + `staffDirectory.test.ts` / `workstations_backend.test.ts` 两个测试文件。
公共层（迁移 / 契约 / handler / 查询）与消费者（前端）分两个 commit，公共层在前。

### 这一刀解决了什么

计划 §5.1 / §3.2：`staff_profiles.level_id` 早已是外键、技能走 `staff_skills` 关联表，
唯独**岗位只有一列自由文本** `staff_profiles.job_title`；而且 `staff.saveProfile`
handler 对 `jobTitle` / `level` / `skills` 三个自由文本字段**匹配不到就当场 `insert` 新目录项** ——
「只换前端控件不算强校验」正是指这条后端路径。前端 `EmployeePerformance.tsx`
用 `Input + datalist`（只是候选提示，不拦自由输入），技能还有「自定义技能标签」输入框。

### 改了什么

**1. `packages/db/sql/0114_staff_directory_id_contract.sql`（新）**

- `staff_profiles` 补 `job_title_id uuid references staff_job_titles(id)` + 索引。
- 回填：规范化（`lower(btrim())`）后同店同名匹配；多行命中取「启用优先、sort 靠前」。
- 仍匹配不到的历史自由值：迁移流程内补建为本店目录项（`on conflict (location_id, name) do nothing`）再关联 ——
  §5.3「匹配不到的历史值可迁为本店历史目录项；只在迁移流程处理」。
- 只读盘点视图 `staff_directory_legacy_audit`（`security_invoker`，`relkind='v'` 不受 RLS 覆盖检查约束，
  `grant select ... to app_user`）：每个仍带自由文本岗位的档案 → 解析到的目录行 + `match_kind`
  (`exact` / `normalized` / `unresolved` / `none`)。正常应全部非空；自由文本路径若回归，未解析行会在此冒出。
- 全文可重复执行（`add column if not exists` + `update ... where job_title_id is null`）。

**2. `packages/db/src/schema/identity.ts`**：`staffProfiles` 加 `jobTitleId`，与迁移一致。

**3. 契约 `packages/contracts/src/commands/setup.ts`**

- `staff.saveProfile` 加 `jobTitleId: uuid.nullable().optional()`。自由文本字段保留但语义收窄
  （见 handler）。
- 新增 `staff.reorderDirectoryOptions`（`kind` + `orderedIds`，`permission: 'staff.manage'`）：
  取代前端「上移 / 下移」的两条串行写。`orderedIds` 必须正好是该类当前全部项的一个排列。

**4. `apps/api/src/handlers/staff.ts`**

- `StaffSaveProfile`：
  - **职级**：`levelId` 优先；`level` 自由文本只按 `key` / 规范化 `name` 解析现存项，解析不到抛
    `VALIDATION_FAILED { reason: 'unknown_level' }`；**删掉** `insert into staff_levels` 自动建项。
  - **岗位**（新）：`jobTitleId` 优先，校验同店；`jobTitle` 自由文本按规范化 `name` 解析现存项，
    解析不到抛 `unknown_job_title`；跨店 / 伪造 ID 抛 `invalid_or_inactive_job_title`。
    停用岗位只允许「已关联该 membership」的人继续保存。持久化 `job_title_id` +
    反规范化显示名 `job_title`（保持旧读取路径可用）。省略字段不动旧值（`case when jobProvided`）。
  - **技能**：`skills` 自由文本解析不到现存项抛 `unknown_skill`；**删掉** `insert into skills` 自动建项。
    停用技能非已关联者仍抛 `invalid_or_inactive_skill`（原逻辑保留）。
  - **删掉** 尾部 `if (input.jobTitle?.trim()) insert into staff_job_titles ...` 兜底建项。
- `SaveStaffDirectoryOption`（岗位改名）：反规范化显示名同步改为「优先按 `job_title_id` 命中，
  兼容尚未回填 id 的旧行按旧名匹配」。
- 新增 `ReorderStaffDirectoryOptions` handler：`for update` 锁全类行 → 校验 `orderedIds`
  是全排列（数量一致、无重复、无越权 / 越类 ID，否则 `directory_reorder_mismatch`）→
  一个事务里按下标重写 `sort`。审计记 `orderedIds`。

**5. `apps/api/src/queries/staffList.ts`**：`StaffDirectoryItem` 加 `jobTitleId` / `levelId`
（前端做 ID 回显选择需要），查询 `select sp.job_title_id, sp.level_id`。

**6. 前端**

- `features/staff/types.ts`：`StaffDirectoryItem` + `SaveStaffProfileInput` 加 `jobTitleId` / `levelId`。
- `features/staff/api.ts`：加 `useReorderDirectoryOptions`。
- `features/staff/DirectorySettings.tsx`：`move()` 从两条串行 `saveDirectoryOption` 改为一次
  `reorderDirectoryOptions({ kind, orderedIds })`；`busy` 合并两个 mutation 的 pending。
- `pages/EmployeePerformance.tsx`：
  - 岗位 / 职级从 `Input + datalist` 改**原生 `<select>`**，`value` 是目录项 ID，
    选项 = 启用项 +（当前值若停用）该停用项并标注「（已停用）」；目录为空显示
    「请先在页面顶部『岗位 / 职级 / 技能设置』中添加」提示。
  - 技能保留可勾选标签，**删掉「自定义技能标签」输入框**与 `handleAddCustomSkill`；
    只能勾 `staffData.skills`；目录为空同样给提示。
  - 提交只发 `jobTitleId` / `levelId` / `skillIds`（都是 ID），不再发 `jobTitle` / `level` / `skills`
    自由文本；确认弹窗按 ID 查显示名。
- `i18n/rotation.ts`：`empUnset` / `empOptionInactive` / `empDirectoryEmptyHint`（5 语言齐全）。

### 明确未改（超出本批 / 留给后续）

- **`user.updateProfile`（技师自助改本人档案，`handlers/profile.ts`）** 仍按自由文本解析 / 自动建 `skills`。
  它是独立的自助编辑面（`Pages/Profile.tsx` 有整套预设建议 + 自定义输入 + 写 `staff_profiles.skills` text[]），
  改成 ID-only 是一个自带 UI 的子项目，且会牵动技师端。**本批不动**；`staff_skills` 关联仍由它写，
  排班 / 履约的技能判定不受影响。计划 §3.2「所有 `staff.saveProfile` 调用方」已全部收口
  （`routes/settings.ts` → 同一 handler；`features/settings` 员工弹窗与向导 `TeamStepForm` 本就不传
  job/level/skill）。
- **行业预设一键生成**（§5.2 静态字典）：属于 W1 向导「员工基础设置」步骤，本批未做。
- **W2b 员工中心紧凑卡片（U13）**：独立工作包，未动。
- **旧值「人工冲突列表」产物**：迁移用 `staff_directory_legacy_audit` 视图代替离线报表；
  没有单独产出 CSV。运营切换后查该视图 `where match_kind in ('unresolved','normalized')` 复核。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移（本机 55322 隔离库） | `MIGRATION_DATABASE_URL=<local> pnpm db:migrate` | `0114 ... OK`；`✓ RLS 覆盖检查通过` |
| 类型 | `@gf/contracts` / `@gf/db` / `@gf/api` / `@gf/web` `tsc --noEmit` | 全部 exit 0 |
| 员工目录套件 | `vitest run src/staffDirectory.test.ts` | 8 passed（3 原有 + 5 新增：未知自由值拒绝 / ID 存取回环 / 跨店 ID 拒绝 / 停用项对新人拦对已关联者放行 / reorder 持久化 + 部分列表拒绝） |
| 员工相邻套件 | `vitest run src/workstations_backend.test.ts src/profile_and_notifications.test.ts src/staffCapacity.test.ts src/staff.test.ts src/settings_enhancements.test.ts src/rooms.test.ts src/blueprint.test.ts src/ticketLifecycle.test.ts` | 全绿（workstations 测试已改为先建目录项） |
| DB 套件 | `pnpm --filter @gf/db test` | 9 files / 91 passed（`rls.test.ts` 39 passed） |
| Web 全量单测 + i18n | `pnpm --filter @gf/web test` / `vitest run src/i18n` | 58 files / 324 passed；i18n 7 passed（词条全语言非空、非中文无 CJK） |
| 守卫 | `pnpm lint:guards` | ✓ |
| 完整 `pnpm --filter @gf/api test` | isolated 库一次跑通 | 86 files / 1176 passed（无 flaky） |

未做：浏览器 / 真机交互验证（EmployeePerformance 弹窗需登录整套栈；按计划 §12 / H 阶段单列）。

### 计划 §5 / T08–T11 对照

| 验收点 | 本批状态 |
|---|---|
| T08 预设重复生成 / 切换行业不重复不覆盖不自动授技能 | ⚠️ 预设生成属 W1，未做；ID 契约层面「岗位不改系统权限」✅ |
| T09 员工新建 / 编辑 / 导入仅本店合法目录 ID；自由值 / 跨店值拒绝 | ✅ handler 强校验 + 新测试覆盖（`staff.saveProfile` 全部调用方已收口） |
| T10 历史自由值 / 停用关联：有迁移、保留历史；改无关字段不丢关联 | ✅ `sql/0114` 回填 + 盘点视图；停用项对已关联者保留（测试覆盖「改 phone 不丢 jobTitleId」） |
| T11 目录重排与刷新：上下移动持久化，不改权限 / 轮牌 / 工资 | ✅ `staff.reorderDirectoryOptions` 原子重排；只写 `sort`，不碰 rotation / compensation（测试覆盖） |

### 回退

1. 前端：`git revert` 消费者 commit。
2. 契约 + handler + 查询：`git revert` 公共层 commit。
3. 迁移：`drop view staff_directory_legacy_audit; alter table staff_profiles drop column job_title_id;`
   （回退会重新打开「自由文本新建目录项」，属计划明确不希望方向，仅用于该批本身回归时止血）。
   已回填的 `staff_job_titles` 新行保留无害。

---

## 批次 #8 — W2b：员工中心信息密度（U13）

**日期**：2026-09-07
**改动范围**：纯前端 —— `pages/EmployeePerformance.tsx` + `i18n/rotation.ts`（9 条新词条）+
`EmployeePerformance.test.tsx`（+1 用例）。无契约 / DB 改动。

### 这一刀解决了什么

计划 §5.3 末三条 / §9.3：员工卡片默认铺开**全部**可做 / 不可做项目（`canDo.map` 无截断）
+ 提成 + 备注，30 项技能 / 50 名员工时卡片被标签撑爆，iPad 上尤甚；编辑弹窗技能标签区无限高，
底部保存键要滑过整列标签才够得到。

### 改了什么（都在 `EmployeePerformance.tsx`）

**1. 卡片改默认紧凑，明细进单卡展开区**

- 紧凑行只留：头像、姓名、工号、状态徽章、岗位、职级、**可预约 / 不可约徽章**、
  **技能数量 + 最多 3 个技能 +「另 N 项」**、`可做 X · 盲区 Y` 计数、「展开明细 / 收起」。
- 展开区（`expandedStaffId` 单卡状态，替换原来只管不可做项目的 `expandedCannotDoStaffId`）：
  提成徽章 + 电话 + 可做项目（截断 12 + 「另 N 项」）+ 不可做项目（截断 12）+ 备注。
- 卡片 padding `p-4`→`p-3.5`，头像 `w-10`→`w-9`，网格 gap `3.5`→`3`。
- 页脚操作（休假 / 复职 / 删除 / 编辑）不变。

**2. 编辑弹窗「技能」区：可搜索 + 已选摘要 + 清除 + 限高滚动**

- 标题行加「清除所选」按钮（`setFormSkills([])`）。
- 新增技能搜索框（`skillSearch` 状态，打开弹窗时清空）：按 `presetLabel` 名称子串过滤；
  **已选项始终可见**（搜索时不因过滤误以为丢了 —— 对应 §5.3「搜索/筛选仍覆盖全部技能」）。
- 标签容器 `max-h-40 overflow-y-auto` + 边框底色，30 项技能不再把保存键顶出屏幕。
- 弹窗整体本就 `max-h-[72vh] overflow-y-auto`，分区标题（基本信息 / 岗位职级 / 技能 / 薪酬）已在，
  本批不再重排分区结构。

**3. i18n（`i18n/rotation.ts`，5 语言齐全）**

`empBookableYes` / `empBookableNo` / `empSkillsCount` / `empSkillsMore` / `empQualifiedShort` /
`empBlockedShort` / `empViewDetail` / `empSkillSearchPlaceholder` / `empSkillClearSel`。
`{p0}` 占位，非中文无 CJK。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter @gf/web exec tsc --noEmit` | exit 0 |
| 组件单测 | `vitest run src/pages/EmployeePerformance.test.tsx` | 2 passed（新增「30 项技能折叠成计数 +『另 N 项』，明细点开才出现」）|
| 多语言完整性 | `vitest run src/i18n` | 7 passed |
| Web 全量单测 | `pnpm --filter @gf/web test` | 58 files / 325 passed |
| 守卫 | `pnpm lint:guards` | ✓ |

未做：浏览器 / 真机交互验证（EmployeePerformance 需登录整套栈；按计划 §12 / H 阶段单列）。
0 / 3 / 30 项技能与多员工的排版仅在组件单测层面覆盖 30 项一档，真机 iPad 竖屏扫屏留待 W6b（U12）。

### 计划 §5.3 / T12 对照

| 验收点 | 本批状态 |
|---|---|
| 默认紧凑行：姓名 / 状态 / 岗位 / 职级 / 可预约 / 技能数量 / 更多操作 | ✅ |
| 最多 2–3 个技能 +「另 N 项」 | ✅ 取 3 |
| 全部技能 / 可做不可做 / 收入细节移到展开区 | ✅ 单卡展开区 |
| 搜索 / 筛选仍覆盖全部技能（不因折叠搜不到） | ✅ 顶部搜索走 `fuzzySearch` 的 `skills` 键未动；弹窗内搜索保留已选项可见 |
| 编辑弹窗技能搜索区限高可滚动、iPad 保存键可达 | ✅ `max-h-40 overflow-y-auto` |
| 编辑弹窗分「个人信息 / 工作设置 / 技能」区 | 🔸 分区标题已在（基本信息 / 岗位职级 / 技能 / 薪酬），未按字面合并成 3 个 |
| T12 零 / 三 / 三十项技能与五十名员工不被标签撑满 | 🔸 组件单测覆盖 30 项一档；真机 iPad 竖屏留 W6b |

### 回退

`git checkout apps/web/src/pages/EmployeePerformance.tsx apps/web/src/pages/EmployeePerformance.test.tsx`
+ 移除 `i18n/rotation.ts` 的 9 条 `emp*` 词条。无数据 / 契约影响。

---

## 批次 #9 — W4：服务导入默认网约 + `catalog.saveService` PATCH 语义 + 批量编辑（U04）

**日期**：2026-09-07
**改动范围**：契约 `SaveService`（字段改可选）+ 新命令 `catalog.bulkUpdateServices` +
`handlers/setup.ts` + `handlers/blueprint.ts`（一行）+ 前端 `Settings.tsx` / `settings/{api,types}.ts` +
`i18n/settings.ts`（24 条）+ 新测试 `catalogBulk.test.ts`。公共层与消费者分两个 commit。

### 这一刀解决了什么

计划 §7.1 三处确认硬伤 + 缺失的批量编辑：

1. `handlers/blueprint.ts` 服务发布 SQL 把 `online_bookable` 写死 `false` —— AI 照片导入的
   普通项目一律不支持网约。
2. `SaveService` 契约里 `taxable` / `onlineBookable` / `isAddon` / `active` 都是
   `z.boolean().default(false|true)` —— 编辑时省略任一字段，Zod 先填默认值，handler 无从分辨
   「没传」和「显式 false」，于是**编辑省略即覆写旧值**。
3. 没有批量修改一组项目的命令，前端也没有多选 / 批量操作条。

### 改了什么

**1. 契约 `packages/contracts/src/commands/setup.ts`**

- `SaveService`：`taxable` / `onlineBookable` / `isAddon` / `active` 从 `.default(...)` 改 `.optional()`
  —— PATCH 语义，「不传即不改」。新建缺省在 handler 里给（见下）。
- 新增 `catalog.bulkUpdateServices`（`permission: 'catalog.manage'`）：
  `serviceIds`（1–200）+ `set`（`onlineBookable` / `staffCount` / `categoryId` /
  `skillsAdd` / `skillsRemove` / `skillsReplace`）。zod `.refine` 挡两件事：`set` 至少一个字段、
  `skillsReplace` 与 `skillsAdd` / `skillsRemove` 互斥。

**2. `handlers/setup.ts` — `SaveService`**

- 新建缺省：`taxable ?? false`、`isAddon ?? false`、`active ?? true`、`staffCount ?? 1`、
  **`onlineBookable ?? !isAddon`（普通项目默认支持网约，加项默认不进网约目录，§7.2）**。
- 编辑：`taxable` / `online_bookable` / `is_addon` / `active` 全部改
  `${input.x === undefined ? tx\`x\` : input.x}`（对齐既有 `category_id` 的写法）；
  `staff_count` 原本已是 `coalesce(... , staff_count)`，保留。
- 加项守卫（新建 + 编辑）：按「本次生效后」的 `isAddon` / `onlineBookable` 组合，
  若两者皆真 → `VALIDATION_FAILED { reason: 'addon_not_online_bookable' }`。

**3. `handlers/setup.ts` — `catalog.bulkUpdateServices`（新 handler）**

- 目标项目 `for update` 锁行，缺一即 `NOT_FOUND`（跨店 ID 整批失败，无半批写入）。
- `set.onlineBookable === true` 且选中项含加项 → `VALIDATION_FAILED { reason: 'addon_not_online_bookable', serviceIds }`。
- `categoryId` / 技能 ID 全部校验本店归属，缺一 `NOT_FOUND`。
- 标量字段（online / staffCount / category）一条 `update ... where id = any(ids)`，不传即不改。
- 技能：`skillsReplace` → 先 `delete` 再逐项 `insert`（空数组＝清空）；否则 `skillsRemove`
  批量 `delete`、`skillsAdd` 逐项 `insert ... on conflict do nothing`。
- **只动 online / staffCount / category / 技能，从不碰 price / duration / name** —— 因此对
  「预览后他人改了价格 / 时长」天然安全（§7.2「不覆盖价格 / 时长」）。
- 单事务全成全败（命令总线默认事务）。审计记 `serviceIds` + 改动字段名。

**4. `handlers/blueprint.ts`**

服务发布 `values (... online_bookable ...)` 从写死 `false` 改 `${r.kind !== 'addon'}`：
普通导入项默认支持网约，加项仍 `false`。

**5. 前端**

- `settings/types.ts` + `settings/api.ts`：`BulkUpdateServicesInput` + `useBulkUpdateServices`
  （成功后 invalidate `settingsKeys.desk` —— 公开目录 / 预约可用性走同一份 desk settings 查询）。
- `pages/Settings.tsx` 服务 tab：
  - 每行加复选框；顶部「全选当前 N 项 / 清空选择 / 已选 N」（列表未分页，`filteredServices`
    就是全部筛选结果，无「本页 vs 全部」歧义）。
  - 勾选后底部 `sticky` 批量操作条：设为可网约 / 取消网约 / 设置技师人数 / 添加技能 /
    移除技能 / 替换技能 / 迁移分类。
  - 一个批量确认弹窗：online/offline 给数量文案 + 选中含加项时红字阻止并禁用「应用」；
    staffCount 数字输入（1–5）；技能三种操作共用可搜索标签列表（`max-h-40` 滚动）；
    分类下拉（含「未分类」）。底部固定提示「批量操作不会改动价格、时长或名称」。
- `i18n/settings.ts`：24 条 `settings.stBulk*`（5 语齐全，`{p0}` 占位，非中文无 CJK）。

### 明确未做 / 交接

- **draft 级「预览每项改技师人数」**（§7.2）：blueprint 草稿模型没有 `staff_count` 列，
  导入一律落 1（＝「AI 无可靠依据不猜双技师」），店主导入后用**批量命令**或单项编辑改 2。
  草稿行内人数编辑器需要 blueprint schema 迁移 + 契约 + `toServiceDrafts` 透传，留作后续。
- **分类栏窄屏可搜索下拉**（§7.2）：批次 #6 的 `flex-wrap` 仍在；完整响应式（窄屏下拉 /
  宽屏单行横滚 + `shrink-0`）随 W6b（U12）iPad 扫屏一起做。
- **逐字段乐观锁**（「预览后他人改了所选字段」）：本命令字段范围窄（不碰价格 / 时长），
  对未选字段天然安全；对所选字段是 last-write-wins。严格版本校验需要 `services.updated_at`
  迁移 + 前端捕获，留作后续。
- **部分成功 / 可重试集合**：本实现是单批事务全成全败（计划允许的默认），未做逐项结果返回。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移 | 无新迁移 | — |
| 类型 | `@gf/contracts` / `@gf/api` / `@gf/web` `tsc --noEmit` | 全部 exit 0 |
| 新测试 | `vitest run src/catalogBulk.test.ts` | 8 passed（新建普通默认网约 / 加项不网约；编辑省略布尔保留旧值；加项设网约被拒；批量 online+人数一事务；skillsAdd 保留 / skillsReplace 覆盖；跨店 ID 整批拒绝无半写；批量加项设网约被拒；未知技能被拒）|
| 相邻套件 | `vitest run src/blueprint.test.ts src/settings_enhancements.test.ts src/phone.test.ts src/public.test.ts` | 192 passed |
| Web 全量单测 | `pnpm --filter @gf/web test` | 58 files / 325 passed（两处 Settings 测试的 api mock 补 `useBulkUpdateServices`）|
| 守卫 | `pnpm lint:guards` | ✓ |
| 完整 `pnpm --filter @gf/api test` | isolated 库一次跑通 | 87 files / 1184 passed（无 flaky） |

未做：浏览器 / 真机交互验证（Settings 服务 tab 需登录整套栈；按计划 §12 / H 阶段单列）。

### 计划 §7 / T20–T24 对照

| 验收点 | 本批状态 |
|---|---|
| T20 普通 / add-on / 次卡 / 套餐类型与默认网约正确 | ✅ 普通新建 + 导入默认 true，add-on 强制 false；套餐(U10) / 次卡不经 `services` 默认路径，未受影响 |
| T21 导入双技师项目占两人容量 | 🔸 导入落 1，店主批量 / 单项设 2 后容量校验走既有 `serviceCapacity`（未在本批加断言）|
| T22 批量加技能保留原技能，替换才清除 | ✅ 新测试覆盖 |
| T23 批量关网约立即影响公开目录；跨页筛选选择 | ✅ 关网约 + `invalidate desk settings`；列表未分页，选择即全筛选结果 |
| T24 跨店 ID / 失效技能 / 并发编辑拒绝且无半批 | ✅ 跨店 / 未知技能整批拒绝、单事务；严格并发版本校验留后续 |
| 30 分类 / 200 项目 iPad 可过滤选中保存 | 🔸 上限 200、复选 + 批量条已具；iPad 扫屏留 W6b |

### 回退

1. 前端：`git revert` 消费者 commit。
2. 契约 + handler：`git revert` 公共层 commit（`SaveService` 字段恢复 `.default()`、
   删 `catalog.bulkUpdateServices`、blueprint 恢复 `online_bookable=false`）。
无数据 / 迁移改动。

---

## 批次 #10 — W6a：生日 / date-only 输入（U11 后半 / §9.2）

**日期**：2026-09-07
**改动范围**：`@gf/contracts` 新增纯校验模块 `birthdate.ts`（+ 测试）；`apps/api` 公开表单
响应加 `today`；`apps/web` + `apps/ipad` 各一个 `BirthdateField` 组件，接入 3 处
（公开健康表 / iPad 自助健康表 / 客户档案）；4 组 i18n 词条。

### 这一刀解决了什么

计划 §9.2：生日全部用原生 `<input type="date">` —— iPad 上要逐月点几十年才到 1965；
`apps/ipad` 还用 `max={new Date().toISOString().slice(0,10)}`（**UTC 今天**）当上限，
出差 / 跨时区时会把「今天」判错。没有共用校验：闰年、切月后的非法日、未来日各页各写。

### 改了什么

**1. `packages/contracts/src/birthdate.ts`（新，纯函数，Web / iPad / API 共用）**

- `BirthdateParts` = `{ year, month, day }`（字符串，允许编辑中途为空）。
- `isoToParts` / `partsToISO`：`YYYY-MM-DD` ⇄ 三字段（拼不出返回 `null`，不代表错误）。
- `daysInMonth(y, m)`：闰年按 4 / 100 / 400 判。
- `parseBirthdate(iso, { today?, optional? })` → `{ ok, value }` | `{ ok:false, reason }`，
  `reason ∈ incomplete | format | invalid_date | future`：
  - date-only，**不转 UTC timestamp**；
  - 真实日历日校验（`2001-02-31` / `1900-02-29` → `invalid_date`，不滚到 3 月）；
  - `today`（`YYYY-MM-DD`，门店日历今天）给出时才判 `future`；**未给不判**
    （§9.2「未加载时不先用设备 / UTC 日期」）；
  - 空串：`optional` 时 `{ ok:true, value:null }`，否则 `incomplete`。
- `parseBirthdateParts(parts, opts)`：区分「填了一半」（`incomplete`）与「填完但该月无此日」
  （`invalid_date`）。
- 15 条单测（`birthdate.test.ts`）：闰年、`1965-03-12` 直填、`2000-02-29` 过 / `1900-02-29` 拒、
  `2月31` 拒、留空、未来日仅在 `today` 已知时拒、非 ISO 形状 → `format`。

**2. `apps/api/src/public/formRoutes.ts`**

`GET /public/v1/forms` 响应加 `today: businessDateOf(new Date(), link.timezone, '00:00')`
—— **cutoff 00:00 = 纯日历日，不套营业日**（§9.2「不要用营业日 cutoff 判断生日」）。
`PublicFormsResponse` 类型同步加 `today?: string`。

**3. `apps/web/src/components/ui/BirthdateField.tsx`（新）**

年：`inputMode="numeric"` 4 位文本直输；月 / 日：`<select>`。日永远列 1–31，越界的
`<option disabled>`（**不移除、不静默改月**，配合下方红字）。`onChange` 发
`partsToISO() ?? ''`；`value` 变化时回显但不冲掉正在编辑的一半。失焦后显示
`parseBirthdateParts` 的错误（`incomplete` 不显示，允许继续编辑）。触摸目标 `min-h-[44px]`，
字段 `aria-label` 关联。

接入：
- `pages/PublicHealthForm.tsx`：客户生日改用组件，`today={publicForms.data?.today}`，
  `optional`；提交时 `parseBirthdate` 再校验一次，非法 toast。词条 `dobInvalid` /
  `dobFuture` / `dobBadDay`（`publicCopy.ts`，5 语）。
- `pages/Customers.tsx`：客户档案生日改用组件，`today` 取 `useStoreTime().timeZone` →
  `instantToWallDate(now, tz)`；新建 / 编辑两个保存函数共用 `birthdayError()` 守卫。
  词条 `crm.custBirthday{Invalid,Future,BadDay}`（5 语）。

**4. `apps/ipad/src/components/BirthdateField.tsx`（新，平行实现）**

同规则、同 `@gf/contracts` 校验函数；iPad 样式 + `useLanguage`。接入
`pages/HealthFormPage.tsx`，去掉 `max=UTC今天`。提交时 `parseBirthdate` 校验。
词条 `health.dob{BadDay,Invalid,Future,Year,Month,Day}`（`i18n/dict.ts`，5 语）。

### 明确未做 / 交接

- **iPad 端 `today`**：iPad 健康表数据来自路由 `location.state`（不是本页 fetch），
  没有门店时区 / 今天。按 §9.2「未加载不用设备日期」，iPad 端**不判未来日**
  （仍比原来的 UTC `max` 好：年直输 + 闰年 + 非法日提示）。要判未来需把 `businessDate`
  从 kiosk 队列流程串进来，留作后续。
- **健康表模板的「通用日期题」**：当前 `PublicHealthForm` / iPad 的问题渲染器只有
  `choice / bool / multi / text`，**没有 `date` 题型**，故本批只处理客户 DOB。
  日后新增 `date` 题型时复用 `BirthdateField` + `parseBirthdate`。
- **隐藏 DOB 字段的不可见必填错误**：`BirthdateField` 的错误只在 `touched` 后显示且
  `incomplete` 不显示，字段不渲染时不产生错误；未做额外处理。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `@gf/contracts` / `@gf/api` / `@gf/web` / `@gf/ipad` `tsc --noEmit` | 全部 exit 0 |
| 纯函数单测 | `vitest run src/birthdate.test.ts`（contracts） | 15 passed |
| contracts 全量 | `pnpm --filter @gf/contracts test` | 8 files / 61 passed |
| web 全量 | `pnpm --filter @gf/web test` | 58 files / 325 passed |
| ipad 全量 | `pnpm --filter @gf/ipad test` | 9 files / 20 passed |
| 公开表单 API | `vitest run src/formShare.test.ts src/public.test.ts` | 109 passed（`today` 字段未破坏既有断言） |
| 守卫 | `pnpm lint:guards` | ✓ |

未做：浏览器 / 真机 iPad Safari 交互验证（年直输 / 月日下拉 / VoiceOver / 外接键盘；
按计划 §12 / H 阶段与 W6b 一起）。

### 计划 §9.2 / T35 对照

| 验收点 | 本批状态 |
|---|---|
| 直接输入 `1965-03-12` 无需翻月 | ✅ 年 4 位文本框 + 月 / 日下拉 |
| `2000-02-29` 成功、`1900-02-29` 拒绝 | ✅ 纯函数单测覆盖；`invalid_date` |
| 切月后非法日提示，不静默把 2/31 变 3 月 | ✅ 日 select 越界项 `disabled` + 红字，不改月 |
| 不接受未来生日，比较基于门店日历今天；未加载不用设备 / UTC | ✅ Web：公开表 `today` 走门店时区、客户档案走 `useStoreTime`；iPad：无 `today` 则不判未来（不再用 UTC max） |
| 可选生日允许留空；已有生日正确回显 | ✅ `optional` + `isoToParts` 回显 |
| `YYYY-MM-DD` date-only 存储，不转 UTC，跨时区保存再打开不变 | ✅ 全程字符串，无 `new Date()` 解析 |
| iPad Safari / 外接键盘 / 数字键盘 / VoiceOver / ≥44px | 🔸 代码层面 `inputMode=numeric` + `aria-label` + `min-h-[44px]`；真机未验 |

### 回退

`git revert` 消费者 commit + 公共层 commit。`@gf/contracts` 删 `birthdate.ts` 及其
`index.ts` 导出；`formRoutes.ts` 去 `today` 字段。无数据 / 迁移改动。

---

## 批次 #11 — W3b：详情动作与下一步 · 共享状态映射（U06 / §6.4）

**日期**：2026-09-07
**改动范围**：`apps/api/src/queries/appointmentDetail.ts`（DTO 加 `ticket` 事实）；
`apps/web` 新增纯函数 `features/schedule/appointmentBoardState.ts`（+ 测试）；
`nextActionLabelKey` 从 `pages/queue/model.ts` 迁到 `features/queue/nextAction.ts`（去 `KanbanItem` 依赖）；
`AppointmentDrawer.tsx` 顶部服务页加「当前状态 + 下一步」；`i18n/schedule.ts` +11 词条。

### 这一刀解决了什么

计划 §6.4：抽屉此前**只显示**四步进度（batch #5 已修误报），**没有任何推进动作** ——
签到 / 开始 / 完成 / 结账全部只在看板上；抽屉也没有把履约状态与付款状态分开，
更没有「部分完成 N/M」。而看板早已有一份设计良好的「主按钮唯一真值来源」
`queueNextAction()` + `paymentStageFor()`。本批不新写状态机，而是让抽屉复用这份推导。

### 改了什么

**1. `apps/api/src/queries/appointmentDetail.ts`**

`AppointmentDetailDto` 加 `ticket: AppointmentTicketFactsDto | null` ——
`queueNextAction` / `paymentStageFor` 的入参子集：
`{ ticketId, status, checkoutTiming, serviceSettledAt, tipSettledAt, serviceCompleted,
items: [{ ticketItemId, name, startedAt, finishedAt }] }`。
新增 `loadTicketFacts()`：按 `appointment_id` 取**最近一张**工单（不按状态过滤，
已结清的「已结束」也能拿到工单 id 供查看）+ 其 `ticket_items` 的 started/finished。
`serviceCompleted` = 全部 item 有 `finished_at`。walk-in 分支返回 `ticket: null`。

**2. `apps/web/src/features/schedule/appointmentBoardState.ts`（新纯函数）**

`deriveAppointmentBoardState({ appointmentStatus, items, ticket })` → 
`{ stage, terminal, fulfillment: {done,total}, paymentStage, paid, nextAction }`：

- `cancelled` / `no_show` → `terminal`，`nextAction` blocked（**不回落 booked**）。
- 有工单：全部 item 完工 → `paymentStage` 非空则 `ready_checkout`、否则 `completed`；
  未全完工 → `in_service`。`fulfillment` 数已完工 item / 总 item。
- 无工单：`checked_in`/`waiting`/`arrived` → `waiting`；`completed`/`paid`/`closed` → `completed`；
  否则 `booked`。
- `paymentStage` = `paymentStageFor(facts)`；`paid` = 阶段为 null 且至少一笔已结。
- `nextAction` = `queueNextAction({ stage, ticket })` —— **与看板同一函数**，
  多项目单不会被一键误完工（先 `start_item` 未开始项，再 `finish_item` 进行中项）。

**3. `nextActionLabelKey` 迁移**

从 `pages/queue/model.ts` 移到 `features/queue/nextAction.ts`（叶子模块），
签名从 `(action, item: KanbanItem)` 收成 `(action, { checkoutTiming? })`。
`model.ts` re-export 保持 `KanbanBoard.tsx` 导入不变（调用点已改传 `{ checkoutTiming: item.rawTicket?.checkoutTiming }`）。
抽屉与看板现在共用同一份文案函数。

**4. `AppointmentDrawer.tsx`**

服务页顶部（非终态时）加一张卡：
- 「履约」当前阶段徽章（`adStageBooked/Arrived/InService/ReadyCheckout/Completed`）
  + 「部分完成 N/M」（仅 `0 < done < total` 时）；
- 「收款」徽章：已结清 / 待收款 / 暂无待收（三色）；
- 「下一步: <动作文案>」+（非 blocked 时）「在看板处理」按钮 →
  `onClose(); navigate('/queue')`。命令执行仍由看板的分步弹窗负责
  （§6.4「优先抽取看板动作编排组件 / hook，再接详情；避免详情 import 整个 Queue 页」——
  本批用共享**纯推导** + 深链，不把 CheckIn/Start/Complete/Checkout 弹窗复制进抽屉）。

**5. i18n `schedule.ts`**：`adStageReadyCheckout` / `adStageCompleted` /
`adFulfillmentLabel` / `adPaymentLabel` / `adPaid` / `adPaymentDue` / `adPaymentNone` /
`adPartialDone` / `adNextStep` / `adGoToBoard`（+ 复用 `adStageBooked` 等）。5 语齐全。

### 明确未做 / 交接

- **看板动作编排 hook 的完整抽取**：`Queue.tsx`（2650 行）里的 CheckIn / Start / Finish /
  Checkout 弹窗编排未抽成独立 hook；抽屉走深链到 `/queue` 而非在抽屉内直接执行命令。
  「共用命令与校验」目前落在「共用推导 + 看板执行」这个边界上。
- **深链定位到具体卡片**：`/queue` 无 `?focus=<id>` 参数，跳过去是整块看板。
  加参数需要 Queue 支持卡片滚动 / 高亮，留作后续。
- **`allowedActions` 全量清单**：本批返回的是「下一步单个主动作 + 阻塞原因」
  （与看板主按钮一致），不是「所有可执行动作的数组」。次要动作（改期 / 加项 / 取消）
  仍是抽屉里各自的既有按钮，未纳入统一 DTO。
- **`ticket.number`**：`tickets` 表无日序号列，DTO 里恒为 `null`（占位）。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `@gf/api` / `@gf/web` `tsc --noEmit` | exit 0 |
| 纯函数单测 | `vitest run src/features/schedule/appointmentBoardState.test.ts` | 8 passed（取消/爽约非 booked、无工单 booked→check_in、多项目 start 未开始项、一完一未 finish 进行中、全完工待收款 ready_checkout+pay_combined、先服务后小费 pay_service、已付 completed、空工单非 done）|
| Web 全量单测 | `pnpm --filter @gf/web test` | 59 files / 333 passed |
| API 详情穿透 | `vitest run src/audit_fixes.test.ts` | 9 passed（`ticket` 字段未破坏既有断言）|
| 完整 `pnpm --filter @gf/api test` | isolated 库一次跑通 | 87 files / 1184 passed（无 flaky） |
| 守卫 | `pnpm lint:guards` | ✓ |

未做：浏览器 / 真机交互验证（抽屉 ↔ 看板双向同步；按计划 §12 / H 阶段单列）。

### 计划 §6.4 / T27–T29 对照

| 验收点 | 本批状态 |
|---|---|
| 枚举真实状态 + 一张共享映射表，不新增字符串状态机 | ✅ `deriveAppointmentBoardState` 复用 `queueNextAction`/`paymentStageFor`，无新枚举 |
| 详情顶部分开显示履约与付款状态；部分完成 N/M | ✅ |
| 后端 DTO 或共享纯函数返回 allowedActions 与不可执行原因；UI 与看板共用判断 | 🔸 共用「下一步 + 阻塞原因」纯函数 + 文案函数；全量 allowedActions 数组与命令编排 hook 未做（深链到看板执行）|
| T27 详情走完签到→服务→完成→结账，看板同步 | 🔸 详情显示每一步的下一动作并深链；实际执行在看板，双向 query 失效沿用既有 |
| T28 取消/爽约/空工单/部分完工：精确状态，无假完成 | ✅ 纯函数单测覆盖 |
| T29 先付后做/双终端重复点击：不重收不重复开单 | ✅ 推导层：`pay_service` 先于 `start_item`；命令幂等 / 并发沿用看板既有 |

### 回退

`git revert` 消费者 commit（抽屉 + `appointmentBoardState.ts` + `nextActionLabelKey` 迁移
+ i18n）与公共层 commit（`appointmentDetail.ts` 去 `ticket` 字段）。无数据 / 迁移改动。

---

## 批次 #12 — W0b：平台共享号短信 routingScope（U09 剩余 · 计划 §3.3）

**日期**：2026-09-07
**改动范围**：1 个新迁移 `sql/0115` + `packages/db/src/sms.ts`（`recordInboundSms` 重写 + 两个解析函数）+ `apps/api/src/telnyx/routes.ts::handleInboundSms`（收 webhook 后规范 E.164）+ `apps/api/src/queries/smsInbound.ts::loadInboundSms`（读冻结归属列）+ `apps/api/src/sms.test.ts`（4 新用例 + 1 既有用例改造）。未碰前端、未碰实时订阅（本就没有）。

### 这一刀解决了什么

批次 #1（`sql/0112`）把「发到门店专属线」的入站短信隔离到唯一 (org, location)，靠 RLS 现场调
`gf_sms_line_owner`。**平台共享号**（`TELNYX_SMS_FROM`，没有任何门店在 `phone_lines` 认领）仍回落
`sql/0079` 口径「发件号码是本店客户」——批次 #1 报告 §3.4 自己列的三个未做项：同 org 两店不隔离、
无法唯一归属的回复没有降级隐藏、归属靠现场反查（号码换绑后历史短信跟着新归属走）。

### 改了什么

**1. `packages/db/sql/0115_sms_inbound_routing_scope.sql`（新）**

- `sms_inbound` 补 5 列（**均无外键**——这是永不删除的凭据表，既有 from/to 也是裸文本；
  归属一旦冻结就与 `phone_lines` / 门店后续生命周期脱钩）：
  `routing_scope`（`store` / `platform` / `unresolved`）、`bound_line_id`、
  `resolved_org`、`resolved_location`、`resolved_at`。
- `gf_sms_line_owner(text)`：0112 的函数，返回列补 `line_id`（返回类型变了必须 `drop` 重建；
  0112 的策略引用了它，一并重建）。
- `gf_sms_outbox_owner(text)`（新，`SECURITY DEFINER` / `search_path=public` / 只授 `app_user`）：
  发件号码 → 对它发过站内短信的门店集合（去重，`limit 2`）。**恰好一行**时该回复唯一可归属。
- **历史行回填**（计划 §3.3「只在有可靠证据时回填」）：命中当前专属线 → `store`；
  否则恰好一家店对该发件号发过短信 → `store`；其余 → `platform`（系统关键词）/ `unresolved`。
  **不**按客户手机号批量归店。收窄方向：发到平台号的历史行，此前「发件人是本店客户」就能看，
  现在起只有拿到可靠绑定的那家店能看。
- 约束：`routing_scope` not null default `unresolved` + check；`routing_scope='store'` 时
  `resolved_org` / `resolved_location` 必非空；`unique (provider_id) where provider_id is not null`。
- SELECT 策略 `inbound_select_own` 重写为纯列比较，**不再现场反查**：
  `routing_scope='store' and resolved_org=app_org_id() and resolved_location=app_location_id()`。
  `platform` / `unresolved` 对**所有**租户不可见（按用户给出的降级许可，计划 §3.2.5）。
  INSERT 策略 `inbound_insert_platform`（0079）不变。

**2. `packages/db/src/sms.ts` `recordInboundSms`**

- 先 `normalizePhoneE164` 规范 from / to（`@gf/contracts`），解析不了退回原值。
- `resolveInboundRouting(from, to, intent)`：① `gf_sms_line_owner(to)` 命中 → `store` + 写
  `resolved_*` + `bound_line_id`；② 否则 `gf_sms_outbox_owner(from)` 恰好一行 → `store` + 写
  `resolved_*`；③ 其余 → `intent==='unknown' ? 'unresolved' : 'platform'`，`resolved_*` 全空。
- 落库**不用** `on conflict do nothing`：那会触发 SELECT 策略检查，而 `platform` / `unresolved` 行
  对任何租户不可见，会被误判成越权（本批踩到）。改为捕获唯一冲突 `23505` 当幂等成功 ——
  `sms_inbound_provider_id` 唯一索引仍然挡下重放，重放不增加未读、不重复通知。

**3. `apps/api/src/telnyx/routes.ts::handleInboundSms`**

验签已过（`verified()`）。`from` / `to` 先 `normalizePhoneE164` 再用 —— 归属与
`setSmsConsent` 都按字符串精确匹配号码，上游偶发非规范写法（缺 `+`、带分隔符）才不会误判。

**4. `apps/api/src/queries/smsInbound.ts::loadInboundSms`**

删掉「本店专属线号列表 + 本店客户号列表」两段拼查，改为直接
`where routing_scope='store' and resolved_org=… and resolved_location=…`（RLS 已保证一次，
这里是纵深防御第二道）。`customers` / `upcoming` 富化逻辑不变（仍按 `from_e164` 在 org 内查）。

### 明确未覆盖 / 交接给下一位

1. **「可靠且唯一的会话归属证据」目前只认 `sms_outbox`**：恰好一家店对该发件号发过站内短信
   （预约确认 / 提醒 / 前台手打），才把平台号回复归给那家店；≥2 家或 0 家 → 隐藏。
   计划 §3.2.4 禁止的「同号客户 / 存在未来预约 / 最近发过短信」都没用。若产品想要更强的
   会话线程绑定（reply-to 消息 ID），Telnyx 入站 payload 目前不带，需上游支持。
2. **历史 `sms_outbox` 无时间窗**：`gf_sms_outbox_owner` 全时段去重。一个号若先后属于两家店
   的客户，两家都发过 → 永远 `unresolved`。可接受（宁隐藏不串店），要更精细需加「最后 N 天」。
3. **平台运营的只读收件箱**：`platform` / `unresolved` 行现在对所有租户上下文不可见。
   若平台侧要审这些行做合规排障，需一个 `operator_only` 或 `SECURITY DEFINER` 的平台读路径
   （本批没做，原始行一条没删，供后续接）。
4. **E.164 规范化只在入口**：`recordInboundSms` 与 `handleInboundSms` 都规范了；既有历史行
   若上游曾写过非规范值，回填按原样字符串匹配，可能漏解析（收窄方向，安全）。
5. **`sms_consent` 仍平台级**：STOP / START 的同意状态处理未动（本就该平台级，docs/09 §5.1）。
   只是 `handleInboundSms` 现在传规范化后的 `from` 给 `setSmsConsent`。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移（本机 55322，先回退到 0114 再全新应用） | `MIGRATION_DATABASE_URL=<local> pnpm db:migrate` | `0115 … OK`；`✓ RLS 覆盖检查通过` |
| 短信套件 | `vitest run src/sms.test.ts` | 39 passed（含 T32 / T33 / T34×2 新增 + CANCEL 用例改造为走 outbox 绑定） |
| 相邻套件 | `vitest run src/sms_direct.test.ts src/telnyx` | 24 passed |
| DB 套件（含 `rls.test.ts` search_path 检查） | `pnpm --filter @gf/db test` | 9 files / 91 passed |
| 类型 | `@gf/db` / `@gf/api` `tsc --noEmit` | 全部 exit 0 |
| 守卫 | `pnpm lint:guards` | ✓ 全部通过 |
| 完整 API 套件（isolated 库一次跑通） | `pnpm --filter @gf/api test` | 87 files / 1188 passed（无 flaky） |

未做：浏览器 / 真机验证（本批不涉及浏览器路径）。未在 staging / 生产执行迁移。

### 计划 §3.4 / T31–T34 对照

| 验收点 | 本批状态 |
|---|---|
| T31 同手机号 A/B 两店，To=A 独立号仅 A 可见（API/RLS/日志） | ✅ 批次 #1 已过，本批未回归（`sms.test.ts` 既有用例仍绿） |
| T32 平台 START / 无法归属回复 → 门店均不可见；平台订阅处理不变 | ✅ 新用例：`routing_scope` 落 `platform` / `unresolved`，`loadInboundSms` + RLS 直查均 0 行 |
| T33 明确关联的预约发件 / 回复只目标店可见，不用最近联系人猜 | ✅ 新用例：恰好一家店发过 → 归该店；两家都发过 → 谁都看不到 |
| T34 同 org 多店、号码换绑、webhook 重试 | ✅ 换绑：改 `phone_lines.e164` 后历史短信仍归原店（读冻结列）、发到旧号的新短信不再归店；重试：同 `provider_id` 只落一行。同 org 两店由策略里的 `resolved_location` 保证（不只 `resolved_org`） |

### 回退

`git revert` 本 commit；`sql/0115` 的回退需手工：`drop policy inbound_select_own` → 重建 0112 版
（现场反查 + 客户回落）→ `drop function gf_sms_outbox_owner` → `gf_sms_line_owner` 去 `line_id` 列 →
`alter table sms_inbound drop column routing_scope, bound_line_id, resolved_org, resolved_location,
resolved_at` + 删 `unique (provider_id)`。回退会**重新打开**平台共享号上的同号跨店可见与
号码换绑历史漂移 —— 按计划 §3 这是明确不希望的方向。

---

## 批次 #13 — W3c：跨午夜营业的 day-offset（U03 剩余 · 计划 §6.1–§6.2）

**日期**：2026-09-07
**改动范围**：`apps/web/src/components/CreateAppointmentModal.tsx`（`resolveInitialDateTime` 加跨午夜尾段分支）+ `apps/web/src/lib/time.ts`（新纯函数 `wallSlotTarget`）+ `apps/web/src/pages/Schedule.tsx`（格子点击传相对营业日 00:00 的原始分钟数，经 `wallSlotTarget` 还原真实日历日）+ `CreateAppointmentModal.test.ts` / `time.test.ts`（+8 断言）。纯前端，无契约 / DB 改动。

### 这一刀解决了什么

batch #3 抽出的 `resolveInitialDateTime` 对「营业到次日凌晨、此刻墙上 01:30 门店仍在营业」
会因 `snapped(90) < openMin(600)` 把默认退回开门时间。且日历格子对 ≥ 24:00 的格子
（`minsToTime` 归一化成 "01:30"）把归一化钟点直接配营业日 → 提交的 `startsAt` 早一整天。

### 改了什么

**1. `resolveInitialDateTime`（`CreateAppointmentModal.tsx`）**

「目标日期就是今天」分支里，除了常规营业窗口，新增 `inCrossMidnightTail`：
`closeMin > 1440 && snapped < openMin && snapped + 1440 < closeMin` —— 把当前凌晨钟点
当作「昨日营业日 + 24h」判断是否仍在延长营业段内。命中则直接用当前钟点（配 `calendarToday`，
即凌晨那一刻的日历日），提交时 `wallMinutesToInstant` 得唯一时刻。尾段不套常规窗口那 30 分钟
余量（凌晨这头更在意「别把 01:45 的新建默认踢回 10:00」）。非跨午夜门店行为完全不变。

**2. `wallSlotTarget(businessDate, rawMinutes)`（`lib/time.ts` 新）**

`rawMinutes`（相对营业日 00:00，跨午夜可 ≥ 1440）→ `{ date, minuteOfDay }`：
`dayOffset = floor(raw / 1440)`，`date = shiftDate(businessDate, dayOffset)`，
`minuteOfDay = raw mod 1440`。例：营业日 09-07 的第 1530 分钟 → `{ '2026-09-08', 90 }`。

**3. `Schedule.tsx` 格子点击**

`timeSlots.map` 现在带 `slotIdx`，算出 `rawMins = DAY_START + slotIdx * 30`（不经 `minsToTime`
归一化）传给 `handleSlotClick`。`handleSlotClick` 签名 `timeString: string` → `rawMins: number`，
走 `wallSlotTarget` 还原真实日历日 + 当日钟点，再作为 `defaultDate` / `defaultTime` 交给弹窗。
营业时段外判定（`rawMins < storeOpenMin || rawMins >= storeCloseMin`）现在用原始分钟数，
凌晨延长段的格子不再被误判成营业时段外。

### 明确未覆盖 / 交接给下一位

1. **格子标签仍显示归一化钟点**（"01:30" 而非 "25:30"）：点击逻辑已用原始分钟数，
   仅显示层未改。若要让跨午夜网格更直观（连续 10:00→26:00 标注），是纯视觉改动，本批未做。
2. **DST × 跨午夜**：`resolveInitialDateTime` 只做分钟算术，真正的时刻构造在提交时由
   `wallMinutesToInstant`（已覆盖 DST，见 `time.test.ts`）完成，本批未改这条路径。
3. **浏览器 / e2e 未验**：需要一家 `closeMin > 1440` 的门店 + 冻结墙上时钟。
   建议 H 阶段给 `e2e/specs/business-day.spec.ts` 补「跨午夜门店凌晨从全局入口新建 →
   日期是次日日历日、钟点是当前」以及「点 25:30 格子 → startsAt 落在次日」两条。
4. **`Calls.tsx` 批准通话草稿**：batch #6 已把它从 UTC 日期改成 `instantToWallDate`，
   跨午夜槽位由 `wallMinutesToInstant` 自然处理，本批未再动。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter @gf/web exec tsc --noEmit` | exit 0 |
| 纯函数单测 | `vitest run src/lib/time.test.ts src/components/CreateAppointmentModal.test.ts` | 50 passed（time +4 跨午夜格子、modal +4 跨午夜尾段） |
| Web 全量单测 | `pnpm --filter @gf/web test` | 59 files / 341 passed |
| 守卫 | `pnpm lint:guards` | ✓ 全部通过 |

### 计划 §6.1–§6.2 / T13–T17 对照

| 验收点 | 本批状态 |
|---|---|
| T13 凌晨 cutoff 前全局新建用门店实际日历日 | ✅ batch #3 已修主体；本批补跨午夜门店此刻钟点不再退回开门 |
| T14 浏览器与门店时区不同 → startsAt / DB / 显示一致 | ✅ 不变（`instantToWallDate` + `nowWallHhMm` + `wallMinutesToInstant`） |
| T15 昨日日历 / 跨午夜格子 / 未来日：保留明确选中语义，格子 offset 不丢 | ✅ `wallSlotTarget` 把 ≥ 24:00 的格子还原到次日日历日 + 当日钟点 |
| T16 DST 缺失 / 重复钟点 | 🔸 沿用 `wallMinutesToInstant` 既有 DST 覆盖，本批未新增 DST 测试 |
| T17 弹窗编辑中 refetch / 切店不重置 | ✅ 不变（batch #2 的 `dirtyRef` 守卫） |

### 回退

`git checkout apps/web/src/components/CreateAppointmentModal.tsx apps/web/src/pages/Schedule.tsx` +
`lib/time.ts` 删 `wallSlotTarget` 及其测试、`CreateAppointmentModal.test.ts` 删跨午夜 4 条。
无数据 / 契约影响。

---

## 批次 #14 — W2 尾巴：`user.updateProfile` 技能改 ID-only（技师自助面）

**日期**：2026-09-07
**改动范围**：`packages/contracts/src/commands/profile.ts`（加 `skillIds`）+ `apps/api/src/handlers/profile.ts`（技能同步重写）+ `apps/api/src/queries/profile.ts`（DTO 加 `skillIds` / `skillDirectory`）+ `apps/web/src/features/profile/types.ts` + `apps/web/src/pages/Profile.tsx`（技能区改字典勾选）+ `apps/web/src/i18n/settings.ts`（+3 词条、-4 死词条）+ `profile_and_notifications.test.ts`（+1 用例、既有用例改造）。无 DB 迁移。

### 这一刀解决了什么

批次 #7 把 `staff.saveProfile` 的所有调用方收口成「只从本店技能字典按 ID 选、服务端不再据自由文本新建」，但**留了一个口子**：技师自助面 `user.updateProfile`（`handlers/profile.ts`）仍按自由文本解析，匹配不到就 `insert into skills` 现场建字典项。任何技师在「个人资料 → 接单设置」里敲一个新词就能往门店技能字典塞行。

### 改了什么

**1. 契约 `UpdateUserProfile`**：加 `skillIds: uuid[].optional()`。`skills` 自由文本保留但语义收窄（见 handler）。

**2. `handlers/profile.ts` 技能同步**（与批次 #7 `staff.saveProfile` 同一套）：
- `skillIds` 权威：校验全部属于本店 + `active`（或本人已关联的停用项），否则 `invalid_or_inactive_skill`。
- `skills` 自由文本：只按 `key` / 规范化 `name` 解析现存项，**删掉 `insert into skills`**；解析不到 → `unknown_skill`；停用且非已关联 → `invalid_or_inactive_skill`。
- 两者取并集后 `delete from staff_skills` 重建；`staff_profiles.skills` 反规范化数组按最终集合的 zh-Hans 名重写（读取层顺序保持一致）。

**3. `queries/profile.ts`**：`staffInfo` 加 `skillIds`（`staff_skills` 里的 id）+ `skillDirectory`（本店 `active` 技能 + 本人已关联的停用项，`{ id, name, active }`）。

**4. `Profile.tsx`**：删 `PRESET_SALON_SKILLS` / `PRESET_SKILL_LABEL_KEYS` / `presetSkillLabel` / 自定义技能输入框 / `handleAddSkill`；技能区改为「从 `skillDirectory` 搜索 + 勾选」，`skillIds` 状态，提交只发 `skillIds`。字典为空显示「先在门店技能设置里添加」提示（复用 `rotation.empDirectoryEmptyHint`）。

### 明确未覆盖 / 交接给下一位

1. **旧客户端仍可发 `skills` 自由文本**：契约保留该字段是为兼容；行为已收成「解析现存项，否则拒绝」。等所有端确认走 `skillIds` 后可在契约层移除 `skills`。
2. **技师端（`apps/tech` / TechProfilePage）只读展示技能**，未涉及编辑，本批未动。
3. **行业预设一键生成技能字典**（计划 §5.2）属 W1 向导，未做。
4. **`staff_profiles.skills` 反规范化数组**仍在维护（读取层 `legacy_skills` 排序依赖它）；长期可只靠 `staff_skills` + 查询侧 `jsonb_agg`。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `@gf/contracts` / `@gf/api` / `@gf/web` `tsc --noEmit` | 全部 exit 0 |
| 个人资料后端套件 | `vitest run src/profile_and_notifications.test.ts` | 14 passed（含新增「自由文本未知值拒绝 + 不新建字典」「对得上字典名/key 仍解析」） |
| Web 全量单测 | `pnpm --filter @gf/web test` | 59 files / 341 passed |
| i18n 完整性 | `vitest run src/i18n` | 7 passed |
| 守卫 | `pnpm lint:guards` | ✓ |

未做：浏览器 / 真机验证（Profile 页技能勾选需登录整套栈）。

### 回退

`git revert` 本 commit。契约去 `skillIds`；`handlers/profile.ts` 恢复旧自由文本 + 自动建项块；`queries/profile.ts` 去 `skillIds` / `skillDirectory`；`Profile.tsx` 与 `settings.ts` 恢复。无数据 / 迁移影响。

---

## 批次 #15 — 一批小改动（U04 分类栏窄屏下拉 / U11 iPad 生日未来日基准）

**日期**：2026-09-07
**范围**：两处独立小修，均纯前端、无契约 / DB 改动。

### 1. U04 — 服务分类筛选栏窄屏改下拉（计划 §7.2）

`apps/web/src/pages/Settings.tsx` 服务项目 tab：batch #6 只做了 `flex-wrap`。现在按 §7.2：
- **窄屏（`< sm`）**：原生 `<select>`（`sm:hidden`），选项 = 全部 / 可网约 / 加项 / 各分类，
  `max-w-[12rem]` 不挤走搜索框与主操作。
- **宽屏（`sm+`）**：单行横向滚动的 chip（`hidden sm:flex ... overflow-x-auto`，
  容器 `min-w-0 max-w-full`，chip `shrink-0 whitespace-nowrap`），不换行不裁切。

选项集合抽成一个 `catOpts` 数组，两种呈现共用同一份，值语义不变
（`all` / `online` / `addon` / `category:<id>`），`filteredServices` 过滤逻辑一字未改。

### 2. U11 — iPad 健康表生日未来日按门店日历今天判（计划 §9.2）

`apps/ipad/src/pages/HealthFormPage.tsx`：此前 `parseBirthdate` 不传 `today`，iPad 端完全
不判未来日（batch #10 交接项）。现在从 `useDeviceAuthOptional()?.storeInfo`（kiosk 配对后
一定在）取 `timezone`，用 `Intl.DateTimeFormat('en-CA', { timeZone })` 得门店**日历**今天
（`YYYY-MM-DD`，无营业日 cutoff、非设备 / UTC 日期），传给 `BirthdateField` 的 `today`
与提交前的 `parseBirthdate`。`timezone` 缺失时仍不传 `today`（不判未来，好过用设备日期）。

`context/DeviceAuthContext.tsx` 新增 `useDeviceAuthOptional()` —— 无 Provider（如被单测直接
挂载的子页）时返回 `null` 不抛错，`HealthFormPage.test.tsx` 无需引入整个 DeviceAuthProvider。

### 明确未覆盖 / 交接

- 分类栏窄屏用的是原生 `<select>`（有平台 type-ahead），不是全自定义可搜索 combobox；
  §7.2「可搜索下拉」的完整交互（大量分类时的筛选输入）留作后续。
- iPad `en-CA` locale 在所有目标 iPad Safari 上都产出 `YYYY-MM-DD`；已在 tsc + 单测覆盖逻辑，
  真机未验（按 §12 / H 阶段）。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `@gf/web` / `@gf/ipad` `tsc --noEmit` | exit 0 |
| Web 全量单测 | `pnpm --filter @gf/web test` | 59 files / 341 passed |
| iPad 全量单测 | `pnpm --filter @gf/ipad test` | 9 files / 20 passed |
| 守卫 | `pnpm lint:guards` | ✓ |

### 回退

`git checkout apps/web/src/pages/Settings.tsx apps/ipad/src/pages/HealthFormPage.tsx apps/ipad/src/context/DeviceAuthContext.tsx`。无数据 / 契约影响。

---

## 批次 #16 — W4 尾巴：拍照开店草案行支持「同时技师人数」（U04 / §7.2）

**日期**：2026-09-07
**改动范围**：1 个新迁移 `sql/0116` + drizzle schema + `@gf/ai`（`DraftItem` / `ServiceDraft` / `toServiceDrafts` + 测试）+ `packages/contracts/src/commands/blueprint.ts`（`draftItem` / `ReviewBlueprintItem` / `ReviewBlueprintItems`）+ `apps/api/src/handlers/blueprint.ts`（3 处：`saveExtraction` 入库、`reviewItem*` 更新、`apply` 落地）+ `apps/api/src/queries/blueprint.ts`（DTO）+ `apps/web/src/features/setup/ImportWorkspace.tsx` + `i18n/setup.ts`（+1 词条）+ `blueprint.test.ts`（+1 用例）。

### 这一刀解决了什么

计划 §7.2 / §7.1：`blueprint.apply` 建 `services` 时**根本没写 `staff_count`**，全部吃 DB
默认 1。价目表上印着「双人四手」的项目导入后只占一个技师容量，排期校验会放行本不该
放的单。批次 #6/#9 做了「批量设人数」但没打通导入草案这条链（handoff W4 交接项：
「blueprint 草稿模型无 `staff_count` 列 → 导入一律落 1」）。

### 改了什么

- **`sql/0116`**：`blueprint_items` 加 `staff_count integer`（**可空**）+ check `null or 1..5`
  （对齐 `catalog.saveService` 契约）。纯加列，不回填。`null` = 老板没在确认页设 → 落地按 1。
- **`@gf/ai`**：`DraftItem.staffCount?` / `ServiceDraft.staffCount`；`toServiceDrafts` 透传，
  变体继承所属项目的值。
- **契约**：`draftItem` 加 `staffCount`（`.nullable().default(null)`）；`ReviewBlueprintItem` /
  `ReviewBlueprintItems` 各加可选 `staffCount`，语义与 `durationMin` 一致（`undefined` = 不改、
  `null` = 清空回落 1），并计入 `editedAt` 判定。
- **handler**：`saveExtraction` 入库带 `staff_count`（模型一般不返回 → null）；两个 review handler
  `staff_count = case when provided then value else keep end`；`apply` 的 `select` 取 `staff_count`、
  `services` insert 写 `${draft.staffCount ?? 1}`。
- **前端**：`ImportWorkspace` 确认页每个非套餐行加一个 1–5 的「同时技师人数」输入，走
  `updateBlueprintItem`（自动进 `editedItemIds`）→ `blueprint.reviewItems` payload。

### 明确未覆盖 / 交接

1. **模型不推断双技师**：`staffCount` 不进提取 prompt（计划 §7.2「AI 无可靠依据时不猜双技师，
   交给店主确认」）—— 提取阶段恒为 null，只由老板在确认页设。
2. **套餐（package）行不设人数**：套餐落地走 `blueprint_packages`，不是 `services` 单行；
   套餐的技师人数由其绑定的成员项目决定，本批不在套餐行加输入。
3. **批量命令逐字段乐观锁**（`services.updated_at`）仍未做（handoff W4 另一项）。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移（本机 55322，回退到 0115 再全新应用） | `MIGRATION_DATABASE_URL=<local> pnpm db:migrate` | `0116 … OK`；`✓ RLS 覆盖检查通过` |
| `@gf/ai` 全量 | `pnpm --filter @gf/ai test` | 12 files / 123 passed（含 `toServiceDrafts` 透传新断言 + 既有断言补 `staffCount: null`） |
| blueprint 套件 | `vitest run src/blueprint.test.ts` | 20 passed（+1：确认页设 2 → `services.staff_count = 2`，没设 → 1） |
| 类型 | `@gf/contracts` / `@gf/ai` / `@gf/db` / `@gf/api` / `@gf/web` `tsc --noEmit` | 全部 exit 0 |
| Web 全量 + i18n | `pnpm --filter @gf/web test` / `vitest run src/i18n` | 59 files / 341 passed；i18n 7 passed |
| 守卫 | `pnpm lint:guards` | ✓ |
| 完整 API 套件（isolated 库） | `pnpm --filter @gf/api test` | 87 files / 1190 passed（无 flaky） |

未做：浏览器 / 真机验证（确认页需登录整套栈 + 传图）。未在 staging / 生产执行迁移。

### 回退

`git revert` 本 commit；`sql/0116` 回退：`alter table blueprint_items drop constraint
blueprint_items_staff_count, drop column staff_count`。落地行为回到「一律 1」。

---

## 批次 #17 — W3b 尾巴：详情「在看板处理」深链定位到具体卡片（U06 / §6.4）

**日期**：2026-09-07
**改动范围**：`apps/web/src/components/AppointmentDrawer.tsx`（navigate 带 `?focus=`）+ `apps/web/src/pages/Queue.tsx`（读 `?focus=`、4s 后自清）+ `apps/web/src/pages/queue/KanbanBoard.tsx`（`focusItemId` prop：滚动 + 高亮）。纯前端，无契约 / DB 改动。

### 这一刀解决了什么

批次 #11 让抽屉的「下一步」按钮深链到 `/queue`，但 handoff 明确「`/queue` 无 `?focus=<id>`
定位，跳过去是整块看板」——前台在几十张卡片里还得自己找刚才那位客人。

### 改了什么

- **抽屉**：`navigate('/queue')` → `navigate(\`/queue?focus=${appointmentId}\`)`。
- **Queue**：`useSearchParams` 读 `focus`，传给 `KanbanBoard`；4s 后 `replace` 掉该 query
  （高亮转瞬即逝，且再次点同一张卡能重新触发）。
- **KanbanBoard**：新增 `focusItemId` prop。匹配 `item.appointmentId`（或退回 `item.id`）的卡片
  挂 `ref`，`useEffect` 里 `scrollIntoView({ block: 'center', behavior: 'smooth' })`，
  并加 `ring-2 ring-teal-400 ring-offset-2` 高亮环。

### 明确未覆盖 / 交接（U06 §6.4 剩余）

1. **看板动作编排 hook 完整抽取**：`Queue.tsx`（~2670 行）的 CheckIn / Start / Finish / Checkout
   弹窗编排仍在页面里，抽屉走深链而非在抽屉内直接执行命令。这是纯结构重构、无行为变化、
   回归面大，未做。
2. **全量 `allowedActions` 数组**：抽屉返回的仍是「下一步单个主动作 + 阻塞原因」（与看板主按钮
   同一函数），次要动作（改期 / 加项 / 取消）仍是抽屉里各自的按钮。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm --filter @gf/web exec tsc --noEmit` | exit 0 |
| Web 全量单测 | `pnpm --filter @gf/web test` | 59 files / 341 passed |
| 守卫 | `pnpm lint:guards` | ✓ |

未做：浏览器验证（需登录 + 看板有卡片 + 开抽屉点「在看板处理」）。逻辑简单，
建议 H 阶段随抽屉 ↔ 看板双向同步一并回归。

### 回退

`git checkout apps/web/src/components/AppointmentDrawer.tsx apps/web/src/pages/Queue.tsx apps/web/src/pages/queue/KanbanBoard.tsx`。

---

## 批次 #18 — W4 收尾：批量编辑逐项乐观锁（U04 / §7.2）

**日期**：2026-09-07
**改动范围**：1 个新迁移 `sql/0117` + drizzle schema + `packages/contracts/src/commands/setup.ts`（`BulkUpdateServices` 加 `expectedVersions`）+ `apps/api/src/handlers/setup.ts`（版本比对）+ `apps/api/src/queries/settings.ts`（DTO 加 `updatedAt`）+ `apps/web/src/features/settings/types.ts` + `apps/web/src/pages/Settings.tsx`（提交带 `expectedVersions` + `stale_services` 文案）+ `i18n/settings.ts`（+1 词条）+ `catalogBulk.test.ts`（+2 用例）。

### 这一刀解决了什么

`catalog.bulkUpdateServices` 在确认页展示一批项目、老板勾选后提交。这中间若有别人改了
其中某项，批量提交会**悄悄覆盖**。`services` 表此前**没有任何版本 / 时间戳列**。

### 改了什么

- **`sql/0117`**：`services` 加 `updated_at timestamptz not null default now()` + 通用触发器函数
  `gf_touch_updated_at()`（`before update` 挂到 `services`）。**任何** UPDATE 路径
  （SaveService / 批量 / blueprint 落地 / archive…）都自动推进它，不用各改法各记时间。
- **契约**：`BulkUpdateServices` 加 `expectedVersions: Record<uuid, string>`（可选，serviceId → ISO
  `updatedAt`）。不传 = 不校验（向后兼容）。
- **handler**：取 `for update` 锁行时一并取 `updated_at`；`expectedVersions` 给出的项目里，
  版本与当前不一致的收集成 `stale`，非空即整批 `VALIDATION_FAILED { reason: 'stale_services',
  serviceIds }`（在任何写之前，天然全批回滚）。
- **前端**：`ServiceItem` DTO 加 `updatedAt`；`Settings.tsx` `runBulk` 从选中项目对象收集
  `expectedVersions` 一起提交；catch 到 `stale_services` 提示「刚被别人改过，刷新重试」。

### 明确未覆盖 / 交接

1. **`stale_services` 只拒绝、不合并**：按 §7.2「拒绝旧版本覆盖**或**显式合并」取前者。
   前端提示后由老板重新加载再操作，没有做逐字段三方合并 UI。
2. **单项 `SaveService` 无乐观锁**：单项编辑仍是「后写胜」。本批只给批量加锁（批量是
   「预览-勾选-提交」有时间窗的那条）。要给单项加需另配 `expectedVersion` 入参。
3. **触发器只挂了 `services`**：`gf_touch_updated_at()` 是通用函数，别的表要同款行为可直接复用。

### 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 迁移（本机 55322，回退到 0116 再全新应用） | `MIGRATION_DATABASE_URL=<local> pnpm db:migrate` | `0117 … OK`；`✓ RLS 覆盖检查通过` |
| 批量编辑套件 | `vitest run src/catalogBulk.test.ts` | 10 passed（+2：期间被改 → `stale_services` 整批拒绝无部分写、用新版本重取可提交；触发器推进版本） |
| 相邻套件 | `vitest run src/settings_enhancements.test.ts` | 14 passed |
| 类型 | `@gf/contracts` / `@gf/db` / `@gf/api` / `@gf/web` `tsc --noEmit` | 全部 exit 0 |
| Web 全量 + i18n | `pnpm --filter @gf/web test` / `vitest run src/i18n` | 59 files / 341 passed；i18n 7 passed |
| 守卫 | `pnpm lint:guards` | ✓ |
| 完整 API 套件（isolated 库） | `pnpm --filter @gf/api test` | 87 files / 1192 passed（无 flaky） |

未做：浏览器验证。未在 staging / 生产执行迁移。

### 回退

`git revert` 本 commit；`sql/0117` 回退：`drop trigger services_touch_updated_at on services;
drop function gf_touch_updated_at(); alter table services drop column updated_at;`。
批量编辑回到「无版本校验、后写胜」。

---

## 会话交接 —— 批次 #7–#11 之后剩余（给下一位）

本轮会话完成 W2 / W2b / W4 / W6a / W6b(U11 部分) / W3b(U06)，`main` HEAD = `d61ebc2`。
用户明确：**U01 向导重构、U12 全端 iPad、U10 套餐另找 AI**。本轮 5 项里还差 2 项没做：

### 1. U09 剩余 —— 平台共享号短信 routingScope（W0b，计划 §3.3）

> **✅ 已在批次 #12 完成**（`sql/0115`）。下面是当时的现状记录，保留供追溯；
> 批次 #12「明确未覆盖」列了新的交接点（平台运营只读收件箱、`sms_outbox` 时间窗等）。

**未动**。本轮只读了代码，没写迁移。现状：
- `sms_inbound` 表（`sql/0034` 建，`sql/0079` + `sql/0112` 收窄 SELECT）**只有**
  `from_e164 / to_e164 / body / intent / provider_id / received_at`，**没有归属证据列**。
- `sql/0112` 的 `gf_sms_line_owner()` 已把**专属线**（`phone_lines.purpose in ('ai_voice','sms')`）
  隔离到唯一 (org, location)；平台共享号仍回落「发件号码是本店客户」——
  同 org 两店不隔离、无预约新客咨询要走这条、无法唯一归属的回复没有降级隐藏。
- 写入路径：`apps/api/src/telnyx/routes.ts::handleInboundSms` → `packages/db/src/sms.ts::recordInboundSms`
  （直接 `insert into sms_inbound (from_e164,to_e164,body,intent,provider_id)`，**未规范化 E.164**，
  `to` 取 `payload.to[0].phone_number`）。
- **读路径**：全仓只有 `apps/api/src/queries/smsInbound.ts::loadInboundSms` 一条
  （Messages / CommunicationLogs 两页都走它），无实时订阅、无搜索/导出消费者、无独立通知写入
  （batch #1 已确认，见批次 #1「明确未覆盖」）。
- `provider_id` 去重：`sql/0034` 无 `sms_inbound` 唯一约束 —— webhook 重放会插重复行。
  routingScope 迁移里应一并加 `unique (provider_id) where provider_id is not null`。

要做（计划 §3.3）：新迁移给 `sms_inbound` 加 `routing_scope`（store/platform/unresolved）、
`bound_line_id`、`resolved_org` / `resolved_location`、`resolved_at`；`recordInboundSms` 收 webhook 后
先规范 E.164 再解析 To、**落库即定归属**（`gf_sms_line_owner` 命中 → store + 写 resolved；
平台号有唯一会话/预约证据 → store；否则 platform / unresolved）；重写 `inbound_select_own` 策略
与 `loadInboundSms` 都读 `resolved_org = app_org_id() and resolved_location = app_location_id()`；
`unresolved` / `platform` 不显示在店铺端。号码换绑：归属已冻结在行里，不再查 `phone_lines` 当前值。
验收 `T32`–`T34`（`T31` batch #1 已过）。

### 2. U03 剩余 —— 跨午夜营业 day-offset（W3c，计划 §6.1–§6.2）

> **✅ 已在批次 #13 完成**（`resolveInitialDateTime` 尾段分支 + `wallSlotTarget` + Schedule 格子）。
> 剩：格子标签仍显示归一化钟点、浏览器 / e2e 未验（见批次 #13「明确未覆盖」）。

**未动**。batch #3 抽出的纯函数 `resolveInitialDateTime`（`apps/web/src/components/CreateAppointmentModal.tsx`，
已 export，有 `CreateAppointmentModal.test.ts`）对「营业到次日凌晨、此刻墙上 01:30 仍属今天营业」
会因 `snapped(90) < openMin` 退到 `openMin`。需处理 `closeMin > 1440` 的 day-offset 语义、
日历格子传真实日期还是明确 offset（不把营业日直接当 `startsAt` 的日期）。复现矩阵见计划 §6.2。
可扩展 `e2e/specs/business-day.spec.ts`。验收 `T13`–`T17`。

### 3. 本轮各批次留下的次要项（非阻塞，随相关大包做）

- **W2**：~~`user.updateProfile` 技师自助改本人技能仍自由文本 + 自动建 `skills`~~ —— **✅ 批次 #14 完成**
  （契约加 `skillIds`、handler 收成「解析现存项 / 否则拒绝」、`Profile.tsx` 改字典勾选）。行业预设一键生成属 W1。
- **W4**：~~blueprint 草稿人数编辑器~~ **✅ 批次 #16**；~~服务分类栏窄屏下拉~~ **✅ 批次 #15**；
  ~~批量命令乐观锁~~ **✅ 批次 #18**（`sql/0117` 加 `services.updated_at` + 触发器，
  `bulkUpdateServices` 收 `expectedVersions`，漂移则 `stale_services` 整批拒绝）。**W4 全清。**
- **W6a**：~~iPad 健康表没有门店 `today` → 不判未来日~~ **✅ 批次 #15**
  （`HealthFormPage` 从 `storeInfo.timezone` 用 `Intl` 取门店日历今天，传 `BirthdateField.today` + `parseBirthdate`）。
  健康表模板目前无 `date` 题型，新增时复用 `BirthdateField` + `@gf/contracts.parseBirthdate`。
- **W3b（U06）**：~~`/queue` 无 `?focus=<id>` 定位~~ **✅ 批次 #17**（抽屉带 `?focus=`，
  KanbanBoard 滚动 + 高亮）。剩：`Queue.tsx`（~2670 行）的 CheckIn/Start/Finish/Checkout 弹窗编排
  未抽成 hook（纯结构重构、回归面大）；返回的仍是「下一步单动作 + 阻塞原因」不是全量
  `allowedActions` 数组。
- **W1 / W5 / W6b / W7**：本轮完全未碰（W5 仅 batch #6 小修）。

### 环境备忘（同交接文档 §0）

下一个迁移号 `0115`（`0114` 已用）。跑迁移到本地必须显式覆盖 `MIGRATION_DATABASE_URL` /
`APP_DB_PASSWORD` 指向本机 55322，否则命中 staging。API 集成测试
`DATABASE_TEST_TARGET=isolated pnpm --filter @gf/api exec vitest run <file>`。

---

## 会话交接 —— 批次 #12–#18 之后（第二轮，给下一位）

用户指令：「除了 U01 / U12 / U10 另找 AI，其余全改」。本轮把 #7–#11 交接单里的
**两大项 + 全部次要项**做完，`main` HEAD = `74f1045`。逐项：

| 项 | 批次 | 迁移 |
|---|---|---|
| U09 平台共享号 routingScope（W0b） | #12 | `sql/0115` |
| U03 跨午夜营业 day-offset（W3c） | #13 | — |
| `user.updateProfile` 技能 ID-only（W2 尾） | #14 | — |
| U04 分类栏窄屏下拉 + iPad 生日 today（W4 / W6a 小修） | #15 | — |
| blueprint 草稿「同时技师人数」（W4 尾） | #16 | `sql/0116` |
| 详情「在看板处理」`?focus=` 定位（U06 尾） | #17 | — |
| 批量编辑逐项乐观锁（W4 收尾） | #18 | `sql/0117` |

下一个迁移号 **`0118`**。

### 唯一剩下没做的（本轮判定为「大改动、无浏览器验证路径、零用户可见收益」，故不硬做）

**看板动作编排 hook 完整抽取（U06 / §6.4）**：`Queue.tsx`（~2670 行）里的
CheckIn / Start / Finish / Checkout 四个弹窗的编排状态与 handler 仍在页面里。理想是抽成
`useQueueActions()` hook，让预约详情抽屉能直接调用同一套命令编排（而不是像 #17 那样深链跳
`/queue`）。**没做的理由**：这是纯结构重构、零行为变化，而 `Queue.tsx` 状态极密、
现有测试对弹窗编排覆盖浅，抽错一处会静默弄坏整个操作板，本会话又没有登录整套栈的浏览器
验证路径。深链方案（#17）已把「详情 → 看板执行」这条路打通到可用。

**连带项**：详情返回的仍是「下一步单个主动作 + 阻塞原因」（与看板主按钮同一函数），
不是全量 `allowedActions` 数组 —— 次要动作（改期 / 加项 / 取消）仍是抽屉里各自的按钮。
这一项依赖上面的 hook 抽取，一起做。

入口：`apps/web/src/pages/Queue.tsx`（`checkInModal` / `startServiceModal` / `completeServiceModal` /
`checkoutModal` 四组 state + `handleConfirmCheckIn` 等）、`apps/web/src/pages/queue/modals/*`、
`apps/web/src/components/AppointmentDrawer.tsx`（`adGoToBoard` 按钮那块）。


## U01 / S1 — 2026-09-08：实施前盘点与接口设计

用户授权开始第一步。基线 `26bc57b`；仅文档变更，业务重构尚未开始。

- 计划与实时状态：[`2026-09-08-u01-setup-refactor.md`](2026-09-08-u01-setup-refactor.md)。
- 逐路径盘点、设计决策、下一步和回退：[`2026-09-08-u01-s1-inventory.md`](2026-09-08-u01-s1-inventory.md)。
- 发现：健康表实际使用 mockData 中的行业预设，旧 presets.ts 非页面事实源；resource.save.active 被 handler 忽略；SavePhoneLine 为 settings.manage 可调用，不能声称平台专用绑定已落实。
- 基线验证：contracts healthForms/phone 共 12 项，web setup flow 4 项通过。它们验证当前实现，T01–T07 仍未执行。
- 未覆盖：数据库连通性、真实旧店数量、API/DB 集成、浏览器和真实电话。未迁移、重置、部署或推送。
- S2 已完成：共享 readiness、房间门禁、同店类型验证与并发保护；下一步 S3 健康表首发。

### 2026-09-08 / U01 S2：统一开店检查、房间门禁与并发保护

- 共享七步 readiness 契约与服务端 loader 已落地，GET 查询和 FinishSetup 不再各自复制 SQL 判断。
- setup→active 新增有效房间硬门槛；有效房间严格限定 room/vip/couples_room、正容量和非 maintenance 已知状态；可排员工只计 active membership。
- 开店、资源保存、人工维护和删除使用同一门店事务锁，保证竞争结果只能是“先停用则开店失败”或“先开店则停用失败”。
- active 店禁止删/停最后一间有效房间；旧 active 零房店不降级，只给结构化修复提示；force 仍不能越过当前占用与最后房门禁。
- resourceTypeId 增加同店显式校验；resource.save 的 active 字段不再静默吞掉。
- isolated 验证共 104 项通过（contracts 63、signup/rooms 26、settings route 15；另 workstations 15 项回归通过），contracts/API/web 类型检查通过。未迁移、未部署、未访问线上库。
