# 分批测试手册

日期：2026-09-05  
配套：[`../CURRENT-ARCHITECTURE.md`](../CURRENT-ARCHITECTURE.md)、[`SEED_SCENARIOS.md`](SEED_SCENARIOS.md)

这份手册回答两件事：**测什么**、**怎么测**。  
自动测能挡住回归；挡不住的，按批次手测。每批有通过标准。一批不过，不要开始下一批。

---

## 0. 先读这三条

1. **不要用开发库跑 API/DB 测试。** 完整验证需要：
   - `DATABASE_TEST_TARGET=isolated`
   - `TEST_DATABASE_URL`
   - `TEST_MIGRATION_DATABASE_URL`
   - `GF_QA_ALLOW_RESET=1`
   - `NODE_ENV=test`（E2E）
2. **QA 账号和演示账号不是同一套。**
   - QA：`qa-<scenario>@maildrop.cc` / `GenieQa!2026`（见 Seed V2）
   - 演示：`owner@maildrop.cc` 等 / `GenieDev!2026`（见 `docs/16`）。演示数据日期常是 2026-08-25～28，拿「今天」会看到空日历。
3. **自动绿 ≠ 能上线。** Playwright 只跑 Chromium + 英文 + 纽约时区，且 **不起 booking / ipad**。多语言、触屏 Kiosk、真邮件、真电话、真预约验证码，必须人手。

---

## 1. 环境怎么起

### 1.1 只跑自动门（不需要浏览器）

```bash
cd geniefront-os
pnpm lint:guards
pnpm typecheck
pnpm test:unit
```

这三项不写业务库，日常改代码先跑。`lint:guards` 会抓：绕过命令总线的 SQL、没加 AI 门禁的模型调用、常见假数据标记、i18n 中文字面量（仅 `apps/web/src/pages` 与 `components`）。

### 1.2 完整单测（会写隔离库）

确认 `.env` / 测试 env 里隔离库变量齐，然后：

```bash
pnpm test          # @gf/db 先，再其它
# 或一次性
pnpm verify        # guards + typecheck + test
```

失败时先看是不是误连了 dev 库（密码被 migrate 改掉、种子 org 不存在）。

### 1.3 浏览器 E2E（自动起 4 个服务）

```bash
GF_QA_ALLOW_RESET=1 NODE_ENV=test pnpm test:e2e
# 调试
GF_QA_ALLOW_RESET=1 NODE_ENV=test pnpm test:e2e:ui
```

会起：API、web、platform、marketing。失败看 `artifacts/playwright/`（截图、trace、video）。

### 1.4 手测时的本地进程

至少：

```bash
pnpm --filter @gf/api dev          # :3000
pnpm --filter @gf/web dev          # :5177
```

按批次再加：

```bash
pnpm dev:booking                   # :5176
pnpm dev:ipad
pnpm dev:marketing                 # :5180
pnpm dev:platform
```

Seed：

```bash
GF_QA_ALLOW_RESET=1 DATABASE_TEST_TARGET=isolated \
  pnpm qa:reset
GF_QA_ALLOW_RESET=1 DATABASE_TEST_TARGET=isolated \
  pnpm qa:seed busy_shop
```

每次换场景先 `qa:reset` 再 `qa:seed`。Seed 会清掉其它 V2 租户，**不要指望同一库里同时留着 10DLC 提交店和平台审核店。**

---

## 2. 自动已经覆盖什么（不必重复当第一优先级）

这些路径有回归网，人手抽查即可，除非你刚改了相关文件。

| 区域 | 自动证据 | 人手还要看的 |
|---|---|---|
| 登录、setup 向导前进、Growth setup | `e2e/specs/auth-setup.spec.ts` | 中文界面；刷新后进度不丢 |
| 前台无权打开 billing | `billing-permissions.spec.ts` | 侧栏是否根本不显示设置 |
| 完工、礼品卡收银、日结封账 | `operations.spec.ts` | 有备注/加项/现金找零的复杂单 |
| 多店隔离 | `multi-location.spec.ts` | 西店「今天」是洛杉矶营业日 |
| 营业日 cutoff | `business-day.spec.ts` | 凌晨 1:30 的「今天」 |
| 计费 UI 额度/自动续充（Stripe 被 mock） | `remaining-browser-qa.spec.ts` | **真 Stripe** 见批次 8 |
| 营销定价 CTA、success/cancel | 同上 + marketing 单测 | 真 Checkout 见批次 8 |
| 平台准入、支持单、10DLC 内审片段 | platform E2E | 运营日常完整工单 |
| 桌面/平板/窄屏不横向溢出 | `responsive.spec.ts` | 只抽了 queue / day-close / billing / schedule |
| 命令 `system: true`、AI 门禁、RLS | API/DB vitest | 不需要手打内部命令 |
| 轮牌/排期/提成纯函数 | packages 单测 | 真店规则组合仍要手测 |
| Stripe TEST 商业闭环 | `COMMERCIAL_E2E.md` 已 PASS（2026-08-30） | 换了 Price ID / webhook / 邮件商后要重做 |

