# 订阅码计费（Stripe 之外的第二条计费权威）实施计划

日期：2026-09-09 · 状态：**批 1–8 全部实现**· 范围：后端为主，运营台前端单列一批

## 1. 要解决的问题

今天全系统只承认一条计费事实来源：Stripe。`handlers/billing.ts` 里写得很直白 ——
"Stripe is the only writer of paid subscription / credit state"，`billing.changePlan`
与 `billing.buyAddon` 在本地一律拒绝执行。这条纪律本身是对的（钱的状态只能有一个
权威），但它把一类真实客户挡在了门外：

- 店家不愿意/不方便绑卡，希望微信、支付宝、Zelle、现金私下付款；
- 我们已经收了钱，需要在系统里把服务开出来，并且能改有效期；
- 已经在用 Stripe 的店家想改成这种付法（或者反过来）；
- 单独卖一包 AI 积分 / 语音分钟，不走 Stripe Checkout。

因此本计划不是"绕过计费闸门"，而是把"唯一权威"扩成 **"每个门店恰好有一个计费权威"**：
`stripe` 或 `license`（订阅码），二者互斥、可切换、切换有留档。

## 2. 不变量（一条都不许破）

1. **一行账户只有一个权威。** `billing_accounts.billing_source ∈ (none, stripe, license)`。
   Stripe webhook 永不改写 `license` 行；订阅码永不改写 `stripe` 行。
2. **额度包不引入新的余额概念。** 兑换额度包 = 往 `credit_ledger` 追加一条
   `kind='topup', source='license'`。账本只追加的纪律（宪法第 9 条）原样保留。
3. **积分与语音分钟不可互换**（决策 8）。码上写的是哪个 unit 就加哪个 unit，不做换算。
4. **金额只用整数分。** 私下收款的面值 `amount_cents` 只做对账留档，不参与任何计算。
5. **一张码只能生效一次，且只属于一个 org。** 同 AUD-02 的精神：`license_redemptions`
   唯一约束 + advisory lock 兜底，重放返回已生效的那一次。
6. **明文码不落库、不进日志。** 只存 `sha256`，签发响应里返回一次；
   `logRedact.ts` 增加脱敏规则。
7. **有效期是显式写死的时刻，不是代码里数出来的天数。** Stripe 模式下事实源是
   `current_period_end`（Stripe 的镜像）；license 模式下事实源是
   `license_period_end`（签发/续期/运营改期那一刻算好写进去的）。两种模式都不在
   请求路径上数日子。

## 3. 数据模型（迁移 `sql/0120_license_codes.sql`）

### 3.1 `license_codes` —— 一张码一行

| 列 | 说明 |
| --- | --- |
| `id` | uuid pk |
| `kind` | `subscription` \| `quota_pack` \| `store_open`（开店码，见 §7） |
| `code_hash` | `sha256(明文)`，unique。**明文不存** |
| `code_prefix` | 明文前 4 位（`GF-3F7K…`），只给运营检索用 |
| `plan` | subscription/store_open：`essential` \| `growth`；quota_pack 为 null |
| `duration_days` | subscription/store_open：这张码能买多少天（如 30 / 365） |
| `unit` / `amount` | quota_pack：`credit` \| `voice_minute` + 整数数量 |
| `amount_cents` | 面值留档（私下收了多少钱）。可空 |
| `payment_note` | `wechat 2026-09-09 ¥1500 / 张老板` 之类的收款说明。必填 |
| `target_org_id` / `target_location_id` | 定向签发时写；空 = 任意门店可兑换 |
| `valid_until` | **码本身**的可兑换截止时刻（默认签发后 90 天）。与订阅有效期是两件事 |
| `status` | `active` \| `redeemed` \| `revoked` \| `expired` |
| `issued_by_operator_id` / `issued_at` | 谁签发的 |
| `revoked_at` / `revoked_by_operator_id` / `revoke_reason` | 撤销留档，行不删 |

RLS：整张表 **不开放给 `app_user`**（无 tenant 列可隔离）。所有读写走
`security definer` 函数，调用方必须是 `platform_operators` 活跃行 —— 与
`sql/0074` 平台台的现有做法一致。店主侧兑换只经过一个窄口函数（§4.3）。

### 3.2 `license_redemptions` —— 兑换事实，只追加

