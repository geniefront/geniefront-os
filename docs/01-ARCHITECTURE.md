# 01 · 系统架构（托管状态层 + 无状态双实例应用）

> 目标：1000 家门店（约 10k–15k 日活员工、10 万+ 预约/日）。
> 但 10 万预约/日分散在 12 小时营业时间里是 **约 2.3 写/秒**，峰值也就几十 QPS。
> 这个量级的正确答案是 **把有状态的东西全部托管出去，应用层做成可随时重启的无状态进程**，
> 而不是自建多活集群。集群留到真的有流量再说（Phase 4）。

---

## 0. 设计理念：状态托管，应用无状态

**一句话：我们不运维 Postgres，不运维 Redis Pub/Sub，不自己做 WebSocket 扇出。**

| 关注点 | 方案 | 为什么 |
|---|---|---|
| **数据库** | **Supabase 托管 Postgres 17**（单区 + PITR + 每日备份） | 备份、PITR、主从由平台负责。自管 Postgres + 每日 `pg_dump` 是现阶段最大的数据丢失风险 |
| **认证** | **Supabase Auth**（邮箱 Magic Link / 密码） | 手机 OTP 依赖短信通道，推迟（见 `03` 决策 11）。PIN + 设备令牌由我们自己签发受限 JWT |
| **实时** | **Supabase Realtime Broadcast** | 扇出在平台侧完成，**两台应用实例之间不需要任何广播通道** —— 这一条直接省掉整个 Redis Pub/Sub 层 |
| **应用** | **Fastify (Node 22) + Docker**，生产 2 台实例，开发 1 台 | 100% 无状态，任意一台重启用户无感 |
| **入口** | **Cloudflare**：DNS / TLS / WAF / Turnstile + **Load Balancing**（已上线） | 两台实例完全平级，无会话亲和性 |
| **回源 TLS** | **Cloudflare Origin CA 证书**（至 2041），两台共用一张 | 不走 ACME：轮询 DNS 下两台会互抢 HTTP-01 challenge。Full (strict) 用 Configuration Rule **只作用于 api 子域**，zone 默认保持 `full`，否则会打断网页编辑器的源站 |
| **队列** | **仍未引入**（2026-08-18）。⭐ **事务性邮件不需要它** —— 预约确认走 `email_outbox` 表 + 事务提交后直接发（sql/0029）。队列留给**真正需要定时**的那些：提前 24 小时的到店提醒、报表导出、评价抓取 Cron。到那时接 **Upstash Redis + BullMQ**（托管，不自建主从 —— 宪法禁的是**自管**） | 没有定时任务之前，队列是纯负债 |
| **对象存储** | **Supabase Storage**（电子签名、指甲照片、价目表原图） | 和 RLS 同一套权限模型 |

### 明确删掉的东西（早期方案里有，现在不做）

| 删掉 | 理由 |
|---|---|
| 自管 Redis 主从 + 跨节点 Pub/Sub 广播网格 | Realtime 在 Supabase 侧，不存在"连不同机器的人互相收不到"的问题 |
| 自管 Postgres + `pg_dump` 异地归档 | 托管 + PITR；恢复演练照做（`04` §10） |
| BullMQ 分布式 stalled watchdog | Phase 1a 根本没有队列 |
| 多活集群 / 滚动更新编排 / 自建 Nginx 层 | 两台无状态实例，挂一台由 Cloudflare 探针剔除；静态前端直接上 Cloudflare Pages |
| Cloudflare Durable Object | 属于 Workers 体系，本方案不用 Workers |

真正的可用性瓶颈从来不是应用节点，是这两个：

1. **Supabase 单区故障** —— 只能等。写进 SLA，**别承诺 99.99%**。
2. **门店自己那条便宜宽带** —— 解法见 `04` §3：要求装 $30/月 的 4G 备份路由，比写离线写入代码便宜一百倍。

---

## 1. 拓扑

```
                     ┌─────────────────────────────────────────┐
                     │  Cloudflare                             │
                     │  • DNS / TLS / WAF / Turnstile          │
                     │  • Pages：desk / staff / kiosk 静态构建  │
                     │  • Load Balancing + /health 探针（生产） │
                     └───────────────┬─────────────────────────┘
                                     │ HTTPS
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
       ┌────────────────────────┐        ┌────────────────────────┐
       │  应用实例 A (Docker)    │        │  应用实例 B (Docker)    │
       │  Fastify               │        │  Fastify               │
       │  • 命令总线 / 鉴权      │        │  • 命令总线 / 鉴权      │
       │  • scheduling/rotation │        │  • scheduling/rotation │
       │    /payroll 纯函数引擎  │        │    /payroll 纯函数引擎  │
       │  • 100% 无状态          │        │  • 100% 无状态          │
       └───────────┬────────────┘        └───────────┬────────────┘
                   │                                 │
                   └────────────────┬────────────────┘
                                    ▼
            ┌───────────────────────────────────────────────┐
            │  Supabase（托管，单区 + PITR）                 │
            │  • Postgres 17：强制 RLS / 资源排他约束        │
            │  • Auth：邮箱 Magic Link / 密码                │
            │  • Realtime：location:{id} 频道广播            │
            │  • Storage：签名、照片、价目表原图              │
            └───────────────────────────────────────────────┘
                                    ▲
                                    │ Phase 1b 起
            ┌───────────────────────┴───────────────────────┐
            │  Upstash Redis + BullMQ（托管）                │
            │  • 邮件定时提醒、报表导出、评价抓取             │
            └───────────────────────────────────────────────┘
```

