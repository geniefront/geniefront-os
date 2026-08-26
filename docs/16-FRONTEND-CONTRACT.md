# 16 · 前端契约

> **写给重做前端的那个 session。** 技术栈由你定（TailAdmin Pro + Tailwind Plus），
> 这一份只讲**前端和后端之间的接触面**。读完就能开工，不需要读这个仓库的其它文档。
>
> 一句话总结：**所有读操作走各自的查询路由，所有写操作走同一条命令总线。**

---

## 1. 三个地址

| 环境 | API |
| :--- | :--- |
| 生产 | `https://api.geniefront.com` |
| 本地 | `http://127.0.0.1:3000`（`pnpm dev:api` 起，端口看根 `.env` 的 `PORT`） |

四个前端应用是**四套独立部署**，不要合成一个：

| 应用 | 谁用 | 身份方式 |
| :--- | :--- | :--- |
| `desk` | 前台 + 老板 | Supabase Auth（邮箱密码 / magic link） |
| `staff` | 技师（手机 PWA） | 上机码换来的**可吊销会话行**，不是 JWT |
| `kiosk` | 门口 iPad | 设备令牌 |
| `booking` | 客人（公开） | 公开 key + Turnstile，无账号 |

---

## 2. ⭐ 命令总线：所有写操作只有这一条路

```http
POST /v1/commands/appointment.create       ← ⭐ 命令名在 URL 里
Authorization: Bearer <supabase access token>
X-Membership-Id: <当前门店的 membership id>
Idempotency-Key: <前端生成的 uuid，同一次用户动作复用同一个>
Content-Type: application/json

{ "input": { … } }                          ← body 里只有 input
```

返回 **201**（真的执行了）或 **200**（命中幂等缓存，是一次重试）。

**不要**为了「这个操作很简单」就去找一条 REST 路由 —— 没有那种路由。
命令总线在一个事务里做完这五件事，绕过去就全丢：

1. Zod schema 校验（形状 + 语义两层）
2. 权限判定（`role_permissions` 表，不是前端判的）
3. 幂等（同一个 `Idempotency-Key` 重放返回**第一次的结果**，不产生第二次写入）
4. 审计（`audit_log`，留动作不留金额）
5. 事务内广播（Realtime，回滚即撤销）

`GET /v1/commands` 返回当前部署**认识的所有命令名与输入 schema**。
前端可以拿它做类型生成，也可以在开发时对着看。

### 2.1 `X-Membership-Id` 从哪来

```
GET /v1/me/locations   →  [{ membershipId, locationId, name, role, … }]
```

用户选一家店 → 把那个 `membershipId` 放进后续所有请求头。
**这个头不是身份** —— 真正的身份在 Supabase token 里，服务端会核对
「这个 token 的用户是不是真的持有这个 membership」。前端伪造它没用。

切店就是换这个头。`user_last_location` 会记住上次选的，`/v1/me/locations`
的返回里有标记。

### 2.2 `Idempotency-Key` 的正确用法

- **一次用户动作 = 一个 key**，从用户点开表单时就生成好，整个流程不变
- 用户改了输入再提交 → **仍然是同一个 key**（后端会拒绝并返回 `IDEMPOTENCY_KEY_REUSED`，
  这是对的：说明你在同一个 key 下换了内容）
- 用户主动重试（点了「重试」）→ **换新 key**
- 网络超时后自动重试 → **复用旧 key**

---

## 3. 错误：后端给码，前端给人话

所有失败都是这个形状：

```jsonc
{
  "error": {
    "code": "STAFF_OVER_CAPACITY",
    "message": "Amy 这个时段已经有客人了",   // 已本地化，可以直接显示
    "details": { "staffId": "…", "conflictAt": "…" }   // 结构化，给你做 UI 用
  }
}
```

**`message` 已经按请求方的语言渲染好了**（`Accept-Language` 或用户的 `locale`），
可以直接显示。`details` 是给你做高亮、跳转、预填用的。

`code` 的完整清单在 `packages/contracts/src/errors.ts`。按处理方式分三类：

