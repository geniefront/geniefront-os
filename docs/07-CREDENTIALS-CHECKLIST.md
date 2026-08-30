# 07 · 需要你提供的凭据与前置动作（Checklist）

> `06-EXTERNAL-SERVICES.md` 讲的是"系统依赖哪些服务"，这份讲的是"**你现在具体要去注册什么、办什么**"。
> 按阻塞程度排序。**最上面那 4 个不给，Phase 0 开不了工；其余都可以边写边补。**

---

## ⚠️ 交付方式

- **不要把密钥贴在聊天里。** 建 `geniefront-os/.env`（`.gitignore` 第一行就写 `.env`），把值填进去。
- 我只读 `.env` 来跑通连接，**不会把值打印出来、不会写进任何文档或提交**。
- **生产环境的 `SUPABASE_SERVICE_ROLE_KEY` 和 Stripe live key 不要放进 `.env`** —— 它们只进 GitHub Actions 的 Repository Secret（宪法第 5 条：service_role 不进应用运行时）。
- 任何需要输密码、绑卡、过实名认证的步骤**都得你自己在对方网站上操作**，我做不了也不该做。

---

## 🔴 A. 现在就要（Phase 0 的硬阻塞，共 4 项）

### A1 · Supabase — 整个状态层

1. 去 [supabase.com](https://supabase.com) 建立隔离环境：`geniefront-os-dev` / `geniefront-os-prod`；API 集成测试再用独立 test 项目或临时 branch
2. Region 选 **US East (N. Virginia)** 或 **US West** —— 客户在美国，别选新加坡
3. dev 用 Free plan 就够；**prod 必须上 Pro（$25/月）**，否则没有 PITR 和每日备份（`04` §10）

需要给我的（**先给 dev 的就能开工**）：

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbG...
DATABASE_URL=postgresql://app_user.xxxx:<APP_DB_PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
MIGRATION_DATABASE_URL=postgresql://postgres.xxxx:<数据库密码>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

> 两条连接都使用 **Transaction pooler**。`DATABASE_URL` 是受限 `app_user`，
> `MIGRATION_DATABASE_URL` 才是只供迁移使用的 `postgres`。

**外加 dev 项目的 service_role key**（跑迁移和灌种子数据要用）：

```bash
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...        # 或旧格式的 eyJ... JWT
```

⚠️ 两条硬规矩：
1. **只有 `packages/db` 的迁移与种子脚本能读它**，`apps/**` 里出现这个变量名 CI 直接失败。
   业务查询一旦走 service_role，RLS 被静默绕过——租户隔离测试会全部通过但毫无意义。
2. **给我的是 dev 项目那一把。生产那一把只进 GitHub Actions Secret**，不落任何 `.env`。
   `check-env.sh` 在 `NODE_ENV=production` 时看到它会直接报错。

#### A1b · Google 登录（sql/0047）⭐ 要你去点两个后台

代码这一侧**什么都不用配** —— `apps/api` 验的是 Supabase 的 JWKS，
会话是密码登的、magic link 登的还是 Google 登的，它一视同仁。
但下面这两步不做，前端那个「用 Google 登录」按钮点下去只会跳到一个报错页。

**① Google Cloud Console** → APIs & Services → Credentials →
Create Credentials → **OAuth client ID** → Web application

- Authorized JavaScript origins：前端每一个域名（含本地开发的 `http://localhost:5190`）
- Authorized redirect URIs：**填 Supabase 的回调，不是我们自己的域名**

  ```
  https://<你的项目>.supabase.co/auth/v1/callback
  ```

  ⚠️ 这一条最容易填错。填成 `https://app.geniefront.com/auth/callback`
  会得到 `redirect_uri_mismatch`，而 Google 的报错页不会告诉你该填什么。

拿到 **Client ID** 和 **Client Secret**。

**② Supabase 控制台**（dev 和 prod **两个项目都要**）：

- Authentication → Providers → **Google** → 打开，粘上面那两个值
- Authentication → URL Configuration → **Redirect URLs** 白名单里加上前端的落地页：

  ```
  http://localhost:5177/**              # 本地 desk（apps/web）
  https://desk.geniefront.com/**        # 生产 desk。不要填 .app
  ```

  ⭐ 这条白名单**同时管三样东西**的落地页，少一个就少一条能用的路：
  Google 登录回跳、激活邮件的 `/activate`、忘记密码的 `/reset-password`。
  上面那个 `/**` 通配一次覆盖掉，但如果你收紧成逐条列举，三条都要列。
  Marketing（`apps/marketing`）不接激活信，不必加进这条白名单。

  ⚠️ 不在白名单里的 `redirectTo`，Supabase 会**静默换成 Site URL** ——
  表现是「登录成功但跳回了首页，一直登不进后台」。

⚠️ **Client Secret 不要发给我，也不要进 `.env`。** 它只活在 Supabase 控制台里，
我们的服务器从头到尾不接触它。

---

### A2 · Anthropic API Key — AI 全部功能

1. [console.anthropic.com](https://console.anthropic.com) → 绑卡预充值
2. **建议先在 Limits 里设一个 $50/月的上限**，防止调试时写错循环烧钱

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

---

### A3 · 域名 + Cloudflare — 入口与发信

**这一项是前置动作，不只是密钥。**

1. 确认主域名（例：`geniefront.com`）。**如果还没买，这是现在就要定的事** —— 后面的发信域名、公开预约页、状态页全挂在它下面
2. 把域名 NS 指向 Cloudflare（免费套餐即可，LB 等生产双实例时再买）
3. 建 API Token：My Profile → API Tokens → Create Token，权限选
   - `Zone → DNS → Edit`
   - `Account → Cloudflare Pages → Edit`

```bash
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_ZONE_ID=...
```

---

### A4 · Resend — 邮件（Magic Link 登录靠它）

1. [resend.com](https://resend.com) 注册，Add Domain 用**子域**：`mail.你的域名`（别用主域，出问题不牵连主域声誉）
2. Resend 会给 3 条 DNS 记录（DKIM / SPF / DMARC）→ 在 Cloudflare 加上 → 等验证变绿

```bash
RESEND_API_KEY=re_...
FROM_EMAIL=noreply@mail.你的域名
```

> ⚠️ **这一项要提前做**，DNS 传播 + 域名声誉预热要时间。短信推迟到门店 ≥ 10 家了（`03` 决策 11），
> 所以 **Phase 0/1 阶段所有通知和登录都压在邮件上**，它挂了整个登录就挂了。

---

### A5 · 开发服务器 —— 1 台实例

你说开发给 1 台。我需要：

- SSH：`host` / `user` / 私钥（或你先装好 Docker，把 deploy key 加进去）
- 规格建议：**2 vCPU / 4GB RAM / 40GB SSD** 起步够用（应用无状态，数据都在 Supabase）
- 装好 Docker + Docker Compose

> 生产那 2 台**先不用开**，等 Phase 1a 快收尾时再开，省两个月机器钱。

---

## 🟡 B. Phase 1b 之前要有（约 6–10 周后）

| 项 | 用途 | 变量 |
|---|---|---|
| **Upstash Redis** | BullMQ 队列：邮件定时提醒、报表导出 | `UPSTASH_REDIS_URL`<br>`UPSTASH_REDIS_TOKEN` |

[upstash.com](https://upstash.com) 建一个 Redis 数据库，选和 Supabase 同区。免费额度对 10 家店足够。

---

## 🟢 C. Phase 2 之前要有（约 4–6 个月后）

| 项 | 用途 | 变量 | 注意 |
|---|---|---|---|
| **Telnyx** ⭐ | 号码 + 语音 + **AI Assistant 对话** + （Phase 2.5）短信 | `TELNYX_API_KEY`<br>`TELNYX_PUBLIC_KEY`<br>`TELNYX_PHONE_NUMBER`<br>`TELNYX_ASSISTANT_ID`<br>`TELNYX_MESSAGING_PROFILE_ID` | ⚠️ **`TELNYX_PUBLIC_KEY` 最容易漏**：它不是调 API 的，是**验证打进来的 webhook 是不是真的来自 Telnyx**（Ed25519）。没有它，任何人都能伪造一条"客人预约了明天三点"进复核队列（`09` §3） |
| ~~Twilio / Vapi~~ | 已否决 | —— | 语音回退路径**已作废**。⚠️ 但 **Twilio 的 10DLC 申请不要注销**，直到 Telnyx 批下来（`09` §1.1） |
| **Stripe** | 向门店收订阅费 | `STRIPE_SECRET_KEY`<br>`STRIPE_PUBLISHABLE_KEY`<br>`STRIPE_WEBHOOK_SECRET`<br>`STRIPE_PRICE_ESSENTIAL`<br>`STRIPE_PRICE_GROWTH` | ⚠️ **需要公司实体 + EIN 做业务认证**，见 D1。先用 test key 开发。Secret / webhook secret **只进 API**，不要进 `apps/marketing` |
| **Marketing origin** | 公开开户 Checkout 回跳 | `MARKETING_BASE_URL` | `https://www.geniefront.com`（本地 `http://localhost:5180`）。**不是** desk，也不是 `.app` |
| **Desk origin** | 激活信 / 重置密码落地 | `APP_BASE_URL` | `https://desk.geniefront.com`。Supabase Redirect URLs 白名单必须含 `/activate` 与 `/reset-password` |
| **Cloudflare Turnstile** | 公开预约页防刷 | `TURNSTILE_SITE_KEY`<br>`TURNSTILE_SECRET_KEY` | 免费，在 Cloudflare 控制台建 |
| **Google Maps**（可选） | 开店时自动填地址/营业时间 | `GOOGLE_MAPS_API_KEY` | Places API，记得限制 Referer |

**Stripe 里要建的产品**（我可以给你确切配置，你在后台点）：
- `essential` $99/月 · `growth` $199/月（**名字要和后台、代码 plan 枚举、DB check 约束三处一致**，迁移 0021）
- 预充值：**积分**与**语音分钟**两种独立商品，**绝不做成一个通用「额度」**
- ⚠️ 确切档位与额度以 `04` §4.1 为准，别在这里再记一份数字

---

## 🔵 D. 不是密钥，但只有你能办（越早越好）

### D1 · 公司实体 + EIN ⚠️

**Stripe 收款和 10DLC 短信都卡在这里。** 如果还没有 LLC / EIN，这是现在就该启动的事——注册要几周。

### D2 · 法务三件套（`03` §C 第 4 条：**必须 Phase 0 完成**）

- **ToS**：必须含免责条款——"系统为辅助工具，不构成税务/财务法定记录"
- **隐私政策**：CCPA/CPRA（加州客户的查询/删除权）
- **DPA**：门店是数据控制者，你是处理者

> 这三份不做，第一家真店上线你就在裸奔。找个懂 SaaS 的美国律师，或先用模板 + 律师审一遍。

### D3 · 10DLC（审核中）

- 状态：**审核中，不进任何依赖链**（`03` 决策 11）
- ⚠️ **2026-08-16 改走 Telnyx**（决策 28）。换 CSP = **在新供应商名下重新排队**，
  brand/campaign 是由 CSP 代提交到 TCR 的，不是把号码搬过去那么简单
- ⚠️ **Telnyx 批准之前不要注销 Twilio 那边正在审的申请**。并行几乎不花钱，
  而"两边都没有"是唯一会真正卡死 Phase 2.5 的状态
- 启动 Phase 2.5 之前，**先找 Telnyx 销售问批量 campaign 报价** ——
  1000 店的 campaign 月费是每月五位数的固定成本，可能反过来推翻定价（`04` §4.2、`09` §6）
- 完整步骤见 **[09-TELNYX.md](09-TELNYX.md) §7 线 B**

### D4 · 种子店

- ✅ 已蹲点一家按摩店
- 还需要 1–2 家业态不同的（nail / 足疗），拿到他们的**纸质轮牌板、手写小费分配表、价目表照片**

---

## ⛔ E. 不要给我的东西

- 你的 Supabase / Cloudflare / Stripe / Telnyx **账号密码**（我不登录，只用 API token）
- 银行卡号、EIN 原件、身份证件
- **生产环境**的 `SERVICE_ROLE_KEY`、Stripe live key（只进 CI Secret；dev 的那把放 `.env` 没问题）
- 真实门店的客户数据 —— 种子数据我用假的，真数据等 Phase 1a 上线时由门店自己录

---

## 📋 `.env.example`（我会在 Phase 0 建仓时生成这份）

```bash
# ── Phase 0 必需 ──────────────────────────────────
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=       # dev 项目的；只给迁移/种子脚本用，apps/** 不许读
DATABASE_URL=                    # 受限角色 app_user，transaction pooler
ANTHROPIC_API_KEY=
RESEND_API_KEY=
FROM_EMAIL=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_ZONE_ID=
APP_JWT_SECRET=                  # 我生成，用于 PIN/设备令牌的受限 JWT

# ── Phase 1b ─────────────────────────────────────
UPSTASH_REDIS_URL=
UPSTASH_REDIS_TOKEN=

# ── Phase 2 ──────────────────────────────────────
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
VAPI_API_KEY=
VAPI_PUBLIC_KEY=
STRIPE_SECRET_KEY=               # 只进 API，不要进 apps/marketing
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=           # 只给 POST /v1/stripe/webhook
STRIPE_PRICE_ESSENTIAL=
STRIPE_PRICE_GROWTH=
APP_BASE_URL=                    # https://desk.geniefront.com
MARKETING_BASE_URL=              # https://www.geniefront.com
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
GOOGLE_MAPS_API_KEY=

# ── Phase 3 ──────────────────────────────────────
BRIGHT_DATA_API_KEY=
```

---

## ✅ 最小开工集

只要这 5 样到位，我就能开 Phase 0：

- [ ] `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `DATABASE_URL`（dev 项目）
- [ ] `ANTHROPIC_API_KEY`
- [ ] 域名 + `CLOUDFLARE_API_TOKEN` / `ACCOUNT_ID` / `ZONE_ID`
- [ ] `RESEND_API_KEY` + `FROM_EMAIL`（发信域名 DNS 验证通过）
- [ ] 开发服务器 SSH（或先在本机跑，服务器晚几天也行）

**其中真正卡住不能动的只有前两项** —— Supabase 和 Anthropic。域名/邮件/服务器可以边写边补。


---

## E. Phase 2 新增（2026-08-16）

| 变量 | 用途 | 现状 |
|---|---|---|
| `STRIPE_SECRET_KEY` | 服务端调 Stripe | ✅ `sk_test_…` 已配 |
| `STRIPE_PUBLISHABLE_KEY` | 前端 Elements | ✅ `pk_test_…` 已配 |
| `STRIPE_WEBHOOK_SECRET` | ⭐ webhook 验签 | ⬜ 空。本地跑 `stripe listen --forward-to localhost:3000/v1/stripe/webhook` 会打印 `whsec_…` |
| `FORM_ENCRYPTION_KEY` | ⭐⭐ 健康表答案加密 | ✅ 已配（dev） |

### ⚠️ `FORM_ENCRYPTION_KEY` 是这个仓库里最不能丢的一把钥匙

健康表答案是**应用层加密**之后才进数据库的（`02` §5）——
RLS 挡的是应用里的越权，挡不住把整个库复制走的人。

**丢了这把钥匙 = 所有已签的健康表永久解不开。** 而健康表是出事时的唯一证据。

- 32 字节，hex 或 base64
- 生成：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **生产那一把只进 CI Secret**，并且要有独立于代码仓库的备份
- 换钥匙需要先用老钥匙全量解密再用新钥匙加密 —— 没有这一步就是数据丢失

### ⚠️ Stripe 用测试还是正式密钥

`sk_test_` 与 `sk_live_` 的区别不是「环境」，是**会不会真的扣钱**。
开发和测试**一律用 `sk_test_`**；正式那一把只进生产的 CI Secret，
而且在接线全部跑通、对过账之前不要放进任何本地文件。