**开发环境**：1 台实例。`docker compose` 起 Fastify + 本地 Postgres（迁移与 RLS 与生产同源），Auth / Realtime / Storage 连 Supabase 的 dev 项目。

### 1.1 故障与恢复

| 场景 | 表现 | 机制 |
|---|---|---|
| 一台应用实例宕机 | **用户无感（实测 52 次请求零失败）** | 两层机制，别只指望探针：<br>① **边缘即时重试** —— 回源 TCP 失败时 Cloudflare 立刻换另一台，这是真正兜住用户的那一层<br>② **健康探针剔除** —— 间隔最低 **60 秒**（15 秒要更高档位），配 2 次重试，实际检测要 1–3 分钟<br>因为无状态且实时在 Supabase 侧，不需要任何节点间协调 |
| 部署新版本 | 无感 | 先摘 A → 部署 → 健康后加回 → 再摘 B |
| Realtime 断开 | 1–2 秒指数退避重连，重连后静默增量对齐 | Supabase Realtime 客户端自带；恢复后拉 `GET /desk/floor-snapshot` 对齐 |
| Supabase 故障 | 全站不可用 | 只能等。门店端进入**只读离线看板**（§12） |
| 门店断网 | 页面不关、不遮罩，切只读看板 | §12 |

---

## 2. 技术选型与仓库结构

| 层 | 选择 | 理由 |
|---|---|---|
| 前端 | **React + Vite + TypeScript**，TanStack Query + Tailwind | 极快构建，四端复用设计 Token |
| 静态托管 | **Cloudflare Pages** | desk / staff / kiosk 三个构建产物直接上边缘，不需要自建 Nginx |
| 后端 API | **Fastify (Node 22)** | 吞吐高，全 TypeScript 契约打通。**单进程无状态**，起 2 个实例就是全部的水平扩展 |
| 类型契约 | **Zod schema 定义所有命令与查询** | `packages/contracts` 一处定义，前后端与 AI Tool 三方受益 |
| 数据库 | **Supabase 托管 Postgres 17** + **Drizzle ORM** | 类型安全、原生 SQL 控制力；备份 / PITR 交给平台 |
| 认证 | **Supabase Auth** + 自签受限 JWT（PIN / 设备令牌） | 见 §5 |
| 实时 | **Supabase Realtime Broadcast** | 扇出在平台侧，应用实例之间零协调 |
| 异步队列 | **Upstash Redis + BullMQ**（Phase 1b 起） | 定时提醒、报表导出、评价抓取。Phase 1a 不引入 |
| 部署 | **Docker 镜像**：开发 1 台实例，生产 2 台 | 环境一致；`docker compose` 只用于本地开发 |

**仓库结构（单一 monorepo，pnpm workspace + Turborepo）**

```
geniefront-os/
  apps/
    desk/            # 前台端 + 老板端（同一构建，权限分页面）
    staff/           # 员工端 PWA（Phase 1c）
    kiosk/           # 门口 iPad 自助签到 + 健康表（Phase 2）
    api/             # Fastify：命令总线 + 查询 +（Phase 1b）BullMQ Worker
    platform/        # 平台运营后台（Phase 3）
  packages/
    contracts/       # ⭐ Zod schema：所有命令、查询、事件、错误码与 AI 工具
    scheduling/      # ⭐ 排期与容量引擎（纯函数，无 IO）
    rotation/        # ⭐ 轮牌引擎（纯函数，无 IO）
    payroll/         # ⭐ 小费/提成规则引擎（纯函数，无 IO）
    db/              # Drizzle schema + migrations + RLS 策略
    ui/              # 共享设计系统组件
    i18n/            # 多语言包（en / zh-Hans / zh-Hant / ko / vi / es）
    sdk/             # 前端 API 客户端
  deploy/
    Dockerfile
    compose.dev.yml  # 本地开发：api + postgres
```

`scheduling` / `rotation` / `payroll` 是**纯函数包**：同一份代码被 API、AI 工具、前端预览、单元测试复用。这三个包决定产品好坏，必须有高覆盖率的测试和大量真实案例快照测试。

---

## 3. 核心架构模式：命令总线（Command Bus）

**这是让"AI 能操作整个前台"成立的唯一干净做法。**

