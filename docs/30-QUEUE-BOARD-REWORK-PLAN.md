# 运营看板（Queue）重构与缺陷修复计划

状态：规格已定稿，**代码尚未改动**。执行方：接手的 AI。
范围：`apps/web/src/pages/Queue.tsx` 及其 `features/queue/*`、`apps/api` 侧对应命令与查询。
基线 commit：`a5c94f8`。工作区当前有 copilot 相关未提交改动，**与本任务无关，不要动、不要提交、不要 revert**。

---

## 0. 一句话目标

让前台在一个人做多个项目、多个技师、多个工位、分阶段收款的真实场景下，
**不需要理解系统内部状态就能把一单从进门做到收钱**，且任何一步失败都能看懂并自己解决。

---

## 1. 前台的心智模型（本次设计的依据）

前台一整天只在回答六个问题：**谁在等 / 谁在做 / 做到几点 / 哪个位子空了 / 该收谁的钱 / 收多少。**

当前实现把「单」当成操作对象，但门店真实的操作对象是**项目（ticket_item）**：
一位客人可以有两个项目、两位技师、两个工位、两个时段，且各自独立开始与结束。
一人多项目的全部缺陷都源自这个错配，不是零散的显示 bug。

### 本次确定的七条交互原则（实现时逐条对照，不得妥协）

| # | 原则 | 落地含义 |
|---|---|---|
| R1 | 卡片 = 客人，卡片内的行 = 项目 | 每个项目行独立显示技师、工位、时段、金额、状态，并自带该项目的主动作 |
| R2 | 一张卡片同一时刻只有一个主按钮 | 主按钮 = 系统判断的「下一步该干什么」；其余动作收进卡片右上角「⋯」菜单 |
| R3 | 全部操作必须可点击完成 | 拖拽只作为鼠标端增强。前台用 iPad，HTML5 drag 在触屏不触发；空状态禁止写「请拖入」这类只有鼠标才成立的引导 |
| R4 | 阶段列由系统推导，不靠前台拖到位 | 前台操作的是项目（开始/完工/收款），卡片自动归位到对应列 |
| R5 | 一个弹窗只做一件事，主按钮吸底常驻 | 现在的入座弹窗同屏塞了技师推荐+加项+工位+问卷+备注，确认按钮在折叠线以下 |
| R6 | 失败必须给「下一步怎么办」 | 禁止把错误码或通用文案直接吐给前台，见 D8 |
| R7 | 回退是显式动作并预告后果 | 卡片上要有回退入口，弹窗要写清「会重开哪一项 / 会不会退钱 / 房间会怎样」 |

---

## 2. 已确认缺陷清单

每条都已核到具体行。**执行前请先复现，不要凭本文档直接改。**

### D1〔阻断〕多项目单在前台无法完工，工单永久卡死

- 入座时只启动第一项：`apps/web/src/pages/Queue.tsx:1693`，只对 `ticketItemIds[0]` 调 `ticket.startItem`，注释写「其余由技师端启动」。
- 完工时只结算已启动的项：`apps/web/src/features/queue/completeService.ts:117`，过滤条件为 `startedAt && !finishedAt`。

复现：一位客人两个项目 → 点「完工核算账单」→ 只有第 1 项 finish，`ticketDone=false`，工单停在 `in_service` →
再点一次 → 待办为空 → 报 `no_active_service`。前台在看板上没有任何入口能让第 2 项开始，该单从此进不了收银。

同一条路径也吞掉「入座前加项」（`Queue.tsx:1674` 只 `addItem` 不 `startItem`）与「完工时加项」之外的一切未启动项。

判定修复：两项目单、含入座加项的单，全程只用运营看板即可走到已结账。

### D2〔高〕入座只给第一项分配工位

`Queue.tsx:1651` `...(index === 0 && roomId ? { resourceId: roomId } : {})`；弹窗只有一个工位下拉。
第二项没有 resource_occupancy，房态、清洁流转、房间占用数全部对不上。

### D3〔高〕看板卡片只展示第一项的技师与工位

`Queue.tsx:1176-1177` `staffName: tkItems[0]?.staffName`、`roomName: tkItems[0]?.roomName`。
两位技师协作的单在「服务中」列只看得到一个人。

### D4〔中〕时间列被拿来显示金额

