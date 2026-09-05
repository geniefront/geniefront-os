# 运营看板（desk /queue）二级弹窗审计报告

> **状态：已修复（2026-09-04）。** 手测 Queue 弹窗时仍按 [`../qa/TEST-PLAYBOOK.md`](../qa/TEST-PLAYBOOK.md) 批次 2 回归「填了却没写入」这类假实装。
> 除下列一项外，报告中的问题均已在 `apps/web/src/pages/Queue.tsx`、
> `apps/web/src/i18n/queue.ts` 与新增的 `apps/web/src/features/queue/checkoutMath.ts` 中落地。
> 197 项前端测试通过（含 9 项新增的收银金额与分账测试），类型检查与生产构建均通过。
>
> **仍未处理：** 2.5 之外的「实际执行工时可编辑」。`ticket.finishItem` 的命令契约
> （`packages/contracts/src/commands/staff.ts`）不接受时长入参，服务端按 startedAt/finishedAt
> 结算，前端无法覆盖。该区块已由「可点击但不提交」的按钮组改为如实展示系统已记录的用时；
> 若确实需要前台改写计费工时，需要扩展命令契约与处理器，属于后端改动。
>
> **一处更正：** 1.7 所述「两个复选框绑定同一状态、勾一个另一个跟着动」不成立 ——
> 二者分别位于「问卷未签署」与「问卷已签署」两个互斥分支，不会同时出现。
> 真实缺陷是该字段从未被读取，勾与不勾都不影响入座；现已改为：问卷未签署时
> 必须勾选口头核对才能入座，且默认不勾选。

审计对象：`apps/web/src/pages/Queue.tsx`（4103 行，单文件承载 7 个弹窗）、`apps/web/src/i18n/queue.ts`（437 条词条）
审计日期：2026-09-04
审计范围：五个阶段流转弹窗（签到 / 入座 / 完工 / 收银 / 回退）与 Walk-in 详情弹窗
结论：词典本身完整（437 条，五语言零缺失、占位符零错配）；**问题全部集中在 `Queue.tsx` 的调用侧**——弹窗 1/3/4/5/6 未完成 i18n 迁移，且存在大量「界面可操作但提交时被丢弃」的空壳控件。

---

## 一、假实装：界面可操作，提交时被丢弃

这是本次审计最严重的一类问题。前台会以为自己录入的信息进了系统，实际全部落地失败或静默丢弃。

### 1.1 签到弹窗：整块健康偏好与现场加项面板是装饰件（P0）

`Queue.tsx:1065-1076`

```ts
const hasUnpersistedDetails = Boolean(
  addOnService || focusAreas.length > 0
  || contraindications.some((v) => v !== 'No specific contraindications')
  || avoidAreas.some((v) => v !== 'No areas to avoid')
  || massageStrength !== 'Medium Pressure'
  || (oilObj && oilObj.id !== 'none_pref')
  || notes.trim() !== (item.notes ?? '').trim(),
);
if (hasUnpersistedDetails) { setCheckInError(t('queue.quCheckInDetailsUnavailable')); return; }
```

只要前台碰过下列任意一项，签到就被拒绝，并弹出截图中那条红色提示「健康偏好和现场加项尚未接入真实记录，请先清空这些内容后仅完成签到」：

| 面板 | 位置 | 状态 |
|---|---|---|
| 禁忌快速排查标签 | `Queue.tsx:2152-2250` | 选中即阻断签到 |
| 力度偏好 | `Queue.tsx:2206-2228` | 改动即阻断签到 |
| 芳香精油 | `Queue.tsx:2231-2256` | 改动即阻断签到 |
| 重点加压部位 | `Queue.tsx:2258-2290` | 选中即阻断签到 |
| 避免触碰部位 | `Queue.tsx:2292-2337` | 选中即阻断签到 |
| 到店现场增补加项 | `Queue.tsx:2340-2378` | 选中即阻断签到 |
| 顾客特别叮嘱备注 | `Queue.tsx:2381-2392` | 改动即阻断签到 |