```ts
// packages/contracts/commands/appointment.ts
export const RescheduleAppointment = defineCommand({
  name: 'appointment.reschedule',
  input: z.object({
    appointmentId: z.string().uuid(),
    startAt: z.string().datetime(),
    staffId: z.string().uuid().optional(),
    reason: z.string().optional(),
  }),
  permission: 'appointment.write',
  // 给 AI 用的描述 + 是否需要人工确认
  ai: {
    description: '把一个已有预约改到新的时间，可同时换技师',
    confirm: 'always',        // never | destructive | always
  },
  // 用于「撤销」
  reversible: true,
});
```

一个命令的执行管线：

```
入参校验(Zod) → 解析上下文(who/tenant/location) → 权限检查 → 幂等键去重
   → 事务开始 → 业务规则校验（冲突/资源/技能） → 写库 → 写审计日志(before/after)
   → 提交 → 发领域事件 → (Realtime 广播 | Queue 异步副作用)
```

**收益：**
- 前端 UI 和 AI 走**完全同一条路**，不存在"AI 有后门"
- AI 工具定义可以从 `contracts` **自动生成**，加一个命令 = AI 自动会用
- 每个命令天然有审计（老板端的"谁改的"直接来自这里）
- `reversible: true` 的命令支持**一键撤销**——AI 操作出错时这是救命的
- 幂等键让重试安全（网络差的门店必须）

**AI 执行流程（务必是两段式）：**

```
用户："把 Lisa 5 点那单改到 6 点"
  ↓ AI 调用只读工具：搜客户、查预约、查 6 点是否有冲突
  ↓ AI 产出「命令提案」：appointment.reschedule { id, startAt }
  ↓ 前端渲染成人类可读卡片："Lisa Chen · 深层按摩 60min · Amy · 5:00PM → 6:00PM"
  ↓ 前台点确认 → 才真正执行
  ↓ 执行后显示"撤销"按钮（60 秒内）
```

只读查询可以直接执行不用确认。写操作默认要确认，熟练用户可以在设置里把低风险命令设为免确认。

### 3.1 系统自有命令（`system: true`）⭐

**2026-08-31 加的一条，起因是一个能复现的 P0。**

`POST /v1/commands/:name` 按名字执行任意已注册命令，而总线里唯一的门是
「你有没有 `def.permission`」。`billing.syncSubscription` 的 permission 是
`billing.manage`，而 owner 预设正好有 —— 于是**一条 curl 就能把自己的门店
写成 growth/active，再一条就能凭空造出十万积分**。两条都实测复现过。

原来标「内部」的方式是 `ai: { exposed: false }`。那个字段**只管 AI 工具生成，
从来不影响 HTTP 路由** —— 标记有了，没有任何东西强制它。

所以判据换成 `CommandDef.system`：

| 这条命令记的是 | 谁能调 | 例子 |
|---|---|---|
| **租户的意图** | 浏览器、AI（权限内） | `appointment.create`、`ticket.pay` |
| **外部系统已经发生的事实** | 只有服务端编排，验完外部凭据之后 | `billing.recordTopup`（Stripe 扣款回执）、`billing.syncSubscription`（webhook 验签）、`ai.recordAssist`（模型调用回执） |

判据只有一句：**如果租户能直接调它，他能不能凭空写出一个没有发生过的事实？**
能，就是 `system: true`。

**两道，都失败即拒：**

1. `apps/api/src/server.ts` —— HTTP 入口在解析身份**之前**就拒掉。
2. `apps/api/src/bus.ts` —— `dispatch()` 要求调用方显式给
   `systemOrigin`（`stripe_webhook` / `anthropic_usage` / `telnyx_call` …），
   而且这一步排在**入参校验之前**：排在后面的话，body 拼错的调用会先拿到
   `VALIDATION_FAILED`，于是「这条命令我到底能不能调」变成一个可以试探出来的问题。

第一道挡的是今天已知的那个入口。而「按名字执行任意命令」这种泛化入口出现过
一次就可能再出现第二次（AI 工具、批量接口、内部代理），那时第一道不会自动
跟着长出来 —— 第二道会：新写的调用点不声明来源就跑不通。

⚠️ 这**不是**第二套权限。权限照常检查。它约束的是**入口**，
执行仍然走同一条总线：审计、幂等、RLS、订阅闸门一条都不少（宪法第 1 条没被绕开）。

回归在 `apps/api/src/systemOnly.test.ts`，断言的对象是**注册表本身** ——
新加一条内部命令而忘了标 `system`，套件当场红。

### 3.2 命令处理器之外不许写业务表 ⭐

宪法第 1 条是唯一一条长期没有可执行检查的规则，于是四条 desk 路由悄悄长出了
裸 SQL 写入（改预约备注、改客户关联、重填健康表、推进建站工单状态）。
它们各自丢掉了审计、幂等和欠费冻结 —— 而因为读也用 `withTenant`，
写混进去看起来毫无违和。

