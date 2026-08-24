# 14 · AI 电话工具接口

> Telnyx AI Assistant 通过 webhook 调用这些工具。实现在
> `apps/api/src/telnyx/routes.ts`，assistant 侧的定义在仓库根的
> `create_assistant.json`。**改了这里必须同步那边** —— 用脚本推，别在控制台里手敲：
>
> ```bash
> # 绑号码，拿这条线的 shop_token（只出现一次）
> pnpm exec tsx apps/api/src/ops/bindAiLine.ts +1757… pk_… --rotate
>
> # 把 create_assistant.json 推到某个 assistant（先 --dry-run 看会改什么）
> node scripts/push-assistant.mjs assistant-… --token st_… --dry-run
> node scripts/push-assistant.mjs assistant-… --token st_…
>
> # 想在部署新代码之前真打电话测：指向本地 ngrok
> node scripts/push-assistant.mjs assistant-… --token st_… --base https://xxx.ngrok-free.dev
> ```
>
> 推之前会把 Telnyx 上的原配置备份到 `.assistant-backups/`，
> `--restore <file>` 一条命令退回去。
>
> ### ⚠️ Telnyx 侧四个坑（都是踩过的，脚本里已经处理）
>
> **① 入参要写进 `body_parameters`，不是 `parameters`。**
> 这个最阴：Telnyx 的 API **会把 `parameters` 原样收下再还给你** ——
> 推完 GET 回来一看「参数都在」，而控制台和运行时读的是 `body_parameters`。
> 那六个工具在它眼里一个入参都没有，模型连 `to` 都不会传，每个工具 404。
> 判断依据是控制台自己建出来的模板 assistant：`parameters` 是空的，
> 内容全在 `body_parameters` / `path_parameters` / `query_parameters` 里。
>
> **② `hangup` 不要自己发** —— 每种内置工具只允许一个（错误码 10015），
> Telnyx 会自己补；重复发整个推送 400。
> **③ `skip_turn` 要自己发** —— 它不会自己补，不发就等于把它删了
> （所以它写在 `create_assistant.json` 的 tools 里；脚本会跟 assistant 上
> 已有的去重，免得又撞上 10015）。
>
> **④ webhook tool 不支持固定 header**（字段只有 name/description/url/method/
> `*_parameters`），所以 `shop_token` 只能由模型填在 body 里 —— 脚本把它
> 写死进那个参数的 description，配上 instructions 里那句「原样带上、不要念出来」。
>
> ### `to` / `from` 从哪来
>
> **模型不会自己知道被叫号码。** 它们由 Telnyx 在 instructions 里做变量替换：
>
> | 变量 | 是什么 | 对应入参 |
> |---|---|---|
> | `{{telnyx_agent_target}}` | 被叫号码（店里的号） | `to` |
> | `{{telnyx_end_user_target}}` | 来电号码 | `from` |
>
> ⚠️ 少了这两行，`to` 就靠模型猜 —— 而 `to` 猜错的表现是
> 「每个工具都 404」或者更糟：**落到另一家店头上**。

---

## 0. 通用约定

**所有工具**：`POST`，`Content-Type: application/json`，返回 200 + JSON。

### 前置三步（每个工具都走）

1. **Ed25519 验签** —— `telnyx-signature-ed25519` + `telnyx-timestamp` 头，
   实现在 `telnyx/verify.ts`。验不过直接 401，业务代码碰不到请求体。
2. **按被叫号码反查门店** —— 入参 `to` 是店里公布的那个号，
   `tenantForPhoneNumber()` 反查出 org / location / 店名 / 时区 / 语言。
   查不到 404，`reason: number_not_bound_to_any_location`。

   ### ⚠️ 入参里没有 `location_id`，但有一个 `shop_token`

   **不接受调用方给的门店 id。** 这几条路由没有登录用户，身份证明只有一个
   签名。而门店 id 或号码都是**公开信息**（号码就印在店门口和 Google 上）——
   一旦公开信息能选定租户，验签被绕过的那一刻，攻击者就能逐个号码
   点名查任意一家店的客户、价目表和排期。

   所以定位门店的仍然是被叫号码（`phone_lines.e164`，`ai_voice` 的号
   全局唯一），另外加一道**猜不到的第二把钥匙**（`sql/0036`）：

   ```
   shop_token: "st_hK3…"      // 每条 ai_voice 线一串，32 字节随机
   ```

   - 建 `ai_voice` 线时**自动生成**，明文只在 `location.savePhoneLine`
     的返回里出现一次，库里只有 SHA-256 摘要
   - 填进 Telnyx 那家店的 assistant 配置（工具参数里的常量），
     每次调用随请求体带回来；验签通过之后再比一次，对不上一律 401
     `reason: shop_token_invalid`
   - 没配 token 的线**照旧只验签名** —— 一次迁移不该让存量号码半夜停掉
   - 轮换：`location.savePhoneLine` 带 `rotateToolToken: true`。
     ⚠️ **换完必须同步到 Telnyx**，否则那家店的电话当场全 401
     （服务端会打一条 warn 日志，带上号码和 locationId）

   #### 它买不到什么（别高估）

   - **不是门店 id，也替代不了号码。** `call.hangup` / `message.received`
     是 webhook 不是 assistant 的工具调用，**带不了自定义参数** ——
     那条路上唯一能确定租户的仍然只有被叫号码。所以 `/v1/telnyx/webhook`
     不检查 token（检查了电话就不计费了）
   - **挡不住 Telnyx 账号被拿下。** 签名公钥和这串 token 都在那个后台里，
     进得去的人两样都拿得到。它只在「我们自己的验签代码有洞」时起作用
   - **多一样要人工同步的东西。** 这是它真实的代价

   > 下文各表里的 `✓*` 就是这个意思：**这条线配了 token 就必填**，
   > 没配就照旧只验签名。

   ### 出参里有 `shop`

   **每个工具的返回里都带一个 `shop`**：

   ```jsonc
   { "shop": { "locationId": "aaaa…", "name": "Lotus Nails & Spa",
               "timezone": "America/New_York" }, … }
   ```

   否则调用方和看日志的人**没有任何办法确认这通电话落到了谁头上** ——
   而「串店」恰恰是这条链路上最难发现的一类故障。AI 也用得上：
   它可以在电话里说出店名。

