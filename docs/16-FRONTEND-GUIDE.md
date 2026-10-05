# 16 · 前端系统开发指南与交接

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](qa/TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


> **前端开发规范与契约仍以本文为准。** 现行端点、路由和进度地图见 [`CURRENT-ARCHITECTURE.md`](CURRENT-ARCHITECTURE.md)；怎么测见 [`qa/TEST-PLAYBOOK.md`](qa/TEST-PLAYBOOK.md)。
> 下文表格里 `apps/ipad` 已不是占位骨架（门口 Kiosk 可跑），`apps/ios` 仍是空壳。公开预约是独立应用 `apps/booking`，营销站是 `apps/marketing`。
>
> 接口细节查阅 [18-API-REFERENCE.md](18-API-REFERENCE.md)。

---

## 1. 快速启动与环境

```bash
pnpm dev:api:local
pnpm dev:web:local
pnpm db:seed local       # 首次创建最小手工 QA baseline；重复运行保留现有数据
```

### 当前测试账号

local 使用 `qa-local-owner@example.test`、`qa-local-desk@example.test`、`qa-local-tech@example.test`、`qa-local-setup@example.test`；密码见 `.env.local` 的 `GF_BASELINE_PASSWORD`。staging 对应 `qa-staging-*`，使用独立密码。

平台管理员保留原账号。完整清单、生产保护范围与隔离回归 seed 说明见 [TEST_ACCOUNTS.md](qa/TEST_ACCOUNTS.md)。

开店向导使用 `qa-local-setup@example.test` / `qa-staging-setup@example.test`。baseline 重跑不会将完成开店的店重置回 setup；需要重复破坏性场景时，在隔离库使用 `qa:seed fresh_owner`。旧 `setup:test:reset` 仅允许独立本机/CI 测试库。

### 首次开店的路由门禁

- `locations.status = 'setup'` 是唯一事实源。会话还原并选定门店后，`SessionGate` 只挂载独立的 `/setup` 路由；`/dashboard`、`/settings`、`/tech/*` 以及其他后台深链接统一重定向回 `/setup`。
- `/setup` 不挂载后台 `Layout`，也不提供“稍后进入后台”的链接。向导只包含门店资料、项目价格、员工接单能力、正式开店四项营业必需信息。
- 网站主页、通知提醒、AI 电话、品牌素材和高级系统设置不会阻塞首次开店；页面只说明这些能力会在开店后从后台继续添加。
- 点击“正式开店”仍由 `location.finishSetup` 在服务端重新检查门店资料、营业时间、启用项目和可接单员工；成功后刷新门店列表并自动进入后台。刷新或换设备不会依赖浏览器里的假进度。
- 已完成门店访问 `/setup` 会被导向当前工作台；设置状态变回 `setup` 时，下一次登录或会话恢复再次执行门禁。

⚠️ **有演示单据的日期是 `2026-08-25` ~ `2026-08-28`**，拿今天去试会看到空日历。可通过 `GET /v1/desk/days?from=&to=` 查询有数据的日期。

---

## 2. 前端架构体系（按终端形态收敛：Web / iOS / iPad）

前端统一按终端形态划分为 **Web 统一端、iOS 移动端、iPad 平板端** 三大客户端，无需按职位/角色拆分子工程：

| 目录 | 定位 | 技术栈 / 状态 |
|---|---|---|
| `apps/web/` | **统一 Web 前端**。覆盖桌面浏览器、手机 Web、平板 Web，自适应响应式布局，内部按登录角色与权限（RBAC）动态切工作台（前台调度、老板看板、技师排班、自助签到） | Vite + React 19 + Tailwind v4 + HeroUI + TanStack Query · **当前主做，Phase 0 已接真数据** |
| `apps/ipad/` | **iPad 平板端**。前台触屏调度 / 门口常驻自助签到 Kiosk 与健康表 | 触屏交互大屏 · 占位骨架 |
| `apps/ios/` | **iOS 移动端**。技师移动端接单打卡 / 老板移动轻量看板 | 移动端原生/跨端 App · 占位骨架 |
| `apps/api/` | **Fastify 后端服务**。命令总线 + 业务引擎 + Supabase 代理 | Fastify + Supabase + 命令总线 |

---

## 3. 前后端交互契约

### 3.1 登录与选店流程（`/v1/me/*`）

1. **登录方式**：走 Supabase Auth（邮箱密码 / Google 登录），获得 Access Token。
2. **获取可进入门店**：
   ```http
   GET /v1/me/locations        Authorization: Bearer <token>
   → { "locations": [...], "claimable": { "locationId": "...", "shopName": "..." } }
   ```
   - `locations` 为空且 `claimable` 存在 → 引导点击认领门店并调用 `POST /v1/setup/claim` 进入开店向导。
   - `locations` 多条 → 渲染选店器。
   - `locations` 1条 → 直接进入该门店。
3. **获取当前门店上下文**（必传选中的 `X-Membership-Id`）：
   ```http
   GET /v1/me/context          Authorization + X-Membership-Id
   → { "membershipId": "...", "locationId": "...", "timezone": "America/New_York", "permissions": ["appointment.read", ...] }
   ```

### 3.2 读写分离原则

- **读操作**：走各自领域的 REST 查询路由（如 `GET /v1/desk/day`、`GET /v1/desk/tickets`、`GET /v1/desk/customers`）。
- **写操作：一律且必须走命令总线（Command Bus）**：
  ```http
  POST /v1/commands/<command.name>
  Authorization: Bearer <token>
  X-Membership-Id: <membershipId>
  Idempotency-Key: <UUID>
  Content-Type: application/json

  { "input": { ... } }
  ```
  - **幂等键（Idempotency-Key）**：`ticket.close`、`appointment.create`、`queue.join` 为必填。用户单次意图必须复用同一个 Key，自动重试复用旧 Key，用户主动重试换新 Key。
  - 前端封装统一使用 `runCommand(name, input, membershipId, idempotencyKey)`。

### 3.3 错误处理模式
后端返回统一错误结构：`{ "error": { "code": "...", "message": "...", "details": {...} } }`。
- `message` 已本地化，可直接人话提示。
- 软冲突（如 `STAFF_OVER_CAPACITY`、`OUTSIDE_BUSINESS_HOURS`）需检查顶层 `overridable: true`，弹窗收集原因后带 `override.reason` 与原幂等键重新提交。

---

## 4. 六大硬性开发规范

1. **写操作一律走命令总线**：严禁在页面中直接 `POST` 业务接口。
2. **控制按钮显隐必须用权限（Permission），严禁用角色（Role）**：
   - 实际权限 = 角色预设 ∪ 个别授予 − 个别撤销。老板可单独撤销某人的折扣权限而不改变其角色。
   - 必须使用 `useCan('<permission>')` 或 `<GuardedButton permission="..." />` 控制入口显隐。
3. **时间一律按门店时区**：绝不使用浏览器本地时区。统一使用 `lib/time.ts`（复用 `@gf/scheduling` 纯函数，严格处理 DST 夏令时转换）。
4. **金额一律整数分（Cents）**：绝不使用浮点数。使用 `features/checkout/api.ts` 的 `dollarsToCents` / `centsToDollars`，多余小数位截断而非进位。
5. **UI 层级与样式隔离**：
   - `<main>` 容器配置 `isolation: isolate`。
   - 跨层浮层（弹窗、抽屉、下拉）必须使用语义层级（`z-dropdown`, `z-drawer`, `z-modal`）并通过 `ui/Modal` 或 `ui/Portal` 传送至外层。行内操作菜单统一使用 `ui/ActionMenu`。
6. **文案一律走 i18n 多语言**：使用 `t('key')`，key 统一在 `src/i18n.ts` 中维护（五种语言 zh / en / ko / es / vi 必须齐全）。门店名、服务名等业务数据不进 i18n。

---

## 5. 真实数据避坑指南（11 大陷阱）

| # | 陷阱场景 | 真实表现与处理方案 |
|---|---|---|
| 1 | **前台员工不参与排班** | `/v1/desk/day` 返回的 `staff` 包含前台（`isBookable: false`）。日程表按技师分列时必须过滤，否则产生多余空列。 |
| 2 | **营业时间外单据** | 时间轴范围不能写死（如 08:00-22:00）。必须由 `features/schedule/gridBounds.ts` 动态计算「营业时间 ∪ 当日全部单据」推导显示范围。 |
| 3 | **结账总额包含小费** | `ticket.close` 的 `amountCents` 必须严格等于 `服务金额 - 折扣 + 小费`。界面上应分别采集基础金额与小费，由系统计算实收。找零转小费需标记 `keepChange: true`。 |
| 4 | **金额为 null 不等于 0** | 无报表权限时 `avgSpendCents` 等返回 `null`。必须显示「无权限查看」，严禁显示为 `$0` 导致误判。 |
| 5 | **客户列表分页结构** | 接口返回 `{ total, rows }`，`total` 为符合条件的总数。支持手机号后四位搜索（后端支持）。 |
| 6 | **健康表读取必须审计** | 查看健康表内容会触发 `form_access_log` 写入。列表页只展示索引，不得预取正文，必须由用户显式点击后再发起查询。 |
| 7 | **下架服务的历史单据** | `items[].serviceId` 可能不在当前有效服务列表。回查不到时必须使用单据自带的快照字段 `serviceName` / `durationMin`。 |
| 8 | **未配营业时间的新店** | `business_hours` 未配置时返回 `isOpen: true` 但 `openMin: null`。未配置不等于不营业。 |
| 9 | **软容量冲突判定** | 判断是否需要弹窗确认需读取顶层的 `err.overridable`，而非子项内部。硬冲突（房间冲突）绝不可覆盖。 |
| 10 | **取消预约必须声明轮牌状态** | `appointment.cancel` 的 `keepStaffTurn` 字段必填无默认值，必须在 UI 界面显式要求前台勾选是否保留技师轮牌顺序。 |
| 11 | **预约状态不可随意修改** | 预约没有通用状态变更命令。爽约通过 `appointment.cancel` + `reason: 'no_show'` 表达；完成通过结账流程推进。 |

---

## 6. 当前进展与路线图（对标 Kuee）

### 6.1 阶段 0（已全部完成，全绿基线）
- 质量基线：`typecheck` 0 错误，29 项单元测试全绿。
- 已对接真数据页面：**登录/选店、日程日历、排队队列、收银结算、客户管理**。
- 其余 14 个页面带 `ui/SampleDataNotice` 示例数据横幅。

### 6.2 阶段 1 待办优先级（对标 Kuee 简化与深耕）
1. **设置中心重构（P9）**：收敛侧栏 20 项，将配置类页面归拢至二级设置中心（System Settings），日常主界面只保留 5 个核心入口。
2. **散客与快速开单（P6 剩余）**：Walk-in 一键落单，无弹窗 30 秒极速开单。
3. **差异化核心（P13/P14）**：轮牌板（Turn Board）与日结 Z 表（Day Close）接通真实数据。
4. **客显屏与自助签到联动（P16/P17）**：WebRTC 客显屏配对与 iPad 自助签到流打通。
