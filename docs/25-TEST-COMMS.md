# 25 · 测试通信：收件箱、固定验证码、发不出信怎么查

面向 local 与 staging。三件事：**capture 模式**（邮件短信不出网）、
**测试收件箱**（在运营台里看这些消息）、**固定手机验证码**（Twilio Verify 没有测试凭据）。

---

## 1. 为什么需要

测试账号看不到东西：`+1617555xxxx` 收不到短信；`qa-xxx@maildrop.cc` 虽然能收信，
但那是一个**公开的一次性收件箱**，任何知道地址的人都能读，不能用来核对真实内容。
结果是「客人收到的确认信长什么样、里面那条链接点不点得开」在上线前**从来没人真正看过一眼**，
E2E 也验不了任何一条带链接的流程。

`COMMUNICATION_DELIVERY_MODE=capture` 把「发出去」换成「留底」：
入队、渲染、分段、去重、重试计数照常，只有最后那一下不出网。
内容本来就整封存在 `email_outbox` / `sms_outbox` 里（`sql/0029` 的设计：写入时就渲染好），
所以**没有第二张表** —— 状态标成新的 `captured`（`sql/0082`）。

> ⭐ `captured` 不复用 `sent`。复用的话 staging 上「发信成功率」会是一个假的 100%，
> 真正的投递故障就藏在这个 100% 底下。

---

## 2. 配置

| 变量 | 值 | 说明 |
|---|---|---|
| `COMMUNICATION_DELIVERY_MODE` | `live`（默认）/ `capture` | 生产配 capture 会**拒绝启动** |
| `MAILPIT_URL` | `http://127.0.0.1:55324` | 可选。capture 的邮件顺带投一份进本机 Mailpit |
| `STAGING_OTP_CODE` | 4–8 位数字 | staging 固定验证码 |
| `STAGING_OTP_PHONES` | `+1617555*`（逗号分隔，`*` 是前缀） | 白名单，**没有默认值** |
| `CAPTURED_MESSAGE_RETAIN_DAYS` | 默认 `7` | 测试消息保留期 |
| `MAILSLURP_API_KEY` | `sk_...` | 可选。用于 local/staging 的 MailSlurp 测试收件箱与回调 |

现状：`.env.local` 与 `.env.staging` 都已配成 capture，固定验证码 `424242`，白名单 `+1617555*`；staging 已配置 `MAILSLURP_API_KEY`。
`.env.production` 一个都没有，`scripts/env-guard.sh production` 会拦住任何一个漏进去的。生产带 `MAILSLURP_API_KEY` 会**拒绝启动**。

**本机 Mailpit** 是 Supabase 本地栈自带的（`supabase/config.toml` 的 `[local_smtp]`）。
本仓库的端口整体后移，所以是 **55324**，不是 Supabase 默认的 54324：
<http://127.0.0.1:55324>。Supabase Auth 的本地激活/重置邮件本来就进这里。

---

## 3. 测试收件箱

运营台（`apps/platform`）左侧 **Test Inbox**。列表按时间倒序合并邮件与短信，
显示收件人、正文摘要、状态、错误；点开一行是整封正文（邮件含 HTML，在沙箱 iframe 里渲染）。
**链接被单独抽出来**了 —— 这一页最主要的用途就是点开激活链接、重置链接、健康表链接。

接口（受 `platform_operators` 保护，和其余运营台接口同一条路）：

```
GET /v1/platform/test-inbox?channel=email|sms&status=captured&search=<收件人/主题/正文>&limit=&offset=
GET /v1/platform/test-inbox/:channel/:id
```

E2E 用法：下单之后按收件人查出那封信，取 `items[0].links[0]` 打开。

⚠️ 信里有客人的邮箱、手机号和一次性链接。这些内容**不进普通应用日志** ——
要看内容只能从这一页或这条接口看。保留 7 天，由 `apps/api/src/ops/retention.ts` 每小时清一次，
清理函数只删 `captured`（真发出去的记录是「我们对客人说过什么」的凭据）。

---

## 4. 固定手机验证码