3. **系统上下文** —— `membershipId: null`（电话背后没有人），
   `actorKind: 'api'`，权限集见下。

### AI 的权限集

```ts
const PHONE_AI_PERMISSIONS = [
  'appointment.write',   // ⭐ 2026-08-22 加。只能建，不能改不能删
  'call.draft',
  'appointment.read',
  'customer.read',
  'schedule.read',
];
```

三条配套约束：

- **只能建，不能改不能删。** 没有 `appointment.cancel`、没有
  `appointment.reschedule` —— 改期取消一律回前台。建错一单可以补救，
  被静默改掉的单没人会发现。
- **永不传 `override`。** 软约束放行需要一个知道店里现在什么情况的人，
  电话那头没有这个人（与公开预约页同口径）。
- **仍然没有 `customer.view_contact`。** AI 用号码查人，但念不出完整号码。

### 两个字段是这套设计的核心

| 字段 | 作用 |
|---|---|
| `guidance` | 把「AI 该怎么办」写进**返回值**，不藏在 system prompt 里。返回里的指令比提示词里的可靠得多，且能随数据变化（例：同号多客户时才出现「请问清是哪一位」） |
| `say` | 需要 AI **原样念出**的句子由服务端给定。不这么做模型会把「已记下，前台稍后回电」说成「已经帮您约好了」。⭐ **一律写英文**（2026-08-23 店主实测后定的）：`say` 和 `guidance` 里出现中文，英文客人那头就只能听模型现编。别的语言由模型照实翻，**确认码、日期、时间、人名原样保留**（instructions 里写死了）|

### 钱一律整数分

`priceCents: 4500` 表示 $45.00。AI 自己格式化。全仓规矩（宪法第 4 条）。

---

## 1. `start_call` — 接通那一下，一次抓完 ⭐

**何时调**：说完开场白之后**第一件事**，整通电话只调一次。

```
POST /v1/telnyx/tools/start_call
```

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✓ | 被叫号码 |
| `from` | string | ✓ | 来电号码 |
| `shop_token` | string | ✓* | 这条线的第二把钥匙（§0） |

```jsonc
{
  "shop": { "locationId": "…", "name": "Lotus Nails & Spa", "timezone": "America/New_York" },
  "businessDate": "2026-08-23",
  "businessHours": { "mon": { "open": "09:30", "close": "19:30" }, "…": null },
  "guidance": "Everything here is background for this call… When they ask what you offer, NAME a few services only — no prices and no durations… ⚠️ There are NO appointment times here on purpose…",
  "caller": {
    "guidance": "More than one customer is on this number. Ask who is speaking…",
    "customers": [ { "customerId": "…", "displayName": "李美玲",
                     "lastVisitOn": "2026-08-17", "lastService": "光疗甲" } ]
  },
  "currency": "USD",
  "services": [ { "serviceId": "…", "name": "Gel Manicure", "durationMin": 45,
                  "priceCents": 4500, "category": "Manicure", "isAddon": false } ],
  "addons":   [ { "serviceId": "…", "name": "Nail Art", "durationMin": 15,
                  "priceCents": 1500, "isAddon": true } ],
  "staff":    [ { "membershipId": "…", "displayName": "Amy", "gender": "female",
                  "skills": ["Gel", "Acrylic"], "onShift": true } ]
}
```

### 为什么合并

`lookup_customer` / `list_services` / `list_staff` 拿到的三样东西，
**在一通电话里是不会变的**：客人是谁、店里卖什么、今天谁在班。
分三次问就是三段静默 —— 电话里每一次工具调用都是一秒多的沉默，
客人会以为断线了。合并之后还顺带解决了两件事：

- 「你们几点关门」「周日开吗」**一次工具都不用调**就答得上来
  （`businessHours` 是整周的，以前这个问题 AI 根本答不了）
