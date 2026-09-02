# 27 · 邮件与短信模板改造说明书

> **这份文档写给接手改模板文案 / 排版的人（或 AI）。**
>
> 目标读者不需要读懂整个系统，但必须知道三件事：**哪些文件是模板**、
> **哪些约束改了会出事且不会报错**、**改完怎么验证**。
>
> 全部内容于 2026-09-02 对着代码逐条核对过。文中每一条「现状」都可以在
> 给出的文件行号处复核 —— 如与代码不符，以代码为准并更新本文。

---

## 0. 一分钟速览

| 你要改的 | 在哪 | 备注 |
| :--- | :--- | :--- |
| **共用邮件容器** | `apps/api/src/email/layout.ts` | 品牌壳：薄荷顶条 + PNG logo + 600px 白卡片 |
| **事务性邮件排版（HTML）** | `apps/api/src/email/render.ts` | 内联样式，5 个模板 |
| **事务性短信文案** | `apps/api/src/sms/render.ts` | 1 个模板 + 合规页脚 |
| **可被店主编辑的模板文案** | `packages/db/sql/0086_…sql` 第 130 行起 | 12 个事件 × email/sms；存量默认行由 `0093` 刷新 |
| **营销邮件的 HTML 排版** | `apps/api/src/notify/dispatch.ts` | 套 `EMAIL_WRAP`，营销另附退订页脚 |
| **退订页** | `apps/web/src/pages/Unsubscribe.tsx` | 公开，无需登录 |
| **店主看的编辑界面** | `apps/web/src/pages/Notifications.tsx` | 759 行 |

🔴 **动手之前必读 §5（硬约束）。** 那一节里每一条违反了都不会报错，
只会在账单上、在送达率上、或在运营商掐掉整条短信通道时体现出来。

---

## 1. ⚠️ 系统里有两条并行的模板路径

这是最容易白干活的地方：同一个「预约确认」在系统里有**两套文案**，
而其中一套是死的。

```
路径 A · 硬编码（TypeScript 函数）
  apps/api/src/email/render.ts   ← 顾客确认信、填表邀请、店主计费三封
  apps/api/src/sms/render.ts     ← 顾客确认短信
  调用方：handlers/appointment.ts、handlers/kiosk.ts
  店主改不了，只能改代码

路径 B · 数据库模板（notification_templates 表）
  默认文案种在 packages/db/sql/0086_notification_defaults_and_unsubscribe.sql
  渲染在 apps/api/src/notify/dispatch.ts
  店主可在设置页改，改完存新版本
```

### 1.1 哪些事件真的会被发出去

`notifyEvent()` 的调用点只有四处（`notify/marketing.ts`、`notify/reminder.ts`、
`handlers/appointment.ts` ×2）。逐个核对下来：

| 事件 | email | sms | 状态 |
| :--- | :---: | :---: | :--- |
| `appointment_confirm` | ✅ 有模板 | ✅ 有模板 | 🔴 **不会被发** —— 建单走路径 A |
| `appointment_changed` | ✅ | ✅ | 在用 |
| `appointment_cancelled` | ✅ | ✅ | 在用 |
| `appointment_reminder` | ✅ | ✅ | 在用 |
| `staff_pending_confirm` | — | ✅ | 🔴 **不会被发** —— 无派发点 |
| `staff_assigned` | — | ✅ | 🔴 **不会被发** —— 无派发点 |
| `staff_changed` | — | ✅ | 在用 |
| `staff_cancelled` | — | ✅ | 在用 |
| `birthday` | ✅ | ✅ | 在用（营销调度器） |
| `holiday` | ✅ | ✅ | 在用 |
| `winback` | ✅ | ✅ | 在用 |
| `review_request` | ✅ | ✅ | 在用 |

**结论：想改「预约确认」的文案，改 `email/render.ts` 的 `renderConfirm()` 与
`sms/render.ts` 的 `renderConfirmSms()`，不是改 SQL 里那两条。**
改 SQL 里的 `appointment_confirm` 一个字都不会生效。

> 这三条「有模板但不发」不是本次改造要修的东西，但你需要知道它们存在，
> 免得改完之后对着一个永远不触发的模板调试。

---

## 2. 硬编码模板清单（路径 A）

### 2.1 `apps/api/src/email/render.ts`（372 行）

统一返回 `{ subject, html, text }`。**HTML 与纯文本两份都要维护** ——
`text` 不是可选的降级，很多客户端与所有反垃圾评分都会读它。