**自动明确没做的：**

- `apps/booking` 整站
- `apps/ipad` 整站
- 任何非英语 UI
- 真 SMS / 真 AI 电话
- 真 Turnstile 预约
- Queue 里每一个弹窗字段
- 退款后的日结与提成
- 营销邮件（一期关闭是产品决策，但退订链接仍要测）
- Elastic Email 生产域名

---

## 3. 手测通用方法

每条用例记录四样，否则无法复现：

1. **场景**：哪个 seed / 哪个真账号
2. **语言 + 视口**：如 zh-Hans / 1280、ko / 390
3. **步骤**
4. **结果**：通过 / 失败（期望 vs 实际）+ 截图或控制台 4xx

语言切换：web 顶栏地球图标。每批至少用 **中文走主路径一遍、英文走一遍、韩语抽一屏**。韩/西/越如果出现中文按钮或英文 placeholder，记为 i18n 缺陷，不要当成「没翻译完所以跳过」。

角色至少覆盖：

| 角色 | Seed | 不能做什么 |
|---|---|---|
| owner | `growth_active` / `busy_shop` | — |
| front_desk | `manager_or_front_desk` | 改套餐、看完整 billing |
| tech | `tech_only` | 进 `/settings`、看完整客人手机号 |
| platform | `platform_operator` | 店主账号不能进平台 |

钱的检查口诀：页面金额、工单、日结、技师收入，四个数字对不上就是 P1。

---

## 4. 批次（按这个顺序）

建议一天 1～2 批。自动先跑第 0 批；自动红了先修，再手测。

---

### 批次 0 — 仓库门（自动，30～90 分钟）

**怎么测**

```bash
pnpm lint:guards && pnpm typecheck && pnpm test:unit
# 有隔离库再：
pnpm test
pnpm test:e2e
```

**测什么 / 通过标准**

- 全绿。
- E2E 失败打开 `artifacts/playwright/report`。
- 若 E2E 因环境起不来（端口、隔离库、QA reset 被拒），记为环境问题，不要标成产品 bug。

**自动查不出：** 任何视觉、文案、真外部服务。

---

### 批次 1 — 登录、选店、开店向导、权限门禁

**Seed：** `fresh_owner`、`growth_setup`、`tech_only`、`manager_or_front_desk`  
**自动：** `auth-setup`、`billing-permissions`  
**手测入口：** `http://localhost:5177`

| # | 怎么测 | 期望 |
|---|---|---|
| 1.1 | 未登录打开 `/dashboard` | 落到登录，不闪后台壳 |
| 1.2 | 错密码 / 对密码 | 错有明确错误；对了进选店或直接进店 |
| 1.3 | `fresh_owner` 登录 | 只能到 `/setup`，手输 `/queue` 被拉回 setup |
| 1.4 | 向导四步：资料 → 项目 → 员工 → 正式开店 | 每步 Save and continue **一次**就前进（QA-001 回归）；刷新不丢 |
| 1.5 | 不填营业时间/项目/可接单员工就点开店 | 服务端拒绝，有人话，不是白屏 |
| 1.6 | 开店成功后访问 `/setup` | 去 dashboard 或 tech，不再进向导 |
| 1.7 | `tech_only` 登录 | 只有 `/tech/*`，`/settings` 进不去 |
| 1.8 | 前台账号打开 `/settings?tab=billing` | 权限安全态，**整页不能变成 Failed to load** |
| 1.9 | 退出 | 再 back 看不到已登录 UI |
| 1.10 | 中文 / 英文 / 韩语各走一遍登录页和向导 | 无中英混排到不可读；按钮不被截断 |

