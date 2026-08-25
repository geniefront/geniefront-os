# 10 · 交接：Phase 2 剩下的活

> **写给下一个 session 的 AI。** 2026-08-16 交接（Stripe 接线 + 前台副驾那一轮更新）。
>
> 先读这一份，再按 §3 挑一件开工。
> 动手前必读 **`03` §A 已定决策 + §D 项目宪法**，那 19 条是这个仓库的物理法则。

---

## 1. 三十秒看懂现在在哪

```bash
cd <仓库根>                  # 本文档在仓库的 docs/ 下
cp .env.example .env        # ⚠️ 真实凭据不在仓库里，见 07-CREDENTIALS-CHECKLIST.md
bash scripts/check-env.sh   # 凭据格式 + 实测联通
pnpm db:migrate             # ⚠️ 0019–0024 都是新的，不跑的话计费整条起不来
pnpm verify                 # 宪法检查 + typecheck + 547 项测试，应当全绿
```

| | 状态 |
|---|---|
| Phase 0 / 1a / 1b / 1c | ✅ 全部完成并部署 |
| **拍照开店**（AI 视觉建项目） | ✅ 完成，实测 17 行零漏行 |
| **Yelp 一键填店** | ✅ 完成，实测 Austin 三家同名店 |
| **Kiosk 门口端** | ✅ 完成，实测越南语走完整条路 |
| **Stripe 订阅 + 两种 AI 额度** | ✅ **接线完成并用真事件实测过**（见 §3.A） |
| **AI 前台副驾** | ✅ **完成**，实测提案带真 uuid、缓存命中 |
| **AI 电话接单** | ✅ **打通了**（2026-08-23 第一通真实电话，2026-08-24 已上线 `00517ad`+）。`assistant-b694392a` → `+17579999968` → 金足足疗。计量/转录/录音/转接的后端见 `docs/14` §10–§11；assistant 侧的话术调优交给店主 |
| **自助开户（付款 → 能用）** | ✅ **完成**（2026-08-18）：建租户 + 激活信 + 认领门店 + 开店清单，见 `12` |

**测试 547 项**，12 个包。分布：
`api 248` · `payroll 91` · `ai 83` · `scheduling 51` · `db 26` · `rotation 24` · `yelp 20` · `contracts 4`

---

## 2. 这一轮做的东西在哪

### 新增的包

| 包 | 干什么 | 要点 |
|---|---|---|
| `packages/ai` | 价目表视觉提取 | strict tool use + 两层校验；纯函数归一化/去重有测试 |
| `packages/yelp` | Yelp Fusion 映射 | **纯代码不过模型**；三个坑全有测试（见下） |
| `apps/kiosk` | 门口 iPad | 六语言、纯触屏、无快捷键 |
| `packages/ai/src/copilot` | 前台副驾 | 快照格式化与意图路由是**纯函数**（31 项测试） |
| `apps/api/src/stripe` | Stripe 验签 + 编排 | 验签手写（19 项离线测试），SDK 只用来调 API |
| `apps/api/src/billing` | 扣额度与自动续充 | `chargeQuota` 进业务事务；续充在事务外 |

### 新增的表与迁移（0014–0024 已全部应用到 dev 库）

| 迁移 | 表 | 关键约束 |
|---|---|---|
| `0014_blueprint` | `shop_blueprints` `blueprint_sources` `blueprint_items` | 落地后**封板**触发器 |
| `0015_phone` | `phone_lines` `phone_calls` `call_drafts` | **号码维度解析策略**（不绕 RLS） |
| `0016_kiosk` | `walkin_queue` `form_templates` `form_submissions` `form_access_log` | 健康表**不可删只可匿名化**；模板发布后不可改 |
| `0038_form_share` | `form_share_links` | 发给客人的一次性填表链接。令牌只存摘要、**不可删只可吊销**；令牌维度的 RLS 解析同 0016 的设备令牌（`docs/15`） |
| `0017_phase2_permissions` | —— | 把新权限补给已有预设角色 |
| `0018_billing` | `billing_accounts` `credit_ledger` `stripe_events` | 账本**连 UPDATE 都收回** |
| `0019_ledger_order` | —— | 账本加 `seq bigserial`：**对账不能按 `created_at` 排**（见 §4.9） |
| `0020_stripe_events_processed_at` | —— | 列名写死那个坑的第二次发作（§4.1 / §4.10） |
| `0021_plans_and_included_quota` | —— | 套餐改名 essential / growth，对齐 Stripe 后台 |
| `0023_credits_and_minutes` | —— | ⭐ 余额从「钱」改成**积分 + 语音分钟两种独立额度** |
| `0024_retire_money_ledger_columns` | —— | 账本上「钱」那两列退休（写 null 不写 0，见 §4.14） |
| `0025_store_contact_numbers` | —— | ⭐ 店家自己的两个号（`main` / `transfer_target`）。**e164 唯一约束收窄到会被反查的 purpose**，见 §4.16 |

### 新增的命令

`blueprint.*`（6）· `call.*`（3）· `location.savePhoneLine` · **`location.requestAiVoice`** · `location.applyYelp` ·
`device.issueToken/revokeToken` · `queue.join/update` · `catalog.saveFormTemplate` · `form.submit` ·
`billing.*`（6，只有 `setAutoTopup` 对 AI 可见）· `ai.recordAssist`（内部）

### 新增的路由（不走 `/v1/commands` 的那几条）

