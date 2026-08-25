# 18 · 接口文档（完整版）

> **给前端直接用的一份。** 读完这一份就能写完整个前端，不需要翻别的文档。
>
> 更短的入门版在 [`16-FRONTEND-CONTRACT.md`](16-FRONTEND-CONTRACT.md)（十分钟读完）。
> 这一份是**详尽的参照表**：每一条路由、每一条命令、每一个错误码。
>
> ⚠️ 本文档由代码实测导出（2026-08-25）。**代码是唯一事实源** ——
> 有出入以 `GET /v1/commands` 的实时返回为准。

---

## 目录

| 节 | 内容 |
| :--- | :--- |
| [§1](#1-三分钟上手) | 三分钟上手 |
| [§2](#2-四个端与四种身份) | 四个端与四种身份 |
| [§3](#3-命令总线所有写操作) | ⭐ 命令总线：所有写操作 |
| [§4](#4-错误处理) | 错误处理（30 个错误码分类表） |
| [§5](#5-读接口desk) | 读接口 · Desk |
| [§6](#6-读接口跨店与账号) | 读接口 · 跨店与账号 |
| [§7](#7-编排路由不走命令总线的六条) | 编排路由（不走命令总线的六条） |
| [§8](#8-公开预约-api给客人的) | 公开预约 API（给客人的） |
| [§9](#9-门口-ipad-kiosk) | 门口 iPad（Kiosk） |
| [§10](#10-技师端) | 技师端 |
| [§11](#11-命令全表89-条) | ⭐ 命令全表（89 条） |
| [§12](#12-权限与角色) | 权限与角色 |
| [§13](#13-实时realtime) | 实时（Realtime） |
| [§14](#14-枚举与常量) | 枚举与常量 |
| [§15](#15-八条不要做的事) | ⚠️ 八条不要做的事 |
| [§16](#16-本地起后端) | 本地起后端 |
| [附录 A](#附录-a--89-条命令的全量表) | ⭐ 89 条命令的全量表（代码导出，不会漂移） |

---

## 1. 三分钟上手

```
生产   https://api.geniefront.com
本地   http://127.0.0.1:3000      # pnpm dev:api（端口在根 .env 的 PORT）
```

```ts
// ① 登录（Supabase Auth）→ 拿 access token
const { data } = await supabase.auth.signInWithPassword({ email, password });
const token = data.session!.access_token;

// ② 选店 —— 拿到 membershipId
const { locations } = await fetch(`${API}/v1/me/locations`, {
  headers: { Authorization: `Bearer ${token}` },
}).then(r => r.json());
const membershipId = locations[0].membershipId;

// ③ 之后所有请求都带这两个头
const H = {
  Authorization: `Bearer ${token}`,
  'X-Membership-Id': membershipId,
  'Content-Type': 'application/json',
};

// ④ 读 —— 普通 REST
const day = await fetch(`${API}/v1/desk/day?date=2026-08-25`, { headers: H }).then(r => r.json());

// ⑤ 写 —— 只有一条路。⭐ 命令名在 URL 里，body 只有 input
const res = await fetch(`${API}/v1/commands/appointment.create`, {
  method: 'POST',
  headers: { ...H, 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ input: { /* … */ } }),
});
// 201 = 真的执行了；200 = 命中幂等缓存（一次重试）
```

**就这五步。** 剩下的都是细节。

---

## 2. 四个端与四种身份

四套独立部署，**不要合成一个** —— 它们的身份来源根本不同。

| 端 | 谁用 | 身份 | 请求头 |
| :--- | :--- | :--- | :--- |
| **desk** | 前台 + 老板 | Supabase Auth | `Authorization: Bearer <jwt>` + `X-Membership-Id` |
| **staff** | 技师（手机 PWA） | 上机码换来的**可吊销会话行**，不是 JWT | `X-Staff-Token` |
| **kiosk** | 门口 iPad | 设备令牌 | `X-Device-Token` |
| **booking** | 客人（公开） | 公开 key + Turnstile，**无账号** | `X-GF-Public-Key` |

### 2.1 `X-Membership-Id` 是什么

**它不是身份。** 真正的身份在 Supabase token 里；服务端会核对「这个 token 的
用户是不是真的持有这个 membership」。前端伪造它没用，只会拿到 403。

它的作用是**选店**：一个人可能在三家店有身份。切店 = 换这个头。

```
GET /v1/me/locations
→ { locations: [{ membershipId, orgId, locationId, locationName, locationStatus, roleKeys }] }
```

`user_last_location` 会记住上次选的，返回里有标记。

### 2.2 技师上机（staff 端）

```
POST /v1/auth/staff/claim-code   { code: "482913" }
→ { staffToken, membershipId, locationId, expiresAt }

GET  /v1/auth/staff/me
     X-Staff-Token: <token>
→ { membershipId, locationId, displayName, permissions[] }
```

或走手机验证码：`POST /v1/auth/phone/start` → `POST /v1/auth/phone/verify`。

> ⚠️ **上机会话没有 Realtime**（私有频道认 Supabase JWT，而上机会话是
> 一行可吊销的数据）。那条路径**降级成 10 秒轮询**。
> **不要为此在服务端自签 Supabase 令牌。**

---

## 3. ⭐ 命令总线：所有写操作

```http
POST /v1/commands/appointment.create      ← ⭐ 命令名在 **URL** 里
Authorization: Bearer <supabase access token>
X-Membership-Id: <membership id>
Idempotency-Key: <uuid>
Content-Type: application/json

{ "input": { … } }                         ← body 里**只有 input**
```

```jsonc
// 201 = 这次真的执行了 / 200 = 命中幂等缓存，是一次重试
{
  "result": { "appointmentId": "…", "overbooked": false },
  "replayed": false,        // true 时 HTTP 状态码是 200
  "undoToken": "audit-id"   // 只有可撤销的命令才有，用于 60 秒内撤销
}
```

> ⭐ **201 和 200 是有意分开的**：客户端据此知道「我这次是真的建了单，
> 还是重试命中了上一次的结果」。两个都当成功处理，但埋点要分得开。
>
> 认不出的命令名返回 **404**（`{ code: 'NOT_FOUND', details: { command } }`），
> 不是 400 —— 那是一条不存在的命令，不是一个格式错的请求。
> ⚠️ 但**鉴权在前**：没带 token 时任何命令名都先拿 401，
> 401 不代表这条命令不存在。
>
> `Idempotency-Key` 也可以放在 body 里（`{ input, idempotencyKey }`），
> **但请求头优先**。推荐一律用请求头，body 那条只是给不方便设头的场景留的。

### 3.1 为什么不能绕过

命令总线在**一个事务里**做完这五件事。找一条「更简单的 REST 路由」绕过去，
这五样全丢：

1. Zod schema 校验（形状 + 语义两层）
2. 权限判定（读 `role_permissions` 表，不是前端判的）
3. **幂等**（同一个 key 重放返回第一次的结果，不产生第二次写入）
4. **审计**（`audit_log`，留动作不留金额）
5. **事务内广播**（Realtime，回滚即撤销）

> `GET /v1/commands` 返回当前部署**认识的所有命令名与输入 schema**。
> 拿它做类型生成，或者开发时对着看。

### 3.2 `Idempotency-Key` 的正确用法

| 场景 | 怎么做 |
| :--- | :--- |
| 一次用户动作 | **一个 key**，从打开表单时就生成好，整个流程不变 |
| 用户改了输入再提交 | **仍是同一个 key** → 后端返回 `IDEMPOTENCY_KEY_REUSED`。这是对的：说明你在同一个 key 下换了内容 |
| 用户主动点「重试」 | **换新 key** |
| 网络超时后自动重试 | **复用旧 key** |

`idempotency: required` 的命令不给 key 直接 400。哪些是 required 见 [§11](#11-命令全表89-条)。

### 3.3 撤销

可撤销的命令返回 `undoToken`（就是那条审计记录的 id）。前端据此显示
60 秒「撤销」按钮。**撤销本身也是一条命令** —— 比如 `discount.void`、
`ticket.void`，不是一个通用的 undo 接口。

---

## 4. 错误处理

所有失败都是这个形状：

```jsonc
{
  "code": "STAFF_OVER_CAPACITY",
  "messageKey": "error.STAFF_OVER_CAPACITY",
  "details": { "itemIndex": 0, "issues": [ … ] },
  "overridable": true          // true = 带 override.reason 重发可以放行
}
```

> ⚠️ **`messageKey` 是 i18n 的 key，不是可以直接显示的文案。**
> 前端按这个 key 查自己的文案表。`details` 是结构化的，
> 给你做高亮、跳转、预填用。

### 4.1 全部 30 个错误码

| Code | HTTP | 什么时候 | 前端该怎么做 |
| :--- | :--- | :--- | :--- |
| `UNAUTHENTICATED` | 401 | 没登录 / token 过期 | 跳登录 |
| `PERMISSION_DENIED` | 403 | 权限不够 | 见下面 §4.3 |
| `MEMBERSHIP_INACTIVE` | 403 | 这个人已离职 | 跳登录，清本地状态 |
| `LOCATION_SUSPENDED` | 403 | 门店被平台停用 | 全局提示，联系客服 |
| **`SUBSCRIPTION_PAST_DUE`** | **402** | **欠费 → 写入冻结，读照常** | 全局横幅 +「去结账」按钮。**不要跳登录** |
| `VALIDATION_FAILED` | 400 | 入参不合法 | 看 `details.reason` / `details.issues`，高亮对应字段 |
| `NOT_FOUND` | 404 | 找不到 | — |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 同一个 key 换了内容 | 客户端 bug，换新 key |
| `RESOURCE_CONFLICT` | 409 | **房间/床/椅被占（硬约束，不可覆盖）** | 让用户换时间或换房间 |
| `STAFF_OVER_CAPACITY` | 409 | 技师并发超了（**软**） | 可带 `override.reason` 放行 |
| `LOCATION_OVER_CAPACITY` | 409 | 门店时段超了（**软**） | 同上 |
| `STAFF_LACKS_SKILL` | 409 | 这位技师不会这个项目 | 换人 |
| `STAFF_NOT_BOOKABLE` | 409 | 这人根本不接客 | 换人。**有 reason 也没用** |
| `OUTSIDE_BUSINESS_HOURS` | 409 | 不在营业时间 | — |
| `OVERBOOK_REASON_REQUIRED` | 400 | 要超卖但没写原因 | 弹输入框，带 reason 重发（**同一个幂等键**） |
| `ALREADY_CANCELLED` | 409 | 已经取消过了 | — |
| `TICKET_ALREADY_CLOSED` | 409 | 单已结 / 已开单不让改 | — |
| `VOID_REASON_REQUIRED` | 400 | 作废没写原因 | 弹输入框 |
| `PAYMENT_MISMATCH` | 400 | 收款额和单据对不上 | 当场拦下，让前台重输 |
| `DAY_ALREADY_CLOSED` | 409 | 这一天封账了 | 要改先重开（`dayclose.reopen`） |
| `VARIANCE_REASON_REQUIRED` | 400 | 账实差异超阈值没写原因 | 弹输入框 |
| `OPEN_TICKETS_REMAIN` | 409 | 还有单没结就要封账 | 列出未结的单 |
| `DAY_HAS_REAL_RECORDS` | 409 | 想把有真单的日子标成断档 | — |
| `HOUSE_CUT_FORBIDDEN` | 422 | 小费方案违反 FLSA | 提示法律约束 |
| `PATCH_TEST_REQUIRED` | 422 | 改方案前要先跑历史预演 | — |
| `BLUEPRINT_FROZEN` | 409 | 拍照草案已落地，改不动了 | — |
| `BLUEPRINT_NOTHING_ACCEPTED` | 400 | 一项都没勾就要回填 | — |
| `EXTRACTION_FAILED` | **502** | 模型没认出任何东西 | 「识别失败，换张清楚的照片」 |
| `INTERNAL` | 500 | 不该发生 | 保留用户输入 + 重试按钮（**换新幂等键**） |
| `UPSTREAM_UNAVAILABLE` | 503 | 上游（Anthropic / Stripe / Telnyx）挂了 | 稍后重试 |

### 4.2 按处理方式分三类

| 类 | 例子 | 做法 |
| :--- | :--- | :--- |
| **要人做决定** | `OVERBOOK_REASON_REQUIRED` `VARIANCE_REASON_REQUIRED` `VOID_REASON_REQUIRED` | 弹输入框 → 带 `reason` 重发**同一条命令、同一个幂等键** |
| **要人改输入** | `STAFF_OVER_CAPACITY` `RESOURCE_CONFLICT` `OUTSIDE_BUSINESS_HOURS` | 显示在**对应字段旁**，不要弹全局 toast |
| **不该发生** | `INTERNAL` `UPSTREAM_UNAVAILABLE` | 全局提示 + 保留输入 + 重试（换新 key） |

### 4.3 ⚠️ `PERMISSION_DENIED` 不是让你藏按钮的信号

权限在服务端判。前端可以按 `roleKeys` 提前隐藏入口来**减少挫败感**，
但**不要把它当安全边界** —— 隐藏了照样能调，服务端照样会拒。

### 4.4 ⚠️ 402 和 401 要分开处理

`SUBSCRIPTION_PAST_DUE` **只冻结写操作，读全部照常**。
所以正确的反应是「顶部挂一条横幅 + 把写操作的按钮置灰」，
**不是跳登录页** —— 老板还要看数据、导报表。

`billing.*` 和 `setup.*` 的命令**永远放行**（否则他换了卡也救不回来）。

---

## 5. 读接口 · Desk

全部要 `Authorization` + `X-Membership-Id`。

| 路由 | 权限 | 返回 |
| :--- | :--- | :--- |
| `GET /v1/desk/day?date=` | `appointment.read` | 某一天的日程：预约、item、技师、房间 |
| `GET /v1/desk/rotation` | `rotation.read` | 轮牌板：顺序、休息、已派 |
| `GET /v1/desk/queue` | `queue.manage` | 候客队列 |
| `GET /v1/desk/tickets` | `ticket.read` | 进行中的工单 |
| `GET /v1/desk/earnings?date=` | `payroll.view_own` **或** `payroll.view_all` | 当日收入。⭐ 有 `view_all` 看全店，只有 `view_own` 就**只返回自己那一份** —— 服务端收窄，不是前端过滤 |
| `GET /v1/desk/dayclose?date=` | `dayclose.manage` | 日结对账：点钞、现金进出、刷卡 batch |
| `GET /v1/desk/gaps` | `dayclose.manage` | 待补录的断档日 |
| `GET /v1/desk/reports?from=&to=&groupBy=` | `report.view` | 经营报表。`?format=csv` 直接下载 |
| `GET /v1/desk/roster?from=&to=` | `schedule.read` | 排班 |
| `GET /v1/desk/settings` | `settings.manage` + `staff.manage` | 门店设置全量（项目/员工/营业时间/AI 电话/官网对接） |
| `GET /v1/desk/payroll/plans` | `payroll.configure` | 薪酬方案 |
| `GET /v1/desk/billing` | `billing.manage` | 订阅与余额（含**试用状态**，见下） |
| `GET /v1/desk/call-drafts?status=` | `appointment.read` | ☎️ 待复核队列（含 AI 的改期/取消请求）。**处理**它要 `appointment.write`（`call.reviewDraft`） |
| `GET /v1/desk/calls` | `appointment.read` | 通话记录 |
| `GET /v1/desk/sms-inbound` | `customer.read` | 客人回的短信（STOP / CANCEL） |
| `GET /v1/desk/forms` | `customer.read` | 健康表模板与提交**列表**（只有「填过没有」，不含内容） |
| `GET /v1/desk/forms/submissions/:id?reason=` | 见下 | ⚠️ **读也留痕** |

> `submissions/:id` 的规矩比别的路由特殊：
> **`reason` 是必填的查询参数**，只接受 `service_prep`（九成是这条）/
> `incident_review` / `customer_request` / `export`，其余 400。
> 返回里的 `canViewContent` 反映 `customer.view_health_form` ——
> **没有这条权限的人拿得到「填过没有」，拿不到「他勾了什么」**。
> 每一次读都会写一条 `form_access_log`。
| `GET /v1/desk/blueprints` / `blueprint/:id` | `catalog.manage` | 拍照开店的草案 |
| `GET /v1/desk/yelp/search?name=&zip=` | `settings.manage` | Yelp 一键填店 |
| `GET /v1/customers/search?q=` | `customer.read` | 快速搜客人（手机后四位 / 姓名） |

### 5.1 客户档案（批 6）

```
GET /v1/desk/customers?q=&vip=1&sleeping=90&limit=50&offset=0
GET /v1/desk/customers/:id
```

⭐ **`q` 优先按手机后四位匹配**（≥3 位数字才走号码匹配），
其次按姓名模糊。前台在电话里问的第一件事就是这四位。

详情**一个请求带回一整页**：档案 + 偏好 + 到访统计 + 礼品卡余额 +
最近消费 + 健康表记录。

```jsonc
{
  "id": "…", "displayName": "张三",
  "phone": "+16175558877",         // ⚠️ 没有 customer.view_contact 时是 "617-***-8877"
  "email": "…",                     // 没权限时是 null
  "vipLevel": 1, "tags": [], "noShowCount": 0, "lateCancelCount": 0,
  "preferences": {
    "preferredStaffIds": [], "avoidStaffIds": [], "preferredGender": "female",
    "allergies": null, "freeNotes": null,
    "profile": {                    // ⭐ key 定死在 contracts，见 §14.3
      "pressure": "firm", "serviceLanguage": "zh-Hans",
      "focusAreas": ["neck", "shoulders"]
    }
  },
  "visits": {
    "total": 12, "firstAt": "2025-03-04", "lastAt": "2026-08-01",
    "avgSpendCents": 7200,          // ⚠️ 没有 report.view 时是 **null 不是 0**
    "lifetimeSpendCents": 86400,
    "daysSinceLastVisit": 24
  },
  "giftCards": [{ "id":"…","code":"ABCD-…","balanceCents":3000,"status":"active" }],
  "recentTickets": [{ "id":"…","businessDate":"2026-08-01","totalCents":7500,
                      "serviceNames":["Deep Tissue 60min"] }],
  "forms": [{ "id":"…","templateKey":"health_history","submittedAt":"…" }]
}
```

> ⚠️ **金额缺失时是 `null` 不是 `0`。** `0` 会被渲染成「$0.00」，
> 读起来是「这位客人一分钱没花过」—— 一个明确的错误信息比空着糟得多。
> 前端要判 `null` 并显示为「—」。

### 5.2 订阅与试用（批 1）

```jsonc
GET /v1/desk/billing
{
  "plan": "growth", "subscriptionStatus": "trialing",
  "currentPeriodEnd": "2026-09-25T…",
  "trialEndsAt": "2026-09-01T…",   // null = 从未试用 / 已转正
  "trialing": true,                 // ⭐ 看的是 trialEndsAt 是否在未来，不看 status
  "hasSubscription": true, "hasPaymentMethod": true,
  "paymentMethodLabel": "Visa ···· 4242",
  "topupPriceCents": 5000,
  "quotas": [                       // 两种额度**不能互换**，界面要分成两块
    { "unit": "credit",       "included": { "total": 150, "used": 12 }, "balance": 0 },
    { "unit": "voice_minute", "included": { "total": 20,  "used": 3  }, "balance": 0 }
  ],
  "recent": [ /* 最近的额度流水 */ ]
}
```

> ⭐ **试用期的 `included.total` 是试用额度（150 积分 / 20 分钟），
> 不是套餐额度。** 显示成套餐额度的话，老板看到「本期含 500 积分」
> 而实际扣到 150 就没了，会当成 bug 报过来。

---

## 6. 读接口 · 跨店与账号

| 路由 | 说明 |
| :--- | :--- |
| `GET /v1/me/locations` | 我的门店列表（切店用） |
| `GET /v1/me/summary?from=&to=&scope=all\|<locationId>` | ⭐ 跨店汇总（批 4） |

```jsonc
GET /v1/me/summary?from=2026-08-19&to=2026-08-25
{
  "from": "2026-08-19", "to": "2026-08-25",
  "stores": [{
    "locationId": "…", "name": {"en":"Lotus Spa"}, "timezone": "America/New_York",
    "appointments": 84, "newCustomers": 11,
    "revenueCents": 612000, "avgOrderCents": 7285, "cancelRateBp": 476
  }],
  "total": { "appointments": 84, "newCustomers": 11,
             "revenueCents": 612000, "avgOrderCents": 7285, "cancelRateBp": 476 }
}
```

三条要知道的：

1. ⚠️ **门店范围由服务端按你的 membership 决定，不接受 `locationIds` 入参。**
   `scope` 只是**过滤器** —— 它只能在「你有权限的那些店」里再挑一个，
   挑不出集合以外的东西。
2. **只汇总你有 `report.view` 的店。** 一个人可能在 A 店是老板、
   在 B 店只是技师（老板去朋友店里兼职接客，这行真实存在）。
3. **各店按各自的 `business_day_cutoff` 算营业日再相加。**
   德州那种横跨两个时区的老板，两家店的「今天」不是同一段时间。

---

## 7. 编排路由（不走命令总线的六条）

这六条**不是**写操作的例外，而是「先做外部 IO，再把结果交给命令」的编排。
外部 IO（调模型 / 调 Stripe）要几秒到几十秒，塞进数据库事务会占住连接。

| 路由 | 权限 | 说明 |
| :--- | :--- | :--- |
| `POST /v1/blueprint/:id/extract` | `catalog.manage` + `ai.use` | 拍价目表 → 提取。**bodyLimit 32MB**，图片走请求体 |
| `POST /v1/blueprint/:id/translate` | `catalog.manage` + `ai.use` | 项目名多语言补齐 |
| `POST /v1/blueprint/plan-regions` | `catalog.manage` | 大牌子分块规划 |
| `POST /v1/storefront/:id/generate` | `settings.manage` + `ai.use` | ⭐ 建站工单 → **AI 出三版**（批 8） |
| `POST /v1/billing/checkout` | `billing.manage` | 开订阅（**首次自动带 7 天试用**） |
| `POST /v1/billing/add-store` | `billing.manage` | ⭐ 开第二家店（批 4） |
| `POST /v1/billing/payment-method` | `billing.manage` | 绑卡（Stripe 托管页） |
| `POST /v1/billing/topup` | `billing.manage` | 充额度 |
| `POST /v1/ai/copilot` | `ai.use` | 前台副驾 |
| `POST /v1/setup/claim` | — | 认领门店（**不要 `X-Membership-Id`**，那一刻还没有） |

### 7.1 图片上传的规矩（extract）

- **长边 ≤ 2576px**，超了服务端会拒（`VALIDATION_FAILED`）。
  API 会自己缩的话，bbox 就不再是原图坐标，「点一下跳回原图那一行」
  会静默地指错位置。**前端先缩，也省流量。**
- 一次最多 **6 张**
- 只收 `image/jpeg` / `image/png` / `image/webp`
- 走**请求体 base64**，不给 URL —— 让服务端去 fetch 客户端给的 URL 就是 SSRF

### 7.2 开第二家店

```jsonc
POST /v1/billing/add-store
{ "name": "Lotus Spa Downtown", "timezone": "America/New_York",
  "businessType": "massage", "plan": "essential" }

→ {
  "locationId": "…", "orgId": "…", "membershipId": "…", "slug": "lotus-spa-downtown-a3f9c1",
  "billing": "linked",              // 或 "not_linked"（第一家店都还没订阅）
  "subscriptionItemId": "si_…",
  "prorationCents": 4233            // ⚠️ null = 取不到，显示「以账单为准」不要显示 $0
}
```

> ⚠️ **`prorationCents` 必须在确认页上显示给老板看。**
> 加 item 会产生按比例计费的中期账单 —— 不能让他事后在信用卡账单上发现。

### 7.3 建站工单生成

```jsonc
POST /v1/storefront/:id/generate
→ {
  "briefId": "…", "status": "drafted",
  "drafts": [
    { "variant": 1, "content": {
        "variantLabel": "稳妥版",
        "hero": { "headline": "…", "subhead": "…", "cta": "立即预约" },
        "about": "…",
        "faq": [{ "q": "门口能停车吗", "a": "…" }],
        "sectionCopy": { "services": "…", "contact": "…" }
    }},
    { "variant": 2, … }, { "variant": 3, … }
  ],
  "model": "claude-sonnet-5", "costMillicents": 1840
}
```

**只有 `status = 'submitted'` 的工单能生成。** 重跑会换掉之前那三版
（老板点「重新生成」时不该看到六版）。

---

## 8. 公开预约 API（给客人的）

完整契约见 [`13-PUBLIC-BOOKING-API.md`](13-PUBLIC-BOOKING-API.md)。这里是速查。

```http
X-GF-Public-Key: pk_3f9a2b1c
Origin: https://lotusnails.com        # 必须在白名单里
```

| 路由 | 说明 |
| :--- | :--- |
| `GET /public/v1/shop` | 门店信息 + `turnstileSiteKey` + `onlineBooking` 配置。**第一个调它** |
| `GET /public/v1/services` | 可在线预约的项目。返回 `services` 和 `addons` **两个数组** |
| `GET /public/v1/availability?date=&serviceId=&addonIds=&staffId=&excludeBookingId=` | 空档 |
| `POST /public/v1/bookings` | 建单。要 `Idempotency-Key` + Turnstile + 蜜罐 |
| `GET /public/v1/bookings/:id?t=<manageToken>` | 查自己那一条 |
| `POST /public/v1/bookings/:id/cancel` | 取消 |
| `POST /public/v1/bookings/:id/reschedule` | ⭐ 改期（批 2） |
| `GET /public/v1/forms` / `POST /public/v1/forms/submit` | 一次性填表链接 |

### 8.1 🔴 破坏性变更：取消现在要 `last4`

```jsonc
// 之前
{ "manageToken": "mt_9f3c…" }
// 现在
{ "manageToken": "mt_9f3c…", "last4": "4821" }
```

**只在这一单留了手机号时才要**（没留号码的单验不了，照旧只认令牌）。

| 错 | `details.reason` | 带什么 |
| :--- | :--- | :--- |
| 后四位不对 | `last4_mismatch` | `attemptsLeft`（还剩几次） |
| 连错 3 次 | `last4_locked` | `retryAfterSec`（锁 15 分钟） |

⚠️ **锁定按预约维度，不按 IP** —— 一家店的客人常常连同一个 WiFi，
按 IP 锁会让第二位客人被前一位连累。

### 8.2 改期

```jsonc
POST /public/v1/bookings/:id/reschedule
{ "manageToken": "mt_…", "last4": "4821",
  "startsAt": "2026-09-02T15:30:00-04:00", "turnstileToken": "0.abc…" }

→ { "bookingId": "…", "status": "booked",
    "startsAt": "…", "rescheduleCountLeft": 1 }   // null = 不限次
```

⭐ **原子改期**：在一个事务里先占新格再放旧格，撞了整体回滚 ——
要么改成功，要么原单一个字节没动，不存在「两头落空」。

> ⚠️ **查空档时要带 `excludeBookingId`**，否则客人看不到
> 「原地往后延 15 分钟」这种最常见的改法（那一格正被他自己占着）。

拒绝的四种 `details.reason`：

| reason | 说明 |
| :--- | :--- |
| `reschedule_disabled` | 老板关掉了自助改期 |
| `reschedule_cutoff_passed` | 太近了（带 `rescheduleCutoffHours`） |
| `reschedule_limit_reached` | 改够次数了（带 `selfRescheduleMax`） |
| `too_soon` / `date_out_of_window` | 新时间不合规 |

全部带 `shopPhone` —— 文案要给店铺电话，让他打电话。

---

## 9. 门口 iPad（Kiosk）

```http
X-Device-Token: <设备令牌>
```

| 路由 | 说明 |
| :--- | :--- |
| `GET /v1/kiosk/hello` | 门店信息、语言、开关 |
| `POST /v1/kiosk/check-in/lookup` | **输手机后四位**找今天的单 |
| `POST /v1/kiosk/check-in` | 签到 |
| `POST /v1/kiosk/walk-in` | 没预约 → 取号 |
| `GET /v1/kiosk/queue/:id` | 我排到第几号 |
| `GET /v1/kiosk/forms/required` | 这位客人还要填哪几份表 |
| `POST /v1/kiosk/forms/submit` | 交表 |

设备令牌由 `device.issueToken` 命令签发（`settings.manage`），
`device.revokeToken` 吊销。

---

## 10. 技师端

```http
X-Staff-Token: <上机会话令牌>
```

| 路由 | 说明 |
| :--- | :--- |
| `GET /v1/auth/staff/me` | 我是谁、在哪家店、有什么权限 |
| `GET /v1/staff/me/today` | 今天的派单、收入、班次 |

技师能调的命令很少（`tech` 预设只有 8 条权限，见 §12）——
主要是 `ticket.startItem` / `ticket.finishItem` / `timeclock.punch` /
`staff.setLocale`。

> ⚠️ 手机号在技师端**默认脱敏**（`617-***-5678`）。
> 保留尾号是故意的：他要能对上「上次那个尾号 5678 的客人」，
> 但拿不到完整号码就没法私下联系（决策 16 防挖客）。

---

## 11. ⭐ 命令全表（89 条）

`idem` 列：`required` = 必须给 `Idempotency-Key`，不给直接 400。

### 预约

| 命令 | 权限 | idem | 撤销 |
| :--- | :--- | :--- | :--- |
| `appointment.create` | `appointment.write` | required | ✅ |
| `appointment.reschedule` | `appointment.write` | optional | ✅ |
| `appointment.cancel` | `appointment.cancel` | optional | ✅ |

> ⭐ `appointment.reschedule` **在一个事务里**先占新格再放旧格。
> 整单平移时保持各 item 的相对间隔（一单两个项目不会被压到同一起点）。
> 已开单的不让改（人已到店，那是运营动作）。
> **改期和取消现在会通知客人和技师**（批 8 收尾）。

### 工单与钱

| 命令 | 权限 | idem | 撤销 |
| :--- | :--- | :--- | :--- |
| `ticket.open` | `ticket.write` | required | ✅ |
| `ticket.addItem` | `ticket.write` | optional | ✅ |
| `ticket.startItem` / `ticket.finishItem` | `ticket.write` | optional | ✅ |
| `ticket.close` | `ticket.write` | required | ✅ |
| `ticket.group` / `ticket.ungroup` | `ticket.write` | optional | ✅ |
| `ticket.closeGroup` | `ticket.write` | required | ✅ |
| `ticket.void` | `ticket.void` | optional | — |
| `discount.apply` | `ticket.discount` | required | ✅ |
| `discount.void` | `ticket.discount` | required | — |
| `discount.saveReason` | `settings.manage` | optional | ✅ |

#### `ticket.close` 的 payments 数组

```jsonc
{
  "name": "ticket.close",
  "input": {
    "ticketId": "…",
    "discountCents": 0,
    "payments": [
      { "method": "cash", "amountCents": 5000, "tipCents": 500,
        "tenderedCents": 10000, "changeCents": 4500, "keepChange": false },
      { "method": "gift_card", "amountCents": 3000, "tipCents": 0,
        "giftCardId": "…" }              // 或 "giftCardCode": "ABCD-EFGH-…"
    ]
  }
}
```

| 字段 | 规矩 |
| :--- | :--- |
| `method` | `cash` \| `card` \| `external` \| **`gift_card`** |
| `keepChange` | 「不用找了」。为 true 时 `changeCents` 必须是 0，差额自动转小费 |
| `tenderedCents` | 客人递过来的现金。必须 ≥ `amountCents + changeCents` |
| `giftCardId` / `giftCardCode` | `method = 'gift_card'` 时**二选一必填** |

> ⚠️ **礼品卡余额不够 → 整笔结账拒绝**（`gift_card_insufficient`），
> 错误里带 `maxApplicableCents`。前端照着那个数改，让前台把余下的
> 另开一行走现金或刷卡。**不会悄悄少扣** —— 那会让单据和实收对不上。
>
> ⚠️ **礼品卡在日结里既不算现金也不算刷卡。** 算进刷卡的话，
> 晚上和刷卡机的 batch total 永远差出这一笔。

### 礼品卡（批 5）

| 命令 | 权限 | idem | 撤销 |
| :--- | :--- | :--- | :--- |
| `giftcard.saveTemplate` | `settings.manage` | optional | ✅ |
| `giftcard.issue` | `ticket.write` | required | ✅ |
| `giftcard.redeem` | `ticket.write` | required | ✅ |
| `giftcard.refund` | `ticket.void` | required | — |
| `giftcard.adjust` | **`dayclose.manage`** | required | — |

> ⭐ **面值 ≠ 售价。** `giftcard.issue` 返回的 `code` 是**明文卡号，
> 只在这一次出现** —— 前台要念给客人或印在卡上。
>
> ⚠️ `giftcard.adjust`（凭空加钱）的权限是 `dayclose.manage` 不是
> `ticket.write` —— 那和「收一笔钱」不是同一件事。

### 轮牌 / 候客 / 排班 / 打卡

| 命令 | 权限 | idem |
| :--- | :--- | :--- |
| `rotation.assign` | `appointment.write` | required |
| `rotation.reorder` / `rotation.skip` / `rotation.setBreak` | `rotation.override` | optional |
| `queue.join` | `queue.join` | required |
| `queue.update` | `queue.manage` | optional |
| `shift.set` / `shift.publish` / `shift.saveTemplate` | `schedule.write` | optional |
| `shift.applyTemplate` | `schedule.write` | required |
| `timeclock.punch` | `timeclock.punch_self` | optional |

### 日结与薪酬

| 命令 | 权限 | idem |
| :--- | :--- | :--- |
| `dayclose.saveCount` / `dayclose.recordCash` / `dayclose.markDay` | `dayclose.manage` | optional |
| `dayclose.finalize` | `dayclose.manage` | optional |
| `dayclose.reopen` | **`payroll.configure`** | optional |
| `dayclose.payTips` | `tip.payout` | required |
| `payroll.savePlan` | `payroll.configure` | optional |

### 门店设置

| 命令 | 权限 | 说明 |
| :--- | :--- | :--- |
| `location.saveProfile` / `location.saveHours` | `settings.manage` | |
| `location.saveOnlineBooking` | `settings.manage` | ⭐ 含改期政策，见 §14.1 |
| `location.saveAiChangePolicy` | `settings.manage` | ⭐ AI 改期/取消的八个开关，见 §14.2 |
| `location.savePhoneLine` | `settings.manage` | ⭐ 含话术，见下 |
| `location.addWebOrigin` / `removeWebOrigin` | `settings.manage` | 官网域名白名单 |
| `location.applyYelp` | `settings.manage` | Yelp 一键填 |
| `location.finishSetup` | `settings.manage` | |
| **`location.create`** | **`billing.manage`** | ⭐ 开第二家店（批 4）。org 不接受入参 |
| `location.requestAiVoice` | `settings.manage` | |
| `catalog.saveService` / `archiveService` | `catalog.manage` | |
| `catalog.saveFormTemplate` | `settings.manage` | |
| `device.issueToken` / `revokeToken` | `settings.manage` | 门口 iPad |
| `setup.claimLocation` | `settings.manage` | 认领门店 |

#### `location.savePhoneLine` 的话术字段（批 3）

```jsonc
{
  "e164": "+14158188936", "purpose": "ai_voice",
  "assistantName": "Emily",
  "greetingTemplate": "Thank you for calling {{store_name}}! This is {{assistant_name}}.",
  "greetingAiGenerated": false,
  "aiAnswer": true,
  "rotateToolToken": false
}
```

| 字段 | 说明 |
| :--- | :--- |
| `greetingTemplate` | 变量：`{{store_name}}` `{{caller_name}}` `{{assistant_name}}` |
| `greetingAiGenerated` | ⭐ 开了之后模板从**逐字稿**变成**语气参考** —— AI 按那个调子自己组织，能带上时段和「是不是老客」 |
| `aiAnswer` | 今天让不让 AI 接。**和 `active` 不是一回事**：`active=false` 是「这号不属于本店」（反查查不到），这个是日常开关 |

> ⚠️ **话术四个字段「没传就不动」。** 前台改个转接方式不该把老板调过的
> 开场白清空。**要清空得显式传 `null`。**

### 通知（批 7）

| 命令 | 权限 | 说明 |
| :--- | :--- | :--- |
| `notification.saveTemplate` | `settings.manage` | ⭐ **每次保存是新版本**，不是原地改 |
| `notification.toggleRule` | `settings.manage` | 开关 + 渠道 + 提前量 |

```jsonc
{ "name": "notification.toggleRule",
  "input": { "eventKey": "appointment_reminder", "enabled": true,
             "channels": ["sms"], "offsetMin": -1440 } }   // 负数 = 事件之前
```

> ⚠️ **没有规则行 = 不发。** 默认全关是有意的：装上新版本的那一刻，
> 所有历史门店突然开始给客人发短信是不可接受的（短信要花钱、会被投诉）。

12 个 `eventKey` 见 §14.4。

### 建站工单（批 8）

| 命令 | 权限 | 说明 |
| :--- | :--- | :--- |
| `storefront.saveDraft` | `settings.manage` | 局部更新，**分节保存不会清空别节** |
| `storefront.submit` | `billing.manage` | ⭐ **必填校验在这一步**，不在保存那步 |
| `storefront.withdraw` | `billing.manage` | 撤回。已 `live` 的撤不回来 |
| `storefront.chooseDraft` | `billing.manage` | 选一版。选新的会清掉旧的选择 |

> ⭐ **`draft` 阶段一个字都不进我们的队列** —— 界面上要明说，
> 老板才敢把半成品先存着。

### AI 电话与通话

| 命令 | 权限 | 说明 |
| :--- | :--- | :--- |
| `call.draftAppointment` | `call.draft` | 落一条待复核（含 AI 的改期/取消请求） |
| `call.reviewDraft` | `appointment.write` | 前台确认或忽略 |
| `call.record` / `call.attachTranscript` | `call.draft` | 通话计量与转录 |

### 员工与客户

| 命令 | 权限 |
| :--- | :--- |
| `staff.add` / `saveProfile` / `setEmployment` / `setRotation` / `issueClaimCode` / `revokeSessions` | `staff.manage` |
| `staff.setLocale` | `appointment.read`（人人都有 —— 改自己的语言不需要额外授权） |
| `form.submit` / `form.share` / `form.revokeShare` | `form.submit` |

### 计费与拍照开店

| 命令 | 权限 |
| :--- | :--- |
| `billing.*`（7 条） | `billing.manage` |
| `blueprint.*`（7 条） | `catalog.manage` |
| `ai.recordAssist` | `ai.use` |

---

## 12. 权限与角色

### 12.1 五个预设角色

| 角色 | 有什么（关键差异） |
| :--- | :--- |
| **owner** | 全部 36 条。**唯一有 `billing.manage`** —— 计费是老板一个人的事 |
| **manager** | 除 `billing.manage` / `ticket.refund` / `ai.execute_without_confirm` 外的全部 |
| **front_desk** | 日常操作全有，但**没有** `payroll.view_all` / `report.view` / `settings.manage` / `staff.manage` / `catalog.manage` |
| **senior_tech** / **tech** | 只有 8 条：`appointment.read` `ticket.read` `ticket.write` `rotation.read` `payroll.view_own` `customer.read` `schedule.read` `timeclock.punch_self` |

### 12.2 前端最常用来判显示的几条

| 权限 | 藏什么 |
| :--- | :--- |
| `billing.manage` | 订阅、开第二家店、建站工单的提交 |
| `report.view` | 报表入口、**客户详情里的所有金额** |
| `customer.view_contact` | 完整手机号 / 邮箱（没有就显示脱敏值） |
| `settings.manage` | 整个设置区 |
| `dayclose.manage` | 日结、礼品卡人工调整 |
| `ticket.discount` | 打折按钮 |
| `rotation.override` | 拖拽轮牌、跳过、强行改派 |

> ⚠️ 再说一次：**这是减少挫败感，不是安全边界。**

---

## 13. 实时（Realtime）

前台看板、派单、在线指示点都靠 Supabase Realtime **私有频道**。

**三个坑已经踩过了，别重踩：**

1. 广播走 `public.gf_broadcast()`，**不要**直接 grant `realtime.messages`
2. 私有频道的 **presence 也走 `realtime.messages` 的 INSERT 检查** ——
   一刀切拒绝会导致「0 人在线」而两边连接状态都正常
3. 广播**在业务事务内**发，不是提交后发（回滚即撤销）

事件类型：`ticket.changed` / `appointment.changed` / `rotation.changed` /
`queue.changed` —— 收到就重新拉对应的读接口，**不要**试图从事件里增量更新
（那会和服务端的真相漂移）。

---

## 14. 枚举与常量

### 14.1 `settings.online_booking`（`location.saveOnlineBooking`）

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `enabled` | false | 总开关 |
| `maxDaysAhead` | 60 | 最远能订多少天以后 |
| `minMinutesAhead` | 120 | 多久之内的不让在线订 |
| `requirePhoneVerification` | false | 订单前验手机验证码 |
| `cancelCutoffHours` | 4 | 开始前几小时内不能自助取消 |
| **`rescheduleEnabled`** | **true** | ⭐ 唯一默认开的护栏 —— 不让改期，客人只剩「取消」或「不来」，而 no-show 比改期糟得多 |
| `rescheduleCutoffHours` | 跟 `cancelCutoffHours` | |
| `selfRescheduleMax` | 2 | 0 = 不限 |

### 14.2 `settings.ai_change`（`location.saveAiChangePolicy`）

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| **`enabled`** | **false** | ⭐ 总开关。没配过的店，AI **一律只能提请求** |
| `allowReschedule` | true | 分开控制 —— 有的店愿意让 AI 改期但绝不让它取消 |
| `allowCancel` | **false** | |
| `requireExactCaller` | true | 来电号码必须精确相等。不做模糊匹配、不做姓名匹配 |
| `requireSingleUpcoming` | true | 名下将来只有一个单时才许直接动 |
| `minHoursAhead` | 24 | 0 = 不限。上限 168 |
| `blockGroup` | true | 组单一律落队列 |
| `blockSameDay` | true | 今天的单一律转人 |

被拦下时 `call_drafts.gate_reason` 会是：`disabled` / `not_allowed` /
`caller_mismatch` / `multiple_upcoming` / `same_day` / `group_ticket` /
`too_soon` / `not_found` / `execute_failed`。**前台界面要显示这个原因** ——
她要知道是哪条闸拦的。

### 14.3 `customer_preferences.profile`

七项，全是枚举（枚举才能筛能派单）：

| key | 取值 |
| :--- | :--- |
| `pressure` | `gentle` `moderate` `firm` |
| `music` | `light` `nature` `silent` |
| `aroma` | `none` `basic` `moderate` `premium` |
| `roomTemp` | `warm` `neutral` `cool` |
| `staffGender` | `any` `male` `female` |
| **`serviceLanguage`** | `en` `zh-Hans` `zh-Hant` `ko` `vi` `es` |
| `focusAreas` | `neck` `shoulders` `upper_back` `lower_back` `arms` `hips` `legs` `feet`（最多 8） |

> ⚠️ `staffGender` 和 `customer_preferences.preferred_gender` 是**同一件事的
> 两处**。那一列是事实源（派单引擎读它），jsonb 里只是界面镜像 ——
> **只写 jsonb 派单不会生效。**
>
> ⚠️ 认不出的 key 服务端会**逐项丢弃**，不报错。这一列有历史遗留。

### 14.4 通知事件（12 个）

| 组 | eventKey |
| :--- | :--- |
| 客户 | `appointment_confirm` `appointment_changed` `appointment_cancelled` `appointment_reminder` |
| **技师** | `staff_pending_confirm` `staff_assigned` `staff_changed` `staff_cancelled` |
| 营销 | `birthday` `holiday` `winback` `review_request` |

每个事件认得的变量见 `EVENT_VARIABLES`（`@gf/contracts`）——
**界面上要把可用变量列给老板看**，让他对着空文本框猜的话，
猜错了也不报错（未知变量渲染成空串），他会以为功能坏了。

### 14.5 建站工单枚举

```
painPoints: poor_mobile no_booking_entry slow dated_photos
            unclear_pricing not_in_search template_feel weak_brand
audience:   local_workers tourists seniors insurance chinese_community members
voice:      warm luxury modern traditional
sections:   hero about gallery services reviews giftcards faq contact
```

### 14.6 其它

| 名 | 取值 |
| :--- | :--- |
| 语言 | `en` `zh-Hans` `zh-Hant` `ko` `vi` `es` |
| 业态 | `nail` `massage` `foot_spa` `lash` `scalp` |
| 套餐 | `essential`（$99 / 500 积分 / 60 分钟）· `growth`（$199 / 1200 / 500） |
| 试用额度 | **150 积分 / 20 分钟**（不是套餐额度按天折算） |
| 支付方式 | `cash` `card` `external` `gift_card` |
| 预约来源 | `desk` `web` `phone_ai` `kiosk` |
| 订阅状态 | `trialing` `active` `past_due` `canceled` `unpaid` |

**金额一律是整数「分」**，字段名以 `Cents` 结尾。
成本类用「毫分」（`Millicents`，1/1000 分）。**前端不要用浮点做金额运算。**

---

## 15. ⚠️ 八条不要做的事

| 不要 | 为什么 |
| :--- | :--- |
| **不要在前端算排期 / 轮牌 / 小费 / 提成 / 日结** | 那些是 `packages/` 里的纯函数，是唯一实现。前端算一遍必然和后端不一致，而不一致的是**钱** |
| **不要做离线写入队列** | 断网切只读看板。轮牌和派单是全局强一致状态，离线合并必然 split-brain（两个前台各自派了同一个技师） |
| **不要把手机号全量拉到前端再隐藏** | 脱敏在服务端按角色做。隐藏只是 CSS —— 那等于把客户名单发到每台装了技师端的手机上 |
| **不要用 `service_role` key** | 它只在迁移 CI 里出现。前端拿到就等于绕过全部 RLS |
| **不要自己拼多个请求凑一个页面** | 需要聚合就提，后端加一条查询路由。七个请求拼一个客户详情页会在弱网下碎掉 |
| **不要用浮点做金额** | 全部是整数分。`0.1 + 0.2` 那个经典问题在收银台上就是差一分钱对不上账 |
| **不要把 `messageKey` 直接显示** | 那是 i18n 的 key，不是文案 |
| **不要把金额的 `null` 渲染成 `$0.00`** | `null` = 没权限看。渲染成 0 会变成一个明确的错误信息（「他一分钱没花过」），比空着糟得多 |

---

## 16. 本地起后端

```bash
cd geniefront-os && pnpm i
pnpm dev:api          # API，127.0.0.1:3000（等价于 pnpm --filter @gf/api dev）
pnpm dev:desk         # 现有前台，5183
```

⚠️ **端口以根 `.env` 的 `PORT` 为准**（现在是 3000）。
前端从 `VITE_API_BASE` 读，别在代码里写死。

⚠️ **`.env` 只有根目录一份**，各个 app 用 `loadEnv('../..')` + `define` 注进去 ——
不要在 `apps/*` 下面各建一个。

开发账号（密码统一 `GenieDev!2026`）：

| 邮箱 | 角色 | 门店 |
| :--- | :--- | :--- |
| `mia@example.test` | `front_desk` | Lotus Nails & Spa |
| `amy@example.test` | `manager` **兼** `tech` | Lotus Nails & Spa |
| `mai@example.test` | `senior_tech` | Lotus Nails & Spa |
| `tran@` / `kim@` / `linh@example.test` | `tech` | Lotus Nails & Spa |
| `owner@example.test` | `owner` | Golden Foot Spa（测多店 / 计费用） |
| `yan@` / `bo@` / `hua@example.test` | `tech` | Golden Foot Spa |

> 云端 Supabase 项目里**已经 seed 好了**，不需要再跑 `pnpm db:seed`。
> ⚠️ 而且**不要跑** —— 种子会解绑 Golden Foot Spa 上那个真实的 Telnyx 号
> （`+17579999968`），解绑后那家店的电话会全部 401。

`pnpm verify` 是唯一的验收入口（lint + typecheck + 835 项测试）。

> ⚠️ **不要并发跑 `pnpm verify`** —— 两个进程会撞同一个测试库，
> 表现是一堆莫名其妙的 404。

---

## 附录 A · 89 条命令的全量表

> 这一节由 `COMMAND_REGISTRY` 导出，**不会和代码漂移**。
> 上面 §11 是按业务分组的速查，这里是完整清单。
> `idem = required` 的命令不给 `Idempotency-Key` 直接 400。

| 命令 | 权限 | idem | 可撤销 |
| :--- | :--- | :--- | :--- |
| `ai.recordAssist` | `ai.use` | optional | — |
| `appointment.cancel` | `appointment.cancel` | optional | ✅ |
| `appointment.create` | `appointment.write` | required | ✅ |
| `appointment.reschedule` | `appointment.write` | optional | ✅ |
| `billing.claimAutoTopup` | `billing.manage` | optional | — |
| `billing.recordTopup` | `billing.manage` | required | — |
| `billing.recordTopupFailure` | `billing.manage` | optional | — |
| `billing.savePaymentMethod` | `billing.manage` | optional | — |
| `billing.setAutoTopup` | `billing.manage` | optional | ✅ |
| `billing.syncSubscription` | `billing.manage` | optional | — |
| `blueprint.apply` | `catalog.manage` | required | ✅ |
| `blueprint.createDraft` | `catalog.manage` | optional | ✅ |
| `blueprint.discard` | `catalog.manage` | optional | — |
| `blueprint.reviewAll` | `catalog.manage` | optional | ✅ |
| `blueprint.reviewItem` | `catalog.manage` | optional | ✅ |
| `blueprint.saveExtraction` | `catalog.manage` | optional | ✅ |
| `blueprint.saveTranslations` | `catalog.manage` | optional | ✅ |
| `call.attachTranscript` | `call.draft` | optional | — |
| `call.draftAppointment` | `call.draft` | required | ✅ |
| `call.record` | `call.draft` | required | — |
| `call.reviewDraft` | `appointment.write` | optional | ✅ |
| `catalog.archiveService` | `catalog.manage` | optional | ✅ |
| `catalog.saveFormTemplate` | `settings.manage` | optional | ✅ |
| `catalog.saveService` | `catalog.manage` | optional | ✅ |
| `dayclose.finalize` | `dayclose.manage` | optional | — |
| `dayclose.markDay` | `dayclose.manage` | optional | ✅ |
| `dayclose.payTips` | `tip.payout` | required | ✅ |
| `dayclose.recordCash` | `dayclose.manage` | optional | ✅ |
| `dayclose.reopen` | `payroll.configure` | optional | — |
| `dayclose.saveCount` | `dayclose.manage` | optional | ✅ |
| `device.issueToken` | `settings.manage` | optional | — |
| `device.revokeToken` | `settings.manage` | optional | — |
| `discount.apply` | `ticket.discount` | required | ✅ |
| `discount.saveReason` | `settings.manage` | optional | ✅ |
| `discount.void` | `ticket.discount` | required | — |
| `form.revokeShare` | `form.submit` | optional | — |
| `form.share` | `form.submit` | optional | ✅ |
| `form.submit` | `form.submit` | required | — |
| `giftcard.adjust` | `dayclose.manage` | required | — |
| `giftcard.issue` | `ticket.write` | required | ✅ |
| `giftcard.redeem` | `ticket.write` | required | ✅ |
| `giftcard.refund` | `ticket.void` | required | — |
| `giftcard.saveTemplate` | `settings.manage` | optional | ✅ |
| `location.addWebOrigin` | `settings.manage` | optional | ✅ |
| `location.applyYelp` | `settings.manage` | optional | ✅ |
| `location.create` | `billing.manage` | required | — |
| `location.finishSetup` | `settings.manage` | optional | — |
| `location.removeWebOrigin` | `settings.manage` | optional | ✅ |
| `location.requestAiVoice` | `settings.manage` | optional | ✅ |
| `location.saveAiChangePolicy` | `settings.manage` | optional | ✅ |
| `location.saveHours` | `settings.manage` | optional | ✅ |
| `location.saveOnlineBooking` | `settings.manage` | optional | ✅ |
| `location.savePhoneLine` | `settings.manage` | optional | ✅ |
| `location.saveProfile` | `settings.manage` | optional | ✅ |
| `notification.saveTemplate` | `settings.manage` | optional | — |
| `notification.toggleRule` | `settings.manage` | optional | ✅ |
| `payroll.savePlan` | `payroll.configure` | optional | ✅ |
| `queue.join` | `queue.join` | required | ✅ |
| `queue.update` | `queue.manage` | optional | ✅ |
| `rotation.assign` | `appointment.write` | required | ✅ |
| `rotation.reorder` | `rotation.override` | optional | ✅ |
| `rotation.setBreak` | `rotation.override` | optional | ✅ |
| `rotation.skip` | `rotation.override` | optional | ✅ |
| `setup.claimLocation` | `settings.manage` | optional | — |
| `shift.applyTemplate` | `schedule.write` | required | ✅ |
| `shift.publish` | `schedule.write` | optional | ✅ |
| `shift.saveTemplate` | `schedule.write` | optional | ✅ |
| `shift.set` | `schedule.write` | optional | ✅ |
| `staff.add` | `staff.manage` | optional | ✅ |
| `staff.issueClaimCode` | `staff.manage` | optional | — |
| `staff.revokeSessions` | `staff.manage` | optional | — |
| `staff.saveProfile` | `staff.manage` | optional | ✅ |
| `staff.setEmployment` | `staff.manage` | optional | ✅ |
| `staff.setLocale` | `appointment.read` | optional | ✅ |
| `staff.setRotation` | `staff.manage` | optional | ✅ |
| `storefront.chooseDraft` | `billing.manage` | optional | ✅ |
| `storefront.saveDraft` | `settings.manage` | optional | ✅ |
| `storefront.submit` | `billing.manage` | optional | ✅ |
| `storefront.withdraw` | `billing.manage` | optional | ✅ |
| `ticket.addItem` | `ticket.write` | optional | ✅ |
| `ticket.close` | `ticket.write` | required | ✅ |
| `ticket.closeGroup` | `ticket.write` | required | ✅ |
| `ticket.finishItem` | `ticket.write` | optional | ✅ |
| `ticket.group` | `ticket.write` | optional | ✅ |
| `ticket.open` | `ticket.write` | required | ✅ |
| `ticket.startItem` | `ticket.write` | optional | ✅ |
| `ticket.ungroup` | `ticket.write` | optional | ✅ |
| `ticket.void` | `ticket.void` | optional | — |
| `timeclock.punch` | `timeclock.punch_self` | optional | ✅ |

**合计 89 条。**