**本批不测：** 支付、预约、日结。

---

### 批次 2 — 一天的核心闭环（最重要的手测）

这是产品能不能进真店的那条路。自动只覆盖「种子里已在服务中的单能完工 + 礼品卡结账 + 日结」。你要自己 **从零开一张单**。

**Seed：** `empty_shop`（从零）、`busy_shop`（有人）  
**自动：** `operations.spec.ts`  
**页面：** `/schedule` `/queue` `/rotation` `/checkout` `/tickets`

| # | 怎么测 | 期望 |
|---|---|---|
| 2.1 | 建客人（同号两个不同名字） | 出现选择器，不静默合并 |
| 2.2 | 日程上为 Lisa 约一个项目 | 预约出现在技师列；营业日是店时区 |
| 2.3 | 签到 → 入座 → 开始 | 队列状态变；**真实 ticket 被创建**（到 `/tickets` 能看到）。开始后房间占用要变 |
| 2.4 | 加一项目录里的服务（不要手填金额） | 小计以后端为准；工单上有这项 |
| 2.5 | 完工（备注空 / 备注有字 各一次） | 进入待收银。有字时不能「点了没反应」（历史 P1） |
| 2.6 | 收银：刷卡记录 + 15% 小费 | tickets 显示已结；技师 summary 小费增加 |
| 2.7 | 另一张单：现金 $100 做 $85，「不用找了」 | $15 进小费，日结现金对得上 |
| 2.8 | Walk-in 不预约直接排队、派给轮牌第一人 | 轮牌前进；指定技师可选择不计轮 |
| 2.9 | 作废一张未结单（必填原因） | 可重新开；队列能回到已签到 |
| 2.10 | 快捷键 `q` `c` `r` `/`（输入框里不要触发） | 跳转正确；设置里可关快捷键 |
| 2.11 | 断网 | 橙色横幅，写操作不可用，页面不整页遮罩崩溃 |
| 2.12 | 换 zh-Hans / en / ko 再走 2.3–2.6 | 弹窗按钮、确认文案跟语言走 |

**重点盯 `Queue` 弹窗：** 健康偏好、现场加项、清洁房间勾选，填了之后必须在后端或下一屏能看到。填了却消失 = P0/P1（假实装）。

**本批不测：** 退款、礼品卡（下一批）、报表图表美丑。

---

### 批次 3 — 钱：退款、礼品卡、日结、提成

**Seed：** `busy_shop`、`gift_card_shop`、`day_close_ready`  
**自动：** 礼品卡收银 + 日结封账已有；**退款、找零、提成跨日没有 E2E**

| # | 怎么测 | 期望 |
|---|---|---|
| 3.1 | 发售礼品卡 $100，用卡结一张服务单（小费用现金或 No Tip） | 余额减少；礼品卡不能付小费（产品如此） |
| 3.2 | 部分退款（只退一个项目） | 订单仍可再退剩余；日结净额减少；不是整单标已退 |
| 3.3 | 全额退款（最好隔一个营业日） | **当天**出现负向提成/小费，**不要改写已封账那天的历史** |
| 3.4 | `day_close_ready` 点钞封账，刷新 | 保持 Closed and locked |
| 3.5 | 封账后再开单 | 被拒或只能记到下一营业日（按实现，但必须明确，不能 silently 写进已封日） |
| 3.6 | 重开营业日（填原因） | 审计里有谁、何时、为什么 |
| 3.7 | `/payouts` 看技师提成展开依据 | 空态用 EmptyState，不要假数字 |
| 3.8 | `/business-data` 选今天/昨天 | 跟营业日走；无数据空态，失败有 PageError |
| 3.9 | 已结工单上若还有「补发电子小票 / Send receipt」 | **应失败或按钮不存在**。命令 `ticket.sendReceipt` 已删，路由还在。记缺陷：死按钮。正确路径是打印 |

现金、刷卡、礼品卡、小费四本账在日结页必须能对上你刚才那几张单。

---

### 批次 4 — 技师端 `/tech`

**Seed：** `tech_only`、以及 owner 兼技师（`growth_active` 若有双身份会进门户选择）  
**自动：** 少量组件测，**没有**技师闭环 E2E

