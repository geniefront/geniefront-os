# GenieFront OS — 规划与交接

美国市场的亚裔服务业门店管理系统（nail / massage / foot spa / 头疗 / 美睫）。
目标：1000 家门店，AI 驱动的前台，多语言。

**这份文档就在代码仓库里**（`docs/`），代码在仓库根的 `apps/` 与 `packages/`。

⚠️ **凭据不在仓库里。** 真实密钥只在本地的 `.env`（已 gitignore）与 CI Secret 中，
仓库里只有 `.env.example` 的占位符。要哪些 key、去哪申请、怎么验，见
[07-CREDENTIALS-CHECKLIST.md](07-CREDENTIALS-CHECKLIST.md)。

---

## 当前状态（2026-08-16）

| | |
|---|---|
| **Phase 0** | ✅ 完成 —— 命令总线、强制 RLS、审计、多店身份 |
| **Phase 1a** | ✅ 完成 —— 轮牌板、日程、开单、结账、小费、开店配置、断网看板 |
| **Phase 1b** | ✅ **核心四项完成** —— 提成引擎 + 收入看板、打烊日结对账、现金小费发放、排班周模板 + 报表 CSV |
| **同期补** | 房间多容量（一房多人多技师）、组单合并/分别付款、现金「不用找了」入账 |
| **Phase 1c** | ✅ **完成** —— 技师端 PWA、Realtime 长连接派单（实测 2 秒）、提示音+震动+翻转卡片、锁屏唤醒对齐、PIN 打卡、手机号服务端脱敏、前台在线指示点 |
| **Phase 2** | 🚧 拍照开店 ✅、Yelp ✅、Kiosk ✅、AI 电话（代码 ✅，卡开户）、Stripe（地基 ✅，测试密钥已到位待接线） |
| **生产环境** | `https://api.geniefront.com` 双实例 + Cloudflare LB，故障转移已演练 |
| **测试** | **384 项**，12 个包，`pnpm verify` 全绿 |
| **CI** | GitHub Actions：宪法检查 + 空库迁移 + 测试 + 镜像 ≤200MB + 容器启动 |
| **下一步** | 见 **[10-HANDOFF.md](10-HANDOFF.md)** —— 交接给下一个 session 的完整清单 |

### Phase 2 已完成：AI 视觉拍照开店

老板拍一张墙上的价目表 → Claude Vision 一行一行读出项目名/价格/时长
→ 左原图右表格逐项核对（低置信度标黄、点行框回原图）→ 一键回填成真项目。

**实测**（`packages/ai` + 前台 `📷 拍价目表`）：17 行的 nail 价目表零漏行、
价格全对、加项/说明/改价规则分类全对、`$70 & up` 开放价识别正确、
bbox 点回原图误差几个像素。**单图 ~$0.08、~23 秒**（`05` §5.1 有实测成本表）。

设计上最要紧的一条：**AI 的产出在被人勾中之前，一个项目都建不出来**。
提取结果落在 `shop_blueprints` 草案里，逐项确认后才通过命令总线变成 `services`，
落地后草案封板留档。详见 `05` §4–§5 与 `03` Phase 2。

### Phase 2 已完成：Yelp 一键填店信息

老板输**店名 + 邮编**两个字段 → 从 Yelp 拉回地址、电话、营业时间、评分
→ 逐项勾选 → 填进本店。**这一条刻意不过模型**（`05` §4.1）。

三个坑都有测试兜着：Yelp 的 `day 0 是星期一`（弄反了整张营业时间表错开一天）、
跨午夜的营业时间、以及 **Yelp 不给时区**（九个州横跨两个时区，
时区错了整家店的日结和提成会错一天，所以一律标出来让老板确认）。

### Phase 2 进行中：AI 电话接单（代码已完成，卡在开户）

**A5–A8 的代码全部写完并测试通过（22 项）**：Ed25519 验签、三个 tool、
`findOpenSlots` 排期空档、`ai_call_min` 计费、前台「☎️ 待复核」队列。

