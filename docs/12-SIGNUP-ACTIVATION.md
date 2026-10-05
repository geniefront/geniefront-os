# 12 · 自助开户：从付款到能用

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](qa/TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


> **写给接手实现这条链路的 AI。** 官网那一侧的契约在 [11](11-WEBSITE-INTEGRATION.md)，
> 这一份是**我们这一侧**要做的全部。
>
> **状态（2026-08-18）：A / B / C 已实现并测过，D 还没做。**
> 落地时和这份清单有三处不一样，见文末 §6 —— 都是实现的时候才暴露出来的。
>
> 动手前必读 `03` §A 已定决策 + §D 项目宪法。
> §2 的两个难点**已经定了解法，不要重开** —— 那两处如果走错方向，
> 会一路撞到宪法上然后推倒重来。

---

## 1. 现状：这条路整个是空的

⚠️ **这套系统目前假设门店已经存在。** 所有 RLS、命令、账单都挂在一个已有的
`org` + `location` 上，而那是**手工塞进去的种子数据**。

```bash
# 验证一下（除了种子脚本，一处都没有）
grep -rn "insert into organizations" apps/ packages/ --include='*.ts' | grep -v seed
```

Stripe webhook 也一样：它从 metadata 读 `gf_org_id` 来定位租户，
而新客**还没有 org**。

---

## 2. ⭐ 两个架构难点（解法已定，别重开）

### 2.1 建租户时还没有租户上下文

**问题**：所有表都是 `force row level security`，策略是 `org_id = app_org_id()`。
而「建一个新 org」这件事，执行的时候 `app_org_id()` 必然是空的。

**❌ 不要做的**：拿 `service_role` 或 postgres 角色去插。
宪法第 5 条：**应用运行时永远不需要能绕过 RLS 的凭据**，
`scripts/lint-guards.sh` 会直接让 CI 失败。

**✅ 已定解法：一个 `SECURITY DEFINER` 函数**，和 `public.gf_broadcast()`
完全同一个套路（sql/0012 有完整论证）：

```sql
create or replace function public.gf_provision_tenant(
  p_checkout_session text,
  p_shop_name  text,
  p_owner_email text,
  p_business_type text,
  p_timezone   text,
  p_locale     text,
  p_plan       text
) returns table (org_id uuid, location_id uuid, already boolean)
language plpgsql
security definer            -- owner = postgres
set search_path = public
as $$ … $$;

revoke all on function public.gf_provision_tenant(…) from public;
grant execute on function public.gf_provision_tenant(…) to app_user;
```

要点：

- **`app_user` 只能调这个函数，不能直接 insert `organizations`**。
  函数是一道极窄的口子，不是一把万能钥匙
- **幂等在函数里做**：`p_checkout_session` 唯一。Stripe 会重投，
  重投必须返回**已经建好的那一家**（`already = true`），不能建出第二家。
  ⚠️ 这是这个函数最重要的性质 —— 建出两家店的话，老板会看到两个空店铺，
  而只有一个能用，他分不出是哪个
- **函数里不发邮件、不调外部**。它只做数据库那一段，几毫秒返回

### 2.2 发激活邮件不能用 service_role

**问题**：Supabase 的 `auth.admin.inviteUserByEmail()` 要 `service_role`，
而 `apps/` 拿不到（同上）。

**✅ 已定解法：用 `signInWithOtp`（anon key 就够）**

```ts
await supabase.auth.signInWithOtp({
  email: ownerEmail,
  options: {
    shouldCreateUser: true,
    emailRedirectTo: 'https://desk.geniefront.com/activate',
  },
});
```

- anon key 能调，不需要 service_role
- token 的有效期、单次使用、撤销**全部由 Supabase 处理** ——
  ⚠️ **不要自己造「邮件里的长字符串 = 身份」那一套**。
  按 `09` §5.2 的标准问一句「捡到这个链接的人能干什么」：
  能成为一家已付费门店的老板。这条链路的强度必须和登录一样，
  那就别自己发明
- 邮件正文在 **Supabase 控制台的 Magic Link 模板**里改成欢迎语。
  ⚠️ **不要再用 SES 补发一封「欢迎」**：两封邮件里只有一封的链接是活的，
  老板会点错那封然后以为系统坏了

---

## 3. 任务清单（按顺序，每一项都能单独验收）

### A · 建租户

| # | 做什么 | 验收标准 |
| :--- | :--- | :--- |
| A1 ✅ | 迁移：`locations.status`（`setup` / `active` / `suspended`），默认 `active`（老店不受影响） | 已有门店 status 全是 `active` |
| A2 ✅ | 迁移：`signup_intents` 表 —— `checkout_session_id` 唯一、记 metadata 原样、记 `provisioned_at` | 同一个 session 插两次撞唯一约束 |
| A3 ✅ | 迁移：`gf_provision_tenant()`（§2.1） | 直接调两次同一个 session，第二次返回 `already = true` 且总数没变 |
| A4 ✅ | Stripe webhook 加 `gf_signup` 分支：校验 `gf_owner_email === customer_email` → 调函数 | ⭐ 两个邮箱不一致时**拒绝并告警**，一行都不写 |
| A5 ✅ | 调 `signInWithOtp` 发激活信（§2.2），失败只记日志不回滚 | 邮件发不出去时，门店**照样建好了** —— 可以人工补发 |

> ⚠️ A5 的顺序：**先建店、再发信**。反过来的话，信发出去了但建店失败，
> 老板点进来看到「你不属于任何门店」，而钱已经付了。

### B · 认领门店

| # | 做什么 | 验收标准 |
| :--- | :--- | :--- |
| B1 ✅ | 命令 `setup.claimLocation`：把当前登录用户绑成这家店的 owner | 绑完能进 desk 并看到自己的店 |
| B2 ✅ | ⭐ 只认**邀请邮箱**：`auth.users.email` 必须等于 `signup_intents.owner_email` | 换一个账号登录后调用 → `PERMISSION_DENIED` |
| B3 ✅ | 一次性：认领过的 intent 不能再认领 | 第二次调用 → 明确报错，不是静默成功 |
| B4 ✅ | 用 `identity_self` 那套上下文（sql/0003）—— 用户还没有 membership 时也能查到自己 | 不需要新的绕过 RLS 的路径 |

> ⚠️ B2 是这条链路上**唯一的身份边界**。写松了 = 任何登录用户都能认领
> 一家别人付了钱的店。

### C · 开店向导

新店进去现在是一片空白 —— 零件都在（项目 / 员工 / 营业时间 / 电话 / 📷 拍价目表 / 🔎 Yelp），
缺的是**引导**。

| # | 步骤 | 复用什么 |
| :--- | :--- | :--- |
| C1 ✅ | 确认店名 / 时区 / 业态（官网传来的，让他改一次） | — |
| C2 ✅ | **一次填好店** | `🔎 Yelp 一键填店`（店名 + 邮编 → 地址/电话/营业时间） |
| C3 ✅ | **项目库** | `📷 拍价目表` + `🌐 补齐多语言` |
| C4 ✅ | 员工（加人 / 上机码 / 踢下线，见 §6.3） | 员工页签 + `staff.add`（sql/0031） |
| C5 ✅ | ☎️ AI 接电话（可选，可跳过） | `location.requestAiVoice`（`09` §2） |
| C6 ✅ | 完成 → `locations.status = 'active'` | — |

**向导的三条规矩**：

1. **每一步都能跳过**，跳过不拦着他用。一个卡在第三步出不去的向导，
   比没有向导糟得多 —— 他会关掉浏览器然后打电话来问
2. **进度存在 `locations.status` 和实际数据上**，不存「向导走到第几步」。
   存步数的话，他从别的设备登录进来会被拉回一个假的进度
3. **完成之后入口不消失**：向导里的每一步在「⚙ 开店配置」里都还在，
   老板随时能回去改

### D · UI（放最后做）

⚠️ **放最后是因为 C 会新增好几屏**，早做要返工。

方向：**苹果的精致 + 大字大按钮的实用**。用户画像是
「四十岁以上、英文不好、店里光线杂、手上有水」（`00` §2、宪法第 11 条）：

| 要 | 不要 |
| :--- | :--- |
| 大留白、细腻圆角与阴影、克制的动效 | 低对比度细字 |
| 触摸目标 **≥ 44pt** | 轻手势、悬停才出现的操作 |
| emoji 用在功能位（📷 🌐 ☎️ 💵），已经在用 | 玻璃拟态、花哨渐变 |
| 颜色 + 图标 + 文字**三通道**传达状态 | 只靠颜色区分（很多老板分不清红绿） |

**「现代高端」和「四十岁以上能用」不冲突** —— 冲突的是「现代」和「细字低对比」。
把精致花在**留白、圆角、字重层次、动效节奏**上，不要花在把字变小变淡上。

---

## 4. 已知的坑

### 4.1 `.env` 里带空格或 `<>` 的值必须加引号

启动方式是 `set -a && . ./.env`（shell 源入），不加引号的 `<` 被当成重定向，
**整个 .env 解析失败** —— 而症状是「api 起不来，报一个和你正在改的东西
毫无关系的 parse error」。`FROM_EMAIL='Name <a@b.com>'` 就是这么踩的。

### 4.2 `db:migrate` 之后紧接着跑测试会撞 `28P01`

迁移里有 `alter role app_user`，Supavisor 刷新凭据有几秒的瞬态。
**重跑一次就好**，别去查密码配置（`10` §4.5 查过了，没问题）。

### 4.3 权限加了要写数据迁移

权限存在 `role_permissions` 表里，**不是从 `ROLE_PRESETS` 实时算的**。
每次给 `PERMISSIONS` 加常量，都要配一条数据迁移（照 `sql/0017`），
否则老板升级完打开新页面看到的是「没有权限」。

### 4.4 邮件必须在事务提交之后发

在事务里发的话，事务回滚了但邮件已经飞出去了。
**邮件和扣款一样收不回来**（`10` §邮件、sql/0029）。
A5 那一步也一样：先提交建店的事务，再去调 `signInWithOtp`。

---

## 5. 做完之后要补的文档

- `08-SEED-STORE-TRIAL.md` 加一节「从买到用的第一天」
- `11-WEBSITE-INTEGRATION.md` §7 的两个负例填上实测结果
- `10-HANDOFF.md` 的进度表

---

## 6. 落地之后：和上面这份清单不一样的三处

### 6.1 「向导」做成了一张**清单**，不是一步一步的流程

§3 C 的三条规矩里，第一条是「每一步都能跳过，卡在第三步出不去的向导
比没有向导糟得多」。一步一步做的话，那条规矩要靠一个个「跳过」按钮去实现 ——
而做成清单，它天然就成立了：五项各自独立，顺序只是建议。

清单占的是**首页那一格**（轮牌板那个页签），不是盖住全屏的一层。
于是「去配项目」是真的跳走了，配完点回轮牌板又能看到清单，
向导里一屏都不用重做（`apps/desk/src/screens/SetupWizard.tsx`）。

进度全部从真实数据推：项目数、可接客的员工数、有没有地址、有没有 AI 号码。
唯一存下来的一条是 `settings.profile_confirmed_at` —— 它**不是**「走到第几步」，
是「有没有人真的看过一眼时区」，换台设备登录看到的是同一件事。

### 6.2 建租户之外还需要**两个** SECURITY DEFINER 函数

§2.1 只说了 `gf_provision_tenant()`。实现时撞出另外两个绕不开的：

- `gf_signup_intent_for_user(user_id)` —— 「这个登录用户能认领哪一家店」。
  邮箱比对必须在函数里做（它 join 的是 `auth.users`，app_user 看不到那个 schema）。
  ⭐ 好处比预想的大：应用这一侧连一个可以传错的邮箱字段都没有，
  B2 那条身份边界成了**数据库事实**
- `gf_sync_user_from_auth(user_id)` —— 把 `auth.users` 那一行镜像进 `public.users`。
  非它不可的理由是一个环：`users` 的 RLS 要求「先有同 org 的 membership」，
  而 `memberships.user_id` 又有外键指向 `users`

除了这三个函数，认领那一步的全部写入仍然是一条正常命令
（`setup.claimLocation`）—— 有 Zod、有权限、有审计、在事务里、受 RLS 约束。
**建租户绕不开数据库函数，认领绕得开，所以就不绕。**

### 6.3 ✅ 开店向导第四步（员工）：Ghost Profile（2026-08-18 定并实现）

原先这里写着「加不了新员工，三条路待拍板」。**老板选了占位符员工那条**，
已经实现（`sql/0031`）。

**做法**：`memberships.user_id` 改成可空。一条 `user_id is null` 的身份
是一位**真实在岗的技师** —— 能被派单、能开单、能算提成、能发小费，
他只是还没在自己手机上登录过。老板在员工页填个名字就加进来了。

**当初为什么把这条标成「风险最大」**：`user_id` 可空之后，
「这条 membership 是不是一个真人」会变成每个查询各自判断的事，
而漏判的表现是「技师看得到别人的单」。

**那个风险是封死的，不是靠自觉**：身份解析只有两个入口
（`listMembershipsForUser` / `loadMembershipBase`），两个都拿
`user_id = app_user_id()` 比对，而 **NULL 不等于任何东西** ——
ghost 在身份模式下连查都查不到。`ghostStaff.test.ts` 有一条专门盯着它：
拿真实用户的账号 + ghost 的 membershipId 去建上下文 → `PERMISSION_DENIED`。

**上机（技师第一次在自己手机上登录）走两条路**，终点都是一条
`staff_sessions` 记录（明文令牌只给一次、库里只有摘要、**可吊销**）：

| | 怎么用 | 什么时候用 |
| :--- | :--- | :--- |
| ① **上机码** | 老板点一下 → 6 位数字 → 念给他 → 15 分钟内输一次 | **默认这条**。不经过任何运营商 |
| ② **手机验证码** | **Twilio Verify** 发码验码（`09` §5） | 他自己来，不用麻烦老板 |

⚠️ **为什么上机码排第一**：宪法第 13 条与 `09` §1.2 都写着「短信不进依赖链」。
供应商挂了、账号欠费、10DLC 卡着 —— 上机码那条都照常能用，开店不受影响。

⚠️ **一个已知的降级**：上机会话**没有实时推送**。Supabase Realtime 的
私有频道认的是 Supabase 的 JWT，而上机会话签不出那个东西
（签得出就意味着我们手里有 Supabase 的签名密钥，那是另一个量级的风险）。
所以这种身份下派单靠 **10 秒轮询**，响铃比「实测 2 秒」慢几秒，
界面上如实写着「每 10 秒刷新」。要拿回 2 秒，只能等 Supabase 手机号登录
（那要另配一个短信供应商）—— **不要为此在服务端自签 Supabase 令牌**。

---

## 7. Google 账号登录（sql/0047，2026-08-26）

### 7.1 后端为什么几乎不用动

`apps/api/src/auth.ts` 验的是 **Supabase 的 JWKS**，不是某一种登录方式。
会话是密码登的、magic link 登的还是 Google 登的，它一视同仁 ——
`sub` 就是 `auth.users.id`，后面所有的东西（membership、RLS、权限）都挂在这个 id 上。

所以「加 Google 登录」在后端不是一个认证问题，**是一个认领门店的问题**。

### 7.2 ⭐ 真正会出事的那一处：Gmail 的点

认领门店那一步比对的是**邮箱字符串**（§3 B2：这是整条链路上唯一的身份边界）。
而 Gmail 忽略本地部分里的点、也忽略 `+` 之后的部分：

```
老板在官网结账，邮箱框里手打   john.doe@gmail.com     → 存进 signup_intents
他回头点「用 Google 登录」，Google 返回  johndoe@gmail.com
lower(si.owner_email) = lower(u.email)                → 不相等
```

**他付了钱，而且进不去。** 报出来的还是「没有可认领的门店」——
客服看到这句话第一反应是去查 webhook，而 webhook 一切正常。

这一行的老板几乎人人用 Gmail，而结账时手打邮箱带不带点完全看当时怎么顺手。
所以 0047 把比对换成了 `gf_canonical_email()`。

### 7.3 ⚠️ 为什么只对 Gmail 规范化

点号规则**只有 `gmail.com` / `googlemail.com` 成立**。
Google Workspace 的自建域名（`john.doe@corp.com`）**不忽略点** ——
那里 `john.doe@` 和 `johndoe@` 是两个不同的人。

一视同仁地去点，会让 **A 认领到 B 付钱的店**。那比原来那个
「付了钱进不去」严重一个量级：前者是投诉，后者是事故。

`+tag` 同理只在 Gmail 上剥。别的域名剥掉，会把
「同一个老板故意用 `owner+store1@` / `owner+store2@` 分开两家店」折叠成一条。

`signup.test.ts` 的 D 组盯着这两条，正反都有。

### 7.4 `email_confirmed_at` 那一条一个字都不能松

```sql
and u.email_confirmed_at is not null
```

不验的话，任何人都可以用别人的邮箱注册一个未验证账号，然后来认领他的店。

**Google 登录天然满足它** —— OAuth 回来的邮箱是已验证的，Supabase 会把
`email_confirmed_at` 填上。所以这道闸对 Google 那条路不构成任何摩擦，
留着它只挡该挡的人。

### 7.5 激活邮件和 Google 登录并不冲突

激活邮件走的是 `POST /auth/v1/otp` + `create_user: true`（§2.2），
它按**付款那个邮箱**建一个 auth 用户。老板如果不点那封信、
直接用同一个邮箱的 Google 账号登录，Supabase 会把这个 OAuth 身份
挂到同一个 `auth.users` 行上（邮箱唯一）。

而就算它没挂上，**认领仍然成立** —— 认领比对的是邮箱，不是 user id。
这一点是当初把身份边界放在邮箱上（而不是发一个我们自己造的激活码）
顺带换来的：登录方式怎么变，那条边界都不用改。

⚠️ 所以激活邮件里的落地页 `/activate` **也应该放一个「用 Google 登录」按钮**。
老板点开信、看到要输密码、退出去用 Google 登 —— 这条路要通。

### 7.6 前端要知道的：`claimable`

`GET /v1/me/locations` 现在多回一个字段：

```jsonc
{ "locations": [ … ],
  "claimable": { "locationId": "…", "shopName": "Lotus Nails & Spa", "plan": "essential" } }
```

在这之前，一个刚用 Google 登录进来的老板 `locations` 是空的，
而前端分不出他是「刚付完钱等着开通」还是「谁也不是」——
只能盲发一次 `POST /v1/setup/claim` 再看是不是 404，
也就是**用一次写操作去探测状态**。

⚠️ `claimable` 和 `locations` **可以同时非空**（已有一家店，又刚买了第二家），
所以不能写成「locations 空了才去看 claimable」。四种情况的跳转表见 `18` §2.2。

### 7.7 要去点的两个后台

代码之外还有配置，见 `07` §A1b：Google Cloud 建 OAuth client（回调填
**Supabase 的** `/auth/v1/callback`，不是我们的域名），Supabase 控制台开
Google provider + 把前端落地页加进 Redirect URLs 白名单。**dev 和 prod 两个项目都要。**

---

## 8. 忘记密码（2026-08-26）

```
POST /v1/auth/password/reset   { "email": "owner@maildrop.cc" }
→ 200 { "ok": true }           ← 永远是这个
```

### 8.1 为什么走我们的服务器

`supabase.auth.resetPasswordForEmail()` 在前端一行就能调完，而 anon key
本来就在前端包里 —— **所以这条路由挡不住有心人**。它挡的是别的三件事：

| | 不走服务器会怎样 |
| :--- | :--- |
| **邮件配额** | 被刷爆之后受损的是我们的发信域名信誉 —— 下一封真的重置邮件进垃圾箱。限频要在我们自己手里，不能只靠 Supabase 的全局默认值 |
| **`redirect_to`** | 前端传的话，「点重置链接跳到攻击者的页面」就只剩 Supabase 白名单一道，而那道是带 `/**` 通配的 |
| **客服** | 「他说没收到」这个问题永远查不下去。现在日志里有这一次尝试（邮箱只存摘要） |

和 §2.2 的激活邮件同一个判断：**只用 anon key，不碰 service_role**（宪法第 5 条）。

### 8.2 ⭐ 响应永远只有一种

「这个邮箱没注册过」是一句**不能说**的话。说了，这条路由就成了一个
「拿邮箱列表探测谁是我们客户」的接口，而客户名单对竞品是有价值的。

所以：邮箱不存在、格式根本不对、上游 Supabase 挂了 —— 全都返回
`200 { ok: true }`。格式错的那条尤其不能报 400：报了，探测的人就先用它
校准一遍「什么叫合法邮箱」，再拿真地址来比。

唯一的另一种响应是 429（每 IP 10 次/小时、每地址 5 次/小时）。
它不泄露任何东西：只说明这个 IP / 这个地址最近被打过。

⚠️ 按地址限频有一个代价：**知道你邮箱的人可以把你的额度打满**，
让你一小时内重置不了密码。所以给到 5 次而不是 1 次 —— 真人手滑两三次是常事，
而 Supabase 自己还有一道 60 秒冷却挡着连点。

⚠️ 限频 key 里放的是邮箱的 **SHA-256 摘要**，不是明文。
明文的话，我们等于把客户名单一份份寄进第三方的 Redis。

### 8.3 Gmail 的点（和 §7.2 是同一个坑）

他当初用 `john.doe@gmail.com` 注册，今天在忘记密码框里打 `johndoe@gmail.com` ——
Supabase 找不到这个账号，静默返回 200，**一封信都不会到**，
而他只会觉得这个系统坏了。

所以两个变体各调一次 recover。⭐ 这**不会**发出两封信：两个字符串里
最多只有一个真的存在账号，另一个在 Supabase 那边是空转。

规范化调的是数据库里的 `gf_canonical_email()`，**不在 TypeScript 里重写一遍**
（宪法第 2 条）。抄第二遍，某天认领门店和忘记密码会对同一个地址给出不同答案，
而那种不一致查起来极痛苦。

### 8.4 Google 注册的人点了「忘记密码」

他没有密码。Supabase 仍然会发一封重置信，点进去能**设**一个密码 ——
也就是给这个 Google 账号补上密码登录。**这个行为是对的，不用拦。**

但更可能的情况是他只是忘了自己当初是用 Google 注册的。所以
`/reset-password` 和忘记密码那一页都要放「用 Google 登录」按钮，
否则他会一直等一封自己其实不需要的信。

⚠️ **不要做「这个邮箱是用 Google 注册的」这种提示。** 那需要读
`auth.users` 的 identities，而把结果回给前端就等于确认了账号存在 ——
§8.2 那条纪律白守了。

### 8.5 落地页归前端

邮件里的链接跳到 `APP_BASE_URL + /reset-password`（服务端拼的）。
那一页从 URL 里拿 recovery token 建立会话，再调
`supabase.auth.updateUser({ password })` —— **这一步不经过我们的 API**。

⚠️ 记得把 `/reset-password` 加进 Supabase 的 Redirect URLs 白名单
（`07` §A1b），不加会被静默换成 Site URL。