`code_id`（唯一，`max_redemptions = 1` 的兜底）、`org_id`、`location_id`、
`redeemed_by_user_id`、`redeemed_at`、`effect jsonb`（生效前后的
`billing_source / plan / period_end / 额度增量`，用于事后解释"这家店为什么是这个到期日"）。
`update`/`delete` 用触发器封死，与 `credit_ledger` 同一条纪律。

### 3.3 `billing_accounts` 新增列

- `billing_source text not null default 'none' check (billing_source in ('none','stripe','license'))`
  - 回填：`stripe_subscription_id is not null → 'stripe'`，其余 `'none'`。
- `license_period_end timestamptz` —— license 模式的事实源。
- `license_code_id uuid references license_codes(id)` —— 当前生效的那张码。
- `license_expiry_notified_at timestamptz` —— 到期前提醒的去重标记（同
  `trial_will_end_notified_at` 的用法）。
- `subscription_status` 的 check 增加 `'expired'`（见 §5.2 的取舍）。

license 模式下 **同时把 `current_period_end` 镜像成 `license_period_end`**：
`queries/billing.ts` 与 `apps/web` 的展示逻辑不必分叉，只有"谁有权写"这一层分叉。

## 4. 核心行为

### 4.1 唯一入口 `applyLicense()`（`apps/api/src/billing/license.ts`）

所有 license 侧的权威写入只走这一个函数：签发即兑换、店主自助兑换、运营改期、
到期回收，全部调它。两处分别写 entitlement 的话，迟早在"清零"和"到期"上漂开，
而漂开的表现是"有的店过期了还能用"。

它在一个事务里做：
1. `select … for update` 锁账户行；
2. 校验权威冲突：`billing_source='stripe'` 且订阅仍活 → 抛 `VALIDATION_FAILED`
   （`reason: 'stripe_active_switch_required'`），必须先走 §6 的切换；
3. subscription/store_open：`license_period_end = max(now(), 现有到期) + duration_days`
   —— **续期是叠加，不是覆盖**（提前续费的店不该被砍掉剩余天数）；
   写 `billing_source='license'`、`plan`、`subscription_status='active'`；
4. quota_pack：`appendLedger({ kind:'topup', unit, amount, source:'license',
   paidCents: amount_cents, reason })`；
5. 写 `license_redemptions` + `license_codes.status='redeemed'`；
6. 审计：运营侧 `writePlatformAudit`，店主侧走命令总线自带的 audit。

### 4.2 运营台 API（`apps/api/src/platform/`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/platform/licenses` | 签发。响应体是**唯一一次**能看到明文码的地方 |
| GET | `/v1/platform/licenses` | 列表（按状态/前缀/门店筛），永不返回明文 |
| POST | `/v1/platform/licenses/:id/revoke` | 撤销未兑换的码；必须写原因 |
| POST | `/v1/platform/stores/:locationId/license/apply` | 定向签发 + 立即生效（等价于 §4.1，不另开写入路径） |
| PATCH | `/v1/platform/stores/:locationId/license` | 改有效期：`{ periodEnd \| extendDays, note }`，`note` 必填 |
| POST | `/v1/platform/stores/:locationId/license/revoke` | 立刻收回（`subscription_status='expired'`），必须写原因 |

权限：签发/改期/收回限 `role = 'super_admin'`；`support` 只读。这是直接放行付费
服务的动作，和"回工单"不在一个量级。

### 4.3 店主自助兑换

`POST /v1/desk/billing/redeem-code` → 命令 `billing.redeemCode`（需 `billing.manage`）。

⭐ 已过期的店照样能兑换续期：`bus.ts` 的 `WRITE_ALLOWED_WHILE_PAST_DUE` 已经包含
`'billing.'` 前缀，冻结闸门天然给它开着口子。**这条不要改，也不要另加白名单。**

限速：按 `location_id` + IP，每分钟 5 次、失败 10 次锁 15 分钟（复用
`public/rateLimit.ts`）。码是"捡到就能用"的凭证，不限速等于开了爆破入口。
错误一律返回同一个 `VALIDATION_FAILED / reason: 'code_invalid'`——
不区分"不存在 / 已用过 / 已撤销 / 过了兑换期"，避免变成一个可探测的接口。