- assistant 里少三份工具定义，模型挑错工具的机会也少三份

### ⚠️ 但空档不在里面

`find_slots` **没有**被合并进来，这是刻意的：

| | 会不会在通话过程中变 |
|---|---|
| 客人是谁 / 价目表 / 谁在班 | 不会 —— 抓一次够用 |
| **空档** | **会** —— 客人犹豫的那一分钟里，前台或官网就能把它订走 |

而且空档还取决于客人说的项目时长、点名的技师、几个人、哪一天 ——
没法在接通那一刻预先算好。把时段塞进这一坨里，模型会在五分钟后
照着念一个已经没了的时间，而这正是这套设计要防的那件事。
所以返回里**一个 `startsAt` 都不出现**，`guidance` 里也写死了这句话
（测试盯着，见 `phone.test.ts`）。

### 项目特别多的店

整张价目表都在这个返回里。38 个项目大约 3–4 KB，模型吃得下；
真有上百个项目的店，再把 `list_services`（带 `category`）配进 assistant，
让它按类问。**接口一直都在**，只是默认不配给模型。

---

## 2. `lookup_customer` — 查客户

**何时调**：`start_call` 已经把它包含在内了（`caller`），一般不用单独调。\n路由保留是因为 Telnyx 那边的配置是人工推的 —— 一次合并不该让还没更新配置的店打不通电话。

```
POST /v1/telnyx/tools/lookup_customer
```

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✓ | 被叫号码（店里的号） |
| `shop_token` | string | ✓* | 这条线的第二把钥匙（§0）。线上没配 token 时可不传 |
| `from` | string | ✓ | 来电号码 |

```jsonc
{
  "guidance": "More than one customer is on this number. Ask who is speaking…",  // 仅 >1 条时出现
  "customers": [
    { "customerId": "...", "displayName": "李美玲",
      "lastVisitOn": "2026-08-17", "lastService": "光疗甲" }
  ]
}
```

**注意**：手机号**不是**唯一键（夫妻、母女共号很常见，决策 21）。
最多回 5 条，`customers` 为空数组即新客。

---

## 3. `list_services` — 报项目和价格

**何时调**：`start_call` 已经给了整张表。只有菜单特别大、想按 `category` 取一类时才单独调。

```
POST /v1/telnyx/tools/list_services
```

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✓ | 被叫号码 |
| `shop_token` | string | ✓* | 这条线的第二把钥匙（§0）。线上没配 token 时可不传 |
| `category` | string | | 分类名模糊匹配，如 `massage` |

```jsonc
{
  "guidance": "Name the services when asked what you offer — no prices or durations until the caller has picked one and said how long… Items in `addons` are ADD-ONS: they go on top of a main service and cannot be booked alone, so say \"plus $15\"…",
  "currency": "USD",
  "services": [
    { "serviceId": "...", "name": "Deep Tissue 60min", "description": null,
      "durationMin": 60, "priceCents": 7500, "category": "Massage", "isAddon": false }
  ],
  "addons": [
    { "serviceId": "...", "name": "Hot Stone", "durationMin": 15,
      "priceCents": 1500, "category": "Add-ons", "isAddon": true }
  ]
}
```

### ⭐ 加项与主项目分成两个数组（2026-08-22）

加项在数据模型里就是一条普通的 `services` 行（`appointment_items.addon_ids`
引用的正是它们），所以在此之前**没有任何一处分辨得出**「热石 $15」
是加项还是一个完整项目 —— 模型会把它当成一次 $15 的服务报出去：

> 客人：「热石多少钱？」　AI：「热石十五块。」
> 客人（到店）：「我做十五块的热石。」　前台：「热石是加在按摩上的。」

`sql/0035` 给 `services` 加了 `is_addon`：

- 老板在**门店设置 → 项目**里逐个勾（「这是加项（只能加在别的项目上）」）
- 拍价目表提取本来就判断得出（`blueprint_items.kind = 'addon'`，05 §5.3），
  现在这个判断有地方存了 —— 建成项目时直接落进 `is_addon`
- `book_appointment` 只听到加项时**不建单**，回一句「请问主项目您想做什么？」
- 官网预约页同口径：`/public/v1/services` 也拆成 `services` / `addons`，
  把加项当主项目提交一律 400（docs/13 §4.2）

**分类过滤的已知限制**：`category` 过滤在**应用层**做。
`service_categories.name` 是多语言 jsonb，库里没有稳定的 `key` 列。
匹配不上时**返回全部**而不是空列表 —— 空列表会让 AI 告诉客人
「我们没有这类项目」，而实际只是分类名对不上。

## 4. `list_staff` — 报技师

**何时调**：`start_call` 给的是**今天**的在班情况。问别的日子（「Mai 周四在吗」）才需要这条。

```
POST /v1/telnyx/tools/list_staff
```

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✓ | 被叫号码 |
| `shop_token` | string | ✓* | 这条线的第二把钥匙（§0）。线上没配 token 时可不传 |
| `gender` | string | | `male` / `female` |
| `date` | string | | `YYYY-MM-DD`，查当天是否在班；不传按今天 |