| 函数 | 收件人 | 语言 | 容器 |
| :--- | :--- | :--- | :--- |
| `renderConfirm` | 顾客 · 预约确认 | 仅英语 | `EMAIL_WRAP` + 明细表 + 改期按钮 |
| `renderFormInvite` | 顾客 · 到店前填表 | 仅英语 | `EMAIL_WRAP` + 填表按钮 |
| `renderTrialEnding` | 店主 · 试用还剩 3 天 | 中/英双语 | `EMAIL_WRAP` + 管理订阅按钮 |
| `renderPaymentFailed` | 店主 · 扣款失败 | 中/英双语 | `EMAIL_WRAP` + 更新支付按钮 |
| `renderSubscriptionCanceled` | 店主 · 订阅已取消 | 中/英双语 | `EMAIL_WRAP` + 恢复订阅按钮 |

容器样式在 `apps/api/src/email/layout.ts`（`EMAIL_WRAP` / `EMAIL_MUTED` / `EMAIL_BTN`），
路径 A 与路径 B 共用。

#### 各模板的入参（改文案时能用的字段）

```ts
ConfirmData      { customerName, shopName, serviceName, whenText,
                   staffName: string|null, shopPhone: string|null,
                   manageUrl?: string|null }
FormInviteData   { customerName, shopName, formTitles: string[],
                   url, expiresText, shopPhone: string|null }
TrialEndingData  { shopName, chargeDateText, planLabel, monthlyText,
                   billingUrl, locale }
PaymentFailedData{ shopName, amountText, nextAttemptText: string|null,
                   billingUrl, locale }
SubscriptionCanceledData
                 { shopName, endsAtText: string|null, atPeriodEnd: boolean,
                   billingUrl, locale }
```

⚠️ `manageUrl`、`staffName`、`shopPhone`、`nextAttemptText`、`endsAtText`
**可以为 null**，每个分支现在都有对应文案。改的时候两条路都要给到文案，
不要写成「必然有值」。

### 2.2 `apps/api/src/sms/render.ts`（222 行）

| 函数 | 行 | 用途 |
| :--- | :--- | :--- |
| `renderConfirmSms` | 132 | 预约确认短信（**唯一的短信模板**） |
| `renderHelpSms` | 197 | 客人回 HELP 时的自动答复（CTIA 强制） |
| `withComplianceFooter` | 217 | 给任意外发短信补署名 + 退订说明 |
| `smsShopName` | 46 | 店名 → 纯 ASCII，四级回退 |
| `prettyPhone` | 82 | E.164 → 可读电话 |

当前成品（`SENDER = 'GenieFront'`，`OPT_OUT_NOTICE = 'Reply STOP to opt out.'`）：

```
GenieFront: Booked at <店名> - <项目>, <时间>. To change call <电话>. Reply STOP to opt out.
```

`renderConfirmSms` 内含**自动截断逻辑**（第 165–195 行）：超过 160 字符时
先砍项目名（保底 16 字符）、再砍店名（保底 12 字符），电话与退订说明一个字
都不动。改文案时若加长固定部分，这段截断会更早触发 —— 也就是客人更常看到
`Deluxe Spa Pedicure with...` 这种被砍过的项目名。

---

## 3. 数据库模板清单（路径 B）

默认文案在 `packages/db/sql/0086_notification_defaults_and_unsubscribe.sql`
第 130 行起，`0087` / `0093` / `0100` 是后续只刷新未改过的默认模板的补丁。
`{{manage_url}}` 只在 `BOOKING_MANAGE_PAGE_ENABLED=1` 且能从 wrap 还原令牌时有值。

变量语法 `{{snake_case}}`，实现在
`packages/contracts/src/notification.ts:82` 的 `renderTemplate()`。

### 3.1 每个事件认得的变量

权威定义在 `packages/contracts/src/notification.ts` 的 `EVENT_VARIABLES`：

| 事件 | 变量 |
| :--- | :--- |
| `appointment_confirm` | `customer_name` `shop_name` `service_name` `when` `staff_name` `shop_phone` `manage_url` |
| `appointment_changed` | `customer_name` `shop_name` `service_name` `when` `old_when` `staff_name` `shop_phone` `manage_url` |
| `appointment_cancelled` | `customer_name` `shop_name` `service_name` `when` `shop_phone` `manage_url` |
| `appointment_reminder` | `customer_name` `shop_name` `service_name` `when` `staff_name` `shop_phone` `manage_url` |
| `staff_pending_confirm` | `staff_name` `customer_name` `service_name` `when` `confirm_url` |
| `staff_assigned` | `staff_name` `customer_name` `service_name` `when` |
| `staff_changed` | `staff_name` `customer_name` `service_name` `when` `old_when` |
| `staff_cancelled` | `staff_name` `customer_name` `service_name` `when` |
| `birthday` | `customer_name` `shop_name` `shop_phone` |
| `holiday` | `customer_name` `shop_name` `holiday_name` `shop_phone` |
| `winback` | `customer_name` `shop_name` `days_since` `shop_phone` |
| `review_request` | `customer_name` `shop_name` `review_url` |