Twilio Verify **没有 Test Credentials 这条路**（不像 Programmable SMS），
验证码只会真的发到真手机上，于是「技师用手机号上机」在自动化里走不通。
所以在应用侧做了一个测试 provider：白名单里的号码用固定验证码。

三道锁，缺一不可：`GF_ENV` 不是 production、`STAGING_OTP_CODE` 显式配了且格式对、
号码命中 `STAGING_OTP_PHONES`。白名单之外的号码照常走 Twilio Verify。

生产侧两道防线：`scripts/env-guard.sh production` 在部署前拦，
`assertCommunicationSafety()` 在进程启动时拦（`apps/api/src/main.ts`）。

---

## 5. Supabase Auth 的激活/重置邮件（**不走我们的发件箱**）

注册激活信、密码重置信是 **Supabase Auth 自己发的**，不经过 `email_outbox`，
因此**不会出现在测试收件箱里**。这一条要单独配：

- **local**：什么都不用配，Supabase 本地栈直接投进 Mailpit（<http://127.0.0.1:55324>）。
- **staging**：在 staging 的 Supabase 项目里 → Authentication → Emails → SMTP Settings，
  填 Mailtrap **Sandbox** 的 SMTP（`sandbox.smtp.mailtrap.io:2525` + inbox 的用户名/密码）。
  这样激活信只会落进 Mailtrap 收件箱，不会真的发给任何人。
  ⚠️ 别填 Mailtrap 的 *Sending*（生产发信）凭据 —— 那个是真发。
- **production**：正常的发信域名 SMTP，不做任何捕获。

> 排查记录（2026-08-31）：配 Mailtrap 之前，staging 的 Supabase Auth
> **从来没有尝试发过任何一封邮件** —— 所有账号的 `confirmation_sent_at` /
> `recovery_sent_at` 全是 null，auth 日志里只有密码登录，一次 `/otp`、`/recover` 都没有。
> 也就是说「staging 收不到激活信」不是 SMTP 坏了，是这条路从没被走通过。
>
> Mailtrap Sandbox 配好之后已实测通过（见第 7 节）。顺带一提：接了自定义 SMTP 之后
> GoTrue 的发信限额从 `2/1h` 提到了 `30`（日志里那条
> `env GOTRUE_RATE_LIMIT_EMAIL_SENT changed` 就是它）——
> 之前那个 2 封/小时的默认值本身也够卡住一轮联调。

---

## 6. 发不出信的时候怎么查

```bash
pnpm diagnose:comms:staging
```

只读，一次看三段：配置、发件箱状态与 `last_error`、SES 账号与域名身份（含沙箱状态与
配置集事件目标）。三段的失败现象在门店那头
是同一个（客人没收到信），但原因完全不同：

| 现象 | 说明 |
|---|---|
| 表是空的 | 业务侧根本没入队，问题不在发信这条路上 |
| 行停在 `pending`，`last_error` 为空 | 没配 key，`flushEmails()` 第一行就 return 了 |
| 行是 `failed`，`last_error` 有 4xx | 地址不合法或域名没验证，重试多少次都一样 |
| 行是 `captured` | capture 模式，本来就没打算发出去 |

**2026-08-31 的一次实测**（staging）：`email_outbox` **一行都没有**，
`sms_outbox` 有 1 条 `sent`；Resend key 有效，`notify.` / `appointment.` / `mkt.` 三个域已验证。
也就是说当时「staging 收不到邮件」不是发信链路坏了 —— 业务邮件根本没产生过，
真正没收到的是 **Supabase Auth 的激活信**，那条路见上面第 5 节。


---

## 7. staging 现状（2026-08-31 部署后实测）

已经上线并验证过的：

- 迁移 0075–0082 全部应用到 staging（此前 staging 落后 8 个文件）。
- API 已部署（版本 `c3685a8-20260831154826`），健康检查通过；
  容器环境里 `GF_ENV=staging`、`COMMUNICATION_DELIVERY_MODE=capture`、
  `STAGING_OTP_CODE` / `STAGING_OTP_PHONES` 已就位，
  启动闸门没有拦（拦了就起不来，这本身就是一次验证）。