## 5. 到期与清零

### 5.1 `ops/licenseSweep.ts`

照 `ops/outboxSweep.ts` / `ops/retention.ts` 的写法：**应用内定时**，不用
`pg_cron`（托管实例上不一定开着）。每 10 分钟一轮：

1. `billing_source='license'` 且 `license_period_end < now()` 且 status 不是 `expired`
   → 置 `subscription_status='expired'`，写审计；
2. 到期前 7 天 / 1 天各发一次提醒（走现有 outbox + 通知模板），
   `license_expiry_notified_at` 去重；
3. **套餐内额度清零**：license 模式没有 Stripe 的续订事件，所以以
   `included_period_start` 为准滚动 —— `now() - included_period_start >= 30 天`
   就重置 `included_credits_used / included_minutes_used` 并把
   `included_period_start` 推进 30 天。⚠️ 不是"清到 now()"：那样会因为每轮扫描的
   时刻抖动而慢慢漂开账期。

### 5.2 为什么新增 `expired` 而不复用 `past_due`

复用 `past_due` 改动最小（`FROZEN_STATUSES` 已含它），但对私下付款的客户显示
"扣款失败"是错的信息，而且运营台分不清"卡被拒"和"订阅码到期"。取舍后选择新增
`expired`：改动集中在三处 —— DB check、`bus.ts` 与 `aiAdmission.ts` 的
`FROZEN_STATUSES`、`apps/web` 的文案键。三处都有测试盯着。

## 6. 两种权威之间的切换

### 6.1 Stripe → 订阅码

一个动作、一个事务边界之外的两步，顺序不能反：

1. **先在 Stripe 侧停掉这家店的收费**。⚠️ 多店经营共用**同一条订阅**，每家店是
   其中一个 item（`stripe_subscription_item_id`，见 `sql/0080`）。所以删的是
   **该店的 item**，不是整条订阅；只有当它是最后一个 item 时才取消订阅本身。
   删错了会把老板另外两家店一起停掉。
2. 再调 `applyLicense()`：`billing_source='license'`，`stripe_subscription_item_id`
   置空，`stripe_customer_id / stripe_subscription_id` **保留**（历史事实不删，
   而且他可能随时切回来）。

已付未用的那部分钱不在系统内折现 —— 退款由人在 Stripe 后台操作，
`payment_note` 里写清楚。系统里自动算比例退款是另一个量级的复杂度，不做。

### 6.2 订阅码 → Stripe

老板自己去走 Checkout / Customer Portal，webhook 落 `billing.syncSubscription`
时视为**接管**：`billing_source='stripe'`，`license_period_end` 保留留档但不再生效，
`license_codes` 那一行状态不动（它已经 redeemed 了）。

### 6.3 webhook 必须跳过 license 行（**最高风险点**）

`applySubscriptionToRow()` 今天会把一条 `customer.subscription.updated` 落到
**同一条订阅上的每一家店**。如果其中一家已经改用订阅码，这条事件会静默把它改回
Stripe 的状态和到期日 —— 表现是"这家店明明续到年底，某天早上突然显示欠费"，
而且没有任何报错。

改法：`applySubscriptionToRow()` 开头判 `billing_source='license'` 且事件不是
"这家店自己新建的订阅" → 跳过该行并记一条 info 日志。这一条必须有专门的测试
（多店共用订阅 + 其中一家 license）。

## 7. 运营直接开店（不经 Stripe）

今天门店的出生路径有两条：`gf_provision_tenant()`（付款 → webhook）和
`setup.location.create`（已登录老板开第二家店）。加第三条：运营签发一张
`kind='store_open'` 的码，在运营台点"开店"。

- **复用 `gf_provision_tenant()`，不新写一个建店函数。** 幂等键从
  `checkout_session_id` 扩成"出生幂等键"，运营路径传 `lic_<code_id>`；
  `signup_intents.metadata.origin = 'ops_license'` 留档。建店逻辑（归一化回退、
  角色预设、默认营业时间）抄第二遍就一定会有一天两边不一致。
- 建完店后 `applyLicense()` 把 license 挂上（`billing_source='license'`，
  `subscription_status='active'`），再走**现有的** `sendActivationOnce()` 发
  magic link。⚠️ 不要为这条路径另造激活码 —— `signup/activation.ts` 的文件头
  已经论证过为什么"成为一家门店的老板"这件事必须复用 Supabase 的 magic link。
