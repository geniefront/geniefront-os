# 13 · 公开预约 API —— 门店官网的对接契约

> **写给做门店官网的那个 AI。** 你做的是**一家店自己的官网**
> （lotusnails.com 这种），上面要有一个「在线预约」。
> 这份文档是官网和门店系统之间的**全部接触面**，读完就能开工。
>
> ⚠️ 别和 [`11-WEBSITE-INTEGRATION.md`](11-WEBSITE-INTEGRATION.md) 搞混：
> 那一份是**我们卖软件的官网**（老板掏钱订阅），接的是 Stripe Checkout。
> 这一份是**门店自己的官网**（客人来订指甲），接的是预约。
> 两份没有任何共用字段。

---

## 0. 实现状态（2026-08-21）

✅ **接口已经实现并跑通**（`apps/api/src/public/`，38 项测试）。

⭐ **而且已经有一张现成的预约页了**（`apps/booking`，默认黑白极简，
另有毛玻璃可选，手机优先，可嵌 iframe 也可独立打开，外观全由 URL 参数控制）。**多数情况下你不需要读这份文档的
§4–§7** —— 贴一段 iframe 就完事，见 **[§10](#10-用现成的那张页面最省事)**。
自己做 UI 再来读 §4。

| | |
| :--- | :--- |
| ⭐ **现成的预约页** `apps/booking`（黑白 / 毛玻璃两套外观，URL 参数可调，见 §10） | ✅ |
| `GET /public/v1/shop` / `services` / `availability` | ✅ |
| `POST /public/v1/bookings`、`GET`/`POST …/:id[/cancel]` | ✅ |
| Turnstile 校验、三维度限频、蜜罐、未完成预约上限 | ✅ |
| 每店域名白名单 + 开店配置里的「🌐 官网对接」页 | ✅ |
| `appointment.cancel` 命令（**之前一直没实现**，顺手补上） | ✅ |
| `POST …/:id/reschedule` **自助改期** + 手机后四位二次校验（§4.6） | 🚧 批 2 |
| `booking_policies`（改期/取消截止、自助改期次数上限） | 🚧 批 2 |
| 手机验证码那一步（§6.5） | ⬜ **没做**，默认关，不影响开工 |

✅ **带真 Turnstile token 的完整链路已经走通了**（2026-08-21，用
`apps/booking` 在浏览器里真订了一单）：真 token → siteverify 通过 →
建出 `source='web'` 的预约 + `source='web'` 的客户 → 确认信入队 →
点「取消这个预约」→ 预约和 item 一起变 `cancelled`。

### 与初版文档的三处出入

写代码时碰到了数据模型的实际情况，这三处**以本文档现在的内容为准**：

1. ~~**没有「加项目录」**~~ —— **2026-08-22 已解决**。
   `services` 加了 `is_addon`（`sql/0035`），老板在门店设置里逐个勾。
   `/services` 现在返回**两个数组**：`services`（能单独订的）和
   `addons`（只能挂在 `items[].addonIds` 上）。
   服务端也不再接受把加项当主项目提交（`addon_not_bookable_alone`）。
   ⚠️ 这是一次**返回结构变更**：原来加项混在 `services` 平列表里，
   官网会把「热石 +$15」当成一个完整项目展示，客人能单独把它订下来。
2. **没有 `priceIsFrom`**（「$55 起」）。这个标记只活在拍照开店的草案里，
   落地成项目时就丢了。要显示「起」得先在项目上补一列，另说。
3. ~~**确认邮件里没有取消链接**，`manageUrl` 也不返回~~ —— **2026-08-25 推翻**。
   邮件里现在放 manage URL，但打开后要输**手机后四位**才能改或取消。
   同时**新增了自助改期**（初版明确说不做）。两条顾虑怎么解掉的见 §4.6。

## 1. 分工：谁做什么

```
门店官网（你做）                      门店系统（我们）
────────────────────────────         ────────────────────────────
首页 / 项目介绍 / 相册
「立即预约」表单
  ├ 拉项目列表        ──────────►    GET  /public/v1/services
  ├ 拉某天空档        ──────────►    GET  /public/v1/availability
  ├ Turnstile 挑战（浏览器里跑）
  └ 提交预约          ──────────►    POST /public/v1/bookings
                                       ├ 验 Turnstile + 限频 + 白名单
                                       ├ 走 appointment.create（source='web'）
                                       ├ 发确认邮件/短信
                                       └ 前台看板 2 秒内出现这一单
「预约成功」页
  （显示确认码 + 管理链接）
```

> 💡 **在动手写这些之前先看 §10。** 上面那张图是「你自己做 UI」的分工；
> 如果直接用我们那张现成的页面，你要做的只有**贴一段 iframe**。

### ⛔ 官网**不要**做的五件事

| 不要做 | 为什么 |
| :--- | :--- |
| **不要自己算时间** | 空档必须来自 `/availability`。自己按「9:00–19:30 每半小时」铺一排格子，客人会订到已经被占的时段，而前台要打电话回去道歉 |
| **不要自己算价格** | 价格以库里为准。你可以显示 `priceCents`，但**提交时传的价格我们一律忽略** |
| **不要收密码、不要建账号** | 客人订指甲不需要账号。收了密码就是凭空多一个泄露面 |
| **不要把 `public_key` 当密钥保护** | 它**不是**密钥（见 §3），它会出现在浏览器里。安全不靠它 |
| **不要自己发确认短信/邮件** | 确认信我们发（里面带取消链接）。官网再发一封，客人会拿着错的那封点进死链 |

---

## 2. Base URL

```
生产    https://api.geniefront.com
本地    http://localhost:3000
```

所有响应都是 JSON，`Content-Type: application/json`。

---

## 3. 鉴权：一个 `public_key`，仅此而已

每家店有一个公开标识，形如 `pk_3f9a2b1c`，在门店系统的
**⚙ 开店配置 → 官网对接** 里能看到并复制。

```http
X-GF-Public-Key: pk_3f9a2b1c
```

### 🔴 它不是密钥，安全不建立在它上面

它会明文出现在官网的 JS 里，**任何人都能看到**。所以：

- 它只能做**公开的事**：读可在线预约的项目、读空档、建一条预约
- 它**绝对不能**读客户名单、读别人的预约、读营业额、改任何配置
- 拿到它的人能做的，等于「打开这家店的官网点预约」能做的 —— 一模一样

真正挡机器人的是 §6 那一整套（Turnstile + 白名单 + 限频），不是这个字符串。

> ✅ `pk_` 现在是 24 位 hex（96 bit，`sql/0033` 的触发器保证）。
> 加长**不是因为它是密钥** —— 而是原来的 8 位（32 bit）短到能被枚举，
> 有人可以扫出「哪些 key 是活的」进而批量骚扰所有门店，
> 而不必先找到每家店的官网。

### 域名白名单

老板在开店配置里填自己的官网域名（如 `lotusnails.com`）。
浏览器请求带的 `Origin` 不在白名单里 → **403 `PERMISSION_DENIED`**。

对官网的影响只有一条：**上线前记得让老板把域名填进去**，
包括预览域名（`*.pages.dev` / `*.vercel.app`）。忘了填的表现是
本地开发好好的、一上线全部 403。

---

## 4. 四条接口

### 4.1 `GET /public/v1/shop` —— 门店信息

页面首屏和表单初始化都要它。**第一个调它**，因为 `turnstileSiteKey`
和 `timezone` 都从这里来。

```http
GET /public/v1/shop?locale=en
X-GF-Public-Key: pk_3f9a2b1c
```

```jsonc
{
  "name": "Lotus Nails & Spa",
  "slug": "lotus-nails",
  "timezone": "America/New_York",     // ⭐ IANA。所有时间都按这个显示
  "currency": "USD",
  "phone": "+16175550142",
  "address": { "line1": "…", "city": "Boston", "state": "MA", "postalCode": "02118" },
  "businessHours": {
    "mon": { "open": "09:30", "close": "19:30" },
    "sun": { "open": "10:00", "close": "18:00" },
    "tue": null                        // null = 那天不营业
  },
  "locales": ["en"],                   // 门店默认语言（v1 只返回这一个）
  "onlineBooking": {
    "enabled": true,
    "maxDaysAhead": 60,                // 只能订未来 60 天内
    "minMinutesAhead": 120,            // ⭐ 两小时内的不让在线订，见下
    "requirePhoneVerification": false, // true 时多一步短信验证码，见 §6.5
    "cancelCutoffHours": 4             // 开始前 4 小时内不能自助取消
  },
  "turnstileSiteKey": "0x4AAAAAAA…"    // ⭐ 前端 Turnstile widget 用这个
}
```

> **`minMinutesAhead` 为什么存在**：网上订「20 分钟后」的单，前台十有八九
> 还没看到人就到了。这不是技术问题是运营问题 —— 太急的单让客人打电话，
> 电话那头能当场说「你现在过来要等 15 分钟」。

`onlineBooking.enabled = false` 时：**只显示店铺电话，不要显示预约表单**。
这时候调 `/bookings` 会 403。

---

### 4.2 `GET /public/v1/services` —— 可在线预约的项目

只返回 `active = true` **且** `online_bookable = true` 的。
老板故意不勾的项目（比如要面谈报价的美睫）不会出现在这里 —— **不要绕过它**。

```http
GET /public/v1/services?locale=zh-Hans
X-GF-Public-Key: pk_3f9a2b1c
```

```jsonc
{
  "categories": [
    { "id": "…", "name": "美甲" }
  ],
  "services": [
    {
      "id": "6f1c…",                  // ⭐ 提交预约时传这个
      "categoryId": "…",
      "name": "凝胶美甲",
      "description": "含修型与护理",
      "durationMin": 60,
      "priceCents": 5500,
      "isAddon": false
    }
  ],
  "addons": [                         // ⭐ 加项：只能加在主项目上
    {
      "id": "9a3e…",
      "categoryId": "…",
      "name": "热石",
      "description": null,
      "durationMin": 15,
      "priceCents": 1500,
      "isAddon": true
    }
  ]
}
```

- `locale` 认不出 → 回退到门店默认语言，不报错

### ⭐ `addons` 怎么用（2026-08-22 起）

- **`addons` 里的项目不能单独订。** 它们只能出现在
  `items[].addonIds` 里。拿一个加项当 `serviceId` 提交 → `400`
  `addon_not_bookable_alone`（查空档也一样）
- **报价说「加 $15」，不是「$15 一次」。** 官网上把它们做成
  选完主项目之后的**勾选项**，不要和主项目并排成一列
- **加项会加长时长**，所以选完加项要**重新拉一次空档**
  （`/availability?addonIds=…`，见 §4.3）—— 少传的话拿到的是
  「只做主项目」的空档，客人会选到一个放不下他这一单的时间
- 反过来是允许的：把一个**主项目**放进 `addonIds`（「加做一次卸甲」
  真店里就是这么卖的），价格和时长照常累加

---

### 4.3 `GET /public/v1/availability` —— 哪些时段有空

**这是整个对接里唯一需要仔细读的一条。**

```http
GET /public/v1/availability?date=2026-09-03&serviceId=6f1c…&addonIds=…,…&staffId=
X-GF-Public-Key: pk_3f9a2b1c
```

| 参数 | 必填 | 说明 |
| :--- | :--- | :--- |
| `date` | ✅ | `YYYY-MM-DD`，**门店本地日期**，不是客人浏览器的日期 |
| `serviceId` | ✅ | 不同项目时长不同，不给项目算不出空档 |
| `addonIds` | | 逗号分隔。加项会加长时长，**选了加项要重新拉一次** |
| `staffId` | | 指定技师（点钟）。不给 = 任意技师 |

```jsonc
{
  "date": "2026-09-03",
  "timezone": "America/New_York",
  "durationMin": 75,                  // 项目 + 加项之后的实际时长
  "slots": [
    { "startsAt": "2026-09-03T10:00:00-04:00", "staff": null },
    { "startsAt": "2026-09-03T10:30:00-04:00", "staff": null }
  ],
  "staff": [                          // 可点钟的技师，`staffId` 用这里的 id
    { "id": "…", "displayName": "Amy", "avatarUrl": null }
  ]
}
```

#### ⭐ 三条必须照做的

**① 时间一律带偏移量，一律按 `timezone` 显示。**
`startsAt` 是带 `-04:00` 的完整 ISO 8601。**不要**用
`new Date(s).toLocaleTimeString()` 直接渲染 —— 那按的是客人浏览器的时区，
一个在加州订波士顿店的客人会看到全部时间差三小时。用
`Intl.DateTimeFormat('en-US', { timeZone: shop.timezone, … })`。

**② `slots` 为空数组是正常的，不是错误。**
那天不营业、排班没人、或者已经订满，都会返回 `[]`。
显示「这天已约满，看看别的日子」，并且**自动跳到下一个有空档的日子**。
显示一个转圈或者一句 "error" 会让客人以为网站坏了然后关掉。

**③ 空档会过期。** 拉回来的空档**不占位**，别人可能在客人填名字的时候订走。
提交时撞上冲突会返回 `RESOURCE_CONFLICT`（§7），
这时候**重新拉一次 availability 并让客人重选**，不要直接报错了事。

> 不做「临时锁位」是有意的：给公开页面开锁位的口子，等于给了一条
> 「刷一遍全天时段、全锁上、十分钟后释放」的路 —— 那正是 §6.6 要防的事。

---

### 4.4 `POST /public/v1/bookings` —— 建预约

```http
POST /public/v1/bookings
X-GF-Public-Key: pk_3f9a2b1c
Idempotency-Key: 9c1e4b7a-…            ⭐ 必填，见下
Content-Type: application/json
```

```jsonc
{
  "turnstileToken": "0.abc…",          // ⭐ 必填，见 §6.1
  "locale": "en",
  "customer": {
    "name": "Amy Chen",                // 1–120 字符
    "phone": "+16175550199",           // ⭐ E.164。见下
    "email": "amy@example.com",        // 可选，但强烈建议收（确认信更可靠）
    "smsOptIn": false                  // ⭐ 见下，默认必须是 false
  },
  "items": [
    {
      "serviceId": "6f1c…",             // ⚠️ 必须是 /services 的 services 里的，不能是 addons 里的
      "addonIds": ["9a3e…"],            // 加项。会加长时长，价格照常累加
      "staffId": null,                 // null = 不指定技师
      "startsAt": "2026-09-03T10:30:00-04:00"   // 原样回传 availability 给的值
    }
  ],
  "partySize": 1,                      // 一起来几个人，1–20
  "notes": "第一次来",                  // 可选，≤ 500 字符
  "website": "",                       // ⭐ 蜜罐字段，见 §6.3
  "formElapsedMs": 45000               // ⭐ 从打开表单到提交过了多久，见 §6.3
}
```

**成功 `201`：**

```jsonc
{
  "bookingId": "b3d2…",
  "confirmationCode": "LN-4K2P",       // 给客人念的短码，前台也能搜
  "manageToken": "mt_9f3c…",           // ⭐ 取消要它，见 §4.5
  "replayed": false,
  "startsAt": "2026-09-03T10:30:00-04:00",
  "durationMin": 75,
  "status": "booked"
}
```

#### 🔴 重放同一个 `Idempotency-Key` 返回 `200`，而且**令牌是 `null`**

```jsonc
{ "bookingId": "b3d2…", "confirmationCode": null, "manageToken": null,
  "replayed": true, "startsAt": "…", "durationMin": 75, "status": "booked" }
```

这不是遗漏。库里存的是**第一次**那个令牌的摘要，重放时新生成的那个验不过 ——
返回它等于给客人一个看起来正常、一按取消就 404 的令牌。

对官网的要求只有一条：**第一次拿到 `manageToken` 就把它存下来**
（sessionStorage / 直接渲染进成功页）。看到 `replayed: true` 时
不要覆盖已经存好的那个。

#### ⭐ `Idempotency-Key` 必填

一个 UUID v4，客人**打开表单时生成一次**，整个提交流程里不变
（包括失败重试）。换页面/换客人才重新生成。

漏掉它的表现：客人手抖点了两下「确认」，或者网络慢了他自己刷新，
**店里那一格被订了两次**。前台看到两条一模一样的单，要打电话去问
「您是订了两次还是一次」—— 这通电话不该存在。

#### 手机号：E.164，官网这边先挡一道

`+1` 开头的 11 位。客人输 `(617) 555-0199` 是正常的，
**你负责在提交前规范化成 `+16175550199`**。
规范不出来就当场提示他重输 —— 号码错了确认短信发不出去，
而客人以为约上了。

#### 🔴 `smsOptIn` 默认必须是 `false`，且不能预勾选

这是**法律要求**（TCPA），不是产品偏好。

- **约会确认与提醒短信不需要这个开关** —— 那是交易性短信，客人主动预约就构成同意
- `smsOptIn` 只管**营销短信**（促销、生日券）
- 复选框必须**默认不勾**，旁边必须有一句明确的措辞，例如：
  > ☐ 我同意接收 Lotus Nails 的优惠短信。频率不定，回复 STOP 退订，可能产生资费。

预勾选或者把它藏进「继续即代表同意」，一次投诉的成本是每条短信 $500–$1500。
**这一条比这份文档里其它所有条加起来都贵。**

---

### 4.5 `POST /public/v1/bookings/:id/cancel` —— 自助取消

```http
POST /public/v1/bookings/b3d2…/cancel
X-GF-Public-Key: pk_3f9a2b1c
Content-Type: application/json

{ "manageToken": "mt_9f3c…", "turnstileToken": "0.abc…" }
```

```jsonc
{ "bookingId": "b3d2…", "status": "cancelled" }
```

- **`manageToken` 是唯一凭证**，只在**建单响应**里出现一次。
  没有它，拿到 `bookingId` 也什么都做不了 —— 预约 id 会出现在
  URL、浏览器历史、分享链接里，只靠它就等于谁都能取消别人的预约

- 开始前 `cancelCutoffHours` 小时内 → `403`，
  文案要给店铺电话：「太近了，请直接打电话给店里 (617) 555-0142」

> `GET /public/v1/bookings/:id?t=mt_9f3c…` 可以只读查一条预约，
> 参数同上。官网如果做「我的预约」页面用它。

---

### 4.6 `POST /public/v1/bookings/:id/reschedule` —— 自助改期

> **⚠️ 这一节推翻了初版的两条决定**（2026-08-25，批 2）。
> 初版写的是「**没有自助改期**」和「**确认邮件里没有取消链接**」。
> 那两条的顾虑都是真的，下面是怎么解决的 —— **不是绕过，是正面解掉**。

```http
POST /public/v1/bookings/b3d2…/reschedule
X-GF-Public-Key: pk_3f9a2b1c

{ "manageToken": "mt_9f3c…", "last4": "4821",
  "startsAt": "2026-09-02T15:30:00-04:00", "turnstileToken": "0.abc…" }
```

#### 顾虑一：「改期会变成取消 + 重订两步，中间那格被人订走」

**解法：原子改期。** `appointment.reschedule` 这条命令**本来就存在**，
在**一个事务里**先占新格再放旧格 —— 容量触发器撞了就整体回滚。
客人要么改成功，要么原单原封不动，**不存在两头落空的中间态**。

这条公开路由只是加一层公开身份的校验然后调它，不重写任何调度逻辑。

#### 顾虑二：「邮件会被转发，捡到链接的人能改掉别人的预约」

**解法：链接 + 手机后四位。** 确认邮件里放 manage URL，但打开后
**要输入预约时留的手机后四位**才能改或取消。捡到链接的同事没有那四位数，
而客人早就习惯这个动作 —— 门口 iPad 签到就是输后四位。

三道闸一起用：

| 闸 | 规则 | 配在哪 |
| :--- | :--- | :--- |
| 二次校验 | 手机后四位必须匹配，错 3 次锁 15 分钟 | 硬编码 |
| 时间截止 | 开始前 `rescheduleCutoffHours` 内不许改 | `booking_policies` |
| 次数上限 | 每张单最多自助改 `selfRescheduleMax` 次 | `booking_policies` |

超限一律返回带**店铺电话**的文案，让他打电话 —— 那时前台还有机会挽留。

> ⚠️ **改期时查空档要把本单自己占的格子排除掉**，否则客人看不到
> 「原地往后延 15 分钟」这种最常见的改法（那一格正被他自己占着）。
> `GET /public/v1/availability` 加一个 `excludeAppointmentId` 参数。

---

## 5. 一个能跑的最小例子

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

<form id="booking">
  <input name="name" required maxlength="120">
  <input name="phone" type="tel" required>
  <input name="email" type="email">
  <!-- 蜜罐：真人看不见，脚本会填 -->
  <input name="website" tabindex="-1" autocomplete="off"
         style="position:absolute;left:-9999px" aria-hidden="true">
  <div class="cf-turnstile" data-sitekey="" data-callback="onTurnstile"></div>
  <button type="submit" disabled>确认预约</button>
</form>

<script>
const API = 'https://api.geniefront.com';
const KEY = 'pk_3f9a2b1c';
const H   = { 'Content-Type': 'application/json', 'X-GF-Public-Key': KEY };

// 打开表单时生成一次，整个流程不变
const idem = crypto.randomUUID();
const openedAt = Date.now();
let turnstileToken = null;

function onTurnstile(t) {
  turnstileToken = t;
  document.querySelector('#booking button').disabled = false;
}

const shop = await (await fetch(`${API}/public/v1/shop`, { headers: H })).json();
document.querySelector('.cf-turnstile').dataset.sitekey = shop.turnstileSiteKey;

// 时间一律按门店时区渲染
const fmt = new Intl.DateTimeFormat(shop.locales[0], {
  timeZone: shop.timezone, hour: 'numeric', minute: '2-digit',
});

async function slotsFor(date, serviceId) {
  const q = new URLSearchParams({ date, serviceId });
  const r = await fetch(`${API}/public/v1/availability?${q}`, { headers: H });
  return (await r.json()).slots;   // 空数组 = 那天约满，跳下一天
}

document.querySelector('#booking').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);

  const res = await fetch(`${API}/public/v1/bookings`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': idem },
    body: JSON.stringify({
      turnstileToken,
      locale: shop.locales[0],
      customer: {
        name:  f.get('name'),
        phone: toE164(f.get('phone')),   // 你负责规范化
        email: f.get('email') || undefined,
        smsOptIn: false,                 // 默认 false，见 §4.4
      },
      items: [{ serviceId, addonIds: [], staffId: null, startsAt }],
      partySize: 1,
      website: f.get('website'),         // 蜜罐原样回传
      formElapsedMs: Date.now() - openedAt,   // ⭐ 别忘了真的传出去
    }),
  });

  if (res.status === 409) {             // 被人抢先订走了
    alert('这个时段刚被订走了，请重新选一个');
    return refreshSlots();              // ⭐ 重拉空档，不是报错了事
  }
  if (!res.ok) return showError((await res.json()).code);

  const b = await res.json();
  // ⭐ 令牌只给这一次。要做「我的预约」就现在存下来
  if (b.manageToken) sessionStorage.setItem(`gf:${b.bookingId}`, b.manageToken);
  location.href = `/booked?c=${b.confirmationCode}`;
});
</script>
```

⚠️ **Turnstile token 用过即废、有效期约 5 分钟。** 提交失败要重试的话，
必须先 `turnstile.reset()` 拿一个新的 —— 拿旧的重试会一直 400。

---

## 6. 防机器人与防恶意 ⭐

公开预约页是这个系统上**唯一一个不需要任何身份就能写库的入口**。
它面对两种完全不同的攻击，防法也不一样：

| | 想干什么 | 代价落在谁身上 |
| :--- | :--- | :--- |
| **垃圾流量** | 刷表单、灌垃圾内容、拿它当短信轰炸机 | 我们（短信费、邮件信誉） |
| **恶意占位** | 把周六下午全订满，然后一个都不来 | 门店（一天的营业额） |

第二种更难防也更疼 —— 因为它每一条都长得像真单。

### 6.1 Cloudflare Turnstile（必做，第一道）

- 前端：`shop.turnstileSiteKey` 渲染 widget，token 随 `POST` 一起交
- 后端：拿 `TURNSTILE_SECRET_KEY` 调 `siteverify` 校验，
  **同时把 `Idempotency-Key` 作为 `idempotency_key` 传过去**，
  这样客人重试同一单不会因为 token 已用过而被判失败
- 验不过 → `400 VALIDATION_FAILED`，`details.reason = "bot_check_failed"`

选 Turnstile 不选 reCAPTCHA 的原因写在 `06-EXTERNAL-SERVICES.md`：
免费、多数情况下客人**完全无感**（不用点消防栓）。
在一个「客人订指甲」的场景里，多一步图片验证的流失比机器人贵。

⚠️ **不要把 Turnstile 当成唯一防线。** 它挡的是脚本，
挡不住一个真人开着浏览器一条一条填 —— 而恶意占位往往就是真人干的。

### 6.2 限频：三个维度一起看

| 维度 | 上限 | 挡什么 |
| :--- | :--- | :--- |
| 每 IP | 5 单 / 小时 | 脚本连打 |
| 每手机号 | 3 单 / 天 | 换 IP 但用同一个号 |
| 每门店 | 30 单 / 小时 | 分布式刷同一家店 |

超了返回 `429`：

```jsonc
{ "code": "RATE_LIMITED", "messageKey": "error.RATE_LIMITED",
  "details": { "scope": "ip", "retryAfterSec": 2840 }, "overridable": false }
