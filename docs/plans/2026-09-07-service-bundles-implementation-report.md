# 组合项目套餐：实施报告

计划：`docs/plans/2026-09-07-service-bundles-implementation.md`
状态：**后端 P0–P8 + 前端全链路完成**（见 §11：目录 CRUD / 看板分组 / 结账视图 / B14 拆单 /
官网预约 / B02 导入分流 / 通知模板 / 目录 CRUD 的浏览器 E2E）。本地 55322 后端全绿
（`@gf/api` 除预存在的 `copilot/acceptance.test.ts` 5 例外全过，见 §6），typecheck 16/16 + guards 绿；
前端 `@gf/web` / `@gf/booking` typecheck + build + 单测绿。
剩：整链浏览器 E2E（booking → 看板 → 结账，种子重、留手测）、ipad / kiosk 触屏。
0118 迁移仅在本地，未上 staging / 生产（上线 / 回退见 §8）。

---

## 0. 基线

- 分支：`main`，起始 `440cd0a`。开工前 `git status` 干净。
- 既有实现：**零**。全仓无 `service_bundle*` / `orderBundle*` 代码，只有计划文档
  （`fc78cbf` 加入）。记忆中 U10 曾划给「另一个 AI」，本轮由用户改派。
- 未做：未查询生产数据、未跑破坏性 DB 测试、未部署、未迁移生产。

---

## 1. 采用的模型（相对计划的取舍）

| 计划建议 | 本轮采用 | 说明 |
|---|---|---|
| `service_bundles` | ✅ 同名 | 目录模板：org/loc、i18n 名称+描述、`price_cents`、`online_bookable`、`version`、`active`、`sort`、`updated_at`（触发器）。 |
| `service_bundle_components` | ✅ 同名 | `id` 即稳定 component_id；`service_id`、`qty(1–20)`、`seq`、`included_addon_ids uuid[]`。 |
| `order_bundle_instances` 关联 appointment/ticket | ✅ 采用「单行双归属」 | 一行同时可挂 `appointment_id` 与 `ticket_id`，预约转工单保留同一实例身份（计划 §5.2 首选方案）。`check` 至少一个非空。 |
| 实例快照字段 | ✅ | `template_version`、`name_snapshot`、`original_total_cents`、`bundle_price_cents`、`discount_cents`、`extra_discount_cents`、`source`、`status(active/split/cancelled)`。历史财务字段不随模板更新重写。 |
| `appointment_items` / `ticket_items` 加可空关联列 | ✅ | `bundle_instance_id`(FK, on delete set null)、`bundle_component_id`、`bundle_unit_index`、`bundle_list_price_cents`。全部可空，普通历史行为空。 |
| 「不按数组 seq / service_id 配对」 | ✅ 部分唯一索引 | `(bundle_instance_id, bundle_component_id, bundle_unit_index)` 在两张 items 表上唯一（where instance not null）——一个执行单元最多映射一条 item。 |
| 币种字段 | ❌ 省略 | 系统单币种（USD），既有 tickets/payments 无币种列，套餐实例不引入。 |
| 独立 `services` 虚拟父项 | ❌ 不建 | 计划 §5.1 明确反对。套餐父分组仅存在于 `order_bundle_instances`，无收款行、不占资源、不计轮。 |
| 唯一共享分摊实现 | ✅ 新纯函数 `allocateBundle`（`packages/payroll/src/bundle.ts`） | 与 `split.ts` / `commission.ts` / `tip.ts` 同处（本包即「差一分就吵架」的钱算术包）。**未新建 `@gf/pricing`**：零新 workspace 布线。分摊方法见「决策 #1」——不复用 `largestRemainderSplit`。 |
| 分摊取整（决策 #1，**已定**） | ✅ 按原价权重摊内建优惠，下取整 + 余数给 seq 末几项 | 复现计划 §6.1 示例表与 B20 / B32 的字面数字（A=8824 / C=1764，退 C=1764、剩余 13236）。零价子项不接余数。用户指示「按大多数店」——1 分落点店主无感，以规格验收数字为准。 |
| 额外优惠是否叠套餐（决策 #2，**已定**） | ✅ 按优惠类型分 | `extraDiscountKind`：`manual`（默认，店主/前台手动折扣）作用于套餐子项＋额外加项 —— 覆盖「$150 套餐再减 $20 = $130」的常见场景；`coupon`（优惠券/自动促销）只摊额外加项，不叠套餐价（计划 §4.5）。 |
| 套餐错误码 | ✅ 用 `VALIDATION_FAILED` + `details.reason` 判别串 | 未新增 `ERROR_CODES` 枚举项：新增一项需同步 `httpStatusFor`、`errorMessage.ts`、`common.ts`（五语言），面过大且风险高。`details.reason` 判别串是仓库既有惯例（marketing / ticket handler）。reason 取值见 `packages/contracts/src/commands/bundle.ts` 头注释。 |

---

## 2. 入口矩阵（P0 交付 · 只读代码审查所得，执行 P2–P8 时须复核）

