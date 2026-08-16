# 10 · 交接：Phase 2 剩下的活

> **写给下一个 session 的 AI。** 2026-08-16 交接。
>
> 先读这一份，再按 §3 挑一件开工。
> 动手前必读 **`03` §A 已定决策 + §D 项目宪法**，那 19 条是这个仓库的物理法则。

---

## 1. 三十秒看懂现在在哪

```bash
cd <仓库根>                  # 本文档在仓库的 docs/ 下
cp .env.example .env        # ⚠️ 真实凭据不在仓库里，见 07-CREDENTIALS-CHECKLIST.md
bash scripts/check-env.sh   # 凭据格式 + 实测联通
pnpm verify                 # 宪法检查 + typecheck + 384 项测试，应当全绿
```

| | 状态 |
|---|---|
| Phase 0 / 1a / 1b / 1c | ✅ 全部完成并部署 |
| **拍照开店**（AI 视觉建项目） | ✅ 完成，实测 17 行零漏行 |
| **Yelp 一键填店** | ✅ 完成，实测 Austin 三家同名店 |
| **Kiosk 门口端** | ✅ 完成，实测越南语走完整条路 |
| **AI 电话接单** | 🚧 **代码全完**，卡在 Telnyx 开户 + 口音实测 |
| **Stripe 计费** | 🚧 **地基全完**，测试密钥刚到位，**接线没做** |

**测试 384 项**，12 个包。分布：
`api 153` · `payroll 80` · `scheduling 51` · `ai 26` · `db 26` · `rotation 24` · `yelp 20` · `contracts 4`

⚠️ **工作区有 69 个未提交的改动**（`git status`）。这一整轮 Phase 2 都没提交过 ——
接手第一件事建议是读一遍 diff 然后分几个 commit 落下去，别在未提交的状态上继续堆。

---

## 2. 这一轮做的东西在哪

### 新增的包

| 包 | 干什么 | 要点 |
|---|---|---|
| `packages/ai` | 价目表视觉提取 | strict tool use + 两层校验；纯函数归一化/去重有测试 |
| `packages/yelp` | Yelp Fusion 映射 | **纯代码不过模型**；三个坑全有测试（见下） |
| `apps/kiosk` | 门口 iPad | 六语言、纯触屏、无快捷键 |

### 新增的表（迁移 0014–0018 已全部应用到 dev 库）

| 迁移 | 表 | 关键约束 |
|---|---|---|
| `0014_blueprint` | `shop_blueprints` `blueprint_sources` `blueprint_items` | 落地后**封板**触发器 |
| `0015_phone` | `phone_lines` `phone_calls` `call_drafts` | **号码维度解析策略**（不绕 RLS） |
| `0016_kiosk` | `walkin_queue` `form_templates` `form_submissions` `form_access_log` | 健康表**不可删只可匿名化**；模板发布后不可改 |
| `0017_phase2_permissions` | —— | 把新权限补给已有预设角色 |
| `0018_billing` | `billing_accounts` `credit_ledger` `stripe_events` | 账本**连 UPDATE 都收回** |

### 新增的命令

`blueprint.*`（6）· `call.*`（3）· `location.savePhoneLine` · `location.applyYelp` ·
`device.issueToken/revokeToken` · `queue.join/update` · `catalog.saveFormTemplate` · `form.submit`

---

## 3. 剩下的活，按建议顺序

### ⭐ A. Stripe 接线（**测试密钥已就位，可立即开工**）

`.env` 现在是 `sk_test_51U5…` / `pk_test_51U5…`。
**`STRIPE_WEBHOOK_SECRET` 还是空的** —— 本地开发用 `stripe listen --forward-to localhost:3000/v1/stripe/webhook`，
它会打印 `whsec_…` 填进去。

**已经写好、不用重做的**：

- `packages/db/src/schema/billing.ts` —— 三张表，注释里写清了每个字段为什么在那儿
- `packages/payroll/src/credits.ts` —— **全部纯逻辑，24 项测试**：
  `shouldAutoTopup()` / `applyEntry()` / `findLedgerBreak()` / `usageChargeCents()`