| # | 怎么测 | 期望 |
|---|---|---|
| 4.1 | 技师登录只看到 Today / Summary / Profile | 无老板侧栏 |
| 4.2 | 前台派一单后技师 Today 在 ~数秒内出现 | Realtime 或回前台再进；锁屏切回要能对齐 |
| 4.3 | 开始 / 完成 | 与前台队列状态一致 |
| 4.4 | PIN 打卡 上班 → 休息 → 回来 → 下班 | 工时能解释；前台代打卡应记 on behalf |
| 4.5 | 客人手机号 | 打码，如 `917-***-5678` |
| 4.6 | Summary 收入 | 与前台同一笔单，金额一致 |
| 4.7 | Profile 改语言 | 立即换界面；共享设备换人要换语言 |
| 4.8 | 断网 | 只读，点开始不能假装成功 |
| 4.9 | 手机视口 390×844 | 两大按钮可点，无横向滚动 |
| 4.10 | 技师想拒单、自己加项、看本周收入 | **没有这些能力是产品缺口，不是回归失败。** 记 P3/未做，不要当 P0 |

双身份账号必须先选门户，选技师后不能靠 URL 回到 `/settings`。

---

### 批次 5 — CRM、营销、健康表、建站工单

**Seed：** `empty_shop`、`storefront_pending`  
**自动：** 几乎没有页面级 E2E

| # | 怎么测 | 期望 |
|---|---|---|
| 5.1 | `/customers` 搜索、建档、改过敏/偏好 | 保存后重进还在；过敏英文 placeholder 在非英语下记 i18n bug |
| 5.2 | 合并两个客人 | 预约/工单跟过去，不能丢单 |
| 5.3 | `/marketing` 礼品卡 tab | 与批次 3 一致 |
| 5.4 | 次卡 / 优惠券 / 积分（有 UI 就走一遍保存） | 失败要报错；Coming soon 的模块必须写「即将上线」而不是像坏了 |
| 5.5 | `/health-forms` 看模板、发布新版 | 老提交仍指向旧版 |
| 5.6 | 生成分享链接 / 二维码，无痕窗口打开 `/forms/:key` | 能签、能提交；提交后再打开失效 |
| 5.7 | 登录后打开提交详情 | 留访问审计；技师无 `customer.view_health_form` 时看不到明文 |
| 5.8 | `/storefront-builder` | 这是工单不是网站编辑器。提交 brief 成功即可；不要期望拖拽生成网站 |
| 5.9 | `/rooms` 建房、容量>1 | 两个人能同时占用到容量上限，超了被拒 |

**假数据嗅探：** 仪表盘、经营分析、薪资、通话、消息，无数据时必须是空态。出现「Lisa Park」但 seed 里没有 = 假数据回归。

---

### 批次 6 — 沟通：邮件、短信、来电、通知

**Seed：** `growth_active`、`ten_dlc_pending`  
**自动：** API 单测多，UI E2E 少  
**产品边界：** SMS 可以整批标「通道未开」；邮件应能在测试收件箱看到。

| # | 怎么测 | 期望 |
|---|---|---|
| 6.1 | 建预约后查 `email_outbox` / 测试收件箱 | 有确认邮件（或明确失败，不沉默） |
| 6.1b | 约在「明天」的单，等提醒 job 或把时钟拨到触发窗口 | API `main.ts` 会跑 `startReminderJob`。没有 BullMQ。该来的提醒没来、时区错了都记缺陷 |
| 6.2 | `/unsubscribe` GET 再 POST | GET 不改状态；POST 幂等；数据库挂了不能谎称退订成功 |
| 6.3 | 设置里通知模板 | 保存、禁用规则；营销邮件入口应为 Coming soon |
| 6.4 | `/messages` 若 SMS 未开 | 清楚说明 10DLC，不要「已提交运营商」这种假状态（内部 pending ≠ 承运商受理） |
| 6.5 | `ten_dlc_pending` 店家提交 → 平台 Mark under review | 文案是「GenieFront 已收到」 |
| 6.6 | `/calls` | 无通话时空态；有草稿才能确认成预约。AI **不能**改期/取消 |
| 6.7 | `/notifications` 标记已读 / 全读 | 顶栏未读数跟着变 |
| 6.8 | 邮件语言 | 跟门店/客人 locale，不要全是英文或全是中文 |

真 Telnyx 电话：**单独约时间**，不放进日常批。没有号码就跳过 6.6 的「打进店里」部分，只测空态和权限。