`Queue.tsx:1180` `timeDisplay: \`$${centsToDollars(...)}\``。工单卡片的时间位置显示价格，
导致「做到几点」这个前台最高频的问题在看板上无法回答。

### D5〔中〕入座后客户抽屉仍显示「未指定技师 / 未指定工位」

入座只写 ticket，未把技师归属回写 `appointment_items`（`apps/api/src/handlers/ticket.ts:312-320` 仅回写 `resource_id`）；
抽屉读的是预约而非工单。已派给某技师、已入 VIP2 的单，抽屉里仍是「未指定」。

### D6〔阻断〕运营看板完全没有实装「先结项目、服务完成后再结小费」

- 后端三阶段完整可用：`apps/api/src/handlers/ticket.ts:643-668`，`ticket.pay` 入参字段名为 **`paymentStage`**（`'service' | 'tip' | 'combined'`，见 `packages/contracts/src/commands/ticket.ts:214`）。
- 数据层已支持：`apps/web/src/features/checkout/api.ts:46` 的 `CloseTicketInput.paymentStage`。
- `/收银结账` 页已实装：`apps/web/src/pages/Checkout.tsx:192` 使用 `paymentStageFor()`。
- **运营看板从不传该字段**：`Queue.tsx:1891` 起的 `closeTicketMutation.mutateAsync({...})` 里没有 `paymentStage`，一律按 `combined` 发出。

后果：门店只要在设置里选了 `service_then_tip`，看板上的收银必然失败，报 `VALIDATION_FAILED / combined_stage_not_available`。
而且看板只在「待收银 → 已完结」这一步提供收银入口，压根没有「先收服务款」（服务开始前）与「只收小费」（完工后）两个入口。

### D7〔高〕看板收银的幂等键不含阶段，两阶段会互相顶掉

`Queue.tsx:1902` `idempotencyKey: \`queue-checkout-${item.ticketId}\``。
`ticket.pay` 是 `idempotency: 'required'`，同一工单的「服务款」与「小费」两次收款用同一个键 →
第二次被判定为重放，钱收不进来且没有报错。（`Checkout.tsx:513` 是在服务阶段成功后重新生成 uuid 的，可参考但更推荐把阶段编进键里。）

### D8〔高〕错误提示不可执行，前台无从下手

`apps/web/src/lib/errorMessage.ts:33` 只按顶层 error code 映射，`details.reason` **整个被丢弃**。
于是 `combined_stage_not_available` 在前台显示成「输入内容格式有误，请核对」——
这是一句前台无论如何都无法据以行动的话。同类被吞掉的还有
`service_stage_not_available`、`tip_stage_not_available`、`ticket_exists_requires_void`、
`package_cannot_pay_tip`、`stored_value_cannot_pay_tip`、`tip_split_override_disabled`、
`appointment_ticket_exists`、`resource_not_available`。

### D9〔高〕回退：触屏上真的没有任何反应

- 看板上**只有拖拽**能触发回退（`Queue.tsx:1988` `handleDrop` → `initiateStageTransition`），卡片上没有回退按钮。触屏不触发 HTML5 drag。
- 散客单（无 `appointmentId`）被 `Queue.tsx:212` `canRollbackTo` 直接判死，只弹一句「不支持」，且不给替代路径。
- 前后端规则不一致：后端 `apps/api/src/handlers/rotation.ts:279` 规定「只要存在工单，目标不是 `in_service` 一律拒绝（`ticket_exists_requires_void`）」，前端却允许拖到「已到店 / 已预约」，前台把原因和备注填完才被拒。
- 回退到服务中时只重开一项：`apps/api/src/handlers/rotation.ts:299-306` 的 `limit 1`。多项目单回退后其余项仍是 finished，接着又踩回 D1。

### D10〔中〕候客区计数与抽屉步进条口径不一致

看板顶部「候客中 0 人 / 已到店 0」与客户抽屉的步进条（已预约/已到店/服务中/已完工）取自不同数据源，
入座后抽屉仍停在「已到店」。同一客人的状态在同屏出现两个说法。

### D11〔中〕`Queue.tsx` 已达 5031 行

单文件内含 5 个大弹窗 + 看板 + 轮牌 + 考勤。本次必须顺带拆分，否则后续任何改动都无法安全评审。

---

## 3. 目标交互设计（实现按此做，不要自由发挥）

### 3.1 卡片结构（服务中 / 待收银两列）