- **不做面向公众的开店码兑换页**：那等于开一个未登录就能建租户的入口。

## 8. 发票页（可选，建议做）

私下收款没有 Stripe 发票，老板的发票页会是空的。往 `billing_invoices` 写一行：
`status='paid'`、`stripe_invoice_id=null`、`hosted_invoice_url=null`、
`description='订阅码 GF-3F7K…（微信转账）'`、`amount_cents = 面值`。
好处是老板的账目连续，我们对账也有一张表可查。

## 9. 批次划分

| 批 | 内容 | 交付判据 |
| --- | --- | --- |
| 1 | 迁移 0120 + drizzle schema + contracts + `applyLicense()` 核心 | 迁移测试 + `applyLicense` 单测（叠加续期、权威冲突、幂等重放） |
| 2 | 运营台 API：签发 / 列表 / 撤销 / 改期 / 收回 + 平台审计 + 权限分级 | 路由测试含 `support` 只读被拒 |
| 3 | 店主兑换命令 `billing.redeemCode`（含 quota_pack 走账本）+ 限速 + 日志脱敏 | 过期店仍能兑换续期的测试；额度包兑换后账本对账一致 |
| 4 | Stripe ↔ license 切换：item 级删除、webhook 跳过 license 行 | 多店共用订阅 + 其中一家 license 的回归测试（§6.3） |
| 5 | `ops/licenseSweep.ts`：到期置 `expired`、到期前提醒、额度按 30 天滚动清零 | sweep 单测用可注入时钟，不 sleep |
| 6 | 运营直接开店（`store_open` 码 → `gf_provision_tenant` → 激活信） | 端到端：签发 → 开店 → 收到 magic link → 能开单 |
| 7 | `billing_invoices` 留痕（§8） | 发票页出现该行 |
| 8 | 运营台前端（`apps/platform`：Licenses 页 + StoreDetail 计费卡片）与 desk 兑换入口 | ✅ 已完成，见 §13 |

## 12. 实现记录（2026-09-09，批 1–7 完成）

### 迁移

| 文件 | 内容 |
| --- | --- |
| `sql/0120_license_codes.sql` | 两张码表 + `billing_accounts` 四列 + 六个窄口函数 + RLS |
| `sql/0121_license_expiry_notice.sql` | `email_outbox.kind` 白名单加 `license_expiring` |
| `sql/0122_license_sweep_functions.sql` | 到期扫描要用的三个 SECURITY DEFINER 窄口 |

批 7 没有迁移：`billing_invoices` 从 0052 起就有，这一批只是**多了一个写入者**。

### 与原计划的差异（都是实现过程中被现实纠正的）

1. **`license_redemptions` 给了 `tenant_isolation` 只读策略**，不是原计划的「两张表都完全
   关闭」。`rls.test.ts` 有一条「带 `org_id` 的表必须有隔离策略」——开了 RLS 却没有策略
   在那条测试里是**故障**，不是更安全。而且门店对自己那几行确实有知情权
   （「我的服务为什么到这一天」）。写入仍然只能走窄口。
   `license_codes` 没有 `org_id`，保持完全关闭 —— 能查它就能枚举别人的码。

2. **扫描必须走 definer 窄口（`sql/0122`），这是踩出来的。** `ops/licenseSweep.ts` 第一版
   直接写 `update billing_accounts … where license_period_end <= now()`，而定时任务跑在
   没有租户上下文的连接上、那张表是 force RLS —— **匹配零行，不报错、不告警**，
   三个用例全绿地返回 0。

3. **`applyLicense` 与命令处理器合并进 `handlers/license.ts` 一个文件。** 两个原因：
   写业务表只允许发生在 `handlers/` 下（`lint-guards.sh` 第 9 条会拦），而拆成
   `billing/license.ts` + `handlers/license.ts` 又会和 `handlers/billing.ts` 的
   `appendLedger` 形成循环 import。

4. **切换 Stripe→license 用 `detachedFromStripe` 显式开关**越过权威冲突检查，
   且只有 `switchStoreToLicense` 在 Stripe 侧真的删掉 item / 取消订阅之后才传。

