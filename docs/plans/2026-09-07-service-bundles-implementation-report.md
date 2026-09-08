# 组合项目套餐：实施报告

计划：`docs/plans/2026-09-07-service-bundles-implementation.md`
状态：**P0 ✅ · P1 ✅ · P2 后端 ✅ · P3a+P3b ✅（预约选套餐→开单继承）· P3c/P4–P8 未做**
（均在本地 55322 验证）本轮范围：P0–P2 + P3a + P3b。导入 UI / 向导 / 结账界面待前端排期。

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

### 决策 #3 —— AI 识别的 Combo / Sessions 分流 · P2 处理，建议如下

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
- [ ] AI schema / prompt / normalize 的 Combo↔Sessions 分流（决策 #3 的启发式）—— 未做。
- [ ] 导入审核 UI、发布分流、项目管理 / 开店向导的套餐 CRUD 界面 —— **前端，待排期**。
- [ ] 只读 HTTP 路由 `/v1/desk/bundles/quote` —— 未接（P3/P5 直接调 `quoteBundle` 函数；
      前端预览需要时再补路由 + SDK）。

### P3 · 创建 / 预约展开 —— 🔶 P3a + P3b 完成，P3c 未做

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
- [ ] **P3c：整套改期 / 移除 / 拆单 / 直接开单选套餐 / walk-in** —— 未做。
      当前整单平移会带着子项一起动（可用）；单独改套餐子项、按实例移除、
      未开单拆单为单项均未实现。

### P4–P8 —— 未开始

---

## 6. 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter @gf/payroll test` | ✅ 6 文件 / **128 例**（含新增 21 例 `bundle.test.ts`） |
| `pnpm --filter @gf/contracts test` | ✅ 8 文件 / 61 例（含 `registry.test.ts` 命令注册校验） |
| `pnpm --filter @gf/db test` | ✅ 10 文件 / **92 例**（含新增 `serviceBundles.migration.test.ts`，跑在本地 55322） |
| `pnpm --filter @gf/api test` | ✅ 88 文件 / **1209 例**（含 `bundle.test.ts` 17 例：目录/报价 11 + 预约展开 5 + 开单继承 1，本地 55322） |
| `pnpm typecheck`（turbo，全 16 包） | ✅ 16/16 |
| `pnpm lint:guards` | ✅ |
| `pnpm test:unit` | ✅ 全通过 |

### 已验证 / 剩余缺口

- **本地隔离库（55322）**：`@gf/db` + `@gf/api` 全套 + 迁移测试 + bundle 目录/报价
  测试均已跑通。`0118` 已应用到本地 55322。
- **迁移未上 staging / 生产**：只在本地。上线顺序见 §8。
- **E2E / 浏览器**：无 UI 变更，未涉及。
- **B01–B32 验收矩阵**：B04/B05/B06/B20/B32 的**金额口径**已由 `bundle.test.ts` /
  `bundle` 纯函数测试覆盖；完整场景（预约/看板/结账/退款全链路）依赖 P3–P8。

---

## 7. 历史 package 处理

未处理（属 P7）。现状：`package_templates` / `customer_packages` 承载次卡，未区分其中
是否混有「其实是固定组合」的历史行。P7 需提供只读扫描 + 逐条确认转换，不按
`sessions=0/1` 自动判断。

## 8. 待执行的生产操作

无。本轮不含任何生产变更。后续 P1 落库顺序：`0118` 在 staging 迁移（加法式，
可回退：回退只需 `drop` 3 张新表 + 4×2 列，无数据依赖），验证后再生产。

---

## 9. 最短复现步骤（P1 已交付部分）

```bash
cd geniefront-os
pnpm --filter @gf/payroll test        # 纯分摊函数，含计划 §6.1 示例（注意待决策 #1）
pnpm typecheck && pnpm lint:guards    # 全绿
# 隔离库环境额外：
# DATABASE_TEST_TARGET=isolated TEST_DATABASE_URL=... TEST_MIGRATION_DATABASE_URL=... \
#   pnpm --filter @gf/db test -- serviceBundles.migration
```

`allocateBundle` 用法示例见 `packages/payroll/src/bundle.test.ts`。