| 链路 | 关键文件 | 现状 / 套餐需要做的改动 | 计划阶段 |
|---|---|---|---|
| AI 识别 | `packages/ai/src/prompt.ts:40`、`schema.ts:33/110`、`normalize.ts:32` | **Combo 与 Sessions 都进 `kind='package'`**，携带 `package_sessions` / `package_service_names` / `package_valid_days`。P2 需把「固定组合」与「按次核销」分流，或加 `kind` 子类型。 | P2 |
| 导入契约 | `packages/contracts/src/commands/blueprint.ts:23/36/222/276`，`apps/api/src/handlers/blueprint.ts` | `blueprint_items.kind` 已含 `'package'`（sql/0104）。`createdPackageIds` 出现在发布输出。P2：发布按 bundle/package/addon 分流，普通服务先解析再建套餐，事务回滚 + 重试幂等。 | P2 |
| 导入 UI | `apps/web/src/features/setup/ImportWorkspace.tsx` | 现按 sessions + 项目名输入。P2：加组成/数量/加项/总价结构化字段，未解析组成显示待补全，同名歧义强制选 ID。 | P2 |
| 项目配置契约 | `packages/contracts/src/commands/setup.ts:11`（`SaveService`）、`apps/api/src/handlers/setup.ts:24` | 服务模型有 `isAddon`、`staffCount(1–5)`、`requiredSkillIds`，**无组合组成关系**。新 `bundle.saveTemplate` / `bundle.archiveTemplate` 契约已加（本轮），handler 待 P2。 | P2 |
| 服务/预约表 | `packages/db/src/schema/scheduling.ts`（services / appointments / appointment_items） | `appointment_items` 有 `addon_ids uuid[]`、`price_cents_snapshot`、`duration_min`、`seq`。本轮已补 4 个可空 `bundle_*` 列。 | P1✅ |
| 预约创建计价 | `apps/api/src/handlers/appointment.ts:244-288` | 主项 + add-on **价格累加**、时长「显式给 `durationMin` 就以它为准，否则累加」。P3：套餐走 `allocateBundle` 展开，不依赖前端展开。 | P3 |
| 公开预约计价 | `apps/api/src/public/routes.ts`（自有 `priceAndDuration`，约 1014 行） | 与内部创建**分叉的**第二套累加逻辑。P3/P6 须统一接入套餐解析，避免二次分叉。 | P3/P6 |
| 开单继承 | `apps/api/src/handlers/ticket.ts:83`（`recalcTotals`）、`:142-172`（从 appointment_items 快照） | `recalcTotals` = `sum(ticket_items.total_cents)` 直接写 `subtotal_cents` 与 `total_cents`。开单校验预约与工单 item 的 `service_id` 顺序完全一致、`price/minutes` override 与快照一致。P3：转工单按 `(instance, component, unit_index)` 稳定映射继承实例；P6 计价适配。 | P3 |
| 折扣/次卡/退款 | `apps/api/src/handlers/ticket.ts:495-580`（次卡覆盖 + 提成基数）、`:1019-1296`（退款 + 提成冲销） | 次卡按 `service_id` 匹配 `ticket_items` 覆盖；退款校验 `refund_cents + amt <= total_cents`，按 `subtotal - discount` 算服务净额。P5：次卡不默认覆盖套餐子项；退款按分摊后净额。 | P5 |
| 提成分摊 | `packages/payroll/src/commission.ts`、`split.ts`（`largestRemainderSplit`、`distributeBuckets`） | 已有唯一整数分拆实现。`packageCommissionBasis` 是**次卡**的开关，计划 §4.5 明确**不复用**它作套餐开关。 | P5 |
| 看板 | `apps/api/src/queries/queue.ts`、`apps/web/src/pages/Queue.tsx`、`pages/queue/` | 项目级执行动作 + 看板阶段。P4：卡片套餐分组 + 进度、动作弹窗理解套餐关系，父分组不重复占资源/计轮。 | P4 |
| 结账（两入口） | `apps/web/src/pages/Checkout.tsx`、`pages/queue/modals/CheckoutModal.tsx`、`apps/api/src/handlers/ticket.ts` 结账段（`:617-990`） | 已有折扣、次卡覆盖、分阶段付款、组单结账、退款。P5：两入口金额一致，组合优惠与额外折扣分开记。 | P5 |
| 迁移执行 | `packages/db/src/migrate.ts` | 手写 SQL 目录 `packages/db/sql/NNNN_*.sql`（drizzle-kit 生成物停在 0010，实际建表全走手写 SQL）。新增 `0118_service_bundles.sql`。 | P1✅ |
| 命令注册 | `packages/contracts/src/registry.ts` | `COMMAND_REGISTRY` 单一事实来源；`BUNDLE_COMMANDS` 已接入 `ALL`。`bundle` 前缀**未**加入 `COPILOT_OPERATIONAL_PREFIXES` —— 副驾集成属 P6。 | P1✅ / P6 |

**尚未补查（P2–P8 执行者必做）**：改期/改项/删除/回退 handler 全量、queue 动作规则、税费引擎接入点、优惠券分摊、日报/CSV、通知模板、健康表匹配的 service_id 聚合、AI 工具链、kiosk 调用链。

---

## 3. 字段口径表（P0 交付）

| 字段 | 所在 | 现含义 | 套餐接入注意 |
|---|---|---|---|
| `ticket_items.unit_price_cents` / `total_cents` | 工单行 | 行金额；`total_cents` 参与 `recalcTotals` 求和 | 套餐子项写**分摊后净额**进 `total_cents`；原价另存 `bundle_list_price_cents`，收据展示「原价/套餐价」用它，不参与求和 |
| `ticket_items.discount_cents` | 工单行 | 行级折扣，参与提成基数计算（`ticket.ts:716-728`） | 套餐内建优惠**不**写这里（否则与已压低的 `total_cents` 叠加 → 二次打折）；额外整单折扣分摊到行才写这里 |
| `tickets.subtotal_cents` / `total_cents` | 工单 | `recalcTotals` 两者都置为 `sum(ticket_items.total_cents)` | 若 `total_cents` 已是套餐净价，下游 `discount_cents` 不得再含同一笔套餐优惠 |
| `appointment_items.price_cents_snapshot` | 预约行 | 主项 + add-on 累加后的快照；开单原样继承 | 套餐子项此值 = `allocateBundle` 的 `bundleNetCents`（未含额外优惠）；额外优惠在结账层分摊 |
| `order_bundle_instances.discount_cents` | 套餐实例（新） | = `original_total_cents − bundle_price_cents`（DB check 强制） | 套餐**内建**优惠，与 `extra_discount_cents`（额外整单优惠分摊）分开记 |
| `packageCommissionBasis` | 门店薪酬配置 | **次卡**提成基数开关 | 计划 §4.5：**不复用**为组合套餐开关 |

---

## 4. 决策记录（用户指示「按大多数店来，需要自定义就做成可配」）

### 决策 #1 —— 分摊取整规则 · **已定**

规格 §6 正文写「最大余数法」，但 §6.1 示例表与 **B20 / B32** 验收用例硬断言
具体数字（`A=8824 / B=4412 / C=1764`；退 C = 1764、剩余套餐 13236）。这组数字
对应的是「**按原价权重摊内建优惠 → 下取整 → 余数一分一分分给 seq 末几项（跳过
零价子项）**」，不是严格最大余数法（后者对该例给 `[8823, 4412, 1765]`）。

采用**匹配规格验收数字**的规则：`allocateBundle` 按此实现，`largestRemainderSplit`
（提成 / 小费 / 组单收款用的最大余数法）不复用于套餐。理由：对店主而言 1 分
落在哪个子项无感，而 B20/B32 是白纸黑字的验收标准，P5 不必再返工。
`bundle.test.ts` 直接断言 `[8824, 4412, 1764]` 与「退 1764 / 剩 13236」。