---

### 批次 7 — 公开表面：营销站、托管预约、iPad

这三端 **Playwright 基本没手感**，是上线前最该手测的。

#### 7A 营销 `pnpm dev:marketing` → `:5180`

| # | 怎么测 | 期望 |
|---|---|---|
| 7A.1 | 首页价格 | Essential $99，Growth $199。没有 Starter/Enterprise/$169 |
| 7A.2 | 点 CTA（可 mock 或真 Stripe TEST） | 进 Checkout；cancel 回 `/signup/cancel` 且说没有建店 |
| 7A.3 | `/signup/success` 不带 session | 无效 / 未验证，**不能**显示付款成功 |
| 7A.4 | 法律页 terms/privacy/sms | 能打开，语言切换不 404 |
| 7A.5 | 五语言切换 Hero/定价 | 抽查韩语、西语 |

#### 7B 预约 `pnpm dev:booking` → `:5176/{slug}`

用有 slug 的 active 店（seed 或设置里 Hosted booking 卡片上的 URL）。

| # | 怎么测 | 期望 |
|---|---|---|
| 7B.1 | 错 slug | 未找到门店，不要空白崩溃 |
| 7B.2 | 选服务 → 技师（含任意）→ 时间 → 填写 → 确认 | 预约出现在 desk 日程 |
| 7B.3 | 过营业时间 / 已满 | 不能约上 |
| 7B.4 | 语言切换 | 步骤条和按钮翻译；不要整页英文锁死 |
| 7B.5 | 管理链接 `/l/{slug}#g/{token}` | **先看 `BOOKING_MANAGE_PAGE_ENABLED`**。关着时邮件里不应出现管理链。开着时改期/取消只动自己的预约，刷新不串到上一份 token（FE-AUD-01 回归） |
| 7B.6 | 手机宽度 | 步骤可点，键盘不挡主按钮 |

没有 Turnstile 密钥时记录「本地跳过验证码」，生产必须用真验证码再测一次防刷。

#### 7C iPad `pnpm dev:ipad`

需要在 desk 设置里发配对码。

| # | 怎么测 | 期望 |
|---|---|---|
| 7C.1 | 未配对 | 强制 `/pair` |
| 7C.2 | 配对成功 | 进主页；再打开 `/pair` 应回主页 |
| 7C.3 | 预约签到：当天有约的手机号 | 打码姓名；非当天客人查不到（防挖客） |
| 7C.4 | Walk-in **两个人**不同项目 | **两个客人都在队列，服务不能被最后一个人覆盖**（UI-AUD-04 回归） |
| 7C.5 | 健康表签名提交 | desk 能看到提交；答案不是明文 SQL |
| 7C.6 | 3 分钟不操作 | 回首页并清空 |
| 7C.7 | 断网提示 | 有，不白屏 |
| 7C.8 | 中/英/越 走 7C.4 | 题目语言正确 |

---

### 批次 8 — 计费与真 Stripe（TEST 模式）

**Seed：** `essential_trial`、`growth_active`、`past_due`  
**自动：** UI 被 mock 过；真钱路径见 `COMMERCIAL_E2E.md`

手测分两档。

**8A 不打 Stripe（每次都做）**

| # | 怎么测 | 期望 |
|---|---|---|
| 8A.1 | Essential trial 打开 Settings → Billing | 套餐是 Essential，额度是试用 150/20，不是 Growth、$169、假发票 |
| 8A.2 | Growth active | 真卡后四位或「有支付方式」；额度 1200/500 |
| 8A.3 | past_due | 明确欠费；改价目表/建预约应被冻（至少 API 冻，UI 要有人话） |
| 8A.4 | 不要出现 Starter / Enterprise 切换卡 | 点了不能本地把套餐改成 active |

**8B 真 Stripe TEST（改价、换 webhook、换邮件商、准备指流量之前必做）**

按 `COMMERCIAL_E2E.md` 重跑：marketing Checkout → webhook → 激活 → claim → setup → desk billing。  
Checklist：`STRIPE_PRICE_ESSENTIAL` / `GROWTH` 与 Dashboard 一致；只有 API 吃 webhook；`APP_BASE_URL` 在 Auth 回调白名单。

**不要在生产 sk_live 上练。**

---

### 批次 9 — 平台后台

