# 11 · 官网 ↔ 系统 的对接契约

> **写给做官网的那个 AI。** 官网是独立仓库、独立部署，和这个系统之间
> **只有一个接触面：Stripe Checkout 的 metadata**。
>
> 这一份只讲那个接触面。读完就能开工，不需要读这个仓库的其它文档。

---

## 1. 分工：谁做什么

```
官网（你做）                          这个系统（已经在了）
─────────────────────────────        ─────────────────────────────
落地页 / 定价页 / 试算
建 Stripe Checkout Session  ──────►  Stripe
   （带 metadata，见 §3）
付款成功页「请查收邮件」                 ◄────── webhook（我们收）
                                     建 org + 门店 + 账单账户
                                     发激活邮件
                                     老板点链接 → 开店向导 → 开始用
```

### ⛔ 官网**不要**做的四件事

| 不要做 | 为什么 |
| :--- | :--- |
| **不要处理 Stripe webhook** | webhook 归我们收。两边都收必然出现「官网以为开好了、我们这边没开」，而钱已经收了 —— 那种投诉查起来极痛苦 |
| **不要建账号、不要收密码** | 身份由 Supabase Auth 管。官网收了密码就等于多一个泄露面，而且和真正的账号体系对不上 |
| **不要自己发「欢迎」邮件** | 激活邮件由我们发（里面带一次性登录链接）。官网再发一封，老板会拿着错的那封点进死链 |
| **不要显示「立即登录」按钮** | 付款那一刻账号还不存在。付款成功页只能说「**查收邮件**」（见 §5） |

---

## 2. 套餐与 Price id

| 套餐 | 月费 | 含 AI 积分 | 含 AI 语音 | 环境变量 |
| :--- | :--- | :--- | :--- | :--- |
| `essential` | $99 | 500 | 60 分钟 | `STRIPE_PRICE_ESSENTIAL` |
| `growth` | $199 | 1200 | 500 分钟 | `STRIPE_PRICE_GROWTH` |

⚠️ **名字必须是 `essential` / `growth`**，三处一致：Stripe 后台的产品名、
官网传的 metadata、我们数据库的 check 约束。
文档早期出现过的 `Starter` / `Pro` / 「AI 电话包 $69」**全部作废**，看到就是旧的。

> **销售话术里必须直说的一条**：Essential 的 60 分钟 ≈ **每天 1 通电话**，
> 是「尝鲜」不是「够用」。开店时问一句「一天大概接几通电话」，
> 超过 2 通就直接推 Growth —— 别让老板自己撞上账单。

---

## 3. ⭐ Checkout Session：必须带的 metadata

这是**整个对接的全部内容**。少一个字段，我们就建不出门店，而钱已经收了。

```js
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: process.env.STRIPE_PRICE_ESSENTIAL, quantity: 1 }],

  // ⭐ 必填。激活邮件发到这里，而**收到激活邮件的人就是这家店的老板**
  customer_email: form.email,

  success_url: 'https://geniefront.com/welcome?s={CHECKOUT_SESSION_ID}',
  cancel_url:  'https://geniefront.com/pricing',

  metadata: {
    gf_signup: '1',                       // ⭐ 没有这个我们会当成老客户续费
    gf_plan: 'essential',                 // essential | growth
    gf_shop_name: form.shopName,          // 店名，会显示在前台顶栏和确认邮件里
    gf_owner_email: form.email,           // ⭐ 必须和 customer_email 完全一致，见下
    gf_business_type: 'nail',             // nail | massage | foot_spa | lash | scalp
    gf_timezone: form.timezone,           // IANA，如 America/New_York
    gf_locale: 'zh-Hans',                 // en | zh-Hans | zh-Hant | ko | vi | es
    gf_phone: form.phone ?? '',           // 可选，店里对外的电话
  },

  subscription_data: { metadata: { gf_signup: '1' } },   // 续费事件也认得出来源
});
```

### 🔴 `gf_owner_email` 必须等于 `customer_email`

这是这份文档里**唯一一条安全要求**。

激活邮件发到哪个邮箱，**决定了谁能成为这家店的老板**。如果这两个字段可以不一致，
就存在「A 付钱、激活链接发给 B」这条路 —— 而 B 拿到的是一家已付费门店的完全控制权。

我们这边会**校验这两个值相等，不相等就拒绝开店并告警**。
所以官网不要给用户任何「换一个邮箱接收」的入口：付款邮箱就是老板邮箱。

### 字段校验（官网这边先挡一道）