```jsonc
{
  "guidance": "Mention a therapist's gender only if the caller raises it. Never read out a therapist's phone number or full name…",
  "therapists": [
    { "membershipId": "...", "displayName": "Yan", "gender": null,
      "skills": [], "onShift": false }
  ]
}
```

**隐私**：只返回显示名、性别、技能、是否在班。**不返回**手机号、邮箱、真实姓名。

`gender` 字段存在是因为「要女技师」在这一行是真实且高频的诉求，
但它在部分司法辖区属敏感信息 —— **只用于筛选，AI 不主动播报**。

---

## 5. `find_slots` — 查真实空档 ⭐

**何时调**：客人说出期望时间之后，**报时间之前**。

```
POST /v1/telnyx/tools/find_slots
```

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✓ | 被叫号码 |
| `shop_token` | string | ✓* | 这条线的第二把钥匙（§0）。线上没配 token 时可不传 |
| `services` | string[] | | ⭐ 听到的项目名（可多个）。**时长按库里的项目求和** |
| `service_heard` | string | | 单个项目名。`services` 的退化形式 |
| `duration_min` | integer | | 只在一个项目都没匹配上时用，默认 45 |
| `around` | string | | ISO 8601 期望时间；不传按现在 |
| `staff_membership_id` | string | | 指定技师 |
| `party_size` | integer | | ⭐ 几位一起来。>1 时同一时刻要凑得齐这么多位技师 |
| `gender_preference` | string | | ⭐ `male` / `female`。只在客人主动提时传 |

```jsonc
{
  "businessDate": "2026-08-21",
  "timezone": "America/New_York",
  "durationMin": 60,            // ⭐ 建单时原样传回 book_appointment
  "partySize": 1,
  "services": [                 // 匹配上的项目，复述给客人时用这里的名字
    { "serviceId": "...", "name": "Gel Manicure", "durationMin": 45,
      "priceCents": 4500, "isAddon": false },
    { "serviceId": "...", "name": "Gel Removal", "durationMin": 15,
      "priceCents": 1000, "isAddon": true }
  ],
  "guidance": "Offer only the times below… Say the `spokenAt` (or `label`) — they are already in the salon's local time. NEVER read `startsAt`: it is UTC and will be hours off.",
  "slots": [ { "startsAt": "2026-08-21T19:00:00.000Z",   // ⚠️ 原样回传给建单，**不要念**
               "label": "3:00 PM",                        // 念这个
               "spokenAt": "Friday, August 21 at 3:00 PM",
               "staff": [ { "membershipId": "...", "name": "Mai" } ] } ]
}
```

> **这是最重要的一条护栏**：AI 在电话里报的每一个时间都必须来自这个接口。
> 它接在排期引擎上，容量、班表、缓冲时间全算过。

### ⚠️ 时间要给**能直接念的**，不能给 ISO

2026-08-24 那通真实电话上暴露的：返回里只有 `2026-08-26T17:00:00.000Z`
和一个 `timezone` 字段，模型就直接把 17:00 念成了 "5 PM" ——
而那家店在洛杉矶，实际是**上午十点**。客人被告知的时间和订下去的**差七小时**，
而确认短信里是对的，所以这个错要到客人下午五点来敲门才会被发现。

结论不是「在 prompt 里叮嘱模型换算时区」，是**后端根本不该把生的 UTC
丢给它**。所以每个时段都带 `label`（`10:00 AM`）和 `spokenAt`
（`Wednesday, August 26 at 10:00 AM`），`alternatives` 里还有 `dateLabel`。
`startsAt` 仍然返回，但它只有一个用途：**原样回传给 `book_appointment`**。

建单成功那句 `say` 里也会把当地时间复述一遍 —— 那是整通电话里最后一次
纠正这个错的机会，而它必须和短信写的一致。

### 四个入参各自防的是什么（2026-08-22 补齐）

| 入参 | 不做会怎样 |
|---|---|
| `services[]` | 模型把「洗剪吹」估成 30 分钟而店里那一项是 60。按它估的找空档，找到的位置放不下这一单 —— 坑的是**后面那位客人**：他被排在一个已经被占掉的时间上。所以时长以**库里**为准，`duration_min` 只在一个都没匹配上时兜底 |
| `party_size` | 两位客人一起来，却按一位报时间 —— 到店发现只有一位技师。>1 时**同一时刻要有这么多位不同的技师**同时有空（并发 2 的美甲师是「做手时另一只脚在泡水」，不是同时伺候两位客人），并且过一遍门店时段容量（`checkCapacity`，与建单同一份实现） |
| `gender_preference` | 筛选必须发生在**找空档之前**。先算完再按性别过滤，会漏掉本可安排的时段：女技师十点有空、男技师十点也有空，`limit` 先被男技师占满，过滤完就成了「十点没有女技师」 |
| `alternatives` | 见下 |

### 没有空档时：`alternatives`

那一天一个空档都没有时，服务端**自动往后找三天**：

