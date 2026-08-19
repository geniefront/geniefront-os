# 12 · 自助开户：从付款到能用

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
  ⚠️ **不要再用 Resend 补发一封「欢迎」**：两封邮件里只有一封的链接是活的，
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
| ② **手机验证码** | Telnyx Verify 发码验码 | 他自己来，不用麻烦老板 |

⚠️ **为什么上机码排第一**：宪法第 13 条与 `09` §1.2 都写着「短信不进依赖链」，
而美国 A2P 10DLC 批下来之前，验证码大概率被运营商静默过滤。
两条路并排摆着，缺哪条都不影响开店。

⚠️ **一个已知的降级**：上机会话**没有实时推送**。Supabase Realtime 的
私有频道认的是 Supabase 的 JWT，而上机会话签不出那个东西
（签得出就意味着我们手里有 Supabase 的签名密钥，那是另一个量级的风险）。
所以这种身份下派单靠 **10 秒轮询**，响铃比「实测 2 秒」慢几秒，
界面上如实写着「每 10 秒刷新」。要拿回 2 秒，只能等 Supabase 手机号登录
（那要另配一个短信供应商）—— **不要为此在服务端自签 Supabase 令牌**。