| 路由 | 为什么不是命令 |
|---|---|
| `POST /v1/ai/copilot` | 模型调用要几秒，塞进事务会占住连接 |
| `POST /v1/billing/checkout` `/payment-method` `/topup` | 调 Stripe 是外部 IO，而且**事务回滚不了扣款** |
| `POST /v1/stripe/webhook` | 没有登录用户，身份是 HMAC 签名 |
| `GET /v1/desk/billing` | 只读；顺带触发一次自动续充检查 |

---

## 3. 剩下的活，按建议顺序

> ⭐ **排序变更（2026-08-18，老板决定）**：**先把功能做完，再让种子店试用**，
> 不是边用边补。已有一家店明确表示愿意等我们做好。
>
> 这推翻了 Phase 1a 时定的「下一步不是加功能，是让种子店真用一天」。
> 理由是那条建议的前提是「没有店愿意等」，而现在有了。
>
> ⚠️ **代价要认**：反馈来得更晚，而越晚发现的设计问题改起来越贵。
> 所以**功能完成的判定要严**——「跑通了」不等于「做完了」，
> 每一条都要能在 `08` 的流程里被真人走一遍不卡住。

### ⭐ 0. 自助开户（2026-08-18 完成）—— 还剩两件

整条链路已经通了：官网付款 → webhook 建租户（`gf_provision_tenant`，
幂等靠 checkout session id）→ Supabase magic link 激活信 →
`/activate` 自动认领 → 开店清单 → 「配好了，开张」置 `active`。
代码见 `sql/0030`、`apps/api/src/signup/`、`apps/desk/src/screens/SetupWizard.tsx`，
设计与三处与原计划不同的地方见 `12` §6。

⬜ **还剩两件**：

1. **Supabase 控制台两处配置**（要人做，AI 做不了）：
   - Authentication → URL Configuration → Redirect URLs 里加
     `https://desk.geniefront.com/activate`（本地调试再加
     `http://localhost:5173/activate`）。**不加的话链接点开会跳回首页，
     而且不报错** —— 症状是「点了没反应」
   - Authentication → Email Templates → **Magic Link** 改成欢迎语。
     ⚠️ 别用 Resend 另发一封「欢迎」：两封信里只有一封的链接是活的
2. **和官网联调一次真事件**（`11` §7 那张表最后一行）：他们建一个测试
   Checkout Session、用 4242 卡付掉，把 session id 发过来

### ⭐ 0b. 占位符员工 + 技师上机（2026-08-18 完成）—— 还剩一件

老板加技师建的是 ghost 身份（`user_id is null`，`sql/0031`）；技师上机
两条路：**上机码**（老板念的 6 位，不经过运营商）和**手机验证码**
（Telnyx Verify）。会话是一行可吊销的数据，不是自签 JWT ——
手机丢了点一下「踢下线」就完事。

✅ **验证码短信已接好**（2026-08-19）：临时走 **Twilio Verify**（`09` §5）——
Telnyx 名下的 10DLC 还在排队，而排队期间验证码会被运营商**静默**过滤。
凭据已配、读接口实测可用、账号是 Full 不是试用。

✅ **已实测（2026-08-20）**：真手机收到码 → 上机 → 前台派单 → 他手机上出现 →
点「开始」→ 审计记的是他自己那条 membership。整条路通了。

⚠️ **两条别推翻的**：
1. **上机码排在手机验证码前面**。宪法第 13 条：短信不进依赖链。
   供应商挂了、10DLC 没批、账号欠费 —— 上机码都照常能用
2. **不要为了拿回实时推送去自签 Supabase 令牌**。上机会话没有 Realtime
   是有意的代价（轮询 10 秒兜底）—— 服务端一旦持有 Supabase 的签名密钥，
   爆炸半径是另一个量级（`auth.ts` 开头那段说明）

### 🔴 0c. 前端**根本没有部署路径**（2026-08-20 发现）

`deploy/` 里只有 API 那一套（Docker + Caddy + compose）。**desk / staff / kiosk
三个前端一个部署配置都没有**，而且：

```bash
dig +short desk.geniefront.com    # 空 —— 域名不解析
dig +short staff.geniefront.com   # 空
dig +short api.geniefront.com     # 有（VPS 那两台）
```

⚠️ **这是自助开户链路当前的第一阻塞**：老板付完钱收到的激活邮件，
链接指向 `https://desk.geniefront.com/activate` —— 一个还不存在的域名。
整条链路在生产环境是断的，而在本地一切正常。

要做的（顺序不能反）：

1. 三个 Vite 应用建站点（Cloudflare Pages 或同一台 VPS 由 Caddy 托静态文件）
   ⚠️ **构建时要注入** `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `VITE_API_BASE`
   —— 它们是 `vite.config.ts` 里的 `define`，不是运行时读的
2. DNS：`desk` / `staff` / `kiosk` 三条
3. Supabase → Redirect URLs 里那条 `https://desk.geniefront.com/activate`
   在域名真的能解析之后才有意义

✅ **顺手修掉的一个同类问题**（2026-08-20）：`deploy.sh` 生成生产 `.env` 时
只改了 `APP_URL`，**没改 `APP_BASE_URL`** —— 也就是说生产环境里那个值
一直是 `http://localhost:5173`，而它正是激活邮件和 Stripe 回跳用的域名。
现在一起改，并且加了防呆：生产 `.env` 里还留着 localhost 就直接中止部署。