### 决策 #2 —— 额外整单优惠按类型区分是否叠加到套餐子项 · **已定**

规格 §4.5 同时说了两件事：「默认套餐部分不自动叠加**优惠券**」＋「**权限允许的
手动优惠**可以应用，记录原因，服务端检查范围和上限」。所以按优惠类型分：

- `extraDiscountKind='manual'`（**默认**）—— 店主 / 前台权限内的手动折扣 / 抹零。
  **作用于套餐子项 ＋ 额外加项**，按各子项净额权重分摊。这正是店主说的
  「$150 套餐再给你减 $20，收 $130」——`extraDiscountCents = 2000`，摊到
  A/B/C 上（提成 / 退款 / 报表按分摊后净额结算）。范围 / 上限由服务端按权限校验（P5）。
- `extraDiscountKind='coupon'` —— 优惠券 / 自动促销。**只摊到额外加项净额**，
  不与套餐价叠加。

`bundle.quote` 入参 `extraDiscountKind`（默认 `manual`）。`bundle.test.ts` 有
「$150 → $130」默认用例与 `coupon` 不叠加用例。

### 决策 #3 —— AI 识别的 Combo / Sessions 分流 · **已实现启发式（`packages/ai`）**

`normalize.ts` 加 `classifyPackageKind(sessions, serviceNames)` + `DraftItem.packageKind`
（`bundle` / `sessions` / `ambiguous`，仅 `kind='package'` 行）：去重后 ≥ 2 项且次数 ≤ 1 →
`bundle`；次数 ≥ 2 且去重后 ≤ 1 项 → `sessions`；其余 `ambiguous`。**只标不改 `kind`**，
发布分流由 P2 blueprint publish 消费（前端排期）。`normalize.test.ts` 1 例。下方为原始建议：

现状两者同为 `kind='package'`。建议启发式（P2 在 `packages/ai` 落地）：
`package_sessions >= 2` 且 `package_service_names` 去重后 ≤ 1 项 → 次卡（预付资产）；
`package_sessions <= 1` 且 `package_service_names` ≥ 2 项 → 固定组合（bundle）；
两者都不满足 → 保留草案让店主选，不猜。本轮不改 `packages/ai`（P2 范围）。

---

## 5. 每阶段状态

### P0 · 代码复核与口径冻结 —— ✅ 完成

- [x] 读约束、记基线、枚举入口（见 §2）与测试位置。
- [x] 明确旧字段含义与消费者（见 §3），特别是折扣 / 提成 / 退款 / 支付阶段。
- [x] 确定实例生命周期（单行双归属）、加项明细存法、字段映射。追加结算方案留 P5。
- [x] 记录与规则的分歧并按「大多数店」定调（见 §4：#1 分摊取整、#2 优惠叠加已定；#3 Combo/Sessions 分流留 P2）。

### P1 · 模型 / 迁移 / 契约 / 纯计价 —— ✅ 完成（本地隔离库 55322 已验证）

- [x] 新表 + 快照 + 约束 + RLS + 索引 + 迁移文件：`packages/db/sql/0118_service_bundles.sql`。
- [x] drizzle schema：`packages/db/src/schema/bundles.ts`（+ `schema/index.ts` 导出）；
      `appointment_items` / `ticket_items` 补 4 个可空 `bundle_*` 列。
- [x] 空库 / 升级兼容：全 `create/alter ... if not exists`，纯加法，既有行不动。
- [x] 共享展开 + 整数分摊纯函数：`packages/payroll/src/bundle.ts`
      （`allocateBundle` / `refundableForUnit` / `BundlePricingError`）。
- [x] 纯函数测试 `packages/payroll/src/bundle.test.ts`（21 例）+ 迁移测试
      `packages/db/src/serviceBundles.migration.test.ts`（RLS 强制、列可空、既有行不动、
      check 约束拒绝、跨租户隔离、整文件可重放）—— **均已在本地 55322 跑通**。
- [x] `0118` 已应用到本地 55322（迁移测试的 finally 重放并登记 `_migrations`）。

### P2 · 目录管理 + 报价 —— ✅ 后端完成（本地库已验证）；导入 UI / 向导待前端排期

- [x] 契约 `packages/contracts/src/commands/bundle.ts`：`bundle.saveTemplate` /
      `bundle.archiveTemplate`（命令，接入 `registry.ts` 的 `BUNDLE_COMMANDS`）。
      `bundleQuoteRequest` / `bundleQuoteResult` 保留为共享类型。
- [x] **`bundle.quote` 不做成命令** —— 命令总线强制每条命令留审计，报价会被前端
      预览高频调用。改为只读查询 `apps/api/src/queries/bundle.ts::quoteBundle`
      （载入目录快照 + `allocateBundle`），创建 / 结账链路 P3–P5 直接调它。
- [x] handler `apps/api/src/handlers/bundle.ts`：saveTemplate（组成/加项校验、
      原价合计、`priceCents ≤ 原价`、编辑递增 version + `expectedVersion` 乐观锁、
      组成 delete+reinsert、审计 before/after）、archiveTemplate（软下架）。
      接入 `server.ts`。
- [x] 集成测试 `apps/api/src/bundle.test.ts`（11 例，本地库跑通）：
      建模板 / 价格超原价拒绝 / 少于两单元拒绝 / 加项当组成拒绝 / 版本递增 + 乐观锁；
      quote 展开合计 = 锁价、C=1764、剩 13236（B20）、额外加项 16500、
      手动优惠 $150→$130、coupon 无可叠加对象拒绝、版本不符拒绝、跨租户 + 已下架不可见。
- [x] 种子重置 `packages/db/src/seed.ts` 清理列表补 3 张 bundle 表（在 `services` 前）。
- [x] normalize 的 Combo↔Sessions 分流（决策 #3 启发式）—— `DraftItem.packageKind`，见决策 #3。
      prompt / schema 保持不动（模型仍只给 `kind='package'`）。
- [ ] 导入审核 UI、发布分流、项目管理 / 开店向导的套餐 CRUD 界面 —— **前端，待排期**。
- [ ] 只读 HTTP 路由 `/v1/desk/bundles/quote` —— 未接（P3/P5 直接调 `quoteBundle` 函数；
      前端预览需要时再补路由 + SDK）。

### P3 · 创建 / 预约展开 —— 🔶 P3a/b/c + P3d（walk-in 直接开单）完成，拆单为单项未做