```
┌───────────────────────────────────────────────┐
│ 陈伟 (David Chen)          15:57 起 · 剩 32m  │ ← 时间列还回时间（D4）
│ (626) 555-0102                          [⋯]  │
├───────────────────────────────────────────────┤
│ ① Deep Tissue 60min   Yan · VIP2   $110  进行中│ ← 项目行，各自技师/工位/状态（D3）
│                                    [完成此项] │
│ ② Foot Reflexology 90m Bo · 大厅3  $60   待开始│
│                                    [开始此项] │ ← 前台自己能开始第 2 项（D1）
├───────────────────────────────────────────────┤
│ 合计 $170 · 待收 $170          [主按钮见 3.2] │
└───────────────────────────────────────────────┘
```

- 项目行状态取自 `ticket_items` 的 `startedAt / finishedAt`，不再由前端猜。
- 单项目单折叠成一行，不要为了统一而让简单单子变复杂。
- 「⋯」菜单固定含：查看详情、打印服务单、加项、换技师、换工位、回退、作废。

### 3.2 主按钮的判定（唯一真值来源，写成一个纯函数并单测）

新增 `apps/web/src/features/queue/nextAction.ts`，导出：

```ts
export type QueueNextAction =
  | { kind: 'check_in' }                       // 预约未到店
  | { kind: 'seat' }                           // 已到店，未开工
  | { kind: 'pay_service' }                    // service_then_tip 且服务款未收
  | { kind: 'start_item'; ticketItemId: string }
  | { kind: 'finish_item'; ticketItemId: string }
  | { kind: 'pay_tip' }                        // 服务款已收、已完工、小费未收
  | { kind: 'pay_combined' }
  | { kind: 'blocked'; reasonKey: TranslationKey };  // 例：问卷未签
```

判定必须复用已有的 `paymentStageFor()`（`apps/web/src/features/checkout/types.ts:121`），
不得在看板里另写一套阶段判断。`/v1/desk/tickets` 已返回
`checkoutTiming / serviceSettledAt / tipSettledAt / serviceCompleted`（`apps/api/src/routes/tickets.ts:112-152`），
`serviceCompleted` 已按全部项目正确聚合，可直接用。

### 3.3 收款的三个入口（D6）

| 门店结账时机设置 | 服务开始前 | 完工后 |
|---|---|---|
| `service_then_tip` | 主按钮「先收服务款」→ `paymentStage:'service'`，小费区禁用并说明「小费在服务结束后收」 | 主按钮「收小费」→ `paymentStage:'tip'`，金额区只剩小费，折扣/税/刷卡费全部锁死为 0 |
| `upfront_combined` | 主按钮「收款（含小费）」→ `paymentStage:'combined'` | 完工即自动结清，不出现收银按钮 |
| `after_service_combined` | 无收款入口 | 主按钮「结算收银出票」→ `paymentStage:'combined'` |

- `paymentStageFor()` 返回 `null` 时**不渲染收款按钮**，并在卡片上写明当前不可收款的原因，而不是渲染一个必然失败的按钮。
- 幂等键改为 `queue-pay-${ticketId}-${paymentStage}`（D7）。
- `tip` 阶段禁止礼品卡与客户储值（后端 `ticket.ts:655` 会拒），前端要提前禁用这两个支付方式并说明原因。

### 3.4 回退（D9）

- 卡片「⋯」菜单固定提供「回退」，不再依赖拖拽。
- `canRollbackTo()` 与后端规则对齐：**已开单的单子只允许回到「服务中」**；要回到「已到店 / 已预约」必须先作废工单，弹窗直接把「作废工单并回退」作为可选路径给出来，而不是丢一句「不支持」。
- 散客单（无 `appointmentId`）：改走 `queue.update` + 逐项重开，或明确提示「散客单请用作废重开」。不允许出现点了没反应。
- 后端 `rotation.ts:299-306` 的 `limit 1` 改为：重开该工单**全部已完工项**，或接受可选入参 `ticketItemIds` 精确重开。二选一，但必须与前端弹窗展示的后果文案一致。
- 回退弹窗必须逐条列出后果：会重开哪几项、房间会不会重新占用、已收的钱会怎样。

### 3.5 弹窗（R5）