```jsonc
{
  "slots": [],
  "guidance": "The day they asked for is full. The times in `alternatives` are on OTHER DAYS — say that day is full first, then offer the other day BY NAME…",
  "alternatives": [
    { "businessDate": "2026-08-25",
      "slots": [ { "startsAt": "2026-08-25T13:30:00.000Z", "staff": "Amy / Mai" } ] }
  ]
}
```

⚠️ 改期建议**不放进 `slots`**，而且 `alternatives` 只在没空档时出现 ——
放一起的话，客人听到的是「周六下午三点可以」，而那是下周三，他会照着周六来。

往后三天也没有（比如客人只要男技师而这三天没有男技师在班）时
`alternatives` 不出现，`guidance` 退回「这一天没有空档……」，
并补一句「在班的技师里没有符合客人性别要求的，别改成推荐别人」。

### 仍未做

| 事项 | 现状 |
|---|---|
| 多项目**换人做** | 只支持同一位技师连着做（时长求和、一段接一段）。换人做要让客人在电话里换两次位置，先不做 |
| 资源（房间 / 椅子） | 找空档时不算资源占用。电话建单不指定资源（`resourceId: null`），所以撞不上数据库那条硬约束；足疗店房间紧张时可能报出一个「人有空但没房间」的时间 |

## 6. `book_appointment` — 真建预约 ⭐

**何时调**：`find_slots` 返回了时段、且客人在电话里复述确认之后。

```
POST /v1/telnyx/tools/book_appointment
```

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `to` | string | ✓ | 被叫号码 |
| `shop_token` | string | ✓* | 这条线的第二把钥匙（§0）。线上没配 token 时可不传 |
| `from` | string | ✓ | 来电号码，作为客人手机号 |
| `call_session_id` | string | ✓ | **幂等键**，见下 |
| `caller_name` | string | ✓ | 客人自报的称呼 |
| `services` | string[] | ✓* | 听到的项目名。主项目在前，加项在后 |
| `service_heard` | string | ✓* | 单个项目名。`services` 的退化形式 |
| `slot_starts_at` | string | ✓ | **必须从 `find_slots` 结果里原样复制** |
| `staff_heard` | string | | 听到的技师名；匹配上则记为点钟 |
| `party_size` | integer | | 默认 1。>1 时**每位客人各配一位技师** |
| `duration_min` | integer | | 只在项目没匹配上时用 |
| `health_notes` | string | | 如 `Pregnant - 5 months` |

\* `services` 与 `service_heard` 至少给一个，且必须至少匹配上**一个主项目**。

### 项目怎么落成 item

- **多项目连做** → 同一位技师，一段接一段（时长取库里的值）
- **加项** → 挂在第一段的 `addonIds` 上，时长并进那一段（不另起一条单）
- **只听到加项** → 不建单，回 `ok:false` + 一句「请问主项目您想做什么？」
- **`party_size: 2`** → 建单前用**同一个排期引擎**重新算那个时刻还有谁有空，
  凑够两位就建两条并排的 item（客人点名的那位排最前）。
  只把 `party_size: 2` 记在预约头上而底下一条 item 的话，日程表上只占掉一个人 ——
  到店来了两位，第二位没有技师。凑不齐则回 `RESOURCE_CONFLICT`，让 AI 重新报时间。

### 成功

```jsonc
{
  "ok": true,
  "appointmentId": "...",
  "businessDate": "2026-08-21",
  "confirmationCode": "GF-4K2P",
  "durationMin": 60,
  "services": [ { "name": "Gel Manicure", "isAddon": false },
                { "name": "Gel Removal", "isAddon": true } ],
  "say": "You're all set. Your confirmation code is G F - 4 K 2 P. We'll text it to this number. See you then!"
}
```

**确认短信自动发出** —— `appointment.create` 在事务里入队 `sms_outbox`，
提交后 `flushSms()` 异步推送。一条短信发不出去**永远不会**推翻已成功的建单
（宪法第 14 条）。短信内容见 `sms/render.ts` 的 `renderConfirmSms`，
强制英文（一个中文字符会把整条从 GSM-7 推进 UCS-2，成本翻倍）。

### 缺件（不建单）

```jsonc
{
  "ok": false,
  "missing": ["slot_starts_at", "caller_name"],
  "say": "I'm sorry, I'm missing something I need to book this. Let me take your details and have the front desk call you right back.",
  "guidance": "Do not retry book_appointment. Call request_callback with whatever you already know."
}
```

### 时段被抢走

客人在电话里犹豫的那一分钟，前台或网站可能把它订走了。

```jsonc
{
  "ok": false,
  "error": "RESOURCE_CONFLICT",
  "say": "I'm sorry, that time was just taken. Let me find you another one.",
  "guidance": "Call find_slots again for a fresh time, then book_appointment."
}
```

`STAFF_OVER_CAPACITY` / `LOCATION_OVER_CAPACITY` 走同一条路（超容量放行需要
一个知道现场情况的人，电话那头没有）。其余错误的 `guidance` 一律是
「改调 request_callback，不要重试」。

