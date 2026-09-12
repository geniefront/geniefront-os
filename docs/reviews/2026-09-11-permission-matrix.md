# A 线：权限矩阵对账

> 范围：v1 `geniefront-os`。对账脚本：`scripts/check-permission-matrix.mjs`

## 结论先行

服务端的权限架构是好的：判定是**单点**的（`apps/api/src/bus.ts`，按命令注册表
声明的 `permission`），不是散在 31 个 handler 里。因此对账能自动化，
而不是靠肉眼逐页走查。

但恰恰因为判定只认「命令」这一个粒度，漏掉了三类东西。三类都不是某个人写错了
一行，而是**同一个结构性盲区的三种表现**：能力的边界和命令的边界不重合时，
权限就落空了。

| 类别 | 数量 | 性质 |
|---|---|---|
| 定义了但没注册的命令 | 1 | 功能整条失效（404） |
| 字段级越权 | 2 类 / 8 条命令 | **安全** |
| 死权限 | 4 | **给店主的假承诺** |
| 漏门禁（前端） | 19 | 亮着的按钮点下去 403 |

---

## A-1 ⭐ `staff.recordDirectCashTip` 从未注册 → 线上必然 404

**现象**：技师端「记录客人直接给我的现金小费」整条功能不可用。

**根因**：`defineCommand` 只是造出一个对象。命令要能被调用，还必须出现在
`packages/contracts/src/commands/*.ts` 汇总的那几个 `*_COMMANDS` 数组里。
这一条定义在（`commands/staff.ts:124`）、handler 注册了
（`handlers/staff.ts:405`）、前端调用点的类型也对（`features/tech/api.ts:129`），
唯独没进 `STAFF_COMMANDS`。

**为什么没人发现**：**没有任何编译期错误**。类型全都对得上，只有路由不存在。

**已修**：补进 `STAFF_COMMANDS`。

**防复发**：`packages/contracts/src/registry.test.ts` 新增注册表完整性用例 ——
扫出所有 `defineCommand` 的名字，逐个断言在注册表里。全仓 180 条命令，
此前漏了 1 条。

---

## A-2 ⭐⭐ 字段级越权（AUD-02）

总线里的门只有一道：「你有没有 `def.permission`」。但有两项能力根本不是独立
命令，而是**另一条命令入参里的一个字段**：

| 能力 | 实际载体 | 该命令要求的权限 | 谁有这条权限 |
|---|---|---|---|
| 打折 | `ticket.close/pay/closeGroup` 的 `discountCents` | `ticket.write` | **技师也有** |
| 突破软容量 | `appointment.create/reschedule/addItem` 与 `ticket.startItem` 的 `override` | `appointment.write` / `ticket.write` | 技师有后者 |

权限清单里明明有 `ticket.discount` 和 `appointment.overbook` 两条，
却**没有任何一条命令要求它们**，全仓也没有任何一处判定。

**唯一的约束是界面把折扣输入框藏了起来** —— 而藏起来不是约束。持有
`ticket.write` 的技师（预设里技师就有）可以直接把整单折成 0。

更坏的一面是它给了店主一个**假的确认**：设置页里「打折」那个勾选框取消掉以后，
他以为限住了，实际什么也没发生。

这与 `system` 标记那次（AUD-01）是同一族缺陷：**标记存在，没人强制。**

### 修法：把字段级权限做成契约里的一等概念

不修在各个 handler 里 —— 那等于要求每个加字段的人记得加判定，
而这条缺陷本身就是没人记得的产物。

- `CommandDef.fieldPermissions`（`packages/contracts/src/command.ts`）：
  声明式地写「这个字段被真的用到时，额外需要哪条权限」
- 判定统一在总线（`apps/api/src/bus.ts` §2b），排在入参校验**之后** ——
  要先拿到值，才能区分「传了 `discountCents: 0`」和「真的打了折」
- 被拒时 403 里点名字段，给的是「你不能改这一项」而非笼统的「权限不足」

已声明：`ticket.close` / `ticket.pay` / `ticket.closeGroup` 的 `discountCents`；
`appointment.create` / `createBatch` / `reschedule` / `addItem` 与
`ticket.startItem` 的 `override`。