`scripts/lint-guards.sh` 第 9 条现在会拦下它。允许名单只有系统路径
（`handlers/`、`stripe/`、`signup/`、`platform/`、`auth/`、`kiosk/routes.ts` 等），
每一处都有明确理由。

**AI 上下文（Context Builder）**：不要让 LLM 自己写 SQL。提供一个 `getFloorSnapshot(locationId)` 只读工具，返回一份精炼的现场快照（今天的预约、在岗技师、轮牌顺序、空房间、等位队列），几 KB 以内，让模型一次拿到全局。这比给它 20 个零碎工具效果好得多。

---

## 4. 多租户与数据隔离

```
organization (老板的账户组；单店老板看不见这个概念)
  └── location (门店 = 计费单位 = 数据边界，一店一订阅)
        └── ... appointments / staff / tickets ...

user (全局唯一) ──< membership (user × location × 角色) >── location
   一个邮箱可以在多家店（甚至不同老板的店）有身份，登录后选店
```

- **每张业务表都有 `org_id`**，多数还有 `location_id`
- **强制 RLS**：即使有服务端 API 也开 RLS，作为最后一道防线。1000 个租户，一次 `WHERE` 写漏就是数据泄露事故
- 应用**不使用 service_role 绕过 RLS**。做法：用一个受限数据库角色 `app_user`，**每个命令都在一个显式事务里执行**，事务的第一条语句是：
  ```sql
  set local app.org_id      = '...';
  set local app.user_id     = '...';
  set local app.location_id = '...';
  ```
  RLS 策略读 `current_setting('app.org_id')`。
- **连接池纪律**：`SET LOCAL` 只在事务内有效，所以 Supavisor 的 transaction mode（6543）与 session mode（5432）都安全 —— **前提是绝不用裸 `SET`**（会话级设置会泄漏到下一个租户的请求）。CI 加一条 lint：源码里出现 `SET ` 而非 `SET LOCAL ` 直接失败。
- **不使用 PostgREST**：Supabase 在这里只承担托管 Postgres + Auth + Realtime + Storage，所有读写都过我们自己的命令总线。
- **`service_role` 的边界**：只有 `packages/db` 的**迁移与种子脚本**可以读它。开发期把 dev 项目的 key 放进 `.env` 是可以的（跑迁移要用），但：
  - `apps/api` / `apps/desk` 等业务代码里**出现 `SUPABASE_SERVICE_ROLE_KEY` 这个变量名就算违规**，CI 加一条 grep 直接失败
  - **生产环境那一把只进 CI Secret**，不落任何 `.env` 文件
  - 危险之处在于它是静默的：业务查询走了 service_role 就绕过 RLS，**你写的租户隔离测试会全部通过但毫无意义**，直到线上串了数据才暴露
- 索引统一以 `(org_id, location_id, ...)` 打头
- **外键不受 RLS 约束** ⭐：Postgres 的外键检查以**表 owner 身份**执行。
  `appointments.customer_id references customers(id)` 这种单列外键，
  写一个别家 org 的 uuid 是能写进去的 —— 写进去之后读路径被 RLS 滤成 NULL，
  客人在界面上凭空消失，库里留一条跨租户引用，全程无报错。
  凡是指向租户数据的外键都要带上 org：`(org_id, customer_id) → customers(org_id, id)`（sql/0076）
- **依赖跨租户可见性的检查必须 SECURITY DEFINER** ⭐：反过来的坑。
  一个「这个 Stripe id 是不是已经属于别的 org」的触发器，如果跟着 `app_user` 跑，
  它要找的正是被 RLS 滤掉的那些行 —— 检查**永远为假**，看起来有防护实际没有。
  用 postgres 身份手工验证是看不出来的，只有以 `app_user` 身份跑的测试能抓到（sql/0081）
- 大表（`appointments`、`ticket_items`、`audit_log`、`messages`）预留**按月分区**，Phase 3 再切
- 1000 店 × 100 单/天 ≈ 3600 万预约/年 —— 单个 Postgres 完全扛得住，**不要过早分库**

---

## 5. 身份与权限

**两类主体，三种登录方式：**

| 主体 | 登录 | 说明 |
|---|---|---|
| 员工（技师/前台/店长/老板） | **Supabase Auth：邮箱 Magic Link / 密码** | 一个人可属于多个门店/多个品牌。**手机 OTP 等短信通道就绪后再开**（`03` 决策 11） |
| 员工（共享设备场景）⭐ | **门店设备令牌 + 4 位 PIN** | iPad 用设备令牌登录成"门店终端"，技师输 PIN 切换身份打卡/看单。由我们自己签发受限 JWT（scope 仅限该门店、仅限员工端能力、短有效期），PIN 不能远程登录 |
| 顾客 | 一期不做账号：**手机号 + 一次性链接** | 顾客身份和员工身份**分开的表**，不要混 |

**权限模型：细粒度 permission + 角色预设**