### 幂等

幂等键是 `telnyx-book-{call_session_id}`。通话重连、webhook 重投都会重放 ——
不去重的话客人会收到**两条确认短信**，而店里多了一个不存在的预约。

⚠️ **念出去的确认码从库里读回来**，不用这一次调用生成的那个：
重放走的是总线缓存的结果（预约还是第一次那条），而这一次又生成了一个新码。
直接念它的话，客人手机上的短信写着 `GF-4K2P`，AI 在电话里念的是 `GF-ZRY5`。

## 7. `request_callback` — 兜底，留给前台回电

> 旧名 `draft_appointment`。**两个路径都还在**，指向同一个 handler ——
> Telnyx 侧的配置是人工同步的，一次改名不该让电话打不通。

**何时调**：只在 `book_appointment` 明确告诉你不要重试时，
或信息实在凑不齐时。**它不创建预约。**

```
POST /v1/telnyx/tools/request_callback
POST /v1/telnyx/tools/draft_appointment   （旧名，等价）
```

入参与 `book_appointment` 基本相同，但**全部可空** —— 知道多少留多少。
（`to` 和 `shop_token` 除外：这两个是每条工具路由的前置，见 §0。）
落 `call_drafts` 表，出现在前台的「来电复核」屏。

```jsonc
{
  "ok": true,
  "draftId": "...",
  "say": "I've taken that down. The front desk will call you back to confirm — usually within a few minutes."
}
```

---

## 8. 一通电话的完整时序

```
接通 + 开场白
 └─ start_call(to, from)                     ← 整通电话只调这一次
      ├─ caller.customers 有 → 用名字打招呼，可提上次做的项目
      ├─ caller.customers 空 → 当新客
      ├─ >1 位 → 按 caller.guidance 问清是哪一位，不许替客人选
      └─ 项目 / 价格 / 加项 / 今天谁在班 / 一周营业时间，**都在手里了**
           客人问「有什么按摩」「几点关门」「有女技师吗」→ 直接答，不用调工具

 ├─ [客人说了想要的时间]
 │   find_slots(to, services[], around, party_size?, gender_preference?, staff_membership_id?)
 │    ├─ slots 有 → 只能从里面挑                        ← 每次报时间都要调
 │    ├─ slots 空 + alternatives 有 → 先说「那天满了」，再问「换 X 号行吗」
 │    └─ 两个都空 → 换一天或转前台，不要自己报时间
 │
 ├─ 向客人复述：项目 / 时间 / 技师 / 人数，等对方确认
 └─ book_appointment(...)
      ├─ ok:true  → 念 say，确认短信已在路上
      └─ ok:false → 按 guidance 走：重新 find_slots，或 request_callback

[任何时候] 客人要改期 / 取消 / 讲价 / 听不懂 → request_callback，说「前台会回电」
```

⚠️ **`start_call` 一次，`find_slots` 可以很多次。** 这条线划在
「会不会在通话过程中变」上：客人是谁、卖什么、谁在班不会变；空档会。

## 9. 明确不做的事

- ❌ **AI 不改期、不取消。** 权限集里没有，客人要改一律转前台或让前台回电。
- ❌ **AI 不报折扣、不承诺价格以外的事。** `list_services` 的 `guidance` 写死了。
- ❌ **AI 不自己算空档。** 只能用 `find_slots` 返回的。
- ❌ **AI 不念完整手机号。** 权限集里没有 `customer.view_contact`。
- ❌ **AI 不传 `override`。** 超容量放行需要一个知道现场情况的人。
- ❌ **AI 不单卖加项。** 只听到加项时不建单，回去问主项目。

---

## 10. 通话记录：计量、转录、录音（`sql/0037`）

> **这一节是后端，已经做完。** assistant 那边不用配任何东西 ——
> 它不知道有这回事。

### 10.1 为什么不能只靠挂机 webhook

2026-08-23 第一通真实电话打完，`phone_calls` 是**空的** ——
而 `/v1/telnyx/webhook` 明明收到了两条请求。挂机那条事件要么发去了别处
（Telnyx 的 connection 上可以单独配 webhook 地址），要么用的是别的事件名。

漏掉它的后果是**静默**的，这是关键：

- 没记通话时长 → **没扣客户的语音分钟** → 月底账对不上，全程零报错
- 没有转录 → AI 在电话里答应了客人什么，事后谁也说不清

所以计量走**两条腿**：

```
挂机 webhook 到了  → 当场记（快，但可能永远不到）
对账任务           → 从 Telnyx 拉回来补（慢几分钟，但一定准）
```

### 10.2 数据从哪来

Telnyx 每通电话存一条 **AI conversation**，比 webhook 全得多：

| 字段 | 用来做什么 |
|---|---|
| `metadata.to` / `from` | 定位门店（和电话工具同一条路：`tenantForPhoneNumber`） |
| `metadata.call_session_id` | ⭐ **幂等键** —— 和 webhook 那条腿必须是同一个 |
| `metadata.called_tools` | 这通电话调过哪些工具 |
| `created_at` / `last_message_at` | 时长（Telnyx 不直接给秒数） |
| `/messages` | **完整逐句转录**，连每次工具调用和它的返回都在 |