🔴 **未知变量渲染成空字符串，不报错。** 写错变量名（`{{customerName}}`
而不是 `{{customer_name}}`）的表现是那个位置**什么都没有**，
句子读起来像少了一个词，而没有任何日志会提到这件事。

⚠️ 新增变量必须同时改三处：`EVENT_VARIABLES`（界面提示用）、
`notify/dispatch.ts` 里组 `vars` 的地方、以及派发点传进来的数据。
只改模板不会有效果。

---

## 4. 界面文件

| 文件 | 行数 | 内容 |
| :--- | :--- | :--- |
| `apps/web/src/pages/Notifications.tsx` | 759 | 通知中心主页 · 模板编辑器在这 |
| `apps/web/src/pages/Unsubscribe.tsx` | — | 营销邮件退订公开页（无需登录） |
| `apps/web/src/features/notifications/NotificationSettingsPanel.tsx` | 394 | 通知规则开关 |
| `apps/web/src/features/notifications/api.ts` / `settingsApi.ts` | — | 对应的数据层 |
| `apps/web/src/pages/CommunicationLogs.tsx` | — | 发件记录 |
| `apps/web/src/pages/Messages.tsx` | — | 短信会话 |
| `apps/platform/src/pages/TestInbox.tsx` | — | 运营台预览 capture 模式下的邮件 |

---

## 5. 🔴 硬约束 —— 违反了不会报错

### 5.1 短信必须是 GSM-7，且尽量落在 160 字符内

实现与理由：`apps/api/src/sms/segments.ts`。

| 编码 | 单段上限 | 拼接时每段 |
| :--- | ---: | ---: |
| GSM-7（纯英文 + 常见符号） | 160 | 153 |
| UCS-2（**出现任何一个**非 GSM 字符） | 70 | 67 |

**一个字符就能让整条翻倍。** 一个中文店名、一个花引号 `'`、一个 emoji、
一个长破折号 `—` —— 整条立刻从 160 掉到 70，客人看到的完全一样，账单翻倍，
而且是每一条都翻。

⚠️ 特别注意这几个「看起来没问题」的字符**不在 GSM-7 里**：
`'` `'` `"` `"`（弯引号）、`—` `–`（长/短破折号）、`…`（省略号）、`•`、
`™` `®`、所有 emoji。写文案时用直引号 `'`、连字符 `-`、三个点 `...`。