- `packages/db/sql/0018_billing.sql` —— RLS + 账本只追加 + 值域约束

**要做的**（顺序有讲究）：

1. **`packages/stripe`** 或 `apps/api/src/stripe/` —— 装 `stripe` SDK，薄客户端
2. **webhook 验签路由** `/v1/stripe/webhook`
   - ⚠️ 和 Telnyx 那条一样：**先验签再解析 body**，验的是**原始字节**
   - 照抄 `apps/api/src/telnyx/routes.ts` 的 `addContentTypeParser` 那一段，
     它已经把 `/v1/telnyx/` 前缀的路由留成原文了，加一个 `/v1/stripe/` 分支即可
   - Stripe 用 HMAC-SHA256（不是 Ed25519），SDK 有 `stripe.webhooks.constructEvent()`
   - **幂等靠 `stripe_events` 表**：event id 是主键，插入冲突就说明处理过了
3. **命令**：`billing.createCheckout` / `billing.savePaymentMethod` /
   `billing.topUp` / `billing.setAutoTopup` / `billing.syncSubscription`（内部）
4. **扣费接线**：`usage_events` 落库的地方（`blueprint.saveExtraction`、`call.record`）
   同时写一条 `credit_ledger` 的 `usage` 记录。
   ⚠️ 用 `usageChargeCents(costMillicents, kind)`，**单位是毫分不是分**（见下面的坑）
5. **自动续充的触发点**：**不要**放在扣费那个事务里（Stripe 调用是外部 IO，
   不能进数据库事务）。做成一个查询 + 一条命令：
   `GET 需要续充的账户` → `billing.chargeTopUp`，由 cron 或 webhook 后置调用
6. **前台界面**：开店配置加一个「订阅与余额」页签

**必须守的**：
- 金额只用整数分（宪法第 4 条）
- **绝不碰卡号/CVV** —— 只存 Stripe 的 `payment_method` id。碰一下 PCI 范围就是另一个量级的合规成本
- 扣费**永远走 `credit_ledger`**，不许直接 `update billing_accounts.balance_cents`

### B. AI 电话：开户与口音实测（**要人做，AI 做不了**）

`09-TELNYX.md` §7 线 A 有完整清单。A5–A8 的代码全写完了，
卡的是 **A1–A4**：开户、买号码、建 Assistant、**真打电话测口音**。

三个 tool 的 URL 和参数在 `09` §7 的表里，照着填进 Telnyx 控制台即可。
号码一到位 → `.env` 填 `TELNYX_PHONE_NUMBER` / `TELNYX_ASSISTANT_ID` →
前台「开店配置」里绑号码（命令 `location.savePhoneLine`）→ 就通了。

⚠️ **口音实测的结果要写进 `09` §4.3 下面那张空表**，那是决定要不要把号码全搬过来的唯一依据。

### C. AI 前台副驾（`05` §6，**不依赖任何外部开户，随时可做**）

现成的地基：
- `packages/contracts` 的 `aiToolDefinitions()` 已经能自动导出全部命令给模型
- `usage_events` 的 `ai_assist` 计量已经在跑（拍照开店那条路验证过）
- `packages/ai` 里的 Anthropic 调用样板可以直接抄

要点全在 `05` §6：现场快照压到 1.5k token、系统提示与工具定义打缓存断点、
命令提案卡片 + 人工确认 + 60 秒撤销。

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
生产那一把只进 CI Secret，别进任何 `.env` 文件之外的地方。

### 5.5 「不确定」比「猜一个」有用

- 价目表读不准 → 标黄，**不自动修正**（低于 $1 的价格不自动 ×100）
- 名字匹配不上 → 留空 + **保留原话**，不做编辑距离
  （`gel manicure` 和 `gel removal` 距离很近，价格差一倍）
- 同号多客户 → **全部列出让人选**，绝不自动挑第一个（决策 21）
- Yelp 时区推不准 → 标 `needs_confirm` 强制老板看一眼

一条共同的理由：**静默的错误比明显的空白危险得多**。前者没人会发现。

---

## 6. 试一遍三条新路（都不用外部开户）

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