**Seed：** `platform_operator`、`revoked_platform_operator`、`support_request_open`  
**自动：** 准入 + 支持单 + 10DLC 片段

| # | 怎么测 | 期望 |
|---|---|---|
| 9.1 | 店主登录平台 URL | 拒绝 |
| 9.2 | 被撤销运营 | 拒绝 |
| 9.3 | 活跃运营刷新后仍在 | 保持登录 |
| 9.4 | 打开一家店详情 | 只能看到这家，不能改 Stripe id |
| 9.5 | 支持单留言并解决 | 店家 desk `/support` 看得到状态；运营备注店家不可见 |
| 9.6 | `/email` `/test-inbox` | 能看出发件失败原因，不泄露 API key |
| 9.7 | 建站工单列表 | 能打开 `storefront_pending` 那条 |

平台英文 UI 可接受，崩了或数据串租户不可接受。

---

### 批次 10 — UI / 响应式 / 多语言扫屏（专门找「说不好」的那类 bug）

不测新功能，只扫「能用但脏」。

**视口：** 1280×720、820×1180、390×844  
**语言：** zh-Hans、en、再抽 ko 或 es  
**页面清单（web）：** 批次 7 以外，把侧栏每一项点开：

Dashboard, Schedule, Queue, Checkout, Tickets, Customers, Marketing, Rotation, Rooms, Employee Performance, Business Data, Day Close, Payouts, Calls, Messages, Communication Logs, Storefront, Health Forms, Settings 各 tab, Support, Profile, Notifications, Tech 三页。

每页问：

1. 有横向滚动吗？
2. 主按钮在手机上能点吗（≥ 约 44px）？
3. 标题/按钮是当前语言吗？还是中英夹杂、韩语里冒出中文兜底？
4. 空态、加载、失败、无权限，四种是不是四种样子？
5. 日期是营业日还是你电脑的今天？
6. 金额是 `$51.75` 这种，还是浮点 `51.749999`？

iPad / booking / marketing 各扫一遍。

**Settings 各 tab 不要漏：** 门店资料、营业时间、在线预约 slug、硬件/kiosk 配对、员工、通知、billing、10DLC。Hosted booking URL 点开应等于批次 7B 用的地址。

---

## 5. 严重级别（记缺陷时用）

| 级 | 含义 | 例子 | 上线 |
|---|---|---|---|
| P0 | 钱/权限/租户写错，或假实装让前台以为写入成功 | 不经 Stripe 开通付费；填了加项提交丢了；A 店看到 B 店客人 | 不能上 |
| P1 | 主路径走不通或对客人/老板撒谎 | 向导保存不前进；billing 显示错误套餐；完工按钮无反应 | 不能指营销流量 |
| P2 | 主路径能走，但明显错或某语言不可用 | placeholder 全英文；韩语按钮溢出；管理页 token 串单 | 可内测，要进清单 |
| P3 | 丑、文案、少用入口 | 平台 Loading…、社区占位 | 不挡内测 |

产品决策不要当 bug：纯记录收银、无顾客账号、SMS 未开、建站是工单、营销邮件 Coming soon、无 iOS App。

---

## 6. 建议的两周节奏

| 日 | 批 | 谁 |
|---|---|---|
| D1 | 0 自动门 + 修环境 | 你或开发 |
| D2 | 1 登录开店权限 | 你 |
| D3–D4 | 2 核心闭环（中文+英文） | 你，真店节奏 |
| D5 | 3 钱 | 你 |
| D6 | 4 技师端手机 | 你，真机最好 |
| D7 | 5–6 CRM/表单/邮件 | 你 |
| D8 | 7 营销+预约+iPad | 你 |
| D9 | 8A 计费 UI；若准备上线加 8B | 你 |
| D10 | 9 平台 + 10 扫屏（含韩语） | 你 |

一批里自动已覆盖的条目，人手做 **一次 happy path + 一次你觉得会坏的边** 即可，把时间留给 Queue 弹窗、预约页、iPad 多客人、五语言扫屏。

---

## 7. 手测记录模板

```
批次:
场景 / 账号:
语言 / 视口:
步骤:
期望:
实际:
级别: P0/P1/P2/P3 / 非缺陷（产品决策）
截图:
```

不要只说「预约有 bug」。写：seed、URL、点了哪个按钮、网络 4xx、屏幕上的字。