豁免并写下理由：`coupon.saveTemplate` / `marketing.saveCouponTemplate` 的
`discountCents` 是「这张券面值多少」，不是「这一单打了多少折」。

**回归**：`apps/api/src/fieldPermissions.test.ts`，按**全集**写 ——
断言对象是注册表本身，新增一条带这些字段的命令而忘了声明，当场红。
已验证：撤掉声明后 3 条用例里红 2 条。

### 一处顺带澄清

收紧 `ticket.startItem.override` 时我担心会锁死技师（技师预设没有
`appointment.overbook`）。查证后不成立：技师端**从来就不发** `override`
（`features/tech/api.ts` 的 startItem 只传 `ticketItemId`），撞上上限时给的
文案是「找前台」。带 reason 重试的一直是前台，而前台有这条权限。

### 前端配套

三处「强制排入」按钮（`CreateAppointmentModal` / `Queue` / `Schedule`）
此前只守 `appointment.write`。已换成 `GuardedButton permission="appointment.overbook"`,
让没有这条权限的人看到可读的原因，而不是按下去收一个 403。

---

## A-3 死权限：声明了，但全仓没有任何一处判定

这一类最坏 —— 不是「少了个功能」，是**给店主的假承诺**：他在设置页取消勾选，
以为限住了某项能力，实际什么也没发生。

`ticket.discount` 与 `appointment.overbook` 原本也在此列，已由 A-2 补上判定。
剩余四条是**口径决定，不是 bug**，需店主拍板：

| 权限 | 现状 | 建议 |
|---|---|---|
| `ticket.refund` | `ticket.refund` 命令实际要求的是 `ticket.void` | 二选一：① 改要求 `ticket.refund`（则**店长将不能退款**，预设里只有店主有）；② 删掉这条权限，承认退款与作废同权 |
| `marketing.manage` | 营销命令实际要求 `settings.manage` | 二选一：改要求它，或删掉。注意店长同时持有两者，改动对现有角色无影响 |
| `package.manage` | 套餐命令实际要求 `catalog.manage` / `ticket.write` | 同上 |
| `ai.execute_without_confirm` | 无任何代码路径读取 | 与 `registry.test.ts` 现有断言（每条暴露给 AI 的命令都必须确认）相矛盾。建议删掉，否则它是个永远不生效的开关 |

前三条都是同一个形状：**权限清单按业务直觉分类，命令按实现分类，两套分类没对齐。**

脚本里为这四条留了显式待决清单并写明理由 —— 新增的死权限会立刻报红，
而不是被这四条的长期存在淹没。

---

## A-4 漏门禁：19 条命令，前端从未检查它要求的权限

**这不是理论问题**，而是 `lib/permissions.ts` 自己的注释警告的那一种：

> 按角色画界面会得到一个「亮着但点下去 403」的按钮，用户对此的解读是系统故障。

**系统性根因**：导航与页面**完全没有按权限过滤**。`Layout.tsx` 里只有
`settings` 一项看了权限（第 228 行），其余每一页对每个前台账号都可见，
页内按钮也全是活的。

触发路径正是该模块记录的核心用例：店主在不改角色的前提下，单独撤销某个前台的
`dayclose.manage`。那名员工照样看到「打烊日结」入口、照样能点每一个按钮，
而每一次点击都 403。

（技师不走这个外壳 —— 他们在技师端，所以受影响的是**被单独撤权的前台/店长**，
以及店主自建的自定义角色。）

明细与修复进度见下节。

### 已修（19 → 3）

| 页面 | 命令 | 权限 | 修法 |
|---|---|---|---|
| `Rotation.tsx` | checkIn / checkOut / skip / reorder / setBreak | `rotation.override` | 控件禁用 + 处理函数兜底 + 只读提示条 |
| `Rotation.tsx` | assign | `appointment.write` | 单独取，不与 override 合并 |
| `Rotation.tsx` | updatePolicy | `settings.manage` | 同上 |
| `DayClose.tsx` | saveCount / recordCash / finalize | `dayclose.manage` | 同上 |
| `DayClose.tsx` | payTips | `tip.payout` | 与 `dayclose.manage` 分开 —— 有的店老板亲自发钱，前台只数抽屉 |
| `DayClose.tsx` | reopen | `payroll.configure` | 重开已封的账 |
| `Customers.tsx` | customer.merge | `customer.merge` | 合并确认按钮 |
| `Customers.tsx` | customer.sendSms | `comms.send` | 发送确认按钮 |
| `Messages.tsx` | sms.sendDirect | `comms.send` | 与既有的 10DLC 闸门**并列**而非合并 —— 「号码还没审批」和「你没有权限」要找的人不是同一个 |
| `Queue.tsx` / `Rooms.tsx` / `Dashboard.tsx` | queue.join | `queue.join` | 弹窗内如实说明原因，而不是静默 return |

