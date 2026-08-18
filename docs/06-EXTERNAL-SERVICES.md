# 06 · 外部依赖与 API 准备清单 (External Services & Keys)

> 本文档汇总系统在各阶段（Phase 0 ~ Phase 3）依赖的全部第三方 API、账号与密钥。
> 建议在进入各阶段开发前提前完成账号注册与审核，特别是涉及企业资质审核的模块（Telnyx 10DLC、Stripe）。
>
> **2026-08-18**：AI 语音与短信全部走 Telnyx，已实测打通。Twilio + Vapi 方案已否决。
> 完整方案、迁移顺序与下一步任务清单见 **[09-TELNYX.md](09-TELNYX.md)**。
> 架构上下文见 `01-ARCHITECTURE.md` §0：**状态托管、应用无状态**。

---

## 1. 优先级 1：核心骨架与 AI 必须项（Phase 0 & 1a 强依赖）

| 服务 | 用途 | 密钥 / 配置项 | 备注 |
| :--- | :--- | :--- | :--- |
| **Supabase** | **整个状态层**：托管 Postgres 16（业务数据 + 强制 RLS）、Auth（邮箱 Magic Link / 密码）、Realtime（`location:{id}` 广播）、Storage（电子签名、指甲照片、价目表原图） | `SUPABASE_URL`<br>`SUPABASE_ANON_KEY`<br>`SUPABASE_SERVICE_ROLE_KEY`<br>`DATABASE_URL`（受限角色 `app_user`） | ⚠️ **`SERVICE_ROLE_KEY` 与 `postgres` 凭据只放在迁移 CI 的 secret 里，不进应用运行时环境变量**（`01` §4）。应用连库一律用 `app_user` + 事务内 `SET LOCAL`。需要 dev / prod 两个项目 |
| **Cloudflare** | DNS、TLS、WAF、**Pages**（desk / staff / kiosk 静态构建产物）；生产环境的 **Load Balancing + `/health` 健康探针** | `CLOUDFLARE_API_TOKEN`<br>`CLOUDFLARE_ZONE_ID` | Load Balancing 是**单独付费订阅**（约 $5/月起），只在生产双实例时需要 |
| **应用主机** | 跑 Fastify Docker 镜像。**生产 2 台实例，开发 1 台** | SSH / 部署密钥 | 无状态，实例之间不需要任何通信（实时扇出在 Supabase 侧） |
| **Anthropic API** | 规则 JSON 生成、价目表视觉提取、前台自然语言副驾、多语言翻译 | `ANTHROPIC_API_KEY` | 需绑卡预充值。模型 ID 用 **`claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`**，不带日期后缀。视觉提取必须用有视觉能力的 Opus 5 / Sonnet 5（`05` §5、§7） |
| **Resend / SendGrid** | 开店邀请邮件、Magic Link 无密码登录、短信上线前的预约确认通知 | `RESEND_API_KEY`<br>`FROM_EMAIL` | **关键前置**：必须在 Cloudflare 处配置好发信域名的 DKIM / SPF / DMARC 记录，否则进垃圾箱 |

---

## 2. 优先级 2：队列与电话（Phase 1b / Phase 2 依赖）

| 服务 | 用途 | 密钥 / 配置项 | 备注 |
| :--- | :--- | :--- | :--- |
| **Upstash Redis** | BullMQ 队列底座：邮件定时提醒、异步报表导出、评价抓取 Cron、死信管理 | `UPSTASH_REDIS_URL`<br>`UPSTASH_REDIS_TOKEN` | **Phase 1a 不引入** —— 没有定时任务之前队列是纯负债。托管 Redis，不自建主从 |
| **Telnyx** ⭐ | 门店对外号码 + 语音信道 + **AI Assistant 对话编排** + （Phase 2.5）短信 | `TELNYX_API_KEY`<br>`TELNYX_PUBLIC_KEY`<br>`TELNYX_PHONE_NUMBER`<br>`TELNYX_ASSISTANT_ID` | 一家把「号码 + 语音 + AI 编排」三层都自己出。⚠️ `TELNYX_PUBLIC_KEY` 是 **webhook Ed25519 验签**用的，不是调 API 的（`09` §3） |
| ~~Twilio / Vapi~~ | 已否决 | —— | 语音回退路径**已作废**（Telnyx 实测通过）。⚠️ 但 **Twilio 那边正在审的 10DLC 申请不要注销**，直到 Telnyx 批下来 —— 这是短信侧的事，与语音无关（`09` §1.1） |

