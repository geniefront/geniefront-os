-- ════════════════════════════════════════════════════════════════════════════
--  0031 · 占位符员工（Ghost Profile）+ 技师上机会话
--
--  ## 要解决的问题
--
--  开一家新店的第一件事是「把我的三个技师加进来」，而在这之前系统里
--  **没有任何一条命令能新增员工**：`memberships.user_id` 非空、外键指向
--  `users`，而 `users.id` 必须等于 `auth.users.id` —— 也就是说
--  「加一个还没登录过的人」在数据模型里根本没有位置（docs/12 §6.3）。
--
--  ## 解法：user_id 可空 = 这个人还没上机
--
--  一条 `user_id is null` 的 membership 是一位**真实在岗的技师**：
--  能被派单、能开单、能算提成、能发小费。他只是还没在自己手机上登录过。
--
--  ⚠️ 当初把这条路标成「风险最大」的理由是：`user_id` 可空之后，
--  「这条 membership 是不是一个真人」会变成每个查询各自判断的事，
--  而漏判的表现是「技师看得到别人的单」。
--
--  **那个风险在这里是封死的，靠的不是自觉：**
--
--    身份解析只有两个入口（packages/db/src/identity.ts 的
--    `listMembershipsForUser` 与 `loadMembershipBase`），两个都用
--    `user_id = app_user_id()` 比对，而 **NULL 不等于任何东西** ——
--    ghost 行在身份模式下连查都查不到，不是「查到了再判断」。
--    0003 那组 `identity_self` 策略是同一个写法，所以数据库这一层
--    也是同样的结论。测试里有一条专门盯着它（signup/staff 测试）。
--
--  ## 上机（claim）走两条路，都不经过密码
--
--    ① **上机码**：老板在员工页点一下，给一个 6 位数字（几分钟有效）。
--       **不依赖短信** —— 宪法第 13 条说的「短信不进依赖链」照旧成立，
--       10DLC 还没批下来也能用
--    ② **手机验证码**：Telnyx Verify 发码、Telnyx 验码（docs/09 §5）。
--       技师自助，不用麻烦老板。⚠️ 美国 A2P 没批之前会被运营商过滤，
--       所以它是第二条路，不是唯一那条
--
--  两条路的终点是同一个东西：一条 `staff_sessions` 记录。
--  ⭐ 明文令牌只在签发那一刻给一次，库里只有 SHA-256 摘要 ——
--  和设备令牌（0016）一模一样的纪律，而且**可以吊销**：
--  技师手机丢了，老板点一下「踢下线」就完事，不用等任何东西过期。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Ghost：membership 可以没有账号 ──────────────────────────────────────

alter table memberships alter column user_id drop not null;

comment on column memberships.user_id is
  'null = 占位符员工（Ghost Profile）：老板加进来了、能接客能算钱，但还没在'
  '自己手机上上机过。⚠️ 身份解析一律用 user_id = app_user_id() 比对，'
  'NULL 不等于任何东西 —— ghost 因此天生登不进来（sql/0031 头部有完整论证）。';

-- ⭐ 一个人在一家店只能有一条身份。
--
-- 上机那一步是「把 user_id 填进一条已有的 ghost」，如果这个人在这家店
-- 已经有一条真身份（比如他以前用邮箱登录过），就会变成两条 —— 而两条
-- membership 意味着两份提成、两个轮牌位置，对不上账的时候没人查得出来。
-- ⚠️ ghost 之间不受这个约束（全是 null，本来就不冲突）。
create unique index if not exists memberships_one_per_person
  on memberships (location_id, user_id) where user_id is not null;

-- ── 2. 员工档案：手机号、界面语言、上机码 ──────────────────────────────────

alter table staff_profiles add column if not exists phone_e164 text;
alter table staff_profiles add column if not exists locale text;
alter table staff_profiles add column if not exists claim_code_hash text;
alter table staff_profiles add column if not exists claim_code_expires_at timestamptz;

-- ⭐ 店内唯一：手机验证码上机时靠它找人，两条一样的号码会让「他是谁」
-- 变成一个随机结果 —— 而随机落到同事身上意味着看到同事的单。
--
-- ⚠️ 刻意**不做全局唯一**：一个技师在两家店上班是这行的常态
-- （和 phone_lines 那条「唯一是为了谁」是同一个判断，docs/10 §4.16）。
create unique index if not exists staff_profiles_phone_per_location
  on staff_profiles (location_id, phone_e164) where phone_e164 is not null;