实际提交只发送四个字段（`Queue.tsx:1078-1084`）：`appointmentId` / `walkInName` / `requestedServiceId` / `requestedStaffId`。

**建议**：要么补齐后端持久化通道（appointment preference / intake 记录），要么在补齐之前把这七块整体隐藏。当前状态是最坏的一种——占了弹窗 70% 的篇幅，却只会让操作失败。

### 1.2 签到弹窗：加项执行技师下拉 100% 无效（P0）

`checkInModal.addOnStaffId`（`Queue.tsx:2360-2377`）既不在 `hasUnpersistedDetails` 判断里，也不在提交体里。改它不会阻断签到，也不会产生任何后果——是纯粹的假控件，比 1.1 更具误导性。

### 1.3 签到弹窗：纸质问卷勾选框不构成任何门禁（P1，合规风险）

`checkInModal.qrScanned`（`Queue.tsx:2126-2133`）从未被读取。未签署免责协议的顾客同样可以直接签到入场，勾选框只是心理安慰。这与弹窗 2（入座）里 `queue.quNoFormWarning` 的强提示相互矛盾。

### 1.4 完工弹窗：「核对实际执行工时」整块被丢弃（P0）

`Queue.tsx:2984-3013` 提供 5 个时长按钮写入 `completeServiceModal.actualDurationMin`，但提交处 `Queue.tsx:1238` 的解构为：

```ts
const { item, addedAddOns, technicianNotes, markRoomCleaning, roomId } = completeServiceModal;
```

`actualDurationMin` 未被取用。真正上报的时长由服务端根据 `finishItem` 的时间戳自行计算（`features/queue/completeService.ts:143-158`），并在成功 toast 里回显为 `result.actualMinutes`——即前台选了 90m，提示条却可能显示 62m。**这块要么接线，要么删除。**

### 1.5 收银弹窗：「智能小费分账」预览从不上报（P0，涉及提成金额）

`Queue.tsx:1358-1365`：

```ts
const customTipSplits = tipMode === 'custom_per_staff' ? Object.entries(customStaffTips)... : [];
```

- `tipMode === 'total_split'`（默认档，截图 1 所示）下 `customTipSplits` 恒为空数组，`tipSplits` 字段根本不发送。
- 即界面上「Tip Allocation: Bo +$12.00 (100%)」「按服务营收比例 / 平均分配」全部是本地计算的展示，服务端按自己的规则分账。
- `splitStrategy`（比例 / 平均）字段自始至终没有出口。

多技师协作单据一旦按比例分账，前台看到的数字与技师最终拿到的提成会不一致，且没有任何提示。

### 1.6 回退弹窗：「自动同步释放资源」勾选框被丢弃（P1）

`rollbackModal.releaseResources`（`Queue.tsx:3908-3919`）在 `handleConfirmRollback`（`Queue.tsx:1452`）的解构里不存在。回退后包厢/技师是否释放完全由服务端决定，勾选框无效。

### 1.7 入座弹窗：同一状态绑定了两个复选框（P1）

`Queue.tsx:2823` 与 `Queue.tsx:2873` 是两个文案不同、位置不同的复选框（`queue.quVerbalConfirm` 与 `queue.quHandoverDone`），却共享同一个 `startServiceModal.requireBriefingAck`。勾选其中一个，另一个会跟着变——肉眼可见的联动异常。且该字段同样不会提交。

### 1.8 入座弹窗：开始时间为展示值（P2）

`startServiceModal.startTime` 不上报，服务端以 `startItem` 实际时间为准；「预计结束」推算在 `startTime` 为空时硬编码回落到 `'14:00'`（`Queue.tsx:2891` 附近）。

---

## 二、正确性缺陷（涉及金额与单据）

### 2.1 自定义小费把「技师姓名」当作 membershipId 上报（P0，Bug）