### ⭐ A. Stripe：**代码全完，剩下三件要人去 Dashboard 做的**

代码这一侧已经接完并跑通（`billing.test.ts` 27 项 + `stripe/verify.test.ts` 19 项），
**而且已经用真事件实测过**（2026-08-17，`stripe listen` + `stripe trigger`）：

| 验的是什么 | 结果 |
|---|---|
| Stripe 真签名 | 200 |
| 伪造签名 / 改 body 一个字节 / 不带签名头 | 一律 401 |
| 带 `gf_` metadata 的 PaymentIntent 走完 webhook | 账本 +$100，余额对上 |
| 同一个 event id 重投 | `duplicate: true`，余额不变 |
| 换 event id、同一笔 PaymentIntent | 第二道按 pi 去重，余额不变 |
| `/v1/billing/*` 与 `/v1/ai/copilot` 未登录 | 401（只有 webhook 是公开的） |

⚠️ 为什么非要打真事件：验签那 19 项测试用的是**我们自己造的签名** ——
造签名和验签名共用同一段字符串拼法，拼错了两边一起错而测试照样绿。
只有真事件能证明我们对格式的理解是对的。

**剩下要人做的只有一件**：生产环境在 Dashboard → Webhooks 建 endpoint，
拿它自己的 `whsec_`（**和 `stripe listen` 给的不是同一个，混用的表现是
「本地全通、上线全 401」**）。

**已经做好的**（顺着钱走一遍）：

| 在哪 | 是什么 |
|---|---|
| `apps/api/src/stripe/verify.ts` | HMAC-SHA256 验签，时间戳窗口 + 常数时间比较（19 项测试） |
| `apps/api/src/rawBody.ts` | 原始字节解析器。**Fastify 一个 content-type 只能注册一个** —— 加供应商是往 `RAW_BODY_PREFIXES` 里加一条 |
| `apps/api/src/stripe/client.ts` | 薄客户端 + 套餐↔Price 映射。**没有业务逻辑** |
| `apps/api/src/stripe/routes.ts` | 编排：订阅 Checkout / 绑卡（setup 模式）/ 手动充值 / webhook |
| `packages/contracts/src/commands/billing.ts` | 六条命令，除 `setAutoTopup` 外全是 `exposed: false`。**每条都带 `unit`** |
| `apps/api/src/handlers/billing.ts` | 落库。`appendLedger()` 是**所有余额变动的唯一入口** |
| `apps/api/src/billing/usage.ts` | `chargeQuota()` —— 和 `usage_events` 那条 insert **在同一个事务里** |
| `apps/api/src/billing/autoTopup.ts` | 自动续充三步：认领（占位）→ 扣款 → 入账。**按单位各跑一趟** |
| `apps/desk/src/screens/Billing.tsx` | 老板端「💳 订阅与余额」。**两种额度分成两块，绝不合成一个总额度** |

**几个当时想清楚了、别推翻的决定**：

- **路由调 Stripe，命令落库。** 命令跑在数据库事务里，把几秒的外部 IO 塞进去
  会占住连接和快照 —— 和 `/v1/blueprint/:id/extract` 躲开的是同一个坑。
  每一次余额变动仍然是一条有审计、有幂等、有 RLS 的命令，宪法第 1 条没破。
- **自动续充「先占位再扣钱」。** `billing.claimAutoTopup` 在事务里拿 advisory lock、
  重判一次、**当场把 `last_auto_topup_at` 写成现在**。反过来（先扣钱再占位）
  并发时会让老板一分钟内被扣两次 $50 —— 有测试盯着这一条。
- **不做跨租户的定时扫描。** 那需要一个能看到所有店的连接，而 `apps/` 拿不到
  （宪法第 5 条，CI 会失败）。余额只会因为用量而下降，所以触发点挂在用量后面：
  拍照开店提取完、副驾回答完、电话挂断记完账、老板打开账单页。
- **同一笔扣款两条路都会来记**（路由 + `payment_intent.succeeded` webhook），
  所以 `billing.recordTopup` 除了总线的幂等键，还按 PaymentIntent id 再去一次重。
- **充值的 PaymentIntent 必须带 `gf_unit` / `gf_units` metadata。**
  webhook 那条路只拿得到那个对象 —— 认不出单位就**不入账**（宁可漏也不猜），
  因为猜错了客户会买了分钟拿到积分，而两者不能互换，只能人工冲账。
- **认不出的 price 不写**（`plan` 传 null 保持原样）。把未知套餐写成 starter
  会让付 Pro 钱的客户被静默降档，账单上看不出来。

⏳ **这一项还差的**（2026-08-18 更新）：单价已实测 **$0.062/分钟（全套）**，
`.env` 的 `TELNYX_RATE_PER_MIN_MILLICENTS` 已填 `6200`。

⚠️ **但要分清两件事，别再像之前那样一句话带过**：

| | 现状 |
|---|---|
| **向客户扣费** | ✅ **早就是通的** —— `chargeQuota` 扣的是 `voice_minute`，客户买的就是分钟（$50 = 200 分钟），**根本不需要知道单价** |
| **我们自己的成本** | ❌ `usage_events.cost_cents` 仍硬编码 `0` + `unitPricePending: true`（`handlers/phone.ts`）。**没有任何代码在读 `TELNYX_RATE_PER_MIN_MILLICENTS`** |