⬜ **卡在要人做的四件事**：Telnyx 开户、买号码、建 Assistant、
**口音实测**（`09` §4.3 的六个场景）。号码一到位、`.env` 填上
`TELNYX_PHONE_NUMBER` / `TELNYX_ASSISTANT_ID`，在开店配置里绑上号码就能通。

⚠️ **一条与原设计不同的决定**：AI **不建**预约草案，只写一张独立的
`call_drafts` 队列 —— AI 建的预约会占住日程表上的位置，一通没听清的电话
就能把周六下午卡掉一格。前台点确认时才走**她自己身份下的** `appointment.create`。
于是就算验签被绕过，攻击面也只到「往待办里塞垃圾」为止。

### Phase 2 已完成：Kiosk 门口端

iPad 自助签到 + **六语言**电子免责书签名 + 排队取号。**实测**用越南语走完整条路：
表单题目/选项全越南语、手写签名 18KB、答案密文入库、`locale='vi'` 留档。

两件值得单独说的：

**健康表答案是 AES-256-GCM 应用层加密的。** RLS 挡的是应用里的越权，
挡不住把整个库复制走的人 —— 备份泄露、误配的只读副本。健康数据泄露一次是永久的，
所以它在**进数据库之前**就已经是密文（密钥在环境变量，`FORM_ENCRYPTION_KEY`）。

**签到刻意不是一个客户查询接口。** 只在当天有预约的人里面找、只返回打码的名字、
每台设备限频。查全表的话，站在门口输一串号码就能知道谁是这家店的客人。

⚠️ **门口 iPad 记得开引导式访问**（设置 → 辅助功能），不然客人一个误触就退出到桌面。

### Phase 2 进行中：Stripe 计费（地基完成，卡在测试密钥）

`billing_accounts` / `credit_ledger` / `stripe_events` 三张表 + **账本只追加**
（连 update 都收回，冲账要写反向记录）+ 24 项纯函数测试：
自动续充三档 $50/$100/$200、续充冷却（防把客户的卡刷冻）、余额允许为负。

✅ **测试密钥已到位**（`sk_test_51U5…`）。`STRIPE_WEBHOOK_SECRET` 还空着 ——
本地跑 `stripe listen --forward-to localhost:3000/v1/stripe/webhook` 会打印出来。

⬜ **接线还没做**：webhook 验签路由、几条命令、扣费接进 `usage_events`、
自动续充的触发点、前台「订阅与余额」页签。步骤在 `10` §3.A。

### 剩余（不阻塞种子店试用）

**1b**：排期引擎完整版（技能/双技师/缓冲/处理时间重叠）、日程表拖拽改期、请假审批流、
邮件提醒 + BullMQ、客户 CSV 导入、落单要素界面。

**1c**：共享 iPad 的设备令牌登录（技师目前用自己邮箱登录）、手机号 OTP、
防代打卡（拍照/Wi-Fi/地理围栏）、换班审批、紧急按钮。

**2**：拍照开店的大牌子两遍分块提取、项目名多语言自动补齐；
AI 电话的开场录音告知与转人工；官网 URL 提取；AI 前台副驾；
Stripe 接线（等测试密钥）。

---

## 文档