comment on column staff_profiles.locale is
  '这位技师自己的界面语言。用邮箱登录的人存在 users.locale，'
  '而手机上机的技师**没有 users 行** —— 那种情况存这里。';

-- ⭐ **同一时刻全局只能有一个活码**。
--
-- 输码的技师不知道自己在哪家店（他就是来上机的），所以码不能按门店加盐 ——
-- 而不加盐就意味着两家店可能同时发出同一个 6 位数字，然后其中一位技师
-- **绑到别人家的店里**，看到的是陌生人的单。那种事查起来毫无线索。
--
-- 这个唯一索引把它变成不可能：第二家店发到重复的码会撞约束，
-- 发码那一侧换一个再试（活码总共只有几个，实际上从不会撞）。
create unique index if not exists staff_profiles_claim_code_unique
  on staff_profiles (claim_code_hash) where claim_code_hash is not null;

comment on column staff_profiles.claim_code_hash is
  '上机码的 SHA-256 摘要。明文只在老板屏幕上出现一次，库里存不下能用的码。'
  '⚠️ 不按门店加盐（输码的人不知道自己在哪家店），改用唯一索引保证'
  '同一时刻全局只有一个活码。';

-- ── 3. 技师上机会话 ────────────────────────────────────────────────────────

create table if not exists staff_sessions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id),
  location_id    uuid not null references locations(id),
  membership_id  uuid not null references memberships(id) on delete cascade,

  -- ⭐ 只存摘要。和设备令牌、PIN 一个道理：库被拖走，拿到的摘要换不回令牌
  token_hash     text not null unique,

  -- claim_code | phone_otp —— 事后要能回答「这台手机是怎么绑上的」
  method         text not null,
  device_label   text,

  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- 60 天滚动。技师天天用，过期只会发生在「这个人已经不来了」的时候
  expires_at     timestamptz not null default now() + interval '60 days',
  revoked_at     timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_sessions_method') then
    alter table staff_sessions add constraint staff_sessions_method
      check (method in ('claim_code','phone_otp'));
  end if;
end $$;

create index if not exists staff_sessions_membership_idx
  on staff_sessions (membership_id, revoked_at);

alter table staff_sessions enable row level security;
alter table staff_sessions force  row level security;
drop policy if exists tenant_isolation on staff_sessions;
create policy tenant_isolation on staff_sessions
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update, delete on staff_sessions to app_user;

-- ── 4. ⭐ 会话令牌维度的解析 ───────────────────────────────────────────────
--
-- 技师的手机打进来时只带得出一个令牌摘要，带不出 org_id ——
-- 和门口 iPad（0016）、AI 电话的被叫号码（0015）、登录后还没选店（0003）
-- 是同一类问题：**缺的是上下文，不是权限**。
--
-- 策略只放行摘要**恰好相等**的那一行：必须先说出完整的 SHA-256 摘要
-- 才查得到，枚举不出会话表；查到的只有一行。
--
-- ⚠️ 正常租户上下文里 app.staff_token_hash 是空的，`token_hash = null`
-- 恒为 null（不是 true），所以这组策略在日常路径上等于不存在。

create or replace function app_staff_token_hash() returns text
language sql stable as $$
  select nullif(current_setting('app.staff_token_hash', true), '')
$$;

drop policy if exists staff_session_lookup on staff_sessions;
create policy staff_session_lookup on staff_sessions
  for select using (token_hash = app_staff_token_hash());

-- last_seen_at 要能写：老板在员工页看「这台手机还在不在用」，
-- 那是决定要不要踢下线的唯一依据
drop policy if exists staff_session_touch on staff_sessions;
create policy staff_session_touch on staff_sessions
  for update
  using (token_hash = app_staff_token_hash())
  with check (token_hash = app_staff_token_hash());

-- 解析一条会话要顺带取到「他是谁、在哪家店、这家店什么时区」。
-- 每一条都限定在**那条会话自己指向的**行上，多一行都看不到。
drop policy if exists membership_by_staff_session on memberships;
create policy membership_by_staff_session on memberships
  for select using (exists (
    select 1 from staff_sessions s
    where s.membership_id = memberships.id and s.token_hash = app_staff_token_hash()));