所以单价影响的是**毛利看板与单位经济**，不是客户账单。
要接上还差一步：在 `call.record` 里把 `cost_cents` 从 0 换成
`ceil(分钟 × 单价)` 并去掉 `unitPricePending`。

⭐ **套餐名以 Stripe 后台为准**（2026-08-17）：`essential` / `growth`，
不是文档早期写的 starter / pro。三处必须一致 —— 代码的 plan 枚举、
DB 的 check 约束、Stripe 后台的产品名。对不上的话，等到有人对着
Stripe 后台查一笔账时谁也说不清哪个是哪个。迁移 0021 做了这次改名。

### ⭐⭐ 定价模型（2026-08-17 定稿，完整算账在 `04` §4.1）

|  | 月费 | AI 积分 | AI 语音 | 我们成本 | 毛利 |
|---|---|---|---|---|---|
| Essential | $99 | 500 | **60 分钟** | $8.72 | 91% |
| Growth | $199 | 1200 | **500 分钟** | $43.00 | 78% |
| 充值 | **$50** | 1000 积分 | **或** 200 分钟 | — | 80% / **75%** |

**四条不能破的**，每一条在代码里都有对应的守卫：

1. **两种额度不能互换。** 语音成本 $0.062/分钟（全套），是一次副驾操作的 **6.2 倍**。
   能换就会被客户全换成最贵的那种用（决策 8）。
   ⚠️ `@gf/payroll/credits` 有一条测试专门扫模块导出，
   出现 `convert` / `exchange` / `toMinutes` 之类的名字就红。
2. **1 积分 = $0.01 的真实成本，向上取整。** 所以拍照开店（Opus，$0.08/张）
   自然扣 8 积分 —— 不用为它单独定规则，也不会有人拿它当免费午餐。
3. **关键词直接答掉的不扣积分。** 那些**根本不会走到 `ai.recordAssist`** ——
   副驾路由在本地答完就返回了。不是一段判断，是一条没有发生的调用。
4. **先用套餐里的**，用完了才扣充值余额；**一次可以跨两边扣**
   （套餐内剩 3 个而要扣 8 个 = 3 + 5），别浪费掉已经付过钱的那几个。
   清零跟着 Stripe 的 `current_period_end` 走，**不自己数日子**。

⚠️ **Essential 的 60 分钟 ≈ 每天 1 通电话，是「尝鲜」不是「够用」。**
这是算过三种配法之后才定的一刀：给 200 分钟的话没人会升级到 Growth
（`04` §4.1 有那张对照表）。**销售时必须直说** —— 开店时问一句
「一天大概接几通电话」，超过 2 通就直接推 Growth。

⏳ **两个还没定的数**：
- ~~`$0.056/分钟` 是不是全包~~ → **已确认 $0.062/分钟，全套**（2026-08-18 实测）。比原估高 11%，`04` §4.1 已重算：Essential $8.72 / 91%、Growth $43.00 / 78%、**充值买分钟那档 75%（最薄）**。
- 关键词路由能拦掉多少提问（现按 65% 估）。日志里已经记了
  `source: local | model`，**上线后捞一周真实数据再定稿**。

### ⭐ A2. AI 前台副驾（**已完成**）

一条口语 → 现场快照 → 提案卡片 → 前台确认 → 执行 → 60 秒撤销。

| 在哪 | 是什么 |
|---|---|
| `packages/ai/src/copilot/snapshot.ts` | 现场快照压成行式文本（16 项测试）。实测一家夸张的忙店 < 1.5k token |
| `packages/ai/src/copilot/route.ts` | **确定性意图路由**（15 项测试）—— 「几个人在等」根本不走模型 |
| `packages/ai/src/copilot/prompt.ts` | 系统提示。**逐字节稳定**，不许插门店名/时间 |
| `packages/ai/src/copilot/copilot.ts` | 模型调用 + 只读工具循环 + 提案 |
| `packages/contracts/src/aiSchema.ts` | 把 Zod schema 压成一行给模型看的字段说明 |
| `apps/api/src/queries/floorSnapshot.ts` | 取数（轮牌复用 desk 那一屏的同一段计算） |
| `apps/api/src/copilot/routes.ts` | `POST /v1/ai/copilot` + 五个只读工具 |
| `apps/desk/src/screens/Copilot.tsx` | 顶栏「🤖 副驾」抽屉 |

**实测**（2026-08-16，`claude-sonnet-5`）：

| | |
|---|---|
| 缓存段 | 7.1k token（系统提示 + 46 条命令目录），第二次调用起 `cacheRead` 命中 |
| 快照 | 一家四人小店 64 token；构造的十二人忙店仍 < 1.5k |
| 一次带工具往返的调用 | **~2 分**（比 `05` §7.1 估的 $0.012 高，因为多了一轮工具） |
| 耗时 | 首次 ~18 秒（写缓存），之后 2–3 秒 |
| 提案质量 | 「把 Kim 标记成休息中」→ `rotation.setBreak` + **真 uuid**，Zod 校验通过 |

**几个想清楚了的决定**：

- **命令目录是文本，不是 40 个 tool。** JSON Schema 展开要一万多 token，
  压成文本 2.1k，而且整段在缓存断点之前。命令名仍然是 strict tool use 的
  枚举 —— 模型编不出不存在的命令名，而那是最危险的那种幻觉。理由全在
  `packages/contracts/src/aiSchema.ts` 顶部。
- **`propose_command` 的入参是一个装着 JSON 的字符串**，不是 object。
  不是随手写的，见 §4.10。