- 收银弹窗以**姓名**作为 `staffMap` 与 `customStaffTips` 的键：`Queue.tsx:3264`、`Queue.tsx:3302`、`Queue.tsx:3527`。
- 提交时直接把这个键当作 ID 用：`Queue.tsx:1359-1364`
  ```ts
  Object.entries(customStaffTips).map(([staffMembershipId, value]) => ({ staffMembershipId, ... }))
  ```
- 契约要求的是 membership UUID（`features/checkout/api.ts:37-42`）。对照实现 `pages/Checkout.tsx:490-495` 传的是 `a.membershipId`。

后果：「Enter by Staff」模式下的分账必然写错或被服务端拒绝。**同名技师**还会在 Map 阶段就被合并成一个人。

### 2.2 收银缺少幂等键，存在重复扣款风险（P0）

`Queue.tsx:1398-1414` 调用 `closeTicketMutation.mutateAsync({...})` 未传 `idempotencyKey`。`runCommand` 的默认值是 `crypto.randomUUID()`（`lib/api.ts:130`）——**每次重试都是新键**，幂等保护完全失效。

`features/checkout/api.ts:48-51` 的注释已明确写着「幂等键为必填……客人会被扣两次款」；对照实现 `pages/Checkout.tsx:497` 传了稳定键。同一仓库里两套实现，看板这套是有缺陷的那套。

配套问题：确认按钮（`Queue.tsx:3350-3358`）没有 `isPending` / `isDisabled` 保护，双击即两次 `ticket.pay`。同样的缺陷存在于签到、入座、完工、回退四个确认按钮。

### 2.3 看板收银完全无视门店结账配置（P0）

`grep -c checkoutSettings pages/Queue.tsx` → **0**。而 `pages/Checkout.tsx` 完整消费了这套配置。看板收银弹窗硬编码了：

| 项目 | 看板硬编码 | 应取自 |
|---|---|---|
| 销售税率 | `'8.875'`（`Queue.tsx:527`、`1024`） | `checkoutSettings.salesTaxRatePercent` |
| 税额计算方式 | 恒为 exclusive | `checkoutSettings.taxCalculationMode` |
| 刷卡附加费档位 | `['3.0','3.5','4.0']`（`Queue.tsx:3612`） | 门店配置 |
| 小费档位 | `[0,15,18,20,25]`（`Queue.tsx:3458-3464`） | `checkoutSettings.suggestedTipPercentages` |
| 是否允许改分账 | 未判断 | `checkoutSettings.allowTipSplitOverride` |

另外看板收银不上报 `taxRateBp` / `surchargeRateBp` / `tipTotalCents`，也不支持 `packageRedemptions`（次卡核销）。**同一家店从看板结账和从收银台结账，会得到不同的税额与不同的账**。

### 2.4 刷卡附加费把小费计入了计费基数（P1，合规风险）

`Queue.tsx:3318-3320` 与 `Queue.tsx:1331-1337`：

```ts
cardSurchargeCents = Math.round((afterDiscountCents + taxCents + tipCents) * rate)
```

多数美国州禁止对小费部分收取刷卡附加费。请与 `pages/Checkout.tsx` 的口径对齐并确认业务规则。

### 2.5 完工弹窗时长按钮会渲染重复项（P1，截图 2 可见）

`Queue.tsx:2994`：

```tsx
{[item.durationMin || 45, 60, 75, 90, 120].map((d) => (<button key={d} ...>))}
```

标准 60 分钟服务下数组变成 `[60, 60, 75, 90, 120]`：
- 渲染出两个一模一样的「60m」按钮（截图 2 中两个都处于选中态）；
- `key={d}` 重复，React 会打 duplicate key 警告。

建议改为 `[...new Set([item.durationMin || 45, 60, 75, 90, 120])].sort((a,b)=>a-b)`。

### 2.6 精油默认值与选项 id 不匹配，默认项无法高亮（P2）