5. **`ownerShopOf` 从 `stripe/routes.ts` 抽到 `email/ownerShop.ts`**：到期提醒要的是
   一模一样的「收件人 + 语言 + 时区 + 店名」，抄第二遍必然漂。

6-b. **种子多了一个活着的 `support` 运营**（`support@maildrop.cc`）。在它之前
   「support 能看不能发」验不出来 —— 种子里唯一的 support 是**被撤销的**那个，
   拿它去签发撞的是 `not_platform_operator`，看起来也是拒绝，但原因完全不同。

7. **种子的清理顺序补了两张码表**。它们对 `locations` / `organizations` /
   `platform_operators` 都有外键，而种子会把运营全删了重建 —— 漏掉的表现是一句
   和订阅码毫无关系的报错：`violates foreign key constraint
   "license_codes_issued_by_operator_id_fkey"`。

### 接口清单

店主侧：`POST /v1/desk/billing/redeem-code`（限频 IP 10/分 + 门店 30/时）。

运营侧：
```
GET    /v1/platform/licenses                                   列表（support 可读）
POST   /v1/platform/licenses                                   签发（限 super_admin，明文只此一次）
POST   /v1/platform/licenses/:codeId/revoke                    撤销未兑换的码
GET    /v1/platform/stores/:locationId/license                 现状 + 兑换历史
POST   /v1/platform/stores/:locationId/license/apply           定向签发 + 立即生效
POST   /v1/platform/stores/:locationId/license/switch-from-stripe  先删 item 再挂订阅码
PATCH  /v1/platform/stores/:locationId/license                 改有效期（note 必填）
POST   /v1/platform/stores/:locationId/license/revoke          立刻收回
POST   /v1/platform/stores                                     运营直接开店
```

### 测试

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `packages/db/src/licenseCodes.migration.test.ts` | 21 | 约束、RLS、窄口身份、并发、可重放 |
| `apps/api/src/license.test.ts` | 30 | 兑换、叠加续期、额度包、私下收款发票、权威互斥、webhook 跳过、到期与冻结、运营台、开店 |
| `apps/api/src/licenseSwitch.test.ts` | 5 | 切换时只删本店 item（Stripe 用替身） |

全量：`@gf/db` 114 绿；`@gf/api` 1288 项中仅 `copilot/acceptance.test.ts` 5 项红 ——
那个文件把日期写死在 `2026-09-07`（今天 09-09），是**与本次改动无关的日期腐坏**。

### 已知待办

（批 1–7 的待办已在批 8 中清掉，见 §13。）
- 批 7 已完成：面值 > 0 的码在兑换时写一行 `status='paid'`、
  `stripe_invoice_id = null` 的发票，号码 `LIC-<codeId 前 8 位>`。
  没写面值的码（补偿性赠送）不写发票 —— 没收到钱就不该有单据。

批 1–6 之间可以连着做；批 4 是唯一会碰到既有 Stripe 逻辑的一批，单独跑一遍
`multistore` 与 `subscriptionLifecycle` 全套。

## 10. 必须有的测试（挑最容易漏的）

1. license 行不被 Stripe webhook 改写（多店共用订阅场景）；
2. 同一张码并发兑换两次 → 只生效一次，第二次返回同一结果；
3. 续期叠加：剩 10 天时兑换 30 天码 → 40 天，不是 30 天；
4. `expired` 冻结写入但读操作照常（与 `past_due` 同一套断言）；
5. 额度包兑换后 `credit_ledger` 链条与 `*_balance` 缓存一致（现有对账测试直接覆盖）；
6. 撤销过的码、过了 `valid_until` 的码、别家 org 的定向码 → 都是同一个
   `code_invalid`，错误体里不泄露原因差异；
7. 明文码不出现在任何日志与审计记录里（`logRedact` 测试）。

## 11. 明确不做

- 不做按比例退款/折现（Stripe 后台人工处理）；
- 不做面向公众的未登录兑换页；
- 不做码换积分与分钟之间的任何换算（决策 8）；
- 不让运营直接 update `billing_accounts` —— 所有 license 写入必经 `applyLicense()`。

## 13. 批 8 实现记录（前端，2026-09-09）

### 运营台 `apps/platform`