```
permission 举例：
  appointment.read / appointment.write / appointment.delete
  ticket.discount / ticket.void / ticket.refund
  payroll.view_own / payroll.view_all / payroll.configure
  rotation.override
  customer.view_contact / customer.view_health_form
  settings.manage / staff.manage / billing.manage
  ai.execute_without_confirm

角色预设：owner / manager / front_desk / senior_tech / tech / (自定义)
店主可以在预设基础上勾选调整 → 存成 location 级的自定义角色
```

### 5.1 一人多角色（很常见，必须一等公民支持）⭐

**店长 / 前台 / 老板自己也接客做按摩**在这类店里是常态。角色模型天生支持（`membership_roles` 是多对多），但必须补两个开关，否则日程表和轮牌会算错：

```
staff_profiles.is_bookable    -- 是否出现在日程表列里 / 可被排单
                              -- 默认：有 tech 角色 = true，纯前台 = false
rotation_participants         -- (location_id, business_date, membership_id, in_rotation)
                              -- 是否参与"今天"的 walk-in 轮牌
```

典型组合：

| 人 | `is_bookable` | `in_rotation` |
|---|---|---|
| 纯技师 | ✅ | ✅ |
| **店长兼技师（只接点钟，不吃 walk-in 轮）** | ✅ | ❌ ← **最常见的那一种** |
| 纯前台 | ❌ | ❌ |
| 老板今天人手不够下场 | ✅ | 当天打开即可 |

`in_rotation` 按**营业日**存，不是按角色存 —— 因为"今天老板下场、明天不下"是天天变的。

**AI 的权限 = 当前操作人的权限的子集**，绝不提权。AI 会话里带 actor 身份。

---

## 6. 实时同步（Supabase Realtime）

门店内所有屏幕必须秒级一致：前台派单 → 技师端秒级响铃弹窗；技师点"完成" → 前台轮牌板、账单页、老板看板同时更新。

**做法**（✅ Phase 1c 已落地）：命令总线**在业务事务内**向 `location:{id}` 频道 broadcast 领域事件：

```jsonc
{ "type": "ticket.assigned", "staff_id": "...", "ticket_id": "...", "v": 128 }
```

- **扇出在 Supabase 侧完成**，两台应用实例之间不需要互相通信 —— 这是选 Realtime 而不是自建 WebSocket 的唯一理由，也是充分理由
- 事件只带 **id + 类型 + 版本号，不带业务数据**。前端收到后 TanStack Query 精准 `invalidate` 重新拉取 —— 避免事件里塞了敏感字段绕过 RLS
- 频道订阅走 Realtime 的授权策略，只有该 location 的活跃 membership 能订阅

### 实现细节（1c 落地时改掉的三处）⭐

**① 事务内广播，不是提交后广播。** 走 `realtime.send()`（往 `realtime.messages` 插一行），
事务回滚它跟着回滚 —— 于是**永远不会有一条对应不上任何事实的事件**。
「提交后再发」那种做法有两个都会真实发生的坏结局：发完那一瞬间进程挂掉，事件永久丢失；
或者事务其实回滚了但事件已经出去，技师手机响了却找不到那张单。

**② 服务端走 `public.gf_broadcast()` 包装函数，不直接调 `realtime.send`。**
`realtime.messages` 的 owner 是 `supabase_realtime_admin`，我们的迁移角色 postgres
对它**没有 GRANT OPTION** —— 直接 `grant insert ... to app_user` 只会发一个 WARNING
然后什么也不做，迁移看起来是成功的。症状是每条广播在日志里留一句
"permission denied for table messages"，而业务毫发无损，所以能潜伏很久。
正确做法是 owner = postgres 的 SECURITY DEFINER 包装函数（`sql/0012`），
顺带给频道名格式校验找到了唯一落点。

**③ 客户端只能 presence，不能 broadcast。**
私有频道的 presence 上报也走 `realtime.messages` 的 INSERT 检查，
所以策略必须按 `extension` 列区分：`'presence'` 放行，`'broadcast'` 拒绝（`sql/0013`）。
一刀切拒绝 INSERT 的话，技师端 track 不上去、前台永远显示「0 人在线」，
而两边的连接状态都正常 —— 从表面完全看不出哪里错了。
挡住客户端广播的理由很实在：不挡的话，任何一个登录的技师都能伪造一条
`ticket.assigned` 让同事的手机响。

**实测**：前台派单 → 技师端收到并刷新，**约 2 秒**；
跨店订阅被 Realtime 明确拒绝（`Unauthorized: You do not have permissions to read from this Channel topic`）。

**Phase 1c · 员工端（Staff PWA）感知层**（✅ 已落地）：

- 收到派单事件 → **Web Audio API 播放专属提示音**（"叮！新客人"）+ **Vibration API 短震动**
- 屏幕翻转为大号高亮卡片（客人、项目、座位号），戴手套扫一眼就懂
- 监听 `visibilitychange`：技师从锁屏/切后台重新点亮屏幕时，自动触发 `GET /staff/my-active-task` 增量对齐，0.5 秒内静默刷新
- 前台看板显示各技师在线/离线指示点（Realtime presence）