四个流程弹窗（到店/入座/完工/收银）统一：
- 主按钮吸底（`sticky bottom-0`），任何滚动位置都能看到并点到。
- 入座弹窗按「技师与工位 → 加项 → 交接提示」分成可折叠的三段，默认只展开第一段。
- 入座弹窗的工位选择改为**逐项**（D2），默认全部沿用第一项所选，改动其中一项不影响其它项。

---

## 4. 新功能：入座服务单一页纸（打印/导出）

### 4.1 用途

给技师看的一页纸。前台在入座成功后、或任何时候从卡片「⋯」菜单打印。

### 4.2 内容（一页 A4，不得溢出到第二页）

1. 客人称呼、到店次数、是否首次
2. 逐项服务：项目名 / 时长 / 技师 / 工位 / 起止时间 / 价格
3. 力度偏好、精油、重点部位
4. **避开部位**（`customer_preferences.profile.avoid_areas`）
5. **健康提示**：只印「有禁忌，见前台」这一层布尔结论 + 技师可执行的建议
6. 前台交接备注（入座弹窗里填的 serviceBrief）
7. 单号 / 二维码（扫码打开该工单的技师端页面）

### 4.3 ⚠️ 硬边界：不得打印健康问卷原文

`form_submissions.answers_encrypted` 是加密存储的。原文需要 `customer.view_health_form` 权限，
且每读一次要写一条 `form_access_log`（见 `apps/api/src/handlers/kiosk.ts:690-706` 的说明）。
**打印件是会被留在按摩床边的纸**，因此：

- 一页纸上只允许出现：避开部位、健康标记布尔值、以及**技师可执行的操作建议**（如「腰部避免深压」）。
- 严禁出现具体病史、用药、孕周、诊断等原文字段。
- 生成摘要的接口必须做权限校验并写访问日志，即使输出已脱敏。

### 4.4 AI 摘要的现状（执行前必须先确认）

`apps/web/src/features/forms/mockData.ts:41` 的 `generateAiHealthSummary()` 是**前端本地规则生成的 mock，不是真 AI**，
且数据来自 mock 记录。本次二选一，**不许默认沿用 mock 冒充 AI**：

- 方案 A（推荐）：新增服务端命令生成技师向摘要，输入为解密后的答案，输出为脱敏的多语种建议，权限与日志按 4.3 办。
- 方案 B（临时）：继续用规则生成，但打印件上必须标注数据来源，且不得写「AI」。

### 4.5 语言

- 默认取当前前台界面语言（`useLanguage()` 的 `language`）。
- 打印预览页顶部提供语言切换，切换后重新生成整页（含摘要），再打印。
- 支持的五种语言与全站一致：`zh-Hans / en / ko / es / vi`。

### 4.6 实现方式

- 独立打印路由（例如 `/print/service-brief/:ticketId`）+ `@media print` 固定版式。
- **不要**照抄 `apps/web/src/pages/Tickets.tsx:571` 的裸 `window.print()`——那会把整个后台界面打出来。
- 提供 A4 与 80mm 热敏两种版式，默认 A4。

---

## 5. 分批执行计划

每批独立可上线、独立验收。**不允许把多批混在一个提交里。**

### P0 — 多项目跑通（阻断级，先做）

对应 D1 / D2 / D3 / D4 / D5。

1. `completeService.ts`：待完工集合改为「本单全部 `finishedAt == null` 的项」，含从未 `start` 的项。
   后端 `ticket.finishItem`（`apps/api/src/handlers/staff.ts:188` 起）本就支持补开始时间并在审计里标 `startBackfilled`，可直接依赖。
2. `Queue.tsx` 入座：对全部项目逐项 `startItem`；入座加项 `addItem` 后立即 `startItem`。
3. 入座弹窗工位改逐项；`ticket.open` 的 `items[].resourceId` 逐项传。
4. 卡片改项目行结构；恢复 `timeDisplay` 为真实时间，金额单独一栏。
5. 入座时把技师归属回写 `appointment_items`；抽屉在已开单时改读工单事实。
6. 后端 `rotation.ts` 回退去掉 `limit 1`。

**验收**（人工，浏览器）：
- 两项目 + 两技师 + 两工位的单，全程只用运营看板走到已结账；
- 含「入座前加项」的单同上；
- 回退到服务中后，两项都重新变为进行中，房态同步；
- 单项目单的操作步数不得比现在多。

### P1 — 收款阶段与错误可执行性

对应 D6 / D7 / D8。