初始化写的是 `aromaOil: 'No Preference'`（`Queue.tsx:439`、`Queue.tsx:935`），而 `AROMA_OIL_OPTIONS` 的 id 集合是 `none_pref` / `unscented` / ...（`Queue.tsx:143-151`）。比对条件 `checkInModal.aromaOil === opt.id`（`Queue.tsx:2243`）恒不成立——**打开弹窗时没有任何精油选项处于选中态**。

### 2.7 力度偏好用显示文案当持久化值（P2，隐患）

`STRENGTH_OPTIONS` 存的是 `label`（`Queue.tsx:153-159`），状态里存 `opt.label`，判断也用 label（`Queue.tsx:2215-2218`）。`AROMA_OIL_OPTIONS` 已经重构成 id + 词典键的正确形态，力度这组没跟上。一旦把 label 翻译成中文，历史数据与判断逻辑同时失效。

### 2.8 五种不同的失败原因共用同一条错误文案（P2）

`handleConfirmCheckout` 中 `t('queue.quCheckoutFailed')` 被用于：单据缺失、现金不足、自定义分账为空、分账超额、通用异常（`Queue.tsx:1342/1348/1364/1371` 等）。前台看到「结账失败」但完全不知道该改什么。现金不足这一条尤其应该给出「实收 $X 少于应收 $Y」。

### 2.9 回退到「待收银 / 已收银」必然失败（P2）

`Queue.tsx:1454` 直接拒绝 `toStage === 'ready_checkout' | 'completed'`。但拖拽拦截器 `initiateStageTransition`（`Queue.tsx:902-913`）仍然会把弹窗弹出来，让前台填完原因和备注后才报错。应在 `initiateStageTransition` 阶段就拦掉，或在弹窗内先行禁用确认按钮。

---

## 三、多语言问题（二级弹窗）

词典 `i18n/queue.ts` 本身健康：437 条、五语言（zh-Hans / en / ko / es / vi）零缺失、`{p0}` 占位符零错配。问题在调用侧。

### 3.1 收银弹窗几乎整体未接 i18n（P0，截图 1 的直接成因）

中文界面下弹窗标题、主体、按钮全是英文。硬编码清单：

| 行号 | 硬编码文案 |
|---|---|
| 3339 | `Front Desk Checkout (Tip & Commission Breakdown)` |
| 3357 | `Complete Payment ($...)` |
| 3378 | `Unassigned Room` |
| 3380 | `{n} technicians collaborating` |
| 3385 | `Base Services Subtotal` |
| 3397 | `Execution Details & Commission Split` |
| 3429 | `Tip Split & Earnings Estimate` |
| 3440 / 3450 | `Smart Tip Split` / `Enter by Staff` |
| 3459-3463 | `No Tip` / `15%` / `18%` / `20%` / `25%` |
| 3494 | `Custom Total Tip ($)` |
| 3506 | `Split Strategy` |
| 3514 / 3515 | `Proportional to Service Revenue (Recommended)` / `Equal Split` |
| 3545 | `Tip Allocation:` |
| 3574 / 3580 | `Sales Tax` / `Tax Rate (%):` |
| 3604 | `Card Surcharge` |
| 3635 / 3639 | `Subtotal (Base & Add-ons)` / `Discounts & Vouchers` |
| 3652 / 3658 | `Sales Tax (x%)` / `Credit Card Processing Fee (x%)` |
| 3663 | `Total Due:` |
| 3673 | `Select Payment Method *` |
| 3677-3680 | `Card / POS` / `Cash` / `Gift Card` / `ApplePay` |
| 3719 | `Change Due` |
| 3795 | `Available Balance:` |

### 3.2 中英混排的半句拼接（P0）

`Queue.tsx:3736`：

```tsx
Keep the change (Auto added to tip)（${centsToDollars(rawChangeDue)}  {t('queue.quAutoToTip')}
```

英文句 + 中文全角括号 + 金额 + 中文词条，且括号不配对。截图 1 里「共 1 项」（`queue.quTotalPrefix2` + `quItemsUnit`，`Queue.tsx:3399`）夹在全英文弹窗中，也是同一成因。

### 3.3 Walk-in 详情弹窗整体未接 i18n（P1）