| 类 | 例子 | 前端该怎么做 |
| :--- | :--- | :--- |
| **要人做决定** | `OVERBOOK_REASON_REQUIRED` `VARIANCE_REASON_REQUIRED` `VOID_REASON_REQUIRED` | 弹出输入原因，带着 `reason` 重发同一条命令（**同一个幂等键**） |
| **要人改输入** | `STAFF_OVER_CAPACITY` `RESOURCE_CONFLICT` `STAFF_LACKS_SKILL` | 显示在对应字段旁，不要弹全局 toast |
| **看 `details.overridable`** | `OUTSIDE_BUSINESS_HOURS` | true → 弹原因框带 `override.reason` 重发；false → 只能改时间。详见 `18` §14.3 |
| **不该发生** | `INTERNAL` `UPSTREAM_UNAVAILABLE` | 全局提示 + 保留用户输入，给「重试」按钮（换新幂等键） |

⚠️ **`PERMISSION_DENIED` 不是让你藏按钮的信号。** 权限在服务端判，
前端可以按 `/v1/me/locations` 返回的 `role` 提前隐藏入口来减少挫败感，
但**不要把它当安全边界** —— 隐藏了照样能调，服务端照样会拒。

---

## 4. 读操作：各自的查询路由

写操作只有一条路，读操作是普通 REST。已有的（会随批次增加）：

```
GET /v1/me/locations            我的门店列表（切店用）
GET /v1/desk/settings           门店设置（项目、员工、营业时间、AI 电话、官网对接）
GET /v1/desk/tickets            进行中工单
GET /v1/desk/rotation           轮牌
GET /v1/desk/billing            订阅与余额
GET /v1/desk/payroll/plans      薪酬方案
GET /v1/desk/blueprints         拍照开店的草案
GET /v1/auth/staff/me           技师端：我是谁
```

新的查询路由随批次加，加了会在这一节补上。

---

## 5. 实时：Supabase Realtime 私有频道

前台看板、派单、在线指示点都靠它。**三个坑已经踩过了，别重踩：**

1. 广播走 `public.gf_broadcast()`，**不要**直接 grant `realtime.messages`
2. 私有频道的 **presence 也走 `realtime.messages` 的 INSERT 检查** ——
   一刀切拒绝会导致「0 人在线」而两边连接状态都正常
3. 广播**在业务事务内**发，不是提交后发

⚠️ **上机码登录的技师会话没有 Realtime**（私有频道认 Supabase JWT，
而上机会话是一行可吊销的数据不是 JWT）。那条路径**降级成 10 秒轮询**。
**不要为此在服务端自签 Supabase 令牌。**

---

## 6. 五条不要做的事

| 不要 | 为什么 |
| :--- | :--- |
| **不要在前端算排期/轮牌/小费/提成/日结** | 那些是 `packages/` 里的纯函数，是唯一实现。前端算一遍必然和后端不一致，而不一致的是钱 |
| **不要做离线写入队列** | 断网切只读看板。轮牌和派单是全局强一致状态，离线合并必然 split-brain |
| **不要把手机号全量拉到前端再隐藏** | 脱敏在服务端做，按角色返回不同字段集 |
| **不要用 `service_role` key** | 它只在迁移 CI 里出现。前端拿到就等于绕过全部 RLS |
| **不要自己拼多个请求凑一个页面** | 需要聚合就提，后端加一条查询路由。七个请求拼一个客户详情页会在弱网下碎掉 |

---

## 7. 本地起后端

```bash
cd geniefront-os && pnpm i
pnpm dev:api      # API，127.0.0.1:3000
```

⚠️ `.env` **只有根目录一份**，各 app 用 `loadEnv('../..')` + `define` 注进去。

开发账号（密码统一 `GenieDev!2026`）：

| 邮箱 | 角色 | 门店 |
| :--- | :--- | :--- |
| `mia@example.test` | `front_desk` | Lotus Nails |
| `amy@example.test` | `manager` 兼 `tech` | Lotus Nails |
| `owner@example.test` | `owner` | Golden Foot Spa |

⚠️ 云端已经 seed 好，**不要再跑 `pnpm db:seed`** —— 它会解绑 Golden Foot Spa
上那个真实的 Telnyx 号，那家店的电话会全部 401。

`pnpm verify` 是唯一的验收入口，改完必须绿。