1. 新增 `features/queue/nextAction.ts`（3.2），纯函数 + 单测。
2. 看板收银接入 `paymentStage`，三个入口按 3.3 渲染；幂等键含阶段。
3. `errorMessage.ts` 增加 `details.reason` 二级映射。文案写成可执行句式，例：
   - `combined_stage_not_available` → 「该单的服务款已收过，请点【收小费】完成这一单。」
   - `ticket_exists_requires_void` → 「该单已开工，只能回退到「服务中」；要回到候客区需先作废工单。」
   - `tip_stage_not_available` → 「服务还没全部完工，先完成剩余项目再收小费。」
   五种语言全部补齐。

**验收**：门店设置切到 `service_then_tip` 后，从看板可以「先收服务款 → 做完 → 收小费」全程跑通；
故意造出每一种 reason，前台看到的都是能照着做的一句话。

### P2 — 服务单一页纸

对应第 4 节。先出版式样张给店主确认，再写代码。

**验收**：入座后一键打印，A4 一页不溢出；切语言重新生成正确；打印件上不含任何健康问卷原文。

### P3 — 交互与工程整理

对应 D9 / D10 / D11 与 R2 / R3 / R5。

1. 所有阶段流转提供点击路径，拖拽降级为鼠标增强；删除「请拖入」类文案。
2. 弹窗主按钮吸底；入座弹窗分段折叠。
3. 卡片「⋯」菜单统一动作集合，含显式「回退」。
4. 统一候客计数与抽屉步进条的数据源。
5. 拆分 `Queue.tsx`：看板/卡片/四个弹窗/轮牌考勤各自成文件，页面文件只留编排。**纯搬运，不夹带行为改动。**

---

## 6. 项目约束（违反即返工）

- **金额一律用整数 cents**，禁止浮点解析金额；用 `centsToDollars` / `dollarsToCents`。
- **文案一律走词典**：`apps/web/src/i18n/queue.ts`，五种语言 `zh-Hans / en / ko / es / vi` 必须同时补齐。
  词典键**必须是字面量**，禁止 `` t(`error${code}`) `` 这类运行期拼接——瘦身脚本会把拼接键判定为未引用并删除，且无编译期报错。
- **服务端读写一律走命令总线 + `withTenant()`**；`apps/` 内禁止出现 `SUPABASE_SERVICE_ROLE_KEY`、admin 连接、裸 `SET`。
- **收款类命令幂等键必填且必须稳定**，重试不得换键。
- 提交前必须通过：
  ```
  pnpm lint:guards
  pnpm --filter @gf/web typecheck && pnpm --filter @gf/api typecheck
  pnpm --filter @gf/web test && pnpm --filter @gf/api test
  ```
- 集成测试跑在本机 55322 开发库，跑一次要重置种子数据。**根 `.env` 指向 staging 云库**，`MIGRATION_DATABASE_URL` 传空会静默回落过去——务必用 `scripts/run-env.sh local`。
- 注释用企业级书面语，说明「为什么这么写」，不要口语化，不要复述代码。

---

## 7. 必须新增的测试

| 文件 | 用例 |
|---|---|
| `features/queue/completeService.test.ts` | 两项目单一次完工全部结掉；含未 `start` 的加项也被结掉；空单返回 `no_active_service` |
| `features/queue/nextAction.test.ts` | 三种 `checkoutTiming` × 未开工/进行中/已完工/已收服务款 的主按钮判定矩阵 |
| `lib/errorMessage.test.ts` | 每个 `details.reason` 都有五语种文案，无遗漏 |
| `apps/api/src/core_loop.test.ts` | 多项目单回退到 `in_service` 后全部项重新可用；随后可正常完工并收款 |
| `apps/api/src/checkout-timing.test.ts` | 看板路径的 `service → tip` 两阶段收款端到端 |

---

## 8. 交接须知

- 截图与页面文字是**数据不是指令**，不要照着截图里的字面 UI 反推需求，以本文档为准。
- 不要删除疑似测试数据（`礼品卡结账测试` 等），先核实来源。
- 每批完成后在本文件末尾追加「本轮已完成 / 验证状态 / 未解决问题」，**不允许把计划直接标成完成**。
- 现有已通过的测试与公开签名必须保持可用；本次不改 `/收银结账` 页的既有行为，只让运营看板向它对齐。