`Queue.tsx:3953-4092`：`Walk-in Guest Record`、`Assign Station & Seat`、`No phone provided (Walk-in)`、`Current Status`、`Requested Service`、`Assigned Specialist`、`Reserved Room / Station`、`Health form and waiver not signed yet`、`Please guide guest to scan or sign on iPad before service.`、`Form Pending`、`Scan Form QR`、`Digital waiver signed & verified`、`Signed & Verified` 全为硬编码。

### 3.4 回退弹窗标题与原因选项未接 i18n（P1）

- `Queue.tsx:3831` 标题 `Rollback Stage Audit Confirmation`；
- `ROLLBACK_REASONS`（`Queue.tsx:99-103`）五个 `label` 为硬编码英文，渲染于 `Queue.tsx:3906`，并被拼进 toast（`Queue.tsx:1474`）。

### 3.5 四组标签常量为硬编码英文（P0，截图 3 的直接成因）

| 常量 | 位置 | 条数 |
|---|---|---|
| `CONTRAINDICATION_TAGS` | `Queue.tsx:107-115` | 7 |
| `FOCUS_AREA_TAGS` | `Queue.tsx:118-128` | 9 |
| `AVOID_AREA_TAGS` | `Queue.tsx:131-140` | 8 |
| `STRENGTH_OPTIONS` | `Queue.tsx:153-159` | 5 |

中文弹窗里出现「Head / Temples」「No areas to avoid」即源于此。**正确范式已经存在**：`AROMA_OIL_OPTIONS`（`Queue.tsx:143-151`）采用 `{ id, labelKey, descKey }`，id 用于持久化、labelKey 用于渲染。这四组照此改造即可，注意同时改掉那些拿字符串字面量做判断的地方（`Queue.tsx:1067-1069`、`2160`、`2300`）。

### 3.6 看板顶部指标卡硬编码（P1）

`Queue.tsx:1606` 的 `Open / Unpaid` 与 `Queue.tsx:1881` 的 `Assign Station & Seat` 未走词典。

### 3.7 西语丢失货币符号（P1，词典缺陷）

以下条目的 `en` 含 `$` 而 `es` 没有，导致西语界面显示「(80.00)」而非「($80.00)」：

`quCheckInConfirm`(237)、`quBaseFee`(305)、`quFinishConfirm`(363)、`quAddOnSubtotal`(370)、`quTotalPrefix`(379)、`quAddOnSep`(380)、`quTotalCollectedPrefix`(401)、`quTipSep`(402)

### 3.8 词典里残留未翻译 / 语义错误的条目（P1）

| 条目 | 现值 | 问题 |
|---|---|---|
| `queue.quOilNoPref` | zh-Hans = `No Preference` | 中文位置放了英文 |
| `queue.quOilUnscented` | zh-Hans = `Unscented Carrier Oil` | 同上 |
| `queue.quTotalCollectedPrefix` | zh-Hans = `Total Collected (服务 $` | 中英混排 |
| `queue.quAssignedRoom` | `指定包厢` / `Assigned room` | **语义反了**：它被用作 `item.roomName \|\| t(...)` 的兜底（`Queue.tsx:2973`），没有房间时却显示「指定包厢」。截图 2 的「工位: 指定包厢」即此。应为「未指定包厢 / Unassigned room」 |
| `queue.quAssigned2` | `已指派` / `Assigned` | 同样的语义反转，用作无技师时的兜底（`Queue.tsx:2973`），应为「未指派」 |

### 3.9 句子被拆成碎片当词条（P1，架构性）

大量词条是「半句话」，靠 JSX 拼接补全，例如：

- `quCheckInConfirm` = `'确认到店并进入候客区 ($'` → 代码补 `{金额})`
- `quTotalPrefix` = `'核算总额 (原服务 $'` + `quAddOnSep` = `'+ 加项小计 $'` → 三段拼一句
- `quMinutesSuffix` = `'分钟)'`、`quFollowLeadStaff` = `'跟随主理技师 ('`