| 文档 | 内容 |
|---|---|
| [00-DISCOVERY.md](00-DISCOVERY.md) | 行业发掘：前台一天的真实动作、轮牌/点钟制、小费法律、落单要素 |
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 架构：托管状态层 + 无状态双实例、命令总线、容量三层、三大引擎 |
| [02-DATA-MODEL.md](02-DATA-MODEL.md) | Postgres 数据模型：全部表、RLS、多店/一人多角色、落单要素 |
| [03-ROADMAP.md](03-ROADMAP.md) | **已定决策 24 条 + 项目宪法 19 条**（写代码前必读）+ 分期 |
| [04-OPERATIONS-RISKS.md](04-OPERATIONS-RISKS.md) | 产品之外会让项目失败的：获客、硬件、单位经济、AI 护栏、竞争 |
| [05-AI-INTEGRATION.md](05-AI-INTEGRATION.md) | 规则即 JSON、对话开店、**价目表视觉提取（已实现，含实测成本）**、模型选型与成本 |
| [06-EXTERNAL-SERVICES.md](06-EXTERNAL-SERVICES.md) | 外部依赖与密钥清单 |
| [07-CREDENTIALS-CHECKLIST.md](07-CREDENTIALS-CHECKLIST.md) | ⭐ **凭据在哪、怎么验、格式对不对** |
| [08-SEED-STORE-TRIAL.md](08-SEED-STORE-TRIAL.md) | ⭐ **种子店试用指南**：测试账号、操作步骤、要问的关键问题 |
| [09-TELNYX.md](09-TELNYX.md) | ⭐ **AI 电话与短信走 Telnyx**：迁移警告、落地方式、口音实测标准、下一步任务清单 |
| [10-HANDOFF.md](10-HANDOFF.md) | ⭐⭐ **交接**：Phase 2 剩下的活、踩过的 8 个坑、定下来别推翻的设计 |

**接手先读 `10`**，它把「现在在哪、下一步做什么、哪些坑别再踩」压在一份里。

**写代码前先读**：`03` §A 已定决策 + §D 项目宪法、`01` §0 架构理念 + §3 命令总线 + §7.1 容量模型。

---

## 给下一个 session 的最短上手路径

```bash
git clone git@github.com:geniefront/geniefront-os.git && cd geniefront-os
pnpm install
cp .env.example .env          # ⚠️ 真实凭据不在仓库里，见 07

bash scripts/check-env.sh     # 所有凭据格式 + 实测联通性
pnpm verify                   # 宪法检查 + typecheck + 384 项测试
pnpm --filter @gf/desk dev    # 前台界面 → localhost:5173
pnpm --filter @gf/staff dev   # 技师端 PWA → localhost:5174（手机浏览器可加到主屏）
pnpm --filter @gf/kiosk dev   # 门口 iPad → localhost:5175
```

**凭据在本地 `.env` 里已配好并实测通过**（该文件已 gitignore，不在仓库中）。
Supabase / Anthropic / Cloudflare / Resend / Turnstile / Upstash / Yelp / Bright Data
都是活的，不用重新申请。**Stripe 测试密钥也已配好**。
缺的只有 **Telnyx 的号码与 Assistant**（要先开户 + 口音实测，见 `09`）。

⚠️ **`FORM_ENCRYPTION_KEY` 丢了 = 所有已签的健康表永久解不开。**
生产那一把只进 CI Secret。

**试用账号**：`mia@example.test` 等，密码 `GenieDev!2026`（见 `08`）。

**部署**：`bash deploy/deploy.sh` —— 滚动更新两台 VPS，任一台不健康就中止。
SSH 别名 `gf-a` / `gf-b` 已配好，免密。

**仓库命名**：`geniefront-os`，应用 `desk` / `staff` / `kiosk` / `api` / `platform`。

**试派单**：前台和技师端同时开着（5173 + 5174，分别登录 `mia@` 与 `linh@`），
前台轮牌板点「派给他 · 开单」→ 技师端 2 秒内响铃翻卡片。
技师端第一次要点一下「🔔 打开提示音」（浏览器要求音频由用户手势解锁）。

**试拍照开店**：前台 →「⚙ 开店配置」→「项目」→「📷 拍价目表，自动建项目」
→ 选一张价目表照片 → 等 ~25 秒 → 逐项核对 → 「建这 N 个项目」。
一次约 $0.08/张，走的是 `.env` 里那把 `ANTHROPIC_API_KEY`。

**试门口 Kiosk**：前台 →「⚙ 开店配置」→「门口 iPad」→ 生成配对码，
另开 `pnpm --filter @gf/kiosk dev`（localhost:5175）粘贴进去。
选语言 → 我没有预约 → 留个称呼 → 签健康表 → 拿号。
健康表答案是加密存的，要看内容得有 `FORM_ENCRYPTION_KEY`。