| 文件 | 内容 |
| --- | --- |
| `src/pages/Licenses.tsx` | 新页面：列表（状态/类型/前缀·收款说明·门店 三种筛选）+ 签发表单 + 撤销 |
| `src/components/LicensePanel.tsx` | 门店详情里的「计费权威」卡片 + 四个动作 + 兑换历史 |
| `src/pages/Stores.tsx` | 加「不经 Stripe 开一家店」表单（super_admin 才显示） |
| `src/lib/license.ts` | 类型 + `centsFromUsdInput` / `intFromInput` / `usdFromCents` |
| `src/pages/StoreDetail.tsx` | license 门店不再显示「Open Stripe Customer Portal」 |

四个动作**故意长得不一样**，因为它们不是一件事的四个选项：

- **Grant / renew** —— 已经归订阅码管，加天数就完了；
- **Switch off Stripe → code** —— 独立按钮。它会先在 Stripe 那边删掉**这家店那个
  item**（最后一个 item 时才取消订阅），是一个**对外**的动作，文案里必须说清；
- **Change end date** —— `note` 必填，`extend` 从 `max(今天, 现有到期)` 起算；
- **Revoke now** —— 当场到期，红色按钮，且说明「不动兑换历史」。

界面上把 Grant 在 `billingSource === 'stripe'` 时藏起来 —— 服务端那时会直接拒
（`stripe_active_switch_required`），而那个拒绝是对的。

`super_admin` 之外只读：签发/改期/收回的按钮都不渲染。**这只是免得 support 点了
之后收到一个看不懂的 403，判定仍然在数据库里**（`gf_license_issue`）。

明文码只在签发响应里出现一次，页面上用一块必须手动关掉的面板显示 + 复制按钮，
**不做「重新查看」**（那需要把明文存下来）。

### 门店端 `apps/web`

| 文件 | 内容 |
| --- | --- |
| `features/billing/api.ts` | `useRedeemLicenseCode()`（走 REST 路由，因为限频在路由上） |
| `features/billing/BillingPanel.tsx` | 兑换码输入块；license 门店不显示 Stripe 客户门户与「未绑卡」 |
| `features/billing/display.ts` | `expired` 文案与红色徽章；`subscriptionNotice` 的 license 分支；`isLicenseBilling` |
| `i18n/settings.ts` | 12 个新词条 × 5 种界面语言 |

三处判断值得记下来：

1. **`subscriptionNotice` 里 license 分支排在最前面。** 它下面那几档全是 Stripe 的
   语汇（「期末取消」是客户门户的产物、「下次扣款」的前提是有一张卡），
   落到 license 门店身上会显示「X 日自动续费」，而事实是到那天就停。
2. **到期的门店，兑换框仍然可用。** 冻结时唯一还该能做的写操作就是把冻结解决掉
   （`bus.ts` 的 `WRITE_ALLOWED_WHILE_PAST_DUE` 放行 `billing.` 前缀）。
   禁用它等于把唯一的自救出口关掉。
3. **失败必须说三句不同的话**：码无效 / 试太快了 / 你还在 Stripe 上。
   合成一句「兑换失败」的话，一个正在被 Stripe 扣款的老板会一直重试一张
   本来就对的码。

### 面值的币种（已知取舍）

`amount_cents` 没有币种列，而私下收款很可能是人民币。运营台把这一格标成
**Amount collected (USD)** 并提示「非美元请填美元等值」—— 因为发票页在
`apps/web` 里是按美元渲染的，存一个人民币数字进去会显示成一个错的 `$`。
真要支持多币种得给 `billing_invoices` 加一列，那会牵动发票渲染，不在这一轮。

### 测试

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `apps/platform/src/lib/license.test.ts` | 13 | 金额与数量的输入解析（不许 parseFloat / Number 取巧） |
| `apps/web/.../display.test.ts` | +6 | license 分支的判据顺序、`expired`、Stripe 四档没被误伤 |
| `apps/web/.../BillingPanel.test.tsx` | +7 | 不给 Stripe 入口、到期只读文案、兑换成功/三档失败 |

运营台的两个页面**没有做渲染测试**：`apps/platform` 里没有 testing-library，
为这一轮引一个新依赖不划算。它们靠 typecheck + `vite build` + 后端那 35 项
接口测试兜着，页面本身很薄。