- **确定性路由「宁可放过」。** 带动作词（挪/改/取消/move/cancel…）的一律走模型，
  关键词还必须基本上就是整句话。误判的代价是「前台以为事情办了」，
  比多花一分钱大得多。
- **只读工具全部只读。** 模型可以随便调、不用确认 —— 这个性质是整个设计成立
  的前提。想加一个「顺便帮她建一下」的工具时，回去读 `copilot.ts` 里那一句。
- **撤销是一张白名单，不是通用引擎。** 只有反向操作能由提案入参 + 执行结果
  完全推出来的才给撤销按钮（`appointment.create` / `rotation.setBreak` /
  `staff.setRotation`）。推不出来的**明说撤不了**，见 §3.D。


### B. AI 电话：开户与口音实测（**要人做，AI 做不了**）

`09-TELNYX.md` §7 线 A 有完整清单。A5–A8 的代码全写完了，
卡的是 **A1–A4**：开户、买号码、建 Assistant、**真打电话测口音**。

**六个** tool 的 URL 和参数在 `docs/14` 里（仓库根的 `create_assistant.json`
就是那份 assistant 配置，直接推上去）。号码一到位 → `.env` 填
`TELNYX_PHONE_NUMBER` / `TELNYX_ASSISTANT_ID` →
前台「开店配置」里绑号码（命令 `location.savePhoneLine`）→ 就通了。

两条命令（细节见 `docs/14` 开头）：

```bash
pnpm exec tsx apps/api/src/ops/bindAiLine.ts +1757… pk_… --rotate   # 绑号码 + 拿 token
node scripts/push-assistant.mjs assistant-… --token st_…            # 推 assistant 配置
```

⚠️ **绑号码那一步会返回一串 `toolToken`（`st_…`），它只出现这一次**
（`sql/0036`：库里只有摘要）。把它填进那家店 assistant 的每个 tool 参数
`shop_token` 的常量值里 —— **忘了填，那家店的电话全部 401**
（服务端日志里是 `shop_token_invalid`，带号码和 locationId）。
丢了就重来一次：`location.savePhoneLine` 带 `rotateToolToken: true`，
然后同步到 Telnyx。理由和边界见 `docs/14` §0。

⚠️ **口音实测的结果要写进 `09` §4.3 下面那张空表**，那是决定要不要把号码全搬过来的唯一依据。

### C. 通用撤销（Phase 3，但现在就该知道缺口在哪）

宪法第 6 条要的是「一切可撤销」，而现在副驾的撤销是一张**白名单**
（`apps/desk/src/screens/Copilot.tsx` 的 `inverseOf`），只覆盖三条：
`appointment.create` / `rotation.setBreak` / `staff.setRotation`。

覆盖不了的那些，缺的都是同一样东西：**改动前是什么**。
`appointment.reschedule` 要撤销得知道原来几点，`queue.update` 要知道原来什么状态 ——
而提案里只有「改成什么」。

正解是拿 `audit_log` 的 `before` 回放：总线已经在写 before/after 了
（`audit.ts`），`undo_of_id` 那一列也留好了。要做的是一条
`system.undo { auditId }` 命令 + 每条命令声明自己怎么被回放。

⚠️ **在那之前，宁可不给按钮也别给一个猜出来的反向命令** ——
前台点了「撤销」而它把单挪到了另一个错误的时间，比不能撤销糟得多。
现在的界面在撤不了的时候会**明说撤不了**，那句话是有意写的。

### D. 零散的补完

| 事 | 在哪 | 备注 |
|---|---|---|
| 大牌子两遍分块提取 | `packages/ai` | `mergeDrafts` 已就位可直接复用（`05` §5.2） |
| 项目名多语言自动补齐 | `packages/ai` | `05` §4.4，术语表已在系统提示里 |
| `category` → `service_categories` | `blueprint.apply` | 现在只显示不落库 |
| 官网 URL 提取 | `packages/ai` | 三条开店入口的最后一条 |
| 叫号大屏 | 新页面 | 现在只有前台屏和客人自己的号 |
| `form_access_log` 读取留痕界面 | desk | 表和触发器都在，没有 UI |
| 电话录音开场告知 | Telnyx Assistant 配置 | 加州 two-party consent（`09` §4.4） |

---

## 4. ⚠️ 我踩过的坑，别再踩一遍

### 4.1 `createdAt()` helper 把列名写死了

`packages/db/src/schema/*.ts` 顶部那个 `const createdAt = () => timestamp('created_at', …)`
**列名是写死的**。写 `joinedAt: createdAt()` 会静默映射到 `created_at` 列，
typecheck 和迁移都不报错，直到运行时 `column q.joined_at does not exist`。

**列名和字段名不一样时，老老实实写全**：
```ts
joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
```

### 4.2 CORS 漏一个自定义头 = 浏览器静默掐掉请求

加了新的自定义请求头（`X-Device-Token` 就是这么漏的一次），
**必须同步加进 `apps/api/src/server.ts` 的 `allowedHeaders`**。

漏了的表现极具迷惑性：服务端日志里只有一个成功的 `204 OPTIONS`，
**没有任何报错**，而前端拿到一句语焉不详的 `TypeError: Failed to fetch`。

### 4.3 计费单位是**毫分**（1/1000 分），不是分