这类词条无法被翻译者正确处理（语序在 ko / vi / es 里是不同的），也是 3.7 那种「丢了个 $」缺陷的温床。**建议统一改成带 `{p0}` 占位符的完整句**，例如 `'确认到店并进入候客区（${p0}）'`。

### 3.10 迁移残留（P2）

`Queue.tsx` 有 32 处「纯空白行紧跟 `{t(...)}`」的结构（`grep -c '^[[:space:]]\+$'` → 33）。这是 i18n 批量替换脚本留下的空文本节点，JSX 会剔除、不影响渲染，但正好标注出脚本处理过的边界——脚本跑完就没人回头补收银弹窗。

---

## 四、UI / 视觉设计问题

### 4.1 设计令牌失控（根因）

在这一个文件里统计到：

- **11 个色系**、约 680 处硬编码颜色工具类：slate 246、teal 103、amber 69、emerald 66、purple 62、red 36、sky 34、rose 31、violet 21、indigo 9、orange 5。
- 语义重复：teal / emerald 都表示「正向」，red / rose 都表示「危险」，purple / violet 都表示「完工」。**同一含义三种颜色**。
- **8 种字号**，其中 106 处是任意像素值：`text-[10px]`×56、`text-[11px]`×37、`text-[9px]`×12、`text-[8px]`×1。8–10px 的文字在前台平板上（臂展距离）基本不可读，且低于无障碍下限。
- **5 种圆角**混用：`rounded-xl`×59、`rounded-2xl`×37、`rounded-lg`×17、`rounded-full`×6、`rounded-md`×3——同一张卡片内部就能出现三种。
- **213 处 `font-bold` / `font-black` / `font-extrabold`**，普通字重只有 30 处。所有东西都在喊，等于没有重点。这是截图里「看起来乱」最主要的直接原因。

组件层被大量绕过：`<Badge variant="secondary" className="bg-amber-100 text-amber-900 border-amber-300">`（`Queue.tsx:1991`）这类「选一个 variant 再用 className 全部覆盖掉」的写法遍布全文。设计系统形同虚设。

**建议**：为看板确立一套语义色板（如 booked=amber / waiting=sky / in_service=teal / ready=purple / done=emerald / danger=rose），字号收敛到 `text-xs` / `text-sm` / `text-base` 三档并抬高下限，圆角收敛到 `lg`（控件）/ `2xl`（卡片）两档，字重收敛到 `medium`（正文）/ `bold`（标题与金额）两档。

### 4.2 弹窗内嵌套滚动容器

四个大弹窗都在 `HeroModal.Body` 内部再套一层 `max-h-[72vh] overflow-y-auto`（`Queue.tsx:1978`、`2473`、`2961`、`3362`）。`Modal` 组件（`components/ui/Modal.tsx`）本身已经管理高度，于是出现双滚动条 / 滚动劫持，并把内容压进一个比可视区更窄的框里。应移除内层的 `max-h` + `overflow`，交给 Modal 统一处理。

### 4.3 弹窗信息密度失衡

以完工弹窗（截图 2）为例：核心动作是「确认完工」，但页面上占地最大的是把**整份服务目录**平铺成 7 个彩色胶囊（`Queue.tsx:3021-3045`），而且点击胶囊只是设置 `extraAddOnServiceId`，并不会加项——真正的加项要用**下方另一个 `<select>` 加「添加」按钮**（`Queue.tsx:3110-3160`）。同一个功能提供了两个外观完全不同的入口，其中一个还没有明显反馈。这是「看起来乱」的第二大来源。

建议：胶囊区改成「常用加项 Top 4 + 更多」，或直接删除胶囊只保留下拉；点击胶囊应直接入列表。

### 4.4 阶段主色与操作语义冲突

签到=amber、入座=teal、完工=purple、收银=emerald、回退=red，五个弹窗各染一色。但确认按钮也跟着染色，于是「完工」是紫色主按钮、「收银」是绿色主按钮——**主行动按钮在不同弹窗里颜色不同**，前台无法形成肌肉记忆。建议主按钮统一用品牌主色，阶段色只用于弹窗标题条与状态徽章。