```

官网收到 429 要显示「太频繁了，请稍后再试或直接致电门店」并给电话 ——
**不要静默重试**，那会把限频撞成死循环。

> 实现备注：门口 Kiosk 那套内存计数（`kiosk/routes.ts`）在这里不够用 ——
> 两台实例各限一半，而公开入口面对的是分布式来源。这一条用 Upstash Redis
> （`.env` 里已有），是宪法第 10 条「不自管状态」允许的托管服务。
>
> ⚠️ **Upstash 够不着时降级到进程内存，不是拒绝。** 限频后端挂掉时
> 拒绝所有预约，等于「Upstash 抖一下 = 所有门店当天收不到网上订单」；
> 降级之后上限被放宽到「每实例一份」，而 Turnstile、蜜罐、
> 未完成预约上限三道还在。日志里会喊。

### 6.3 蜜罐 + 最短填写时间（零成本，挡掉大半）

- **蜜罐**：表单里放一个视觉隐藏的 `website` 字段。真人看不见所以永远是空的，
  傻脚本会把每个 input 都填上。非空 → **假装成功**（返回 201 和一个假确认码），
  但什么都不写库。假装成功是有意的：直接报错等于告诉对方蜜罐在哪
- **最短时间**：官网把 `formElapsedMs` 一起交上来，**< 3 秒**当机器人处理
  （同样假装成功）。真人选日期、选时段、填名字、填手机号不可能三秒内做完

⚠️ **`formElapsedMs` 是客户端自报的，伪造起来毫不费力。**
它挡的是照着表单字段无脑 POST 的那一类，不是任何认真的人 ——
一条都不该算作安全边界。留着它是因为它便宜、而且对真人零摩擦。

这两条加起来能挡掉绝大部分自动化流量，所以放在 Turnstile 之后当第二道
（顺序上其实在**前**：它们是内存判断，不花一次 Cloudflare 往返）。

### 6.4 服务端只信服务端

**官网传来的这些一律不信**，全部以库里为准：

| 官网传的 | 我们怎么处理 |
| :--- | :--- |
| 价格 | 忽略。价格快照取自 `services.base_price_cents` |
| 时长 | 忽略。取自 `services.duration_min`（按技师等级可能不同） |
| `startsAt` | **重新验一遍**：是否在营业时间内、是否真的有空、是否在 `minMinutesAhead` 之后 |
| `serviceId` | 必须是这家店的、`active` 且 `online_bookable` 的 |
| 任何 `override` | **公开入口没有软约束放行**，撞上就是撞上 |

最后一条要特别说：前台可以带 `override` 理由超卖放行，
**公开 API 一个字都不许传**。放行的判断需要一个知道店里现在什么情况的人，
而公开入口那头没有这个人。

### 6.5 手机号短信验证（可选，默认关）

⬜ **这一步还没实现。** `requirePhoneVerification` 恒为 `false`，
官网现在不用管它 —— 但字段留着，将来打开时官网只要按下面加一步。

`shop.onlineBooking.requirePhoneVerification = true` 时，多一步：

```
POST /public/v1/verify/start   { phone, turnstileToken }  → { verifyId }
POST /public/v1/verify/check   { verifyId, code }         → { verifyToken }
POST /public/v1/bookings       { …, verifyToken }
```

**默认关着**，只给被恶意占位骚扰过的店开。原因是三条都不轻：
每条验证码要花钱、多一步会流失真客人、而且短信通道故障时预约页整个不能用
（宪法第 13 条：短信永远不进关键依赖链）。

**它是唯一能有效挡住「真人手工占位」的手段** —— 因为攻击者要为每一条假单
准备一个能收码的号码。所以它值得存在，但不该默认开。

### 6.6 恶意占位的第二道：未完成预约上限

同一个手机号在**未来**的未完成预约超过 3 条 → 拒绝，
`details.reason = "too_many_upcoming"`。

一家四口一起约不会撞上（那是**一条**预约的 4 个 item，不是 4 条预约）。
撞上的基本只有两种人：真的想占位的，和一个填错了一直重订的客人 ——
后者的正确出口也是打电话给店里。

### 6.7 内容与隐私边界

- `notes` ≤ 500 字符，**存原文、显示时转义**。前台看板上它是纯文本，
  永远不当 HTML 渲染
- 公开接口**永远不返回**：其他客人的任何信息、技师的手机号或全名
  （只给 `displayName`，通常是英文名）、营业额、客户名单
- **手机号查不出人**。没有任何公开接口接受「输个手机号看看我有没有预约」——
  那等于把客户名单挂在官网上。查预约只能凭 `manageToken`
- 确认邮件/短信由**我们**发，官网拿不到也不需要客人的联系方式做别的事

---

## 7. 错误码

所有错误的响应体是同一个形状：

```jsonc
{
  "code": "RESOURCE_CONFLICT",
  "messageKey": "error.RESOURCE_CONFLICT",
  "details": { "startsAt": "2026-09-03T10:30:00-04:00" },
  "overridable": false
}
```

**按 `code` 分支，不要按 HTTP 状态码分支**，更不要把 `messageKey`
直接显示给客人 —— 那是给我们前台界面查文案表用的。

| HTTP | `code` | 官网该怎么办 |
| :--- | :--- | :--- |
| 400 | `VALIDATION_FAILED` | 看 `details.reason`：<br>`bot_check_failed` → 重置 Turnstile 重试一次<br>`missing_idempotency_key` → 你忘了带那个头<br>`too_soon` / `date_out_of_window` → 换个时间<br>`too_many_upcoming` → 这个号未来的未完成预约满了，给店铺电话<br>⭐ `addon_not_bookable_alone` → 你把一个加项当主项目提交了。加项只能进 `addonIds`（§4.2） |
| 403 | `PERMISSION_DENIED` | 域名不在白名单，或这家店关了在线预约。**显示店铺电话** |
| 404 | `NOT_FOUND` | `public_key` 不对，或项目已下架 → 重拉 `/services` |
| 409 | `RESOURCE_CONFLICT` | ⭐ **被抢先订走了**。重拉 availability 让客人重选 |
| 409 | `LOCATION_OVER_CAPACITY` | 那个时段满了。同上处理 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一个 key 配了不同的 body。**换一个新 key** |
| 409 | `ALREADY_CANCELLED` | 取消一条已取消的。当成功处理，显示「已取消」 |
| 429 | `RATE_LIMITED` | 限频。显示 `details.retryAfterSec` 和店铺电话，**不要自动重试** |
| 5xx | `INTERNAL` | 显示「暂时无法预约，请致电 (617) 555-0142」。⭐ **一定要给电话** |

> 最后一行是这张表里最重要的一行。预约页挂掉的时候，
> 客人手上还有店铺电话就只是不方便；没有就是一单生意没了。
> **店铺电话应该在预约页上一直可见**，不只在报错时。

---

## 8. 客人订完之后发生什么（你不用实现，但要知道）

1. 我们验 Turnstile → 限频 → 白名单 → 蜜罐
2. 走**同一个** `appointment.create` 命令，`source = 'web'`
   —— 和前台手工建、AI 电话建的走同一条路，同一套容量检查、同一套审计
3. 前台看板上**实时**出现这一单，标着「网站」来源，可筛可撤
4. 确认邮件进 outbox，事务提交后才发（发出去了但事务回滚是最糟的组合）
5. 老板在开店配置里可以把某个项目取消勾选 `online_bookable`，
   官网下次拉 `/services` 就没有了 —— **不需要改官网代码**

⚠️ **确认信可能延迟几秒到几分钟。** 所以「预约成功」页要**当场显示确认码**，
不要写「请查收邮件确认」—— 客人会盯着收件箱刷新然后怀疑自己没订上。

---

## 9. 联调步骤

接口已经在跑，所以联调只剩三步：

1. 老板在门店系统里打开 **⚙ 开店配置 → 🌐 官网对接**：
   - 把「在线预约」打开（打不开的话是一个项目都没勾「可在线预约」，那一页会直说）
   - 复制那串 `pk_…` 给你
   - 把你的官网域名**和预览域名**都填进白名单
2. 你按 §5 把表单跑通：拉项目 → 拉空档 → 提交 → 拿到确认码
   → 前台看板上出现那一单，标着「网站」
3. 把 session 里那个 `bookingId` 发给我们，我们对一下审计流水

### ⭐ 唯一还没在真环境走过的一步

**带真 Turnstile token 的一次真请求。** 我们这边 30 项测试用的是替身
（不打网络），所以「Cloudflare 真的把 token 发过来、我们的 secret 验得过」
这一段只有你真提交一次才算数。**第一次提交成功 = 这一步通过。**

### 我们这一侧已经测到哪一步（2026-08-21，30 项）

| | 状态 |
| :--- | :--- |
| 同一个 `Idempotency-Key` 两次 → 只建一条，第二次 200 且不发新令牌 | ✅ |
| 没带幂等键 → 直接拒绝 | ✅ |
| 蜜罐填了内容 → 返回一个**形状一模一样**的 201，库里没有这条单 | ✅ |
| 三秒内交卷 → 同上 | ✅ |
| Turnstile token 用第二次 → 400 `bot_check_failed` | ✅ |
| 白名单外的域名 → 403，**且带 CORS 头** | ✅ |
| 订没勾「可在线预约」的项目 → 404（知道 id 也绕不回来） | ✅ |
| 官网传 `override` → 一个字都不生效，没有 overbooked 的 item | ✅ |
| 同一个 IP 连打 → 第六条 429 + `retryAfterSec` | ✅ |
| 同一个手机号 → 未来第四条 `too_many_upcoming` | ✅ |
| 同号不同名（母女共用一个号）→ **两个客户**，绝不自动合并 | ✅ |
| 同号同名第二次 → 复用同一个客户，不攒重复 | ✅ |
| 拿到 bookingId 但没有令牌 → 404，不确认这条单存不存在 | ✅ |
| 关掉在线预约后：建单 403，**但已订的客人还能取消** | ✅ |
| 拿这串公开 key 调需要登录的接口 → 一条都调不动 | ✅ |
| **带真签名的 Turnstile 走完整条链路** | ⬜ 等官网提交第一次 |

### 时区抽查（请你务必做一次）

**用一台设成 `America/Los_Angeles` 的机器**订波士顿的店，
页面上显示的时间必须是波士顿时间。这一条错得最安静 ——
本地开发永远发现不了，因为你的电脑和店在同一个时区。

## 10. 用现成的那张页面（最省事）

`apps/booking` 是一张做好的预约页 —— **默认黑白（Square Appointments 那一路）、
手机优先、深浅色自适应**，接的就是上面 §4 那几条接口。
**长什么样由 URL 参数决定**（§10.4），改一行 `src=` 就换一套。

它有两种活法，你挑一种：

```
① 嵌进你的页面（iframe）     客人不离开你的官网，背景透明，融进你的设计
② 跳过去（独立页）           一行 <a>，什么都不用写
```

两种都**不需要你写任何 JS 去调接口** —— Turnstile、蜜罐、幂等键、
时区、409 重拉空档，全在里面了。

### 10.1 你需要的两样东西

| | 从哪来 |
| :--- | :--- |
| **门店标识** `pk_…` | 老板在门店系统里 **⚙ 开店配置 → 🌐 官网对接**，点「复制这串标识」 |
| **页面地址** | `https://book.geniefront.com/`（生产）<br>本地开发 `http://localhost:5176/` |