`packages/ai/src/cost.ts` 全程用毫分。`$0.012 = 1.2 分 = 1200 毫分`。
我第一版测试写成 12000，账单会**差 10 倍**——
而这是最难被发现的一类错（数字看起来完全正常）。

### 4.4 权限加了要写数据迁移

权限存在 `role_permissions` 表里，**不是从 `ROLE_PRESETS` 实时算的**
（店主可以在预设基础上勾选调整，那张表才是事实）。

所以：**每次给 `PERMISSIONS` 加常量，都要配一条像 `0017_phase2_permissions.sql`
那样的数据迁移**，否则老板升级完打开新页面看到的是「没有权限」。

### 4.5 Supavisor 在 `alter role` 之后会短暂拒连

跑完 `pnpm db:migrate`（里面有 `alter role app_user with login password`），
紧接着跑测试有一定概率撞上 `28P01 Authentication credentials are invalid`。

**这是 pooler 刷新凭据的瞬态，重跑一次就好。** 别去查密码配置，我查过了，没问题。

### 4.6 测试要自己清理，尤其是建了业务数据的

`blueprint.test.ts` 的 apply 用例会建真 `services`。不清理的话开发库里
一天天堆 Gel Manicure，下一个人会以为那是种子数据。

清理顺序被外键逼着：**先记 id → 删父表（级联子表）→ 再按 id 删 services**。
反过来会撞 `blueprint_items_applied_service_id_fk`。

### 4.7 drizzle-kit generate 遇到改列名会开交互式提问

改了字段名之后 `drizzle-kit generate` 会问「是新建列还是重命名」，
管道喂 `\n` 不管用（它要方向键）。我写了个小脚本驱动它：见本文件末尾附录。
**选 rename**，不然会 DROP + ADD 丢数据。

### 4.8 `vitest` 里 postgres.js 的 timestamptz 可能回来是字符串

vite-node 的 VM realm 和 Node 原生 realm 的 `Date` 不是同一个构造函数。
**结果字段里的时间戳一律走 `parseTs()`**（`@gf/db` 导出），别直接 `.toISOString()`。
症状是「测试里炸、生产里好」——最难查的那一类。

### 4.9 ⭐ 账本按 `created_at` 排序，并发时会报一个**根本不存在的**篡改

这条是被测试逼出来的，非常反直觉，而且它只在并发时出现。

Postgres 的 `now()` 返回的是**事务开始时刻**，不是语句执行时刻。并发扣费时：

```
事务 A: 开始(t=10) → 拿行锁 → 写账本(balance_after=-4) → 提交
事务 B: 开始(t=9)  → 等锁 …… → 写账本(balance_after=-8) → 提交
```

两行的 `balance_after` 是**按提交顺序**串好的（行锁保证了这一点），
可是按 `created_at` 排出来 B 在前 A 在后 —— `findLedgerBreak()` 立刻报一个断点，
而账本本身一点问题都没有。

**症状极具迷惑性：并发越高越容易出，每次断点位置还都不一样**，
看起来完全像是有人在篡改账本。

修法不是放宽检查（那等于把唯一能发现篡改的手段关掉），
而是给账本一个不依赖时钟的顺序：**`seq bigserial`**（迁移 0019）。
序号在插入那一刻取，而插入必然在拿到行锁之后，所以它和 `balance_after` 严格一致。

⚠️ **对账、翻流水一律 `order by seq`，别用 `created_at`。**

### 4.10 strict tool use 里不能有「形状不定」的 object

`strict: true` 要求 schema 里**每一个** `type: 'object'` 都显式写
`additionalProperties: false`。而副驾的 `propose_command` 要传的命令入参
每条命令都不一样，字段根本枚举不出来 —— 写成 object 会被 API 当场 400：

```
tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false
```

两条路：放弃 `strict`（丢掉命令名的枚举保证），或者把入参当**字符串**传。
选了后者（`input_json`）：命令名那一条保证比入参形状重要得多 ——
编错字段名的结果是一个 `VALIDATION_FAILED`，编错命令名则可能命中另一条真实
存在的命令。而入参本来就要过 Zod（`bus.ts` 第 1 步），少一层 JSON Schema 不损失什么。

⚠️ 解不出 JSON 时**不许「尽力修复」**：一个被猜着补全的入参可能正好是一条
合法但错误的命令，而前台在卡片上只看得到那句 summary。

### 4.11 快照里不给 id，就必须有一条「名字 → id」的工具

第一版的只读工具里没有 `list_staff`。实测问「把 Kim 标记成休息中」，
模型给出的是 `rotation.setBreak { membershipId: "Kim" }` —— 一个名字填在 uuid 上。
Zod 会拦下来，但**那次调用的钱已经花了**，而前台看到的是「参数不对」。

快照里刻意不带 uuid（省 token、也避免模型记错），
所以**凡是命令要填的 id，都得有一条明确的查询工具**。加了之后同一句话
两轮就给出了带真 uuid 的正确提案。

### 4.12 `lint-guards.sh` 会误伤名字里带钱味儿的非金额字段

`select count(*) … as total` 配上 `Number(rooms.total)` 会被
「金额字段走了浮点解析」拦下（宪法第 4 条）。那条规则宁可误伤也不放过是对的，
**改个列别名比给它开例外便宜** —— 房间数叫 `room_count` 就行。

⚠️ 连注释里出现 `Number(...total...)` 都会被拦。别在解释里复述被拦的那个写法。

### 4.13 余额缓存和账本对不上，`findLedgerBreak` 抓不到