- [x] **P3a：`appointment.create` 支持 `bundleSelections`**（本地库已验证）。
      契约加 `bundleSelectionInput`（`bundleId` / `expectedVersion` / `startsAt` /
      `unitOverrides[]` / `extraAddons[]` / `extraDiscount*`）；`items` 放宽到可空，
      加 refine「items 或 bundleSelections 至少一个非空」；output 加 `bundleInstanceIds`。
- [x] handler：调 `quoteBundle` 展开 → 从 `startsAt` **顺排**子项（每子项标准时长）→
      每份套餐建一行 `order_bundle_instances`（appointment_id 有、ticket_id 空）→
      各子项 `appointment_items` 写 `bundle_instance_id/component_id/unit_index/list_price`。
      买两份 = 两个独立实例，散项照旧。子项走既有容量 / 资源 / 冲突检查。
- [x] `quoteBundle` 补 `nameSnapshot`、每单元 `durationMin` + `includedAddonIds`、
      额外加项 `unitOrdinal` + `durationMin`（供排程与快照）。
- [x] 测试 `apps/api/src/bundle.test.ts` P3a 5 例（本地跑通）：单份展开+实例快照、
      两份同模板+散项互不串、手动优惠 $20 落到实例与子项、额外加项并入单元快照+addon_ids、
      版本不符整单回滚不留半份。
- [x] **P3b：`ticket.open` 继承套餐实例**（本地库已验证）。开单时读预约子项的
      `bundle_*` 快照 → 同一 `order_bundle_instances` 行补 `ticket_id`（**保留实例
      身份**，计划 §5.2）→ `ticket_items` 写全 4 个 `bundle_*` 列。`recalcTotals`
      按子项快照求和不变，工单 subtotal = 套餐净价。测试 1 例（本地跑通）。
- [x] **P3c：套餐感知的改期 / 取消**（本地库已验证）。
      `appointment.reschedule` 单独改一个套餐子项 → 自动把同一 `bundle_instance_id`
      的全部子项一起挪，保持相对间隔，整体撞了一起回滚（计划 §4.3）。
      `appointment.cancel` 整单取消 → `order_bundle_instances.status='cancelled'`。
      测试 2 例。
- [x] **P3d：`ticket.open` 直接选套餐（walk-in）**（本地库已验证）。`TicketOpen` 契约加
      `bundleSelections[]`（`bundleId` / `expectedVersion` / `unitOverrides[]`（每单元一位技师，
      `membershipId` 必填）/ `extraAddons[]` / `extraDiscount*`），`items` 放宽可空 + refine，
      output 加 `bundleInstanceIds`。与 `appointmentId` 互斥
      （`bundle_selection_not_allowed_with_appointment`）。handler 调 `quoteBundle` 展开 →
      建一行 `order_bundle_instances`（`ticket_id` 有 / `appointment_id` 空 / `source='walk_in'`）→
      各子项 `ticket_items` 写 4 个 `bundle_*` 列 + 技师；额外加项并入归属单元的价与时长。
      首版限制：组成服务 `staff_count` 必须为 1（`bundle_unit_multi_staff_unsupported`）。
      测试 `bundle.test.ts` `describe('ticket.open 直接选组合套餐（walk-in）')` 4 例
      （展开+实例+金额、结账走通、与 appointmentId 互斥、unitOverrides 不足被拒）。
- [x] **B14：拆单为单项** —— 新命令 `bundle.splitInstance`（`apps/api/src/handlers/bundle.ts`）。
      仅未开工（无 `started_at`）未付款（无 `payments`、`service_settled_at` 空）可拆：各子项
      `total_cents` 恢复为锁定的 `bundle_list_price_cents`，四个 `bundle_*` 关联列清空，
      `order_bundle_instances.status='split'` 留作来源凭据，`recalc` 工单金额。首版不支持带
      额外加项 / 额外优惠的实例（`bundle_split_with_extras_unsupported`）——走作废重建。
      `bundle.test.ts` 拆单 4 例。

### P4 · 看板与履约 —— 🔶 查询 DTO 完成（后端），前端卡片渲染待排期

- [x] `apps/api/src/queries/queue.ts`（走单队列）：`items[]` 每项加
      `bundleInstanceId/bundleComponentId/bundleUnitIndex`；entry 加 `bundles[]`
      （instanceId / name / bundlePriceCents / discountCents / extraDiscountCents /
      unitCount / status）。
- [x] `apps/api/src/routes/tickets.ts`（`/v1/desk/tickets` 看板）：`items[]` 加
      4 个 `bundle_*` 字段；ticket 加 `bundles[]`（+ `doneCount` / `fulfilled`）——
      进度按**有效子项**（全部 `finishedAt` 才 `fulfilled`），完成 1/3 不提前完工（§4.3）。
- [x] 测试 P4 1 例：走单队列 entry 暴露 `bundles[]` + 各 item 的套餐归属。
- [ ] 前端看板卡片分组渲染、动作弹窗理解套餐关系、技师端套餐上下文 —— **前端，待排期**。
- [ ] 父套餐不重复占资源 / 不计轮：当前子项各自走既有资源 / 轮牌规则，
      无「父分组」额外占用（结构上不存在父行）；专项回归留 P8。

### P5 · 结账 / 退款 / 提成 / 报表 —— 🔶 后端关键项完成，前端结账视图待排期

事实核对（相对计划 §3 的口径表）：P3a 起套餐子项的 `appointment_items.price_cents_snapshot`
写的是 `allocateBundle` 的 **`netCents`（已含额外优惠）**，不是口径表初稿说的 `bundleNetCents`。
即额外优惠在**创建时**已落进子项快照与 `subtotal_cents`，结账层不再二次分摊 ——
`order_bundle_instances.extra_discount_cents` / `discount_cents` 为快照/报表字段，
下游 `recalcTotals` / 税 / 提成 / 退款一律以子项 `total_cents` 为准，无父子重复。

- [x] **次卡不覆盖套餐子项（计划 §4.5 / B17）** —— `apps/api/src/handlers/ticket.ts`
      `applyPackageRedemptions`：可核销范围新增 `bundle_instance_id is null` 过滤。
      此前按 `service_id` 命中会把已是分摊净额的子项再全额核销一次，错位提成基数与退款净额。
      散项照旧。`service_ids` 仅命中套餐子项服务时整笔拒（`package_services_not_on_ticket`）。