> **Phase 1a 不需要这一层。** Desk-Only 模式下只有前台一台电脑 + 可选的墙面轮牌大屏，Realtime 只用来同步这两块屏。

> ⚠️ **这一层挂了只是退化，不是事故**（宪法第 14 条）。技师端有 60 秒兜底轮询，
> 前台端有 20 秒轮询，两边的连接状态都显示在界面上 ——
> 前台那个「● 实时 N 人在线」回答的是一个很具体的问题：
> **「我派给她，她手机上会响吗？」** 灰点不代表人不在店里，只代表该口头喊一声。
---

## 7. 排期引擎（`packages/scheduling`）

**唯一一处**计算"能不能约"。输入输出都是纯数据，无 IO。

约束项：
1. 门店营业时间 + 节假日例外
2. 技师排班（班次）− 请假 − 已有预约 − 休息/午餐
3. **技能匹配**：`service.required_skills ⊆ staff.skills`
4. **等级/性别/语言偏好**过滤
5. **资源约束**：项目需要 `{room:1, pedicure_chair:1}`；情侣按摩需要 `{couples_room:1}` 且同时锁 2 名技师
6. **缓冲时间**：项目前后 buffer（翻床、清洁）
7. **重叠/处理时间**：项目可拆成 `活跃段 / 等待段`，等待段允许技师被复用 ⭐
8. 提前预约窗口、最晚可约、最小提前量
9. 时段粒度（5/10/15 分钟）

输出：`AvailabilitySlot[]`，附带**为什么不可约**的原因码（前台需要看到"Amy 4 点被 Lisa 占了"而不是空白）。

### 7.1 容量模型：三层，只有资源层是硬约束 ⭐

决策 17 要求「默认允许超卖、不设阻断性卡死」，但按摩店的床位物理上不可能超卖。所以**按层区分强度，不做全局开关**：

| 层 | 约束 | 强度 | 谁天然被它卡住 |
|---|---|---|---|
| **资源**（房间 / 床 / 双人房 / 足浴椅） | 同一 `resource_id` 时间不可重叠 | **硬约束** —— 数据库 `EXCLUDE USING gist`，无覆盖入口 | 按摩 / 足疗店：3 个房间就是只能同时做 3 个，不需要额外设置 |
| **技师** | `staff_profiles.max_concurrent_appointments`，默认 **1**；美甲店可设 2（做手时脚在泡水 / 等干） | **软约束** —— 超出弹黄色警告 + 必须选原因，前台可放行 | 美甲店：这就是"美甲店按技师来"的那一层 |
| **门店时段** | `location.settings.capacity.max_concurrent_per_slot`，默认 = 该时段**在岗且 `is_bookable` 的员工数** | **软约束** —— 超出警告，可放行 | 兜底，防止前台一口气收 20 个 walk-in |

**关键点：技师层不建数据库排他约束。** 否则决策 17 的超卖上线当天就会撞 DB 错误，而且前台看不懂那个报错。技师重叠只做应用层软告警，放行时写 `overbooked = true` + `overbook_reason` 进审计。

**「预约默认都同意」**：公开预约 API / AI 电话创建的预约，只要没撞资源硬约束就直接接受；容量超限只在前台看板上高亮成待关注，**不拒绝客人**。

**前台强行覆盖**：任何软约束前台都可点"仍要安排"，引擎放行并记录操作人 + 原因。硬约束（资源冲突）不给覆盖入口，只提示"3 号房 15:00–16:00 已被占用"并列出可选房间。

### 7.2 营业日：Desk 的「今天」不是日历上的今天 ⭐

**2026-08-31 定的口径（AUD-13）：Desk 上一切 Today / Yesterday
都是门店的营业日，含 `business_day_cutoff`。**

```
America/New_York，cutoff 04:00
  2026-08-31 01:30 EDT  →  营业今天 2026-08-30，营业昨天 2026-08-29
  2026-08-31 04:00 EDT  →  营业今天 2026-08-31
```

凌晨一点半那一单属于昨晚那一场生意 —— 这不是技术偏好，是门店自己数钱的方式。

**判据只有一份**：`businessDateOf` @ `packages/scheduling/src/business-day.ts`，
服务端和前端共用。前端入口是 `useBusinessDay()` @ `apps/web/src/lib/time.ts`，
cutoff 由 `GET /v1/me/context` 的 `businessDayCutoff` 下发。

⚠️ **不许再写第二份日期实现**，也不许用 `toISOString().slice(0, 10)`
或浏览器本地日历语义 —— 前后端各写一份的结果必然是在 DST 那两天分叉。

⚠️ **只修时区不修 cutoff 是个陷阱**，而且已经踩过一次：
QA-008 把所有日期控件从 UTC/浏览器本地改成了「门店时区的日历日」，
看起来彻底解决了时区问题。但营业日和门店时区的日历日**每天有几个小时不相等**，
而不相等的那几个小时正是前台封账的时刻。表现是日结页显示
「今天在营业」且全部为零，当晚真实的钱在前一个日期下。