这两件事**要两条检查**，很容易只做一条：

- `findLedgerBreak()` 抓的是「账本行被就地改过」
- **缓存对不上**抓的是「没碰账本，直接 `update billing_accounts.balance_cents`」

后者才是更可能发生的那一种（一句手写的 SQL 就能干出来），而且光看账本
完全发现不了 —— 账本自己是自洽的，只是没人再看它了。
`loadBilling()` 现在两条都查（`ledgerBreakAt` + `balanceMismatch`）。

⚠️ 发现之后**不在界面上悄悄纠正**：账本是事实，缓存错了是事故，要有人去查。
反过来更要命 —— 缓存错了却往账本里补一笔调账来抹平，等于**把污染写进事实**，
而账本删不掉改不动，那个断点会永远留在库里。这个坑我踩过一次，
`billing.test.ts` 的 `resetBilling()` 里有完整的复盘。

### 4.14 「不涉及钱」不能写 0，要写 null

账本从「钱」改成「积分 / 分钟」时（迁移 0023），`amount_cents` 是 `not null`，
于是新行只能写 0 —— 而 0 立刻撞上 0018 那条方向约束
（`kind='topup'` 时 `amount_cents` 必须 > 0）。

约束报错只是表象。**真正的问题是写 0 本身就是错的**：

> `0` 的意思是「这笔金额是零」，而事实是「**这一笔跟钱没关系**」。

这两件事在对账时会被读成完全不同的意思 —— 一个说「有一笔零元交易」，
另一个说「这条记录不在钱的账本上」。迁移 0024 把两列改成可空，新行写 null。

同一个道理的另一面：**历史行原样留着**（宪法第 9 条，财务数据不删）。
它们记录的是真实发生过的钱。

### 4.16 ⭐ 「全局唯一」要问一句「唯一是为了谁」

`phone_lines.e164` 本来是全局唯一，理由写得很清楚：同一个号码属于两家店的话，
webhook 会随机落到其中一家 —— 无从复现的串店。

那个理由是对的，但它**只对会被反查的号成立**（`ai_voice` / `sms` —— webhook
拿着被叫号码来问「这是谁家的」）。店家自己的两个号（`main` 对外公布的号、
`transfer_target` 人工客服号）我们**从来不反查**。

而全局唯一在这两种上会造成一个很常见的误伤：

> **人工客服号通常是老板的手机，而一个老板开两三家店在这行很普遍。**
> 第二家店填同一个号就会撞约束，报一个看起来毫无道理的错。

迁移 0025 把唯一索引收窄成部分索引（`where purpose in ('ai_voice','sms')`），
`phone_line_lookup` 那条 RLS 策略也跟着加了同样的 purpose 过滤 ——
不加的话，那条给「没有登录用户的 webhook」用的极窄策略会顺带把店家自己的
号码也放进同一个查询面（`09` §5.2 的判断标准）。

⚠️ **连带破坏**：`SavePhoneLine` 原来用 `on conflict (e164) do update`，
索引一改就报 `no unique or exclusion constraint matching`。
冲突目标改成了 `(location_id, purpose) where active` ——
语义也更对：**一店一用途只留一条，换号是 update 那一条**。

### 4.15 换计量单位时，测试的清理逻辑要跟着换

`billing.test.ts` 的 `resetBilling()` 原本按「钱」清零。改成两种额度之后
它必须**按单位各清一次** —— 漏掉一种的话，那一种的余额会跨用例累积，
而报错会以一种完全无关的形式出现（「为什么这个用例算出来是 -15 而不是 -5」）。

⚠️ 而清零本身必须**走账本写一条 adjustment**，不能 `update balance = 0`——
那正是 §4.13 那条检查要抓的东西，而且一旦写进开发库就永远消不掉。

---

## 5. 这一轮定下来、以后别推翻的几个设计

这几条是踩过或想清楚之后定的，改之前先想想为什么。

### 5.1 AI 的产出永远先进「草案」，不直接进业务表

- 拍照开店 → `blueprint_items`，逐项勾中才变 `services`
- AI 电话 → `call_drafts`，**完全不碰 `appointments`**

电话那条尤其重要：**AI 建的预约会占住日程表上的位置**。
一通没听清的电话就能把周六下午卡掉一格，而前台要到复核时才发现。
现在前台点确认时走的是**她自己身份下的** `appointment.create`，
容量检查、超卖放行、审计一样不少。

### 5.2 没有登录用户的入口，权限窄到极致

| 入口 | 身份 | 权限 |
|---|---|---|
| Telnyx webhook | Ed25519 签名 | `call.draft` + 三个只读 |
| Kiosk iPad | 设备令牌 | **只有 `queue.join` + `form.submit`** |

都**没有** `customer.view_contact`、都建不了预约、都叫不了号。
判断标准：**捡到这台设备/拿到这个 URL 的人，能干什么？**

### 5.3 「缺上下文」不等于「要绕过 RLS」

三处都没绕过 RLS，而是各加了一个维度的上下文 + 一条极窄的策略：

| 场景 | 上下文 | 策略 |
|---|---|---|
| 登录后还没选店 | `app.user_id`（0003） | `identity_self` |
| webhook 只带被叫号码 | `app.phone_lookup`（0015） | `e164` 恰好相等 |
| iPad 只带令牌摘要 | `app.device_token_hash`（0016） | 摘要恰好相等 |