- [x] **提成基数按分摊实售额** —— `writeCommissionEarnings` 取子项 `total_cents`（= 分摊净额），
      不引入 `bundle_list_price_cents`；`packageCommissionBasis` 不复用为套餐开关（计划 §4.5）。
- [x] **税 / 结账收款校验** —— `closeOneTicket` 的 `subtotal − discount − 次卡覆盖 + 税 + 小费`
      对套餐单成立（subtotal 已是子项净额之和），无父行计税、无二次优惠。
- [x] **退款冲销按原提成政策** —— `TicketRefund` 读 `earnings` 原始行按净额比例冲回，
      从不按当前模板/费率重算历史；套餐单全额退 → 提成 amount/base 各归零。
- [x] 回归测试 `apps/api/src/bundle.test.ts` 新增 `describe('P5 …')` 4 例（B17 / B23 / B25 / B29）：
      结账收款+税+提成基数、次卡只核散项、次卡命中子项被拒、全额退款提成冲销归零。
- [ ] 两个 Checkout UI 的套餐视图（原价/套餐优惠/套餐价/加项分行展示）—— **前端，待排期**。
- [ ] 付款后加项补差、分阶段小费下的套餐、组单里含套餐单 —— 现有实现按子项净额通用处理，
      未见套餐特有分叉；专项用例留 P8。

### P6 · 顾客端与 AI 入口 —— 🔶 公开预约（官网自助）套餐入口完成，kiosk 读路径可用，AI 分流待排期

- [x] **公开预约下单支持套餐** —— `apps/api/src/public/routes.ts` `POST /public/v1/bookings`：
      body 加 `bundleSelections[]`（`bundleId` + `startsAt` + 可选 `extraAddons`），`items` 放宽可空
      + refine「两者至少一个非空」。校验：套餐必须本店 `active AND online_bookable`，额外加项必须
      本店 `online_bookable AND is_addon`，`startsAt` 过下单窗口闸门。展开 / 排程 / 定价全部交给
      `appointment.create` 的 `bundleSelections` 路径（P3a，调 `quoteBundle`）——
      `source='web'`、`override` 永不传、版本/优惠/技师不接受客户端传入。
- [x] **只读套餐目录** —— `GET /public/v1/bundles`：仅 `online_bookable` 套餐，返回组成、
      目录原价合计、组合价、内建优惠、各子项时长。
- [x] **只读服务端报价** —— `POST /public/v1/bundle-quote`：直接复用 `queries/bundle.ts::quoteBundle`
      （与下单同一实现，满足计划交付门槛「不同入口同一选择 → 同一组成与金额」），
      额外优惠强制为 0。没勾线上的套餐一律 `VALIDATION_FAILED { reason: 'bundle_not_online_bookable' }`。
- [x] 回归测试 `apps/api/src/public.test.ts` 新增 `describe('组合套餐（U10 / P6 …')` 6 例：
      目录只出线上套餐、报价子项净额=组合价、隐藏套餐 400、下单展开+建实例+金额、
      隐藏套餐下单被拒、items 与 bundleSelections 皆空 400。
- [x] **kiosk 已签到的套餐预约** —— 分组 / 报价经 P4 的共享 `queries/queue.ts` 暴露（`bundles[]` +
      每项 `bundle_*`），无需 kiosk 侧改动。
- [x] **walk-in 现场开单选套餐** —— `ticket.open` 的 `bundleSelections`（P3d）。kiosk 的
      `JoinQueue` 是「单项目排队」快捷流，套餐 walk-in 走前台 `ticket.open`；kiosk 侧本身
      不新增套餐选择器（计划 §7「入口能力不足时给人工办理提示」）。
- [ ] **AI 副驾 / 电话** —— `appointment.create` 的 `bundleSelections` 参数已在命令契约中，
      桌面副驾走 `appointment` 前缀即可提议；`bundle.saveTemplate/archiveTemplate` 属目录设置，
      **不进副驾操作前缀**（同 `catalog.*`）。`packages/ai` 的 Combo↔Sessions 分流启发式已落
      （决策 #3，`DraftItem.packageKind`）；发布分流由 P2 前端消费。
- [ ] 通知模板按套餐 / 子项展示 —— 未改；现有模板按 `appointment_items` 渲染，套餐子项即普通行。

### P7 · 历史数据与上线准备 —— ✅ 只读扫描 + 转换脚本 + 上线/回退方案

- [x] **只读历史 package 候选扫描** —— `apps/api/src/queries/bundleMigration.ts::scanLegacyPackageCandidates`
      + 路由 `GET /v1/desk/bundles/legacy-scan`（`catalog.manage`）。按「去重项目数 + 次数」
      两条启发式分类：`likely_bundle`（≥2 项且 sessions≤1）、`likely_punchcard`（≤1 项且
      sessions≥2，默认不列）、`ambiguous`（其余，交店主判断）。**不改写任何数据**，
      每条附一句话建议 + 已发/在用 `customer_packages` 计数供人工比对。测试
      `bundle.test.ts` `describe('P7 …')` 1 例。
- [x] **逐条确认转换脚本** —— `apps/api/src/ops/legacyPackageToBundleCli.ts`
      （`pnpm --filter @gf/api legacy-package-to-bundle <plan|apply> <org-id> <location-id> <mapping.json>`）。
      运维先跑 `legacy-scan` 拉候选，人工挑出真组合、按实际份数编 `mapping.json`，
      `plan` 只校验预览（模板在本店 / 服务有效非加项 / qty≥1 / 展开≥2 单元 / 组合价≤原价合计），
      `apply` 在一个事务里建 `service_bundles` + 组成、可选 `package_templates.active=false`，
      并把 `templateId→bundleId` 映射写 `<mapping.json>.applied.json`。**已售 `customer_packages` 不迁移**。
      本地 55322 `plan` 空映射冒烟通过；无自动化测试（同 `ops/marketingDomainCli.ts`）。
- [x] **加法式迁移顺序 / 旧版本兼容 / 功能开关 / 回退**（见 §8）。

**转换脚本设计（P7 未实现，供执行）**：
1. 运维先跑 `legacy-scan`，人工在 `likely_bundle` / `ambiguous` 里逐条勾出「确实是固定组合」。
2. 对每个勾中的 `package_templates` 行：用其 `service_ids`（按当前目录价）建一条
   `service_bundles` + `service_bundle_components`（`qty` 由运维按实际组合填，不猜），
   `service_bundles.price_cents = package_templates.price_cents`。