- 启动日志里有 `{"removed":0,"retainDays":7,"msg":"captured message retention"}` ——
  新的保留期清理在 staging 上真的跑起来了。
- `GET /v1/platform/session` 返回 `comms: { env: "staging", deliveryMode: "capture" }`。
- 实发两条 `sms.sendDirect`：两条都落成 **`captured`**、`provider_id = capture:…`，
  一条都没有出网到 Telnyx，`usage_events` 里也**没有**产生计费行；
  测试收件箱接口把它们连同抽出来的链接一起列了出来。

⚠️ 一个既有行为（不是这次改的）：`sms.sendDirect` 的 flush 是在同一个请求里
`void` 掉的，所以刚入队的那一条常常要等**下一次店内动作**才会被扫到 ——
第一条测试短信就是在发第二条时才变成 `captured` 的。补发机制本来就是这么设计的
（`sms/flush.ts` 的头注释），但在测试收件箱前面等的人要知道这一点。

### 运营账号

staging 原先 `platform_operators` **一行都没有**，任何人都打不开运营台。
现已按 seed 的口径建了一个：`ops@maildrop.cc` / `GenieDev!2026`，super_admin，
只存在于 staging。要再加人就照 `packages/db/src/seed.ts` 里那段写
（auth.users + auth.identities + users + platform_operators 四张表）。

⚠️ 手工往 `auth.identities` 写行时，`identity_data` 必须是 **jsonb 对象**。
用字符串参数拼 `::jsonb` 会存成一个 json **字符串**，GoTrue 登录时报
`Database error querying schema` —— 现象和密码错完全不同，很难猜。


---

## 8. 顺带修掉的一个权限口子（0083）

Supabase 的安全检查在 staging 上报出三个 `SECURITY DEFINER` 函数**匿名可调**
（`/rest/v1/rpc/<name>`，而 anon key 本来就在每个前端的包里）：
`gf_purge_command_idempotency`、`gf_assert_stripe_ids_single_org`、
`gf_billing_tenant_for_stripe_refs`。第一个会**删数据**。

根因是老写法只 `revoke ... from public`，而 Supabase 给 `public` schema 的新函数
设了默认权限，`anon` / `authenticated` 各自拿着一份**独立的** EXECUTE ——
收 PUBLIC 收不掉它们。`0074` / `0082` 已经是对的写法
（`revoke ... from public, anon, authenticated` + 显式 `grant ... to app_user`），
`0083` 把同样的写法补给这三个。

⚠️ `user_in_location(uuid)` 故意保留对 `authenticated` 的执行权：
Realtime 频道授权与 Storage 对象策略都在这个身份下调它（0011/0013/0014/0016），
收掉等于技师端实时频道和价目表照片一起失效。


---

## 9. 端到端验收记录（2026-08-31）

### 激活邮件 → Mailtrap Sandbox

按 `signup/activation.ts` 的口径调 `/auth/v1/otp`（`create_user: true`）给
`qa-activate-…@maildrop.cc`：HTTP 200，auth 日志出现
`user_confirmation_requested`，`auth.users.confirmation_sent_at` 第一次被写上
（GoTrue 只有在 mailer 没报错时才会写这一列，也就是 Mailtrap 收下了这封信）。
邮件长什么样要在 Mailtrap 的 inbox 里看 —— 那把凭据不在仓库里，脚本这边验不到。

### 业务邮件与短信 → 测试收件箱

在 staging 的「金足足疗」建了一位带邮箱的客户，然后下了一单
（`customer.saveProfile` → `appointment.create`）：

- `email_outbox` 与 `sms_outbox` 各多一行，**两行都是 `captured`**、
  `provider_id = capture:…` —— SES 和 Telnyx 都没被调用
- 运营台接口按收件人查得到，详情返回整封正文与 HTML
- `usage_events` 没有产生短信计费行

⚠️ 这封确认信的 `links` 是空的，这是**对的**：自助管理链接只发给公开预约
（官网下单那条路会带 `manageToken`），前台手工建的单没有那个令牌
（`handlers/appointment.ts` 里那段注释）。要验链接抽取，用公开预约那条路。