**应用运行时永远不需要能绕过 RLS 的凭据。** 这条别破。

### 5.4 敏感数据分两层防

RLS 挡的是**应用里的越权**；它挡不住**把整个库复制走的人**。
所以健康表答案是 **AES-256-GCM 应用层加密**的（`FORM_ENCRYPTION_KEY`）。

⚠️ **那把密钥丢了 = 所有已签的健康表永久解不开。**

⭐ **2026-08-24 起，读健康表内容也要留痕**（`form_access_log`：谁、什么时候、
因为什么、从哪个 IP）。权限 `customer.view_health_form` 同时给了
`manager` 和 `front_desk` —— 理由见 `docs/15` §2.1：`02` §3.1 给技师看的那句话
是「有禁忌，**见前台**」，前台看不到的话这句话指向了一个同样看不见的人。
生产那一把只进 CI Secret，别进任何 `.env` 文件之外的地方。

### 5.5 「不确定」比「猜一个」有用

- 价目表读不准 → 标黄，**不自动修正**（低于 $1 的价格不自动 ×100）
- 名字匹配不上 → 留空 + **保留原话**，不做编辑距离
  （`gel manicure` 和 `gel removal` 距离很近，价格差一倍）
- 同号多客户 → **全部列出让人选**，绝不自动挑第一个（决策 21）
- Yelp 时区推不准 → 标 `needs_confirm` 强制老板看一眼

一条共同的理由：**静默的错误比明显的空白危险得多**。前者没人会发现。

### 5.6 额度这条路上，**事实和缓存要分得很清**

`credit_ledger` 是事实，`billing_accounts.credit_balance` /
`voice_minute_balance` 只是缓存。
这不是洁癖，它决定了三件事怎么做：

| 场景 | 做法 |
|---|---|
| 扣费 | 永远 `appendLedger()`，不许 `update balance_cents` |
| 冲一笔账 | 写一条**反向记录**，不是把原来那条改掉 |
| 缓存和账本对不上 | **按账本修缓存**，绝不往账本里补一笔来抹平 |

最后一条最容易做反，而做反的代价是**把污染写进了事实** ——
账本删不掉改不动，那个断点会永远留在库里（§4.13 有完整复盘）。

### 5.7 副驾的边界：**它提议，前台执行**

模型产出的是一个待确认对象，写入永远发生在前台点确认那一下，
用的是**她自己的身份**。于是三件事是自动成立的，不需要在副驾这边再实现一遍：

- 权限：她没权限的命令，执行时就是 `PERMISSION_DENIED`（没有后门）
- 容量：超卖软约束照常拦，照常要她带原因放行
- 审计：流水上记的是她，不是「AI」

代价是副驾没法「一句话做三件事」。那是**故意的** ——
一张卡片上让前台确认三件事，她会只看第一件。

---

## 6. 试一遍五条新路（都不用外部开户）

```bash
pnpm --filter @gf/desk dev     # 5173
pnpm --filter @gf/kiosk dev    # 5175
# 另开一个终端跑 API：
set -a && . ./.env && set +a && npx tsx apps/api/src/main.ts
```

登录 `mia@example.test` / `GenieDev!2026`（见 `08`）。

| 试什么 | 怎么走 | 花多少钱 |
|---|---|---|
| **拍照开店** | 开店配置 → 项目 → 📷 拍价目表 | ~$0.08/张（真调 Anthropic） |
| **Yelp 填店** | 开店配置 → 营业时间 → 🔎 输店名和邮编 | $0（免费额度） |
| **门口 Kiosk** | 开店配置 → 门口 iPad → 生成配对码 → 粘到 5175 | $0 |
| **AI 副驾** | 顶栏 🤖 副驾 → 说一句话 | 问「几个人在等」$0（不走模型）；「把 Kim 标记成休息中」~2 分 |
| **订阅与余额** | 顶栏 💳 订阅与余额（**只有老板看得到**） | $0（Price id 没填的话开通那一步会报 503） |

⚠️ **副驾那一屏用 `mia@example.test` 登录看不到 💳 页签，这是对的** ——
`billing.manage` 只在 owner 的预设里，而种子数据的 owner 在足疗店那家。

⚠️ 拍照开店和 Yelp 落地都会**真的改开发库的数据**。
试完记得清理（我留了脚本思路在 §4.6）。

---

## 附录：驱动 drizzle-kit 的交互式提问

```js
// /tmp/gen.cjs —— node /tmp/gen.cjs（在 packages/db 目录下跑）
const { spawn } = require('child_process');
const p = spawn('npx', ['drizzle-kit', 'generate'],
  { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: 'x' } });
let buf = '', answered = 0;
p.stdout.on('data', (d) => {
  const s = d.toString(); buf += s; process.stdout.write(s);
  const q = (buf.match(/created or renamed from another column\?/g) || []).length;
  if (q > answered && answered < 10) {
    answered = q;
    // 方向键下 + 回车 = 选第二项（rename）
    setTimeout(() => { p.stdin.write('\x1b[B'); setTimeout(() => p.stdin.write('\r'), 60); }, 120);
  }
});
p.stderr.on('data', (d) => process.stderr.write(d));
p.on('close', (c) => process.exit(c ?? 0));
```

`generate` 不需要真的连库（`DATABASE_URL=x` 就够），它只对比 schema 和快照。
真正连库的是 `migrate`，那个要 `MIGRATION_DATABASE_URL`（postgres 角色）。