3. 记 `template_id → bundle_id` 映射表（新表或 `service_bundles.meta`），便于审计与回滚。
4. **已售 `customer_packages` 不迁移**：老客户手里的次卡按旧核销路径继续用到用完；
   新销售改走 `bundle.saveTemplate` + `appointment.create` 的 `bundleSelections`。
5. 被转换的旧 `package_templates` 行 `active=false`（`onlineSale=false`），停止新发卡，
   历史工单与在用次卡不受影响。

### P8 · 完整验证与交接 —— 🔶 后端测试矩阵 + 报告完成；浏览器/ipad 闭环依赖前端

- [x] 受影响包全量测试 + typecheck + guards（结果见 §6）。
- [x] B01–B32 逐条落点见 §9。
- [ ] 浏览器验证前台完整闭环（选套餐→看板→派单→服务→结账→收据）—— **无前端，未验证**。
      booking / ipad E2E 同理。后端契约与金额口径已由集成测试覆盖。
- [ ] 多语言 / 时区 / 触屏 / 断网 —— 后端：i18n 名称快照随实例落库（`name_snapshot`、
      `nameSnapshot`），营业日沿用门店 `timezone` / `business_day_cutoff`；前端场景未验证。

---

## 6. 实际运行的命令与结果

全部于 2026-09-08 在本地隔离库（55322）跑过一遍，全绿：

| 命令 | 结果 |
|---|---|
| `pnpm --filter @gf/payroll test` | ✅ 6 文件 / **128 例**（`bundle.test.ts` 21 例 `allocateBundle`/`refundableForUnit`） |
| `pnpm --filter @gf/contracts test` | ✅ 8 文件 / **61 例**（`registry.test.ts` 命令注册，`bundle.splitInstance` 已接入） |
| `pnpm --filter @gf/ai test` | ✅ 12 文件 / **124 例**（`normalize.test.ts` +1 决策 #3 `packageKind` 分类） |
| `pnpm --filter @gf/db test` | ✅ 10 文件 / **92 例**（`serviceBundles.migration.test.ts`：RLS / 列可空 / check / 跨租户 / 可重放） |
| `DATABASE_TEST_TARGET=isolated pnpm --filter @gf/api test` | 🔶 **1226 例通过 / 5 失败**。失败全在 `src/copilot/acceptance.test.ts`（场景 1/2/3/4/6），**在干净 `main` 上即为红**（`git stash` 后复现），order/time 敏感，与 U10 无关（已开 background task 修）。`bundle.test.ts` 33 例 = 目录/报价 11 + P3a 5 + P3b 1 + P3c 2 + P3d(walk-in) 4 + P4 1 + P5 4 + P7 1 + 拆单 4；`public.test.ts` +6 U10。 |
| `pnpm typecheck`（turbo，全 16 包） | ✅ 16/16 |
| `pnpm lint:guards` | ✅ 全通过 |

### 已验证 / 剩余缺口

- **本地隔离库（55322）**：上表全套跑通。`0118` 已应用到本地 55322。
- **`ops/legacyPackageToBundleCli.ts`**：`plan` 空映射冒烟通过；无自动化测试（同类 ops CLI 惯例）。
- **预存在失败**：`copilot/acceptance.test.ts` 5 例，非本工作引入，判读时按「除该文件外全绿」。
- **迁移未上 staging / 生产**：只在本地。上线 / 回退顺序见 §8。
- **E2E / 浏览器 / ipad**：套餐无前端，未验证。后端契约、金额口径、RLS、幂等、
  并发（乐观锁）已由集成测试覆盖；前台完整闭环、触屏、断网、多语言 UI 待前端排期后补测。
- **B01–B32**：逐条落点见 §9（前端主链路已交付；剩通知模板汇总行 + E2E）。

---

## 7. 历史 package 处理

只读扫描（`scanLegacyPackageCandidates` / `GET /v1/desk/bundles/legacy-scan`）+ 逐条确认
转换脚本（`ops/legacyPackageToBundleCli.ts`）均已交付，见 P7。原则：不按 `sessions=0/1`
自动判断；已售 `customer_packages` 与历史工单不随扫描 / 转换迁移；转换保留
`template_id → bundle_id` 映射（写 `.applied.json`）。

## 8. 待执行的生产操作与上线 / 回退

**未执行任何生产变更。** `0118` 仅在本地 55322。

**上线顺序**（加法式，逐步可回退）：
1. `0118_service_bundles.sql` 应用到 staging（`MIGRATION_DATABASE_URL` 必须显式指向
   staging，勿踩 `db-env-footgun`）。纯加法：3 张新表 + `appointment_items` / `ticket_items`
   各 4 个可空列 + 索引 + RLS，既有行不动。
2. 部署带 P1–P7 的 API。此时后端能建 / 报价 / 展开 / 结账 / 退款 / 公开预约套餐。
3. 前端排期后再放开 UI；在此之前套餐对前台不可见 —— `bundle.saveTemplate` 是唯一
   建模板入口，没有模板就没有可选套餐（隐性功能开关）。
4. 验证无回归后同样顺序上生产。

**回退**（不删已用的表）：
- 轻回退：把所有 `service_bundles.active=false`（并 `online_bookable=false`）——
  停止一切新套餐销售 / 预约，已建实例（`order_bundle_instances`）仍可查看 / 履约 / 结算 / 退款。
- 代码回退：回退 API 到 P0 之前；`bundle_*` 列与新表保留（可空、无 `not null` 依赖），
  历史 `order_bundle_instances` 成为只读记录，不会让已开工单变孤儿。
- **不可** `drop` 已有 `order_bundle_instances` 行的三张表 —— 那会切断历史工单的套餐归属。
  仅当 staging 上尚无任何实例时才允许整体 `drop`（回退脚本自带该断言）。

---

## 9. B01–B32 验收矩阵落点