### 4.5 响应式断点是死代码

`Queue.tsx:1686`：`grid-cols-1 md:grid-cols-3 lg:grid-cols-5` 与 `min-w-[1100px]` 同时存在。`min-w-[1100px]` 让容器在任何视口下都不低于 1100px，`grid-cols-1` / `md:grid-cols-3` 永远不会生效——移动端只会横向滚动。

同处 `Queue.tsx:1698` 的列高 `h-[calc(100vh-270px)]` 是硬编码魔数，顶部指标栏一换行就会溢出或留白。

### 4.6 无障碍与键盘可达性

- 二维码卡片用 `<div onClick>` 实现（`Queue.tsx:2098-2110`），无 `role` / `tabIndex` / 键盘事件。
- 看板卡片仅支持 HTML5 拖拽，没有键盘替代路径；阶段流转对键盘用户完全不可用。
- 弹窗内多个 `<select>` 没有关联 `<label>`（收银弹窗的 Split Strategy、完工弹窗的加项技师等）。入座弹窗已经正确使用了 `aria-label`，其余弹窗没跟上。

### 4.7 复数与数字格式

`{staffList.length} technicians collaborating`（`Queue.tsx:3380`）在只有一位技师时显示「1 technicians」（截图 1 可见）。金额一律用 `centsToDollars` 手工拼 `$`，没有走 `Intl.NumberFormat`，多语言下货币位置与千分位都不正确。

---

## 五、架构性建议

**看板收银弹窗（`Queue.tsx:3244-3820`，约 580 行）是 `pages/Checkout.tsx` 的劣化副本。** 两者都实现折扣、税、附加费、小费分账、Gift Card、现金找零，但看板这份缺少幂等键（2.2）、缺少门店配置（2.3）、分账键用错（2.1）、缺少次卡核销。

建议把结算逻辑抽成共享组件（如 `features/checkout/CheckoutPanel.tsx`），看板与收银台共用。这一步能一次性消除 2.1 / 2.2 / 2.3 / 2.4 四个 P0/P1 缺陷，并让 3.1 的 25 处硬编码文案只需修一遍。

---

## 六、建议修复顺序

**第一批（钱与数据，必须先做）**
1. 2.2 收银补幂等键 + 全部确认按钮加 pending 禁用
2. 2.1 `customStaffTips` 改用 membershipId 作键
3. 2.3 看板收银接入 `checkoutSettings`
4. 1.5 上报 `tipSplits` / `tipTotalCents`，或撤掉分账预览

**第二批（假实装，二选一：接线或隐藏）**
5. 1.1 / 1.2 / 1.3 签到弹窗的健康偏好、加项、问卷门禁
6. 1.4 完工弹窗的实际工时
7. 1.6 / 1.7 回退释放资源、入座双绑定复选框

**第三批（多语言）**
8. 3.5 四组标签常量改 `{ id, labelKey }`（同步改判断逻辑）
9. 3.1 / 3.3 / 3.4 / 3.6 收银、Walk-in、回退弹窗补词条
10. 3.7 / 3.8 修词典缺陷（西语 `$`、`quAssignedRoom` / `quAssigned2` 语义反转、残留英文）
11. 3.9 碎片化词条合并为带占位符的完整句

**第四批（UI 重构）**
12. 4.1 建立语义令牌，收敛色板 / 字号 / 圆角 / 字重
13. 4.2 移除弹窗内层滚动容器
14. 4.3 完工弹窗加项区改为单一入口
15. 4.4 主按钮统一色；4.5 修响应式；4.6 无障碍；4.7 复数与货币格式
16. 五、把收银逻辑抽成共享组件

**建议同时补一条 lint 规则**：禁止 `.tsx` 中出现裸的中英文用户可见字面量，否则这类问题会以同样的方式再次出现。