⭐ 更要命的是**测试也会跟着漏**：任何把时钟停在营业时间的用例，
两种实现都通过。要抓住它，时钟必须停在**当地午夜到 cutoff 之间**
（`e2e/specs/business-day.spec.ts`、`apps/web/src/lib/time.test.ts`）。

#### 第四层：营业时间（sql/0046）⭐

上面三层管的是「同一时刻塞不塞得下」，这一层管的是「这个时刻店里有没有人」。
`OUTSIDE_BUSINESS_HOURS` 这个错误码从第一天就在错误码表里，但在 0046 之前
**从来没有人抛过它** —— 前台想约凌晨三点就能约成。

判据是纯函数 `@gf/scheduling` 的 `checkBusinessHours`，
阈值在 `location.settings.off_hours`（老板可调，`location.saveOffHours`）：

| 渠道 | 宽限窗口（开门前/关门后各 N 分钟） | 越界之后 |
| :--- | :--- | :--- |
| 前台（`enforce: false`，默认）| — | 不查 |
| 前台（`enforce: true`）| 给 | `warn` 带 reason 放行 / `block` 一律不许 |
| 官网 `web` / 电话 AI `phone_ai` | **不给** | 一律拒，**不看 `enforce`** |

⭐ 最后那一行是**不可配的不变量**，和上面「预约默认都同意」那句话
不冲突而是补充它：默认同意的是「排得挤一点」，不是「店里没人的时候也收单」。
老板那个开关管的是「前台能不能通融」，不是「要不要把没人在的时段挂到网上卖」。

⭐ **找空档那条路不吃宽限**：`findOpenSlots` 仍然只在 [open, close] 里找，
宽限窗口一格都不会报出来。报出来客人就会自己订，而那个点店里一个人都没有。
所以前台的「非营业时间加单」入口是手动输时间，不是从空档列表里挑。

⚠️ `business_hours` 一个键都没有 = **还没配，不是不营业**。新店从 Stripe
建出来时它是 `'{}'`，把空对象当成七天全关，新店第一单就会被自己的闸门挡住。
---

## 8. 轮牌引擎（`packages/rotation`）

纯函数 + 事件溯源式的 turn ledger：

```
turn_events: (location, business_date, staff_id, delta, reason, ticket_id, actor, at, note)
  reason ∈ served | skipped_no_skill | skipped_off | request_not_counted
          | manual_override | offline_service | break | reset_daily
```

- 当前顺序 = 由事件重放得出，**永远可解释**（技师质疑时前台能一条条给他看）。
- **前台手动拖拽覆盖（Manual Override）**：前台可在界面直接拖拽调整技师轮牌顺序或改派，系统产生一条 `manual_override` 事件，强制记录操作人、变动前后位置与原因（如"客人指定/技师暂休/前台协调"），杜绝内部猜忌。
- 店主可配策略：turn 折算规则（按金额/时长/固定）、指定单是否计轮、跳过后的回插位置、是否欠轮补偿。

---

## 9. 薪酬与小费引擎（`packages/payroll`）

- 输入：一个已结账的 ticket（含 items、时长、技师、等级、角色）+ 该门店生效版本的 `tip_policy` / `comp_plan`
- 输出：`allocations[]`（每人金额 + 计算依据的可读说明）
- **规则用声明式 JSON 表达，不允许写代码**（安全 + 可被 AI 生成/解释）
- **策略版本化**：改规则不影响历史单据；结账时把 `policy_version` 快照进 ticket
- 提供 `simulate(policy, historicalTickets)` → 店主改规则前看差异
- 见 `00-DISCOVERY.md` §3.2 的法律护栏，必须在 UI 层实现

---

## 10. 通讯与通知（解耦设计）

- **阶段解耦**：
  - **Phase 1b 基础通知**：基于邮件（Resend/SES）发送预约确认/变更 + 前台手工电话回呼 + 网页 Magic Link 查看。
  - **Phase 2.5 短信独立专项期**：**门店数 ≥ 10 家且 10DLC 审核完成后**才上线短信自动化（确认、提醒、叫号、唤醒）。核心业务不被短信审批卡住，代码里在此之前不写任何短信依赖。
- 统一 `messaging` 服务：模板（多语言）→ 渲染 → 发送 → 回执 → 入库
- **同意管理**：`consents` 表记录 channel / purpose(transactional|marketing) / 时间 / 来源 / IP / 文本版本
- 发送前统一拦截：无同意、STOP 名单、静默时段、频率上限
- **10DLC**：走"平台品牌 + 多 campaign"托管架构，在 **Telnyx** 名下申请（`03` 决策 28、`09`）。
- 所有外发通知在 **BullMQ 异步队列**（Upstash Redis，Phase 1b 起）中进行，支持定时延迟、失败自动重试与死信告警。