| ID | 覆盖 | 证据 / 缺口 |
|---|---|---|
| B01 | 🔶 后端 | `bundle.saveTemplate` 与 `package.saveTemplate` 分属两套契约 / 两组表；导入分流属前端 P2 |
| B02 | 🔶 前端 | `ImportWorkspace.tsx` 组合/次卡分流选择器 + 发布走 `bundle.saveTemplate`（§11.6）；未解析组成走既有 blueprint 服务行，无独立选择 UI |
| B03 | 🔶 | `bundle.saveTemplate` 幂等 `optional`；导入发布幂等属 P2 前端 |
| B04 | ✅ | `bundle.test.ts` P3a「两份同模板」+ `allocateBundle` qty 展开（`payroll/bundle.test.ts`） |
| B05 | ✅ | `bundle.test.ts` quote「extra add-on → serviceNet 16500」；原价 185 / 优惠 20 / 应付 165 口径 |
| B06 | ✅ | 同上：包含加项计入原价不另收，额外加项全价且带 `unitOrdinal` 归属 |
| B07 | ✅ | `bundle.test.ts` P3a「两份同模板 + 散项，两实例互不串」 |
| B08 | ✅ | `order_bundle_instances` 快照（`name_snapshot`/`bundle_price_cents`/`template_version`）+ `bundle.archiveTemplate` 后旧报价用快照；`quoteBundle` 对停用服务 `bundle_service_inactive` |
| B09 | ✅ | `bundle.test.ts` P3b「ticket.open 继承同一实例」+ 三元组唯一索引防重复展开 |
| B10 | 🔶 | 子项走既有容量 / 资源硬约束（P3a 复用 `appointment.create` 校验）；整套原子失败由事务保证（P3a「版本不符整单回滚」用例）；专项资源不足用例未补 |
| B11 | 🔶 | 顺排 + 营业日按门店 tz/cutoff（P3a）；DST / wait 段专项未补 |
| B12 | 🔶 | 子项各自 `ticket_item_staff`；看板进度按有效子项（P4 `doneCount`/`fulfilled`）；两技师三项专项浏览器用例未补 |
| B13 | 🔶 | `order_bundle_instances.status`（active/split/cancelled）+ P4 进度不提前完工；部分取消调整流程属前端 |
| B14 | ✅ | `bundle.splitInstance`：未开工未付款拆回锁定单项原价，实例置 `split` 留来源。`bundle.test.ts` 拆单 4 例（恢复原价 17000 / 二次拆被拒 / 带额外优惠不支持 / 已结账不能拆）。带额外加项的实例走作废重建 |
| B15 | ✅ | 结账 `settlementStage` service/tip 分离对套餐单成立（子项净额进 subtotal），`bundle.test.ts` P5 结账用例 |
| B16 | 🔶 | 付款后加项补差走既有 `service_settled_at` 冻结 + 追加结算；套餐特有分支无（子项即普通行） |
| B17 | ✅ | `bundle.test.ts` P5「次卡只核散项」「命中子项被拒」；`ticket.ts` `applyPackageRedemptions` 排除 `bundle_instance_id` |
| B18 | ✅ | 额外优惠 `manual`/`coupon` 分流 + 服务端算（`allocateBundle`，`bundle.test.ts` quote 两例）；不信客户端金额 |
| B19 | 🔶 | 子项税按各自明细进既有税引擎（`closeOneTicket` 按 subtotal 算，无父行）；混合税属性专项未补 |
| B20 | ✅ | `bundle.test.ts` quote「退 C = 1764 / 剩 13236」+ `payroll/bundle.test.ts` `refundableForUnit` |
| B21 | ✅ | `TicketRefund` 累计 `refund_cents + amt <= total`、按 earnings 原行比例冲销、幂等键；`bundle.test.ts` P5 全额退款用例 |
| B22 | ✅ | P5 全额退款：状态 `refunded`、提成 amount/base 归零、预约 / 队列收场（`isFullRefund` 分支） |
| B23 | ✅ | P5 退款用例断言按**原** earnings 行冲销，不按当前模板 / 费率重算；小费独立 `tip_allocations` |
| B24 | 🔶 | 组单 `closeOneTicket` 逐单结、`distributeBuckets` 按方式填；套餐实例不跨 ticket（单行双归属）；组单含套餐专项浏览器用例未补 |
| B25 | ✅ | `bundle.test.ts` P5「结账收款 = 分摊净额 + 税」；两 Checkout UI 一致性属前端 |
| B26 | ✅ | 前台预约 P3a / walk-in 直接开单 P3d / 官网 `public.test.ts` U10 三入口均走同一 `quoteBundle`；金额一致由测试断言（均 = 组合价 15000）。kiosk walk-in / AI 见 P6 段 |
| B27 | ✅ | `bundle.test.ts` quote「跨租户 `bundle_not_found`」+ 0118 RLS 迁移测试（`serviceBundles.migration.test.ts`） |
| B28 | ✅ | `bundle.saveTemplate` `expectedVersion` 乐观锁 + `quoteBundle` 版本校验（`bundle.test.ts` 多例）；报价服务端算 |
| B29 | ✅ | P5「结账无第 4 行父套餐收款、提成基数 = 15000 非 17000」；日报 / CSV 按子项净额（无父行天然不重复） |
| B30 | ✅ | 纯加法迁移 + 既有测试全绿（`@gf/api` 全量，见 §6）；旧普通服务 / 加项 / 次卡行为不变 |
| B31 | 🔶 | 断网只读、旧客户端不改快照 —— 后端不建离线写队列；前端场景未验证 |
| B32 | ✅ | i18n 名称快照落库（`name_snapshot`）；分摊数字（A=8824 / C=1764）`payroll/bundle.test.ts` 断言；触屏 / 裸 key 属前端 |

图例：✅ 后端有测试证据 · 🔶 后端就位但缺专项用例或依赖前端 · ⛔ 未做

---

## 10. 最短复现步骤

```bash
cd geniefront-os
pnpm --filter @gf/payroll test        # allocateBundle / refundableForUnit 纯函数（§6.1 数字）
pnpm typecheck && pnpm lint:guards    # 全绿
# 隔离库（会重置本地 55322 种子数据）：
DATABASE_TEST_TARGET=isolated pnpm --filter @gf/api exec vitest run bundle.test public.test
DATABASE_TEST_TARGET=isolated pnpm --filter @gf/db  exec vitest run serviceBundles.migration
```

`allocateBundle` 用法见 `packages/payroll/src/bundle.test.ts`；结账 / 退款 / 次卡对套餐
安全见 `apps/api/src/bundle.test.ts` `describe('P5 …')`；公开预约见
`apps/api/src/public.test.ts` `describe('组合套餐（U10 …')`；历史扫描见
`describe('P7 …')`。

---

## 11. 前端实施（apps/web + apps/booking）

按切片交付，每片 typecheck + build + 单测 + guards 绿。**未做浏览器 / ipad 端到端**。