drop policy if exists profile_by_staff_session on staff_profiles;
create policy profile_by_staff_session on staff_profiles
  for select using (exists (
    select 1 from staff_sessions s
    where s.membership_id = staff_profiles.membership_id
      and s.token_hash = app_staff_token_hash()));

drop policy if exists location_by_staff_session on locations;
create policy location_by_staff_session on locations
  for select using (exists (
    select 1 from staff_sessions s
    where s.location_id = locations.id and s.token_hash = app_staff_token_hash()));

drop policy if exists org_by_staff_session on organizations;
create policy org_by_staff_session on organizations
  for select using (exists (
    select 1 from staff_sessions s
    where s.org_id = organizations.id and s.token_hash = app_staff_token_hash()));

comment on table staff_sessions is
  '技师手机上的一次上机。明文令牌只在签发那一刻给一次，库里只有摘要；'
  '手机丢了老板点「踢下线」即刻失效 —— 这正是不用自签 JWT 的理由。';

-- ── 5. 上机码的查找路径 ────────────────────────────────────────────────────
--
-- 技师输入 6 位上机码时，同样没有任何租户上下文。
-- 但这里**不能**照搬上面那套「摘要相等就放行」：6 位数字只有一百万种，
-- 而 SHA-256 是可以离线全跑一遍的 —— 也就是说「摘要」在这里
-- **不是秘密**，它只是把明文换了个写法。
--
-- 所以上机码走一个 SECURITY DEFINER 函数，把三件事一起做完：
--   · 限定「未过期、未被用掉」
--   · **一次性**：查到就当场把码作废（同一条语句里，没有查完再写的缝隙）
--   · 只返回那一条 membership 的归属，不返回任何别的东西
--
-- 真正的防线是**限频 + 短时效**（路由那一层），这个函数保证的是
-- 「猜中一次也只能用一次」。

create or replace function public.gf_redeem_staff_claim_code(p_code_hash text)
returns table (membership_id uuid, org_id uuid, location_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_m uuid;
  v_o uuid;
  v_l uuid;
begin
  update staff_profiles sp
     set claim_code_hash = null, claim_code_expires_at = null
   where sp.claim_code_hash = p_code_hash
     and sp.claim_code_expires_at > now()
     -- 离职的人手里那张码不该还能用
     and exists (select 1 from memberships m
                  where m.id = sp.membership_id and m.status = 'active')
  returning sp.membership_id, sp.org_id, sp.location_id
       into v_m, v_o, v_l;

  if v_m is null then return; end if;
  return query select v_m, v_o, v_l;
end $$;

revoke all on function public.gf_redeem_staff_claim_code(text) from public;
grant execute on function public.gf_redeem_staff_claim_code(text) to app_user;

comment on function public.gf_redeem_staff_claim_code(text) is
  '兑换上机码：查到即作废（同一条 update，没有查完再写的缝隙）。'
  '⚠️ 6 位码的摘要不是秘密（一百万种可以离线全跑），真正的防线是路由层的'
  '限频 + 几分钟时效；这个函数保证的是「猜中一次也只能用一次」。';

-- ── 6. 手机号找人：同样是一个极窄的函数 ────────────────────────────────────
--
-- 手机验证码那条路，验码是 Telnyx 做的；我们这边要回答的是
-- 「这个已经被验证过的号码，对应哪几条在岗身份」。
--
-- ⚠️ 一个技师在两家店上班就有两条 —— 这是常态，不是异常。
-- 返回多条时由界面让他选一家（和多店老板的选店器同一件事）。

create or replace function public.gf_staff_by_phone(p_phone text)
returns table (membership_id uuid, org_id uuid, location_id uuid, display_name jsonb)
language sql
security definer
set search_path = public
as $$
  select sp.membership_id, sp.org_id, sp.location_id, sp.display_name
  from staff_profiles sp
  join memberships m on m.id = sp.membership_id and m.status = 'active'
  join locations l on l.id = sp.location_id and l.status not in ('closed','suspended')
  where sp.phone_e164 = p_phone
  order by sp.location_id
$$;

revoke all on function public.gf_staff_by_phone(text) from public;
grant execute on function public.gf_staff_by_phone(text) to app_user;

comment on function public.gf_staff_by_phone(text) is
  '已验证的手机号 → 在岗身份（可能多家店）。⚠️ 调用方必须先完成短信验证，'
  '这个函数本身不验证任何东西 —— 它是「验完之后找人」的那一步。';