新增共用组件 `components/ui/ReadOnlyNotice.tsx`：一屏十几个灰按钮不会被读成
「我没权限」，只会被读成「系统坏了」或「还没加载完」。要在页面顶部先说清楚，
下面的灰才有解释。

### 顺带发现：两处前端死代码

`useAdjustGiftCard`（`Marketing.tsx:221`）与 `useSavePayrollPlan`
（`features/payroll/api.ts:19`）都**声明了 mutation 但没有任何界面使用**。
`giftcard.adjust` 与 `payroll.savePlan` 因此进不到用户手里 —— 门禁问题是次要的，
先要定这两个功能是没做完还是不要了。

### 留待口径决定（3）

`notification.markRead` / `notification.markAllRead` / `staff.setLocale`
要求的都是 `appointment.read`。每个角色预设都有这条，所以今天守不守没有实际差别。
但**要求本身是可疑的**：把通知标为已读、改自己的界面语言，与「能不能看预约」
没有任何关系，看起来是当初随手填了一条人人都有的权限。

该定的是这些命令到底该要求什么，而不是在界面上补一道守着 `appointment.read` 的门。

---

## A-5 复核通过的部分

- **5 条未声明 `permission` 的命令**（`user.updateProfile`、`staff.setPin`、
  `user.revokeSession`、`user.saveNotificationPreferences`、`support.submitRequest`）
  经逐条复核**没有问题**：都是对自己账号的操作。其中 `staff.setPin` 接受可选的
  `membershipId`，handler 里对「改别人的 PIN」检查了 `staff.manage`，
  并且按 location 收窄（AUD-06 已处理过跨门店那层）。
- **2 条孤儿门禁**（`customer.view_contact`、`report.view`）是只读显隐，正常。
  服务端在查询层判定（`queries/customer.ts`、`businessSummary.ts`）。
- **读权限整体架构正确**：不走命令总线，在查询层判定，脱敏发生在数据出库那一刻
  而不是界面上。

---

## 工具与防复发

| 位置 | 作用 |
|---|---|
| `scripts/check-permission-matrix.mjs` | 全量对账。已接入 `scripts/lint-guards.sh` 第 11 条 |
| `packages/contracts/src/registry.test.ts` | 注册表完整性：定义了就必须注册 |
| `apps/api/src/fieldPermissions.test.ts` | AUD-02 回归，按全集断言 |

对账脚本自带两份**待决清单**（死权限 4 条、漏门禁 3 条），每条写明为什么还没定。
留清单而不是让脚本长期红着 —— 一个永远失败的检查会被忽略，
于是新出现的缺口也跟着被忽略，那正是这个检查要防的事。

### 脚本本身的局限（写下来，免得被误读成保证）

判定粒度是**全站**而非每个调用点：只要有任意一处检查过某条权限，
要求该权限的命令就算「守住了」。这挡得住「整类能力完全没人守」，
挡不住「A 页守了、B 页忘了」。后者要靠逐页走查。

它也**不是安全边界** —— 它检查的是界面是否诚实，不是服务端拦不拦得住。

---

## 验证

- `pnpm --filter @gf/contracts test` → 70 项通过（含新增注册表完整性）
- `pnpm --filter @gf/api exec vitest run src/fieldPermissions.test.ts` → 3 项通过；
  **撤掉修复后复验：3 条里红 2 条**
- `pnpm --filter @gf/web typecheck` → 干净
- `pnpm --filter @gf/web test` → 68 文件 441 项通过
- `bash scripts/lint-guards.sh` → ✓ 全部通过（含新增第 11 条）