### 11.1 基础层
- 后端读路由（`apps/api/src/routes/marketing.ts` + `queries/bundleCatalog.ts`）：
  `GET /v1/desk/bundles`（目录，组成 / 服务名 / 目录价已解析，含 `nameI18n` /
  `descriptionI18n` / `fulfillable` / `instanceCount`）、`POST /v1/desk/bundles/quote`
  （复用 `queries/bundle.ts::quoteBundle`）。
- `apps/web/src/features/bundles/{types,api}.ts`：`useBundleCatalogQuery` /
  `useSaveBundleTemplate` / `useArchiveBundleTemplate` / `useSplitBundleInstance` / `quoteBundle`。
- `apps/web/src/i18n/bundles.ts`（`bundle.*`，全 5 语言），注册进 `i18n/index.ts` 与
  `LanguageContext.tsx` 懒加载表。

### 11.2 目录管理面板（对应「开店向导套餐界面 / 项目管理」）
`features/bundles/BundleManagerPanel.tsx`，挂在 `pages/Marketing.tsx` 新「组合套餐」标签页。
列表卡片（原价划线 / 组合价 / 优惠 / 在售·可在线预约徽标 / 需修复 / 已售份数）+ 编辑器
Modal（中英文名 + 组成 repeater + 组合价 + 在线预约开关，实时算原价合计 / 优惠）+ 复制 +
下架确认。写走命令总线，`bundle_version_conflict` / `bundle_price_above_components` /
`bundle_component_empty` / `bundle_service_inactive` 映射到本地化提示。`useCan('catalog.manage')` 门控。

### 11.3 看板卡片分组
`features/queue/ticketItems.ts::groupTicketItemsByBundle`（纯函数 + 3 单测）：同一
`bundleInstanceId` 子项聚成一组带进度，散项各自成组。`KanbanBoard.tsx` 渲染成带
「套餐」徽标 + 名称 + 组合价 + `{done}/{total}` 进度的分组卡片（完成 1/3 不显示已完工）。
`features/tickets/types.ts` 的 `TicketItem` / `TicketSummary` 补 `bundle_*` / `bundles[]`
（后端 P4 已返回）。

### 11.4 结账套餐视图 + 拆单入口（B14）
`features/bundles/BundleCheckoutSummary.tsx`：只读明细卡（原价合计 / 套餐优惠 / 套餐价 /
子项，口径「原价 170 / 优惠 20 / 套餐价 150」），`pages/Checkout.tsx` 与看板
`pages/queue/modals/CheckoutModal.tsx` 共用。`features/checkout/types.ts` 补
`bundle_*` / `bundles[]`。看板套餐分组头加「拆成单项」按钮（`status=active` 且未开工才显示）
→ `Queue.tsx` `ConfirmDialog` + `useSplitBundleInstance`，`bundle_split_with_extras_unsupported`
本地化提示。

### 11.5 官网在线预约（apps/booking）
- 后端 `GET /public/v1/availability` 加 `bundleId`：按 `quoteBundle` 求整体时长排格子，
  不接受指定技师。
- `apps/booking/src/lib/api.ts`：`getBundles` / `Bundle` / `BookInput.bundleSelections` /
  `getAvailability` 支持 `bundleId`；`lib/i18n.tsx` 5 语言补 `bundle.*`。
- `BookPage.tsx`：选服务页顶部「套餐」区（原价划线 / 组合价 / 立省），选套餐后跳过选技师
  直接进选时间，Confirm 与右侧摘要走套餐变体，提交发 `bundleSelections`。`BookPage.test.tsx`
  +1（套餐全流程 12 例全绿）。

### 11.6 导入分流 UI（B02）✅
`ImportWorkspace.tsx`：package 行加「组合套餐 / 次卡」选择器，默认按 `guessPackageKind`
启发式（与 `packages/ai::classifyPackageKind` 同口径），店主可手动改。发布时判定为组合套餐的
行在 `blueprint.reviewItems` 里标 `rejected`（不建 `package_template`），`blueprint.apply`
建好组成服务后按名称匹配 → `bundle.saveTemplate`（在线预约默认关）；组成不全 / 价格缺失的行
跳过并 toast 列名（店主到「组合套餐」页手建 —— 不猜、不静默漏项，计划 §7）。
未解析组成的「选择 / 新建」交互仍走既有 blueprint 服务行，本切片不加独立 UI。

### 11.7 通知 / 提醒模板按套餐名展示 ✅
`notify/appointmentServiceLabel.ts::composeServiceLabel`（纯函数 + 查库包装）：预约含活跃套餐
实例 → 用 `order_bundle_instances.name_snapshot`（多份 ` + ` 连接），还有散项补 `+ N more`；
无套餐多项目 → `<首项> + N more`；单项目 → 首项名（旧行为不变）。三处 `serviceName` 改走它 ——
`enqueueConfirmEmail` / `enqueueConfirmSms`（`handlers/appointment.ts`）+ `enqueueOneReminder`
（`notify/reminder.ts`），不再只取首个 `appointment_item`。顾客侧恒英语，`+ N more` 用字面量。
纯函数 5 例；`public.test.ts` 断言官网套餐预约的确认短信含套餐名、不含首个子项名。

### 11.8 浏览器 E2E ✅（目录 CRUD）+ 待办
- `e2e/specs/bundles.spec.ts`：Marketing →「组合套餐」标签页 → 新建（两个执行单元 + 组合价）
  → 保存 → 卡片显示原价合计 / 组合价，刷新后仍在。真实 `bundle.saveTemplate` +
  `GET /v1/desk/bundles` 闭环，本地 Playwright（Chromium）通过。
- 顺带修 `packages/db/src/qa/reset.ts`：`TABLES_IN_ORDER` 补 `order_bundle_instances` /
  `service_bundle_components` / `service_bundles` —— 0118 引入的三张 FK 表没进重置列表，
  库里有过组合套餐后 `pnpm qa:seed` 会撞 `service_bundle_components_service_id_fkey`。
- **待办**：booking → 看板 → 派单 → 服务 → 结账 → 收据的整链 E2E（种子数据更重，留手测，
  TEST-PLAYBOOK §2）；ipad / kiosk 触屏（Playwright 不起）。
- ⚠️ `operations.spec.ts` 的 #6（礼品卡结账，2min 超时）/ #7（日结）在 `bf07a7f`（前端改动
  之前）+ 仅本次 reset 修复的状态下同样失败 —— 预存在环境 flakiness，与 U10 无关。