⚠️ 这几个**在 GSM-7 里但各占 2 个字符**：`^` `{` `}` `\` `[` `~` `]` `|` `€`。

### 5.2 🔴 短信里一个字都不许提「回复 CANCEL」

理由在 `apps/api/src/sms/keywords.ts` 的文件头。

`CANCEL` 是运营商强制的**退订**关键词（与 `STOP` `UNSUBSCRIBE` `QUIT` 同级）。
在预约短信里写 "reply CANCEL to cancel" 等于亲手教客人退订，而他以为自己
取消的是预约 —— 之后我们**永久**无法再给他发任何短信，包括他下次自己
预约后的确认。

改期一律引导**打电话**。这一条没有例外。

### 5.3 短信的署名必须是 `GenieFront`，不是店名

理由在 `sms/render.ts` 第 126–140 行。三条，任何一条都足以否决改回店名：

1. **发送号是平台号**（一个号服务所有门店）。署名店名而号码是平台的，
   客人存下的号和店里的号对不上；
2. **10DLC 注册的品牌是 GenieFront**。冒用店名署名，在运营商眼里是
   「发送者身份与注册品牌不符」，这一类最容易被判成欺骗性流量，
   届时被掐掉的是**整条通道**，不是某一条消息；
3. 退订是平台级的（客人回 STOP 是对我们说的），署名与退订对象不一致本身矛盾。

店名仍然出现在句子里（`Booked at <店名> - …`），客人照样知道是哪家店。

### 5.4 每条外发短信都要带退订说明

CTIA 要求至少出现在第一条里，我们**每条都带** —— 一年来两次的客人不会
记得自己订阅过什么。`withComplianceFooter()` 会自动补，但模板类短信
（`renderConfirmSms`）自身已带，不要重复。

### 5.5 语言策略

定义在 `apps/api/src/email/locale.ts` 与 `email/render.ts` 文件头。

| 收件人 | 语言 |
| :--- | :--- |
| **顾客邮件** | **恒为英语**，不跟顾客档案、不跟操作员界面语言 |
| **顾客短信** | **恒为英语** |
| **店主计费类邮件** | 默认英语，按 `organizations.default_locale` 切中文 |

⚠️ 顾客侧模板**不保留多语言分支**。这是有意的：此前保留过中文分支，
调用点漏传 `locale` 时会静默落进去，表现为「顾客收到中文邮件」而无任何报错。
删掉分支使这类缺陷在类型层面即不可能出现 —— **不要加回来**。

### 5.6 营销邮件必须有可用的退订入口

`List-Unsubscribe` + `List-Unsubscribe-Post` 两个头由 `email/send.ts` 自动加，
不用管。但**正文里的退订链接**是 `notify/dispatch.ts:197` 拼的，见 §6.2。

### 5.7 邮件正文不写支付卡信息

`renderPaymentFailed` 的注释写明：卡组织、后四位、失败码一律不写。
邮件存在被转发与截图的可能，而「前往更新支付方式」这一动作已足够。

---

## 6. 已知缺陷（按建议优先级）

### 6.1 ✅ 营销邮件排版（2026-09-02）

路径 B 经 `email/layout.ts` 的 `renderTemplatedEmailHtml` /
`renderMarketingEmail` 套与路径 A 相同的 `EMAIL_WRAP` 容器。
店主模板仍按纯文本转义，换行转 `<br>`。

### 6.2 ✅ 退订页（2026-09-02）

`apps/web` 公开路由 `/unsubscribe?t=`（`SessionGate` 最前面，无需登录）。
`GET /public/v1/email/unsubscribe` **只读**，`POST` 才执行退订。

邮件页脚链到 desk 的公开页 `${APP_BASE_URL}/unsubscribe?t=<token>`
（生产 `https://desk.geniefront.com/unsubscribe`）。Gmail 一键退订走
`POST ${APP_URL}/public/v1/email/unsubscribe`。

### 6.3 ✅ 店主侧三封邮件容器样式（2026-09-02）

`renderTrialEnding` / `renderPaymentFailed` / `renderSubscriptionCanceled`
套 `EMAIL_WRAP`，并带「管理订阅 / 更新支付方式 / 恢复订阅」按钮。

### 6.4 三个事件有模板但永不触发

`appointment_confirm`（email + sms）、`staff_pending_confirm`、`staff_assigned`。
见 §1.1。改它们不会有任何效果。

---

## 7. 改完怎么验证

```bash
# 1. 类型 + 全量测试（模板有测试盯着）
pnpm typecheck
pnpm --filter @gf/api exec vitest run src/email/render.test.ts src/sms.test.ts

# 2. 看短信实际占几段
#    sms.test.ts 里有现成的 measure() / segmentsOf() 用例可仿写
```

⚠️ **`pnpm test` 跑全量会重置本地开发库的种子数据**（每个测试文件之前都跑
一遍 `pnpm db:seed`，删掉并重建两个种子组织）。只改模板的话，跑上面那两个
文件就够。

### 本地看真实排版

`COMMUNICATION_DELIVERY_MODE=capture` 时邮件不出网，整封留在 `email_outbox`
表里，运营台的 Test Inbox 页能看。配了 `MAILPIT_URL` 还会顺手投一份到本机
Mailpit，可以在真的邮件客户端里看 HTML 渲染效果
（`apps/api/src/comms/mode.ts`）。

### 短信的字符预算自查

改完 `renderConfirmSms` 或 SQL 里任何一条 sms 模板后，用最长的真实组合试算：

```
店名   Golden Lotus Nails and Day Spa
项目   Deluxe Spa Pedicure with Callus Treatment
```

这个组合在旧文案下会超一段。当前文案靠自动截断压回 1 段 —— 加长固定部分
会让截断更早触发。

---

## 8. 不在本次范围内的东西

- **Supabase Auth 的两封信**（激活 Magic Link、忘记密码）**不在仓库里**，
  在 Supabase 控制台 → Authentication → Email Templates。见 `docs/26` §3。
- **发件域名与投递链路**（供应商、DKIM、退信回流）见 `docs/26` §4–6，
  与文案无关。
- **通知规则**（哪家店开哪些通知、静默时段、TCPA 时段限制）在
  `notification_rules` 表与 `notify/dispatch.ts` 的闸门里，不是模板问题。

---

**相关文档：** `docs/26-OUTBOUND-MESSAGING.md`（发信链路）、
`docs/09-TELNYX.md`（短信通道与 10DLC）、`docs/25-TEST-COMMS.md`（本地看信）。