实现：[`telnyx/conversations.ts`](../apps/api/src/telnyx/conversations.ts)（只取数、不写库）
+ [`telnyx/reconcile.ts`](../apps/api/src/telnyx/reconcile.ts)（走命令总线写库）。

### 10.3 ⚠️ 为什么是两条命令

这是这套东西里最容易做错的一处：

```
call.record           记时长 + 扣语音分钟   幂等键 telnyx-hangup-{call_session_id}
call.attachTranscript 补转录/工具/录音       幂等键 telnyx-conv-{conversation_id}
```

**不能合成一条。** webhook 先记过之后，对账任务再用同一个幂等键
dispatch `call.record` 会**命中缓存直接返回** —— 处理器根本不执行，
转录永远写不进去。而换一个幂等键就会**再扣一次语音分钟**：
那是直接给客户多收钱。

所以：计费那条一通电话只记一次，补料那条随便补多少次都不碰钱
（有测试钉着这两件事）。

`call.attachTranscript` 找不到对应的通话时**什么都不做**，不凭空插一行 ——
插了就会出现一条「有转录、没时长、没扣过分钟」的幽灵通话。

### 10.4 怎么开

```bash
# API 里定时跑（默认关）。值是间隔分钟数
TELNYX_RECONCILE_MINUTES=15

# 手动补一段历史（分钟）
pnpm exec tsx apps/api/src/ops/reconcileCalls.ts 4320
```

两台机器同时跑不会记两遍 —— 幂等键挡着（`telnyx/schedule.ts`）。

### 10.5 前台看到什么

```
GET /v1/desk/calls?days=7&limit=50        权限：appointment.read
```

```jsonc
{
  "calls": [
    { "callId": "…", "fromE164": "••••6667", "startedAt": "…",
      "durationSeconds": 193, "outcome": "completed",
      "toolsUsed": ["start_call", "find_slots", "book_appointment"],
      "booked": true,                      // ⭐ 一眼看出这通电话有没有订上单
      "recordingUrl": null,
      "transcript": [ { "role": "assistant", "text": "You're all set…" } ] }
  ],
  "bookedCount": 2,
  "totalMinutes": 9
}
```

- **来电号码按 `customer.view_contact` 脱敏**（没这个权限只看到尾号）——
  和来电复核屏同一个口径：看得见有这通电话，不等于能抄走客人的号码
- **转录是 AI 说错话之后唯一的证据。** 决策 6 改成「AI 直接建单」之后，
  前台不再逐单复核 —— 客人到店说「电话里明明说五点」时，只有这里能对质
- 它同时是 `04` §9「AI 到底准不准」唯一诚实的度量来源

### 10.6 录音

`recording_url` 这一列**只负责存**。要不要录、录了传哪去，在 Telnyx 那边配。

> ⚠️ **加州是 two-party consent**（`09` §4.4）。开录音必须在开场白里
> 告知客人正在录音 —— 这是 assistant 那边的事，但后端这一列存在
> 不等于合规已经做到。

---

## 11. 转接人工与自动挂断

> **后端只做两件事：告诉 AI 能不能转、以及事后记下它转了。**
> 转接和挂断本身是 Telnyx 的**内置工具**，配在 assistant 上。

### 11.1 转接

`start_call` 的返回里有：

```jsonc
"transfer": { "available": true, "e164": "+16175550199" }
```

来自 `phone_lines.purpose = 'transfer_target'` —— 店家在「开店配置 → 电话」
里填的那个号，多数时候是老板的手机（`09` §2）。

- `available: false` 时 `guidance` 里会写死**「never say you will transfer」**。
  说了「我帮您转接」却转不过去，客人听到的是一声忙音，然后这通电话就没了 ——
  那种情况要走 `request_callback`（前台回电）
- assistant 侧：加 Telnyx 的内置 `transfer` 工具，号码填这个 `e164`
- 转走的通话在 `call.record` 里记 `outcome: 'transferred_to_human'`
  （对账任务目前一律记 `completed`，转接是不是该单独标出来，
  取决于 Telnyx 给不给这个信号 —— **还没定，见下**）

### 11.2 自动挂断

Telnyx 的内置 `hangup` 工具，assistant 上**已经配好了**。
后端这边只在 `start_call` 的 guidance 里加了一句「客人没别的事就道别挂断，
不要挂着空线」—— 空线烧的是语音分钟，而那是按分钟卖给店家的。

### 11.3 还没做的

| 事项 | 卡在哪 |
|---|---|
| 转接结果分开记 | 对账任务现在一律记 `completed`。要区分得看 Telnyx 的 conversation 里有没有转接信号 —— 真转一次电话看一眼 metadata 就知道 |
| 录音落我们自己的存储 | 现在只存 Telnyx 给的 URL。那个 URL 会不会过期没验证过 |
| 通话统计进老板的报表 | `/v1/desk/calls` 已经给了 `bookedCount` / `totalMinutes`，但还没接进「经营报表」那一页 |