⚠️ 那串 `pk_…` **不是密码**，它本来就要写进你的 HTML。别当密钥藏。

### 10.2 ② 跳过去 —— 一行

```html
<a href="https://book.geniefront.com/?k=pk_3f9a2b1c" class="your-button-class">
  立即预约
</a>
```

`?locale=zh-Hans` 可选，认不出会回退到门店默认语言。

### 10.3 ① 嵌进去 —— iframe + 一段自动调高

**iframe 不会跟着内容长高。** 不处理的话，客人滚到「填手机号」那一步
会发现底下的按钮被切掉了 —— 而这在你的页面上**完全看不出问题**
（是 iframe 内部在滚）。所以那段脚本不是可选的。

```html
<iframe id="gf-booking"
        src="https://book.geniefront.com/?k=pk_3f9a2b1c&embed=1"
        title="在线预约"
        style="width:100%;border:0;height:640px;display:block"
        loading="lazy"></iframe>

<script>
  (function () {
    var f = document.getElementById('gf-booking');
    window.addEventListener('message', function (e) {
      // ⚠️ 只认这个 iframe 发来的消息 —— 页面上别的第三方脚本也会 postMessage
      if (e.source !== f.contentWindow) return;
      if (!e.data || typeof e.data !== 'object') return;

      if (e.data.type === 'gf-booking:height') {
        f.style.height = e.data.height + 'px';
      }
      if (e.data.type === 'gf-booking:booked') {
        // 可选：埋个转化统计。e.data.confirmationCode 是客人拿到的确认码
      }
    });
  })();
</script>
```

