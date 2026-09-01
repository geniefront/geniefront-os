# 26 · 外发消息：会发什么、卡在哪、控制台上要配什么

> 代码这一侧的事实源是 `apps/api/src/{links,email,sms,notify}` 的文件头注释。
> 本文只写**代码之外**的两件事：控制台上要手工配的东西，以及打开闸门的顺序。

---

## 1. 当前会发出去的四类

| 类别 | 渠道 | 品牌 | 条件 |
| :--- | :--- | :--- | :--- |
| 预约确认 | 短信 + 邮件 | 平台 GenieFront | 无条件 |
| 预约修改 | 短信 + 邮件 | 平台 | 无条件 |
| 预约取消 | 短信 + 邮件 | 平台 | 无条件 |
| 次日提醒 | 短信 + 邮件 | 平台 | 门店本地 18:00 之后 |
| 技师侧四条 | 短信 | 平台 | 无条件（属事务性通知） |

顾客侧的邮件与短信**恒为英语**，不跟随顾客档案，也不跟随操作员的界面语言。
店主的计费类邮件按 `organizations.default_locale`，默认英语。

## 2. 当前发不出去的，以及为什么

| 类别 | 卡在哪 | 怎么打开 |
| :--- | :--- | :--- |
| 营销四类（生日 / 节日 / 唤回 / 求评） | 门店 10DLC 未获批 | 运营台 → 10DLC 页面审批 |
| 营销**邮件**另有一道 | 门店专属发件域名未验证 | 见 §4 |
| 前台手打短信 | 门店 10DLC 未获批 | 同上 |

⚠️ 两道闸门都在代码里强制，不是「先别打开那个开关」。在未获批的品牌上发
商业性短信，运营商掐的是**整条通道** —— 届时连预约确认也一并发不出去。

---

## 3. Supabase Auth 的两封信 ⚠️ 不在仓库里

激活链接与忘记密码由 Supabase Auth 直接投递，**不经过 `email_outbox`**，
因此代码这一侧管得到的只有落点地址（`links.ts` 的 `activationRedirectUrl`
与 `resetRedirectUrl`，按环境分流）。**正文与语言完全由控制台上的模板决定。**

位置：**Supabase 控制台 → Authentication → Email Templates**。

### 3.1 Magic Link（激活信 —— 店主收到的第一封）

Subject：

```
Activate your GenieFront account
```

Body：

```html
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;color:#211e1b;max-width:520px">
  <p>Your GenieFront account is ready.</p>
  <p>Click below to activate it and open your dashboard. This link can only be used once.</p>
  <p style="margin:28px 0">
    <a href="{{ .ConfirmationURL }}"
       style="display:inline-block;background:#0f0f0f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600">
      Activate my account
    </a>
  </p>
  <p style="color:#6b635a;font-size:14px">
    If the button does not work, copy this link into your browser:<br>
    <span style="word-break:break-all">{{ .ConfirmationURL }}</span>
  </p>
  <p style="color:#6b635a;font-size:14px">
    If you did not sign up for GenieFront, you can ignore this email.
  </p>
  <p style="color:#6b635a;font-size:14px">— GenieFront</p>
</div>
```

### 3.2 Reset Password（忘记密码）

Subject：

```
Reset your GenieFront password
```

Body：

```html
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;color:#211e1b;max-width:520px">
  <p>We received a request to reset your GenieFront password.</p>
  <p style="margin:28px 0">
    <a href="{{ .ConfirmationURL }}"
       style="display:inline-block;background:#0f0f0f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600">
      Set a new password
    </a>
  </p>
  <p style="color:#6b635a;font-size:14px">
    If the button does not work, copy this link into your browser:<br>
    <span style="word-break:break-all">{{ .ConfirmationURL }}</span>
  </p>
  <p style="color:#6b635a;font-size:14px">
    <strong>Signed up with Google?</strong> You may not have a password —
    go back to the sign-in page and use the Google button instead.
  </p>
  <p style="color:#6b635a;font-size:14px">
    If you did not request this, you can ignore this email; your password will not change.
  </p>
  <p style="color:#6b635a;font-size:14px">— GenieFront</p>
</div>
```

> ⭐ 「Signed up with Google?」那一段不是客套话。用 Google 注册的店主没有密码，
> 点了忘记密码之后 Supabase **仍然会发信**，点进去能设一个密码 —— 这个行为是
> 对的，不用拦；但不写这一句，他会一直等一封自己其实不需要的信
> （`auth/passwordReset.ts` 文件头有同一段说明）。

### 3.3 ⚠️ 两条约束

1. **Redirect URLs 白名单要三套环境都加**：
   `http://127.0.0.1:5177/**`、`https://staging-desk.geniefront.com/**`、
   `https://desk.geniefront.com/**`。少加一个的表现是「点激活链接跳到
   `?error=redirect_to_not_allowed`」。
2. **不要再用 Resend 补发一封「欢迎」信。** 两封信里只有一封的链接是活的，
   店主会点错那封，然后以为系统坏了（docs/12 §2.2）。

---

## 4. 营销邮件的门店专属发件域名

一店一个子域：`promo@<label>.geniefront.com`。**信誉是按域名累积的** ——
共用一个子域的话，一家店的营销邮件被大量举报会拖垮其余全部门店的营销送达率。