---

## 12. 本地怎么测（不打真电话）

这六个接口没有登录用户，**少了签名一律 401**，所以 curl 试不动。
仓库里有一把开发用的密钥和一个假电话脚本：

```bash
pnpm db:migrate && pnpm db:seed          # 种子店：绑好 AI 号、排好 7 天班、有加项
TELNYX_PUBLIC_KEY=$(node scripts/voice-tool.mjs pubkey) pnpm exec tsx apps/api/src/main.ts
```

另开一个终端：

```bash
node scripts/voice-tool.mjs flow                       # 一通完整的电话
node scripts/voice-tool.mjs list_services              # 单独调一个工具
node scripts/voice-tool.mjs find_slots '{"party_size":2}'
TO=+13235550123 node scripts/voice-tool.mjs list_staff '{"gender":"male"}'   # 换足疗店
```

- 种子给两家店各绑了一个 AI 号：美甲 `+12125550123`、足疗 `+13235550123`
  （**不绑的话每个工具都是 404** —— 定位门店只有被叫号码这一条路）。
  要拿真号打进种子店：`SEED_AI_LINE=+1… pnpm db:seed`
- 每个号还有一串 `shop_token`（§0），`pnpm db:seed` 会打印出来。
  **脚本自己会带上**（种子店的 token 从门店 uuid 推出来，重灌不变）；
  换真号测试时 `SHOP_TOKEN=st_… ` 覆盖。
  ⚠️ 种子那串是固定的开发值 —— 真实门店的由命令随机生成，只露一次面
- 班表也在种子里（今天起 7 天，published）。**没有班次 `find_slots` 永远返回空**，
  而那个表现和「今天真的约满了」一模一样
- ⚠️ `.dev-telnyx-key.json` 是开发专用私钥（已 gitignore）。
  它签得出合法请求，**生产的 `TELNYX_PUBLIC_KEY` 永远不能是它**

### 真号在种子店上测

真号是运维手工绑的（`ops/bindAiLine.ts`），而**重灌种子会按 org 删掉
`phone_lines` 再插一遍** —— 真号的绑定和 token 会一起没，
表现是 Telnyx 那边配好的 `shop_token` 和库里对不上，那家店的电话全部 401。

所以真号在测的时候，重灌种子要把它带进来：

```bash
SEED_SPA_AI_LINE=+17579999968 SEED_SPA_TOOL_TOKEN=st_… pnpm db:seed
```

（美甲店那两个是 `SEED_AI_LINE` / `SEED_TOOL_TOKEN`。）

⭐ **忘了也不会静默出事**：种子在动手之前会检查库里的 AI 线，
发现不是 555 假号的就**直接停下**，把上面这条命令打给你。
确实要清掉：`SEED_FORCE=1 pnpm db:seed`。

---

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-24 | 通话计量改成两条腿（挂机 webhook + 从 Telnyx conversation 对账，`sql/0037`）；转录、用过哪些工具、录音落库并开放给前台 `/v1/desk/calls`；`start_call` 带上转接号；短信署名从店名改成 GenieFront；⭐ **`find_slots` 改为返回可直接念的门店当地时间** —— 此前返回 UTC ISO，模型把 17:00 念成了 5 PM，而那家店在洛杉矶（上午十点） |
| 2026-08-22 | 种子在冲掉真号的 AI 线之前会停下来（`SEED_FORCE=1` 才继续）；`phone.test.ts` 跑完会把种子店那两条线放回去 —— 之前跑一次测试本地就全 404 |
| 2026-08-22 | `lookup_customer` / `list_services` / `list_staff` 合并成 `start_call`（接通时一次抓完，另给一周营业时间）；三条老路由保留但 assistant 里默认不配。**`find_slots` 刻意没合进去** —— 空档会在通话过程中被订走 |
| 2026-08-22 | 每条 `ai_voice` 线一串工具 token（`sql/0036`，验签之后的第二道门，填进 assistant 配置；webhook 那条路不检查）；六个工具的返回都带上 `shop`（哪家店）；号码反查失败不再一律当成「没绑门店」—— 库挂了要报 `phone_lookup_failed` |
| 2026-08-22 | `find_slots` 补齐 `services[]` / `party_size` / `gender_preference` / `alternatives`；`list_services` 拆出 `addons`（`sql/0035` 的 `is_addon`，门店设置里可勾）；`book_appointment` 支持多项目连做、加项、多人各配一位技师，确认码改为从库里读回（幂等重放不再念错码）；`scripts/voice-tool.mjs` 假电话脚本 |
| 2026-08-22 | 加 `list_services` / `list_staff` / `book_appointment`；`draft_appointment` 更名 `request_callback` 并降为兜底；`PHONE_AI_PERMISSIONS` 加 `appointment.write`；`appointment.create` 的 `web` 载荷更名 `guest`（电话与网页共用） |
| 2026-08-18 | 初版三工具：`lookup_customer` / `find_slots` / `draft_appointment` |