`&embed=1` 做两件事：**背景透明**（交给你的页面）、**开始上报高度**。

#### 三条会让你少查半天的

- **给 iframe 一个不太矮的初始高度**（例子里是 640px）。太矮的话，
  高度消息到达之前客人看到的是一条缝
- **别给 iframe 设 `scrolling="no"`**。真有一帧高度没跟上时，
  能滚至少还能用；不能滚就是死的
- **`loading="lazy"` 只在预约区不在首屏时加**。在首屏加了反而慢一拍

### 10.4 ⭐ 换个样子：改 URL 就行

页面长什么样**全由 URL 参数决定**，改一行 `src=` 就换一套，不用改代码、
不用进老板后台、也不用等我们发版。

```
https://book.geniefront.com/?k=pk_3f9a2b1c&theme=mono&accent=1a56db&radius=0
```

| 参数 | 取值 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `theme` | `mono` \| `glass` | `mono` | `mono` = 黑白、发丝线、大量留白（Square Appointments 那一路）；`glass` = 毛玻璃 |
| `mode` | `light` \| `dark` | 跟随客人系统 | ⚠️ 一旦显式指定就**不再**跟着系统变 —— 你的页面是白的就写 `light` |
| `accent` | 六位或三位 hex（`1a56db` / `%23111`） | `mono` 用黑，`glass` 用品牌红 | 选中态、主按钮、焦点圈。**字色自动配**（亮底配深字、暗底配白字），不用你算 |
| `radius` | `0`–`28` | `mono` 12 / `glass` 28 | 圆角。`0` = 全直角 |
| `width` | `320`–`900` | `560` | 内容最大宽度（px） |
| `header` | `0` | 显示 | `header=0` 隐藏顶部的店名 —— 你的页面上方已经写着了，再来一遍是重复 |
| `density` | `compact` | `normal` | 紧凑：内边距和点击区都收一档 |
| `locale` | `en` / `zh-Hans` / … | 门店默认语言 | 认不出会安静回退 |
| `embed` | `1` | — | 背景透明 + 开始上报高度（见 §10.3） |