事务性邮件**不走这条路**，仍用平台的 `FROM_EMAIL`，否则新店在 DNS 验证通过
之前连预约确认都发不了。

### 顺序

1. **建 domain**：Resend 控制台手建，或
   `pnpm --filter @gf/api marketing-domain create <运营user-id> <location-id> [label]`
2. **加 DNS**：Cloudflare 加 SPF / DKIM / DMARC 三条，**Proxy 一律关掉（DNS only）**
3. **启用**：运营台 → 门店页 → Outbound messaging → 「检查 Resend 并启用」

⚠️ 第 3 步核验的是**事实**：服务端会去问 Resend 该域名 `status` 是不是
`verified`，通过了才写 `locations.marketing_email_from`。面板上没有输入框让人
手填地址 —— 一个笔误的后果不是报错，是整批退信，而退信率同样计入信誉。

标签按门店 slug 推算（`oasis-spa-a1b2c3` → `oasisspa`）。两家同名门店会撞标签，
那时在面板里显式指定第二家用什么；**系统不自动加数字后缀**，`lotusspa2@…`
看起来就像仿冒。

---

## 5. Resend 的投递回调（退信 / 投诉回流）

不接的话，系统对一封信的下场一无所知：`email_outbox.status` 停在 `sent`，
而那只表示 Resend 收下了。于是一个早已不存在的邮箱每次预约都再退信一次，
一位点过「举报垃圾邮件」的顾客下个月照样收到营销邮件 —— 两者都扣信誉。

**Resend 控制台 → Webhooks → Add Endpoint**

| 项 | 值 |
| :--- | :--- |
| Endpoint URL | `https://api.geniefront.com/v1/webhooks/resend`（staging 换 `staging-api`） |
| 订阅事件 | `email.delivered`、`email.delivery_delayed`、`email.bounced`、`email.complained` |
| 签名密钥 | 复制 `whsec_…` 填进环境变量 `RESEND_WEBHOOK_SECRET` |

⚠️ **没配 `RESEND_WEBHOOK_SECRET` 时这条路由一律回 401**，不是放行。
一个不验签的公开写接口等于任何人都能把任意地址塞进抑制名单 —— 那是一个
「让某家店的顾客再也收不到确认信」的接口。

### 硬退与软退分开

| 事件 | 处理 |
| :--- | :--- |
| `bounce.type = Permanent` | 进抑制名单，**永久**不再发 |
| `email.complained` | 进抑制名单，**并且**关掉该地址的营销订阅 |
| `Transient` / `Undetermined` | **不进**抑制名单，只记 `delivery_state` |

软退也拦的话，一次对方服务器抖动就会让这个顾客永远收不到预约确认。

---

## 6. 定时任务一览

| 任务 | 间隔 | 环境变量 | 作用 |
| :--- | :--- | :--- | :--- |
| `startReminderJob` | 30 min | `APPOINTMENT_REMINDER_HOUR`（默认 18） | 次日预约提醒 |
| `startMarketingJob` | 60 min | `MARKETING_SEND_HOUR`（默认 10）、`MARKETING_WINBACK_DAYS`（90）、`MARKETING_REVIEW_DELAY_HOURS`（3） | 营销四事件 |
| `startOutboxSweepJob` | 2 min | `OUTBOX_SWEEP_MIN_AGE_SEC`（120） | 兜底投递 |
| `startRetentionJob` | 60 min | — | 保留期清理 |

⚠️ 兜底投递这一条不能省。投递本来只由业务动作触发，而 Stripe webhook 写进来的
三封计费信不经过任何业务动作 —— 更糟的是**扣款失败的门店被冻结成只读，
开不了单，也就永远触发不了那个触发点**。最需要收到「你的卡扣不上了」的店，
恰恰是唯一收不到的那家。

---

## 7. 还没做的

| 项 | 说明 |
| :--- | :--- |
| 自助改期页 `/b/:id` | 后端与链接构造就绪，缺前端页面。上线后置 `BOOKING_MANAGE_PAGE_ENABLED=1`。计划做成类似托管预约页的形态，上线之后再说 |
| 短信侧的投递回执 | Telnyx 的 DLR 回调没接，短信只有「交出去了」没有「送达了」。邮件侧这一半见 §5 |

---

## 8. 店主自己在哪配

**设置 → Smart Comms → 顾客通知与营销**（`apps/web` 的 `notifications` tab）。

这一页给出三样东西：

1. **12 个事件的开关**，按顾客 / 技师 / 营销分三组，每组注明它走哪个品牌；
2. **文案编辑器**，只编辑英语那一版（顾客侧恒为英语）。保存是**新增一个
   版本**而不是原地改 —— 队列里可能还有引用旧版本的消息，那些必须按当初
   的措辞发出去；
3. **节日日程**，同一天只能有一个。

⚠️ 页面顶部固定显示**两道闸门的当前状态**，每个被拦住的开关旁边也直接写出
原因。这不是装饰：这一页最容易产生的误解是「我把开关打开了，顾客就会收到」，
而闸门不通时一条也发不出去，**且不会报错**。只给开关不给闸门状态的话，
店主打开之后唯一能得到的反馈是「什么也没发生」。
