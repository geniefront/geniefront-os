# GenieFront OS

美国市场亚裔服务业门店管理系统（nail / massage / foot spa / 头疗 / 美睫）。
目标 1000 家门店，AI 驱动的前台，多语言。

> 📖 **完整文档在 [`docs/`](docs/)。接手先读 [`docs/10-HANDOFF.md`](docs/10-HANDOFF.md)**，
> 它把「现在在哪、下一步做什么、哪些坑别再踩」压在一份里。
> **写代码前必读 [`docs/03-ROADMAP.md`](docs/03-ROADMAP.md) §A 已定决策 + §D 项目宪法** ——
> 那 19 条是这个仓库的物理法则。

---

## 现在能跑什么

| | |
|---|---|
| **Phase 0** | ✅ 命令总线、强制 RLS、审计、多店身份 |
| **Phase 1a** | ✅ 轮牌板、日程、开单、结账、小费、开店配置、断网看板 |
| **Phase 1b** | ✅ 提成引擎 + 收入看板、打烊日结对账、现金小费发放、排班 + 报表 CSV |
| **Phase 1c** | ✅ 技师端 PWA、Realtime 派单（实测 2 秒）、PIN 打卡 |
| **Phase 2** | 🚧 拍照开店 ✅、Yelp ✅、Kiosk ✅、Stripe 计费 ✅、AI 前台副驾 ✅、**官网在线预约 ✅（含现成的预约页）**、AI 电话（代码 ✅ 卡开户）、**健康表全链路 ✅**（生成/存储/同步/分享，docs/15） |
| **前台界面** | ✅ 30 个屏全部走同一套组件（`apps/desk/src/ui/`）—— 老的 `.btn`/`.card`/`.badge` 那套 CSS 已经退役 |
| **测试** | **704 项**，13 个包，`pnpm verify` 全绿 |

---

## 上手

```bash
pnpm install
cp .env.example .env          # ⚠️ 真实凭据不在仓库里，见 docs/07-CREDENTIALS-CHECKLIST.md
bash scripts/check-env.sh     # 凭据格式 + 实测联通性
pnpm verify                   # 宪法检查 + typecheck + 704 项测试
```

跑起来：

```bash
pnpm --filter @gf/api dev   # API 后端       → localhost:3000
pnpm --filter @gf/web dev   # 统一 Web 前端   → localhost:5177
```

---

## 仓库结构

```
apps/
  api/        Fastify。命令总线、RLS 上下文、Telnyx webhook、Kiosk 设备认证
  web/        统一 Web 前端（React 19 + Tailwind v4 + HeroUI + TanStack Query）
              覆盖桌面端高信息密度操作、老板报表、技师排班、自助签到，按角色权限切界面
  ipad/       iPad 平板端（前台触屏调度 / 自助签到 Kiosk）
  ios/        iOS 移动端（技师接单打卡 / 老板移动看板）
packages/
  contracts/  命令 Zod schema + 权限 + 错误码 —— 前后端唯一真源
  db/         Drizzle schema + drizzle/ 自动迁移 + sql/ 手写 RLS 与触发器
  scheduling/ 排期引擎（纯函数）
  rotation/   轮牌引擎（事件溯源，纯函数）
  payroll/    提成、小费、日结、预充值余额（纯函数）
  ai/         Claude Vision 价目表提取
  yelp/       Yelp 店信息映射（刻意不过模型）
deploy/       双 VPS 滚动更新 + Cloudflare LB
docs/         ⭐ 全部设计文档与交接
```

---

## 四条贯穿全仓库的规矩

摘自 `docs/03-ROADMAP.md` §D 项目宪法，改动前先读那一份完整的 19 条。

1. **每一次写库都是一条具名命令**，走 `dispatch()`：Zod 校验 → 权限 → 幂等键 → 审计。
   没有绕过总线的写入路径。
2. **强制 RLS。** 每张带 `org_id` 的表都有 `tenant_isolation`；应用以受限的
   `app_user` 连接，靠 `withTenant()` 的 `SET LOCAL` 划定租户。
   **应用运行时永远不需要能绕过 RLS 的凭据。**
3. **钱一律整数分**，百分比用基点（bp），AI 成本用毫分。全仓库不出现一次浮点算钱。
4. **AI 的产出在被人勾中之前，不产生任何真实记录。** 视觉提取落
   `shop_blueprints` 草案，来电落 `call_drafts` 队列，都要人确认后才通过命令总线落地。

---

## 安全

- **`.env` 已 gitignore，真实密钥从不进仓库。** 仓库里只有 `.env.example` 占位符。
- **健康表答案是 AES-256-GCM 应用层加密的**（`FORM_ENCRYPTION_KEY`），
  进数据库之前就已是密文 —— RLS 挡不住整库被复制走。
  ⚠️ **这把密钥丢了 = 所有已签的健康表永久解不开。**
- **看一眼健康表的内容会留一条痕**（`form_access_log`：谁、什么时候、
  因为什么、从哪个 IP）。要权限 `customer.view_health_form`，技师没有。
- 生产环境的 service_role key 与加密密钥只进 GitHub Actions Secret，不落任何 `.env`。

---

私有仓库，版权所有。