几个搭配：

```
# 你的官网是黑白极简的 —— 什么都不用传
?k=pk_…

# 你的官网是深色的，主色是那个蓝
?k=pk_…&embed=1&mode=dark&accent=1a56db&header=0

# 想要直角 + 窄栏
?k=pk_…&embed=1&radius=0&width=420

# 想要毛玻璃（页面本来就有质感的话更融）
?k=pk_…&embed=1&theme=glass
```

#### ⚠️ 认不出的值会**安静回退**，不报错

`radius=999` 会被夹到 28，`accent=红色` 会被忽略回到默认黑，
`theme=bogus` 就是 `mono`。不报错是有意的：报错也没人看，
而一个长得不对的按钮比一页错误信息容易发现得多。

**这也是一道安全边界** —— 这些值会变成 CSS 变量，
`accent=red;}body{display:none}` 这种东西原样插进去就是一次 CSS 注入。
所以每个参数都白名单校验过（`apps/booking/src/lib/theme.ts`）。

### 10.5 自己做 UI 的话

**先想清楚值不值** —— §10.4 那几个参数多半已经够你把它调成你的样子了，
而自己做要重新踩一遍 Turnstile 重试、幂等键、时区、409 重拉这几个坑。

真要自己做：回去读 §4–§7。`apps/booking/src/lib/api.ts` 是一份可以直接抄的客户端，
`screens/DetailsStep.tsx` 里那几处（Turnstile 重试要 reset、蜜罐、
`formElapsedMs`、TCPA 那个勾选框）都是踩过的坑，值得照着来。

