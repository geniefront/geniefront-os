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

部署 desk / api / marketing **不会**改这些模板。它们活在 GoTrue 项目配置里，必须用
`scripts/push-auth-email-templates.mjs` 显式 PATCH。

### 3.1 五封 Auth 信

事实源是仓库里的 HTML，不要在控制台里手改后再和仓库分叉：

| 类型 | 文件 | 主题 |
| --- | --- | --- |
| Magic Link | `supabase/templates/magic_link.html` | Sign in to GenieFront |
| Recovery | `supabase/templates/recovery.html` | Reset your GenieFront password |
| Confirmation | `supabase/templates/confirmation.html` | Confirm your GenieFront email |
| Invite | `supabase/templates/invite.html` | You are invited to GenieFront |
| Email change | `supabase/templates/email_change.html` | Confirm your new GenieFront email |

推到托管项目：

```
SUPABASE_ACCESS_TOKEN=sbp_… PROJECT_REF=yfqybhuvzluvrapodahw \
  node scripts/push-auth-email-templates.mjs
```

本地 `supabase start` 走 `config.toml` 的 `auth.email.template.*`。
仓库 HTML 里 logo 写 `{{ .SiteURL }}/brand/geniefront-logo-email.png`；
push 脚本会改写成营销站绝对地址（staging.geniefront.com / www.geniefront.com），
避免 desk 没部署 PNG 时收件箱破图。Site URL 必须是 desk 域名
（staging-desk / desk），不能是 localhost。

Recovery 保留「Signed up with Google?」那段（见 `auth/passwordReset.ts`）。

> ⭐ 「Signed up with Google?」那一段不是客套话。用 Google 注册的店主没有密码，
> 点了忘记密码之后 Supabase **仍然会发信**，点进去能设一个密码 —— 这个行为是
> 对的，不用拦；但不写这一句，他会一直等一封自己其实不需要的信
> （`auth/passwordReset.ts` 文件头有同一段说明）。

### 3.3 ⚠️ 两条约束

1. **Redirect URLs 白名单要三套环境都加**，**Site URL 不要留 localhost**：
   `http://127.0.0.1:5177/**`、`https://staging-desk.geniefront.com/**`、
   `https://desk.geniefront.com/**`。
   不在白名单里的 `redirect_to` 会被**静默换成 Site URL**。Site URL 若是
   `http://127.0.0.1:5177`，staging 发出的「Your sign-in link」里就是 localhost。
2. **不要再用 SES 补发一封「欢迎」信。** 两封信里只有一封的链接是活的，
   店主会点错那封，然后以为系统坏了（docs/12 §2.2）。

---

## 4. 三个发件域名

| 类别 | 发件地址 | 环境变量 | 覆盖的 `kind` |
| :--- | :--- | :--- | :--- |
| 店家事务 | `noreply@notify.geniefront.com` | `FROM_EMAIL` | `platform_notice`、`trial_ending`、`payment_failed`、`subscription_canceled` |
| 客户事务 | `noreply@appointment.geniefront.com` | `CUSTOMER_FROM_EMAIL` | `appointment_confirm`、`appointment_changed`、`appointment_reminder`、`receipt`、`form_invite` |
| 客户营销 | `<门店标签>@mkt.geniefront.com` | `MARKETING_EMAIL_DOMAIN` + 逐店写在 `locations.marketing_email_from` | 走 `from_email` 列，优先于按 `kind` 的推断 |

⚠️ 划分依据是**信誉隔离**，不是美观。三类邮件的投诉率与退信率差异极大，而
发信信誉按域名累积：混用一个域时，一家店的营销投诉会直接拉低所有门店预约确认
邮件的送达率 —— 而那件事**不会有任何人来投诉**，只表现为到店率下降。

映射表在 `apps/api/src/email/send.ts` 的 `CUSTOMER_FACING_KINDS`。⚠️ 未登记的
`kind` 默认按**店家事务**处理：漏登记一种店家通知只是域名不够贴切，而漏登记后
默认走顾客域则是把店家邮件计入顾客域信誉，属于静默污染。

⚠️ `CUSTOMER_FROM_EMAIL` 缺省时**回落到 `FROM_EMAIL`**，不拒发 —— 拆分是送达率
优化，不该成为发信能力的前置条件。代价是漏配时信誉隔离静默失效，
`pnpm diagnose:comms:*` 会把这一项打出来。

### 4.1 ⚠️ 营销侧：门店之间共享信誉