| 字段 | 要求 | 挡不住会怎样 |
| :--- | :--- | :--- |
| `gf_shop_name` | 1–80 字符，非空 | 店名空着，前台顶栏是一片空白，老板以为没开通 |
| `gf_owner_email` | 合法邮箱，且 `=== customer_email` | 见上面那条 |
| `gf_business_type` | 五个值之一 | 认不出的话我们按 `nail` 建，项目模板会不对 |
| `gf_timezone` | IANA 时区名 | **时区错了整个日程表就是错的**。拿不准就让用户选，别猜 |
| `gf_locale` | 六个值之一 | 认不出按 `en`，老板会看到一屏英文 |

> `gf_timezone` 可以用 `Intl.DateTimeFormat().resolvedOptions().timeZone` 预填，
> 但**要让用户看见并能改** —— 用 VPN 的人拿到的是错的。

---

## 4. 我们收到之后做什么（你不用实现，但要知道）

1. 验签 → 按 `checkout.session.id` 去重（Stripe 会重投，**重投不能建出第二家店**）
2. 校验 `gf_owner_email === customer_email`
3. 建 `organization` + `location(status='setup')` + `billing_account` + 订阅记录
4. 给 `gf_owner_email` 发一封带一次性登录链接的激活邮件
5. 老板点链接 → 成为这家店的 owner → 进开店向导

**一般在付款后几秒内完成。** 慢的情况（Stripe 重投、我们这边短暂故障）
最长可能几分钟 —— 所以成功页不要写「立即」。

---

## 5. 付款成功页要写什么

```
✅ 付款成功

我们已经把开通链接发到 你的邮箱@example.com

请查收邮件并点击里面的链接来开通你的店铺。
几分钟还没收到？看一下垃圾邮件，或者联系 support@geniefront.com
```

⚠️ **不要写「立即登录」或给登录链接** —— 那一刻账号还不存在，
点进去只会看到登录页，然后用户开始怀疑自己是不是买错了。

⚠️ **不要用 `{CHECKOUT_SESSION_ID}` 去查询任何我们的接口**。
成功页是纯静态的，把 session id 放 URL 里只是方便客服排查。

---

## 6. 退款与取消

- **取消订阅**：走 Stripe 的 Customer Portal，我们从 webhook 收 `customer.subscription.deleted`
- **退款**：在 Stripe 后台操作。⚠️ **退款不会自动删除门店数据** ——
  这是有意的：门店的预约、客户、财务记录是他们的经营数据，删了不可逆
- 官网**不需要**做订阅管理界面。老板在系统里点「💳 订阅与余额」进 Customer Portal

---

## 7. 怎么测

1. Stripe 测试模式建一个 Checkout Session，metadata 按 §3 填全
2. 用 `4242 4242 4242 4242` 付款
3. 告诉我们那个 session id，我们查 webhook 有没有正确建出门店
4. **必测的两个负例**：
   - `gf_owner_email` 和 `customer_email` 故意填不一样 → 我们必须拒绝
   - 同一个 session 重投两次 → 只能建出**一家**店

### 我们这一侧已经测到哪一步（2026-08-18）

| | 状态 |
| :--- | :--- |
| 邮箱不一致 → 拒绝 + 告警，**一行都不写** | ✅ 已测（`apps/api/src/signup.test.ts`） |
| 同一个 session 建两次 → 只有一家店，第二次返回 `already` | ✅ 已测 |
| 时区/业态/语言认不出 → 回退到安全值 + 原值留档 | ✅ 已测 |
| 收到激活邮件的人 → 成为老板，拿到 owner 全部权限 | ✅ 已测 |
| 换个账号去认领同一家店 → 什么都拿不到 | ✅ 已测 |
| **带真签名的 Stripe 事件走完整条链路** | ⬜ 等官网建出第一个真 session |

⬜ 那一行要你配合：**按 §3 建一个测试模式的 Checkout Session、用
`4242 4242 4242 4242` 付掉，然后把 session id 发给我们。**
上面那些用例验的是「事件到了我们这边之后发生的事」，
而「Stripe 真的把带 `gf_signup` 的事件发过来、签名对得上」这一段，
只有真发一次才算数。

---

## 8. 需要的凭据

官网只需要 Stripe 的：

```
STRIPE_SECRET_KEY          # 建 Checkout Session
STRIPE_PRICE_ESSENTIAL     # price_xxx
STRIPE_PRICE_GROWTH        # price_xxx
```

⛔ **官网不需要也不应该拿到**：`STRIPE_WEBHOOK_SECRET`（webhook 归我们）、
任何 Supabase 的 key、任何我们数据库的连接串。