---

## 11. 我们这边还欠的

按重要性：

1. ⬜ **手机验证码那一步**（§6.5）。默认关，不阻塞官网。
   它是唯一挡得住「真人手工占位」的手段，等真被骚扰了再开
2. ⬜ **加项目录**。库里分不出加项和项目（§0），要在 `services` 上补一列
   `is_addon`，拍照开店那条路（`blueprint.apply`）也要跟着填
3. ⬜ **`priceIsFrom`**（「$55 起」）。同样要在 `services` 上补一列 ——
   现在这个标记只活在拍照开店的草案里，落地时丢了
4. ⬜ **多语言的 `locales`**。`/shop` 现在只返回门店默认语言。
   项目名本来就是多语言 jsonb，接口按 `?locale=` 取 —— 缺的只是
   「这家店到底配了哪几种语言」这个事实，现在没有地方存
5. ⬜ **`appointment.reschedule`** 也还没有 handler（和 `cancel` 一样是
   只有契约没有实现）。前台的「改时间」按钮现在同样是 404 ——
   **这是公开预约之外的一个已存在的洞**，值得单独修

### 已经做完的（给下一个 session 省时间）

- `sql/0033_public_booking.sql`：public_key 加长（触发器保证熵）、
  `location_allowed_origins` 表 + RLS、appointments 的两列、
  `app_public_key()` 维度解析策略、online_booking 默认配置
- `packages/db/src/publicBooking.ts`：`withPublicKey()`，和设备令牌同一个套路
- `apps/api/src/public/`：`routes` / `publicAuth` / `turnstile` / `rateLimit`
  / `origin` / `bookingToken`
- `apps/api/src/handlers/appointment.ts`：web 客户的 find-or-create（宪法第 16 条）
  + **`appointment.cancel` 的实现**
- `apps/desk/src/screens/Settings.tsx`：「🌐 官网对接」页
- `apps/api/src/public.test.ts`：30 项

⚠️ **别把 `/public/*` 挂在 `/v1/commands/:name` 上。**
那条路的前提是「请求里有一个可信身份」，公开入口没有。
两者混在一起，早晚有人把一条本该要登录的命令暴露到公网上。

⚠️ **权限收窄在 `public/routes.ts` 里，不在权限表里。**
那个上下文确实有 `appointment.write`（不然建不出预约），但每一次
dispatch 的入参都是路由自己拼的。想扩大它的人，改的是
`public/publicAuth.ts` 文件头那段注释描述的边界 —— 先读那段。

---