`mkt.geniefront.com` 是**所有门店共用的一个域**，门店身份来自本地部分
（`spasite1@`、`lotusnails@`…）。也就是说：

- ✅ 营销与事务性邮件之间是隔离的 —— 这是这套划分真正要保护的东西
- ⚠️ **门店之间的营销信誉是共享的** —— 一家店的名单质量差会影响其余门店的
  营销送达率，而各店对彼此的名单既无从知晓也无从干预

这是 2026-09-02 定的取舍：换来的是**营销开通不再需要任何 DNS 操作**。上一版
每店一个子域（`promo@<label>.geniefront.com`），要「建域名 → 人工加三条 DKIM →
等传播 → 核验」四步，每开一家店都要人介入一次。

该判断可逆：真出现某家店拖累整体时，把它单独挪到自己的子域即可 ——
`marketing_email_from` 存的是**完整地址**而非标签，因此挪一家店不影响其余。

### 4.2 给一家店开通营销

```
1. 确认 mkt.geniefront.com 在当前供应商处 verified（核验事实，不是声明）
2. 把 <label>@mkt.geniefront.com 写进 locations.marketing_email_from
```

运营台：门店页 → Outbound messaging → 「检查并启用」。或者 CLI：

```bash
pnpm --filter @gf/api marketing-domain status
pnpm --filter @gf/api marketing-domain enable <运营user-id> <location-id> [label]
```

⚠️ 第 1 步不能省，且**每次启用都重新查一遍**，不吃缓存。域名在供应商侧被停用
（欠费、投诉率超标、密钥换了账号）时**不会有任何通知** —— 表现是整批营销邮件
退信，而退信率同样计入信誉。

标签按门店 slug 推算（`oasis-spa-a1b2c3` → `oasisspa`）。两家同名门店会撞标签，
那时显式指定第二家用什么；**系统不自动加数字后缀**，`lotusspa2@…` 看起来就像仿冒。

---

## 5. 供应商与投递回调

### 5.1 当前是 Resend，SES 待命

```
EMAIL_PROVIDER=resend   # 默认，当前生产在用
EMAIL_PROVIDER=ses      # SES 脱离沙箱后改这一行，不需要改代码
```

SES 账号目前**仍在沙箱**（`ProductionAccessEnabled = false`，200 封/天、
1 封/秒）：只有已在 SES 验证过的收件地址能收到邮件，发往其余地址一律
`MessageRejected`。所以发信走 Resend，SES 的整套实现（`@gf/aws` + `snsWebhook.ts`）
保留待用。

⚠️ 这个值**打错字时回退到 `resend`**，不是报错。最坏情况必须是「继续用当前能真正
送达的那一家」，而不是「切进沙箱后所有邮件被静默拒收」。

#### ⚠️ 切换时必须一起动的三样东西

换 `EMAIL_PROVIDER` 不只是换一个发信通道：

| 要动的 | 不动的后果 |
| :--- | :--- |
| **发件域名要在新供应商那边验证过** | 三个域当前只在 Resend 验证；SES 侧验的是另外三个（`mail.` / `app.` / 根域），DKIM 记录不同 —— 直接切会让每一封都被拒 |
| **投递回调换路由** | Resend 走 `/v1/webhooks/resend`，SES 走 `/v1/webhooks/ses`（还要配置集 + 事件目标）。漏配的表现是退信与投诉**静默停止回流**，而发信一切正常 |
| **历史 `provider_id` 不通用** | 发件箱里已有的行记的是旧供应商的消息 id，新供应商的回调永远匹配不上。这不是错误，但切换当天「送达率」会断崖 —— 那是口径变化，不是投递故障 |

切换前后各跑一次 `pnpm diagnose:comms:*`，它按当前 provider 体检对应那一侧。

### 5.2 两条回调路由**始终都注册**

不按 `EMAIL_PROVIDER` 只注册一条 —— 切换供应商之后，旧供应商仍会为切换前发出的
邮件投递回调（退信可能晚几小时到几天），摘掉旧路由等于把那批退信丢掉，
**而丢掉的正是最该进抑制名单的地址**。

两条各自靠自己的凭据把关，没配就一律 401：

| 路由 | 验签方式 | 凭据 | 没配时 |
| :--- | :--- | :--- | :--- |
| `POST /v1/webhooks/resend` | Svix，共享密钥 HMAC | `RESEND_WEBHOOK_SECRET` | 401 |
| `POST /v1/webhooks/ses` | SNS，X.509 非对称签名 | `SES_SNS_TOPIC_ARN`（校验来源，不是密钥） | 401 |