---

## 11. 支付（已定：纯记录制）

- **系统不碰钱**。现金/刷卡由门店现有终端处理，系统只**记录**支付方式与金额。不收定金、不做在线结账。
- 好处：完全避开 PCI 范围、避开资金牌照、避开退款纠纷。这是正确的一期决策。
- `payments.processor_ref` / `terminal_ref` 仅可保存店家手工录入的外部凭据编号，不能据此宣称已连接终端。
- 不做留卡担保、在线定金或门店业务款代收。
- 唯一收钱的地方是**你向门店收订阅费**（Stripe，走平台侧，与门店业务数据无关）。
- 爽约问题一期用非支付手段解决：**邮件确认 + 二次提醒 + 爽约计数 + 前台人工预警**（短信要等 Phase 2.5）（系统高亮显示历史爽约次数，由前台决定是否接待，不自动封禁），实测能压掉大部分 no-show。

---

## 12. 可用性、运维与灾备

| 组件 | 故障影响 | 缓解 |
|---|---|---|
| Cloudflare | 边缘不可用 | 极低概率；可临时把 DNS 指向实例 IP |
| 应用实例（挂 1 台） | 无影响（已做故障演练） | 边缘即时重试兜底 + 探针 1–3 分钟内剔除，另一台承接全部流量 |
| 应用实例（2 台同时挂） | 服务中断 | 容器守护自动重启；两台放在**不同机房/可用区** |
| **Supabase** | **全站不可用（核心单点）** | 单区托管，区域性故障只能等。**SLA 别承诺 99.99%**。PITR 分钟级恢复 + 每季度真做一次恢复演练（`04` §10） |
| Upstash Redis / BullMQ | 定时提醒延迟 | 队列持久化，恢复后补发；**不影响任何同步写路径** |
| 邮件商 (Resend) | 提醒延迟 | 队列自动重试 + 死信告警 |
| AI 电话商 (Telnyx) | 电话转人工 | 降级到语音信箱或前台回呼工单 |

### 门店断网：不遮罩、不关页面，切只读看板 ⭐

实体店的网说断就断。**页面绝不能变成一堵墙** —— 前台一旦被挡住就会退回纸笔，而且不一定会回来。

```
心跳 / Realtime 断开 ≥ 5 秒
  ↓
顶部出现常驻橙色横幅：「网络已断开 · 显示的是 14:32 的数据 · 正在重连…」
  ↓
页面自动切到【离线看板】（不跳转、不刷新、不丢当前页）：
  • 今日轮牌板快照（谁在队列、现在轮到谁）
  • 今日预约日程表
  • 进行中的工单列表
  ← 全部来自 IndexedDB 本地缓存，每次成功请求后自动写入
  ↓
所有写操作按钮置灰，hover 提示「网络恢复后可操作」
  ↓
恢复：自动重连 → 静默增量对齐 → 横幅转绿「已恢复」→ 3 秒后消失
```

**坚决不做离线写入队列。** 轮牌顺序、派单、开单是全局强一致状态，离线改完再合并必然 split-brain（两个前台各自派了同一个技师），代价远大于收益。断网期间前台用纸记一下，恢复后补录 —— 这本来就是他们熟悉的方式。

**兜底**：离线看板提供「打印当前轮牌与今日预约」按钮，长时间断网直接出纸。

---

## 13. 门店官网：只有两层，没有编辑器

**2026-08-25 决策：不做网站编辑器。** 不做模板、不做拖拽、不做实时预览、不做发布回滚、
不做自定义域名。那是个无底洞，而且做完店主还是做不出好看的东西。

取而代之的是两层，中间那层**故意留空**：

| 层 | 有没有 | 是什么 |
| :--- | :--- | :--- |
| **默认层** | ✅ 已完成 | `apps/booking` —— 黑白 / 毛玻璃两套外观，URL 参数可调，可嵌 iframe 也可独立打开。开箱即用，不需要店主做任何设计动作 |
| **配置层** | ⛔ **故意不做** | 店主不能自己调颜色、改排版、拖组件 |
| **定制层** | 🚧 批 8 | **建站工单**（`storefront_briefs`）—— 店主填一张结构化需求单，AI 出三版，人工精修后上线。见 `docs/17` |

第三方官网（`lotusnails.com` 这种）仍然通过**公开预约 API** 集成，契约见
[`13-PUBLIC-BOOKING-API.md`](13-PUBLIC-BOOKING-API.md)。那一份没有变化 ——
变的只是「我们自己不提供编辑器」。

---

## 14. 平台运营（你自己用的那一层）

单独的 `apps/platform`（Phase 2），只有你能进：租户列表、订阅状态、用量（短信条数/AI token）、功能开关、模拟登录（impersonate，必须双人确认 + 全程审计）、事故公告推送。
订阅与官网你交给别的 AI 也可以，但**用量计费的计数必须由本系统产出**（每次发短信/每次 AI 调用写一条 usage 记录）。