---

## 3. 优先级 3：商业化与生产保护（上线接客前）

| 服务 | 用途 | 密钥 / 配置项 | 备注 |
| :--- | :--- | :--- | :--- |
| **Cloudflare Turnstile** | 公开预约页面的防刷单 / 防机器人 | `TURNSTILE_SITE_KEY`<br>`TURNSTILE_SECRET_KEY` | 免费，体验优于 reCAPTCHA |
| **Stripe** | B2B SaaS 收费：门店月费（`essential` $99 / `growth` $199）+ 预充值（积分 / 语音分钟两种，**不可互换**） | `STRIPE_PUBLIC_KEY`<br>`STRIPE_SECRET_KEY`<br>`STRIPE_WEBHOOK_SECRET` | 需完成业务主体认证。**一个 org = 一个 Customer，每家店一个 subscription item**（`02` §1）。副驾额度与电话分钟是**两个独立的计量项**，不能合并成一个"额度" |
| **Google Maps API**<br>*(可选)* | 创建门店时输入名称即自动填入地址、营业时间 | `GOOGLE_MAPS_API_KEY`（Places API） | 需在 GCP 开启并限制 HTTP Referer |
| **Yelp Fusion API**<br>*(Phase 2)* | ⭐ **开店一键填充**：店名 + 邮编搜到店，自动带出地址/电话/营业时间/评分。同一个 key 还提供权威的 `rating` / `review_count` | `YELP_CLIENT_ID`<br>`YELP_API_KEY` | ⚠️ `/reviews` 端点**只返回 3 条、正文截断到约 160 字**，做不了完整口碑分析 —— 那部分靠 Bright Data（`05` §8） |
| **Bright Data**<br>*(Phase 3)* | 抓取 **Google**（以及需要时的 Yelp）完整评价正文，Top 50 | `BRIGHT_DATA_API_KEY` | 配合 BullMQ Cron 每日抓取，增量对比后才调用 LLM |

---

## 4. Phase 2.5：短信（**门店数 ≥ 10 且 10DLC 批准后才启动**）⚠️

短信是**独立专项期**，不进任何依赖链（`03` 决策 11）。**换到 Telnyx 不改变这一条。**

| 事项 | 说明 |
| :--- | :--- |
| **10DLC 注册** | 在 **Telnyx** 名下注册 brand + campaign，需公司 EIN 与资质。⚠️ **换 CSP 要重新排队** —— brand/campaign 是由 CSP 代提交到 TCR 的，换供应商不是搬号码那么简单（`09` §1.1） |
| **⚠️ 过渡期纪律** | **Telnyx 批准之前不要注销 Twilio 那边正在审的申请。** 并行的成本几乎为零，而「两边都没有」是唯一会真正卡死 Phase 2.5 的状态 |
| **⚠️ 规模化固定成本** | 每家店一个 campaign 的月费 × 1000 店 = 每月五位数的固定成本。**启动前必须先找 Telnyx 销售确认批量报价**，这可能反过来推翻定价档位（`04` §4.2、`09` §6） |
| 附带解锁 | 手机号 OTP 登录（可用 Telnyx Verify API） |
| 合规 | TCPA：同意记录、STOP / HELP 处理、时区静默时段拦截。**与供应商无关，是法律要求** |

---

## 💡 开发初期快速启动检查单 (Checklist)

跑通 `Phase 0` 和 `Phase 1a` 的极简闭环，只需要这几个 Key：

- [ ] `SUPABASE_URL` & `SUPABASE_ANON_KEY`（dev 项目）
- [ ] `DATABASE_URL`（受限角色 `app_user`，用于命令总线连库）
- [ ] `ANTHROPIC_API_KEY`
- [ ] `RESEND_API_KEY` + 发信域名 DKIM/SPF/DMARC 配置完成

**Phase 1a / 1b / 1c 都不需要**：Redis（1b 才接）、Telnyx、Stripe、Turnstile、Bright Data。