⚠️ **401 而不是 200**：这两条路由都会往抑制名单里写东西，也就是具备「让某个地址
再也收不到我们的邮件」的能力。一个不验签的公开写接口等于把该能力对外开放。

#### Resend 侧的一次性配置

Resend 控制台 → Webhooks → Add Endpoint：

| 项 | 值 |
| :--- | :--- |
| Endpoint URL | `https://api.geniefront.com/v1/webhooks/resend`（staging 换 `staging-api`） |
| 订阅事件 | `email.delivered`、`email.delivery_delayed`、`email.bounced`、`email.complained` |
| 签名密钥 | 复制 `whsec_…` 填进 `RESEND_WEBHOOK_SECRET` |

#### SES 侧的一次性配置（脱离沙箱后再做）

⚠️ SES 与 Resend 在这里有本质差别：**Resend 默认对所有邮件发回调，SES 不是。**
SES 只有**绑定了配置集、且该配置集配置了事件目标**的邮件才会产生投递事件。
缺任一环节时 `/v1/webhooks/ses` 一条请求都收不到，而现象与「一切正常」完全相同。

1. 建 SNS 主题，例如 `geniefront-ses-events`
2. 给该主题加 HTTPS 订阅，端点 `https://api.geniefront.com/v1/webhooks/ses`。
   ⚠️ 订阅确认由本服务自动完成 —— 它会校验签名与 `TopicArn` 之后才访问
   `SubscribeURL`
3. 建配置集（`SES_CONFIGURATION_SET`），加一个事件目标指向该主题，
   勾选 **Delivery、Bounce、Complaint、DeliveryDelay、Reject**
4. 把主题 ARN 填进 `SES_SNS_TOPIC_ARN`
5. ⚠️ **每一个域名身份都要绑上这个配置集**

SNS 的三个必须校验的点（`snsWebhook.ts` 已实现）：

| 校验 | 不做的后果 |
| :--- | :--- |
| `SigningCertURL` 主机名必须是 `sns.<区域>.amazonaws.com` | 攻击者指向自己的证书、用自己的私钥签名，验签必然通过 —— 形同虚设 |
| 待签串字段集合与顺序按消息类型走 | 线上全部验签失败（SES 的通知**不带 `Subject`**，多拼一个字段就全错） |
| `TopicArn` 必须等于 `SES_SNS_TOPIC_ARN` | 证书只能证明「这是合法的 SNS 消息」，不能证明「是发给我们的」 |

⚠️ SNS 投递时的 `Content-Type` 是 `text/plain`，正文却是 JSON。`rawBody.ts` 为此
单独注册了 `text/plain` 解析器；漏掉的话每条回调在进路由之前就被拒为 415，
而本地用 curl 测（通常带 `application/json`）复现不出来。

### 5.3 硬退与软退分开

| 事件 | 处理 |
| :--- | :--- |
| `Bounce` + `bounceType = Permanent` | 进抑制名单，**永久**不再发 |
| `Complaint` | 进抑制名单，**并且**关掉该地址的营销订阅 |
| `Transient` / `Undetermined` | **不进**抑制名单，只记 `delivery_state` |
| `Reject` / `RenderingFailure` | 记软退，**不抑制收件人** —— 问题在我方内容，不在地址 |

软退也拦的话，一次对方服务器抖动就会让这个顾客永远收不到预约确认。

⚠️ 抑制的对象取 `bouncedRecipients` / `complainedRecipients`，**不是**
`mail.destination`。两者不一致时按 destination 抑制会误伤未退信的地址，
而这种误伤是静默的。

---

## 6. SES 脱离沙箱的申请

AWS 控制台 → SES → Account dashboard → Request production access。
批下来之前 `EMAIL_PROVIDER` 不要改成 `ses`。

`pnpm diagnose:comms:*` 在 provider 为 `ses` 时会把沙箱状态显式打出来。

---

## 7. 定时任务一览

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

## 8. 还没做的

| 项 | 说明 |
| :--- | :--- |
| 自助改期页 `/l/{slug}#g/{token}` | 前端与 API 已就绪。令牌在 fragment 里，不进 Caddy/Cloudflare 访问日志。新短信/邮件里的 `manage_url` 仍由 `BOOKING_MANAGE_PAGE_ENABLED` 控制；生产路由验证前保持关闭。 |
| 短信侧的投递回执 | Telnyx 的 DLR 回调没接，短信只有「交出去了」没有「送达了」。邮件侧这一半见 §5 |

---

## 9. 店主自己在哪配

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
