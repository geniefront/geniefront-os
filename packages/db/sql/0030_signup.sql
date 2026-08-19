-- ════════════════════════════════════════════════════════════════════════════
--  0030 · 自助开户：建租户 + 认领门店（docs/12）
--
--  这条链路和系统里其它所有写操作有一个根本区别：**执行的时候还没有租户**。
--  官网把钱收了，Stripe 把事件发过来，而这一刻 org 不存在、门店不存在、
--  老板的账号也还没有。所有 RLS 策略读的都是 app.org_id —— 它必然是空的。
--
--  ❌ 不能走的那条路：拿 service_role / postgres 去插。
--     宪法第 5 条「应用运行时永远不需要能绕过 RLS 的凭据」，
--     scripts/lint-guards.sh 会直接让 CI 失败。
--
--  ✅ 走的这条路：三个 SECURITY DEFINER 函数，和 sql/0012 的 gf_broadcast()
--     完全同一个套路 —— **一道极窄的口子，不是一把万能钥匙**。
--     app_user 拿到的只是这三个函数的执行权，拿不到任何一张表的额外权限：
--
--       gf_provision_tenant()      建 org + 门店 + 计费账户 + 开户意向（幂等）
--       gf_signup_intent_for_user() 「这个登录用户可以认领哪一家店」（只读）
--       gf_sync_user_from_auth()    把 auth.users 的那一行镜像进 public.users
--
--  后两个都**只看得到调用者自己那一行**：判定用的是 auth.users 里的邮箱，
--  不是应用传进来的字符串。于是「谁能成为这家店的老板」是一条数据库事实，
--  不是一句可以被忘记的 if（docs/12 §3 B2）。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 门店多一个 setup 状态 ────────────────────────────────────────────────
--
-- 新开的店落在 'setup'：付了钱、建出来了，但还没配项目、没配员工。
-- 走完开店向导才变 'active'。
--
-- ⚠️ **不是 'suspended' 也不是 'closed'** —— 那两个状态 buildContext 会
-- 直接拒绝登录（actor.ts），而这家店恰恰需要老板进得去才能配起来。
-- 'setup' 在 identity 的门店列表里也照常可见（identity.ts 只挡后两者）。
--
-- 老店不受影响：默认值仍是建表时的 'trial'，这条迁移一行数据都不改。

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'locations_status') then
    alter table locations add constraint locations_status
      check (status in ('setup','trial','active','past_due','suspended','closed'));
  end if;
end $$;

comment on column locations.status is
  'setup=向导没走完 | trial | active | past_due | suspended | closed。'
  '进度存在这一列和真实数据上，不存「向导走到第几步」—— 存步数的话，'
  '老板换一台设备登录会被拉回一个假的进度（docs/12 §3 C）。';

-- ── 2. 开户意向 ─────────────────────────────────────────────────────────────
--
-- 一次付款一行。它同时是三件事：
--   · **幂等键** —— checkout_session_id 唯一。Stripe 明确说了 webhook 是
--     「至少一次」投递，重投必须返回已经建好的那一家。建出两家店的话，
--     老板会看到两个空店铺而只有一个能用，他分不出是哪个
--   · **认领凭据** —— owner_email 决定谁能成为这家店的老板
--   · **留档** —— metadata 原样存下来。事后查「官网到底传了什么过来」
--     只有这一份是原始证据

create table if not exists signup_intents (
  id                   uuid primary key default gen_random_uuid(),

  -- ⭐ 幂等的全部依据。Stripe 的 checkout session id
  checkout_session_id  text not null unique,

  org_id               uuid not null references organizations(id),
  location_id          uuid not null references locations(id),

  -- ⭐ 收到激活邮件的人就是这家店的老板。全小写存，比对时不区分大小写
  owner_email          text not null,
  plan                 text not null,

  -- 官网传来的 metadata 原样留档（含被我们改掉的字段：时区认不出时的回退等）
  metadata             jsonb not null default '{}'::jsonb,

  provisioned_at       timestamptz not null default now(),
  -- 激活信只发一封。发第二封的话，两封里只有最新那一封的链接是活的，
  -- 老板会点到旧的那封然后以为系统坏了（docs/12 §2.2）。
  -- 这一列同时也是客服的抓手：为空 = 从来没发出去过，可以人工补发
  activation_email_sent_at timestamptz,
  -- 一次性：认领过就不能再认领（docs/12 §3 B3）
  claimed_at           timestamptz,
  claimed_user_id      uuid
);

-- 老库补列（表已经存在时 create table if not exists 不会加列）
alter table signup_intents add column if not exists activation_email_sent_at timestamptz;

create index if not exists signup_intents_unclaimed
  on signup_intents (lower(owner_email)) where claimed_at is null;

alter table signup_intents enable row level security;
alter table signup_intents force  row level security;
drop policy if exists tenant_isolation on signup_intents;
create policy tenant_isolation on signup_intents
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update on signup_intents to app_user;
-- 付款留档不删（宪法第 9 条的同一条精神：财务事实只追加）
revoke delete on signup_intents from app_user;

comment on table signup_intents is
  '一次自助开户 = 一行。checkout_session_id 唯一是整条链路的幂等依据；'
  'owner_email 是这条链路上唯一的身份边界。';

-- ── 3. 建租户 ───────────────────────────────────────────────────────────────
--
-- 函数里**不发邮件、不调外部**。它只做数据库那一段，几毫秒返回 ——
-- 外部 IO 塞进来会占住连接，而且**事务回滚不了一封已经发出去的信**。

create or replace function public.gf_provision_tenant(
  p_checkout_session text,
  p_shop_name        text,
  p_owner_email      text,
  p_business_type    text,
  p_timezone         text,
  p_locale           text,
  p_plan             text,
  p_phone            text default null,
  p_metadata         jsonb default '{}'::jsonb
) returns table (org_id uuid, location_id uuid, already boolean)
language plpgsql
security definer
set search_path = public
as $$
-- OUT 参数叫 org_id / location_id，而底下几乎每张表都有同名的列。
-- 不声明这一句的话，`on conflict (location_id)` 会报「引用不明确」——
-- 而且报的是运行时错误，建表迁移跑过、函数创建成功，第一次真调用才炸。
#variable_conflict use_column
declare
  v_org      uuid;
  v_loc      uuid;
  v_name     text;
  v_email    text;
  v_type     text;
  v_tz       text;
  v_locale   text;
  v_plan     text;
  v_slug     text;
  v_meta     jsonb := coalesce(p_metadata, '{}'::jsonb);
begin
  if coalesce(trim(p_checkout_session), '') = '' then
    raise exception '缺少 checkout session id';
  end if;
  if coalesce(trim(p_owner_email), '') = '' then
    raise exception '缺少老板邮箱';
  end if;

  -- ⭐ 幂等的关键一步：先把这个 session 锁住，再查有没有建过。
  -- 不锁的话两条并发的重投会同时查到「没建过」，然后建出两家店 ——
  -- 而唯一约束只能挡住第二次插 signup_intents，那时候 org 和门店
  -- 已经建出来了，回滚掉的是那条最该留下的留档。
  perform pg_advisory_xact_lock(hashtext('gf_signup:' || p_checkout_session));

  select si.org_id, si.location_id into v_org, v_loc
  from signup_intents si where si.checkout_session_id = p_checkout_session;

  if found then
    return query select v_org, v_loc, true;
    return;
  end if;

  -- ── 入参归一化 ───────────────────────────────────────────────────────────
  --
  -- 官网那边已经挡过一道（docs/11 §3），这里再挡一次是因为
  -- **认不出来就拒绝的话，钱已经收了而门店建不出来**。
  -- 一律回退到安全值 + 原样留档，让老板在向导第一步确认（docs/12 §3 C1）。

  v_name  := left(trim(coalesce(p_shop_name, '')), 80);
  if v_name = '' then v_name := 'My Shop'; end if;

  v_email := lower(trim(p_owner_email));

  v_type := lower(coalesce(p_business_type, ''));
  if v_type not in ('nail','massage','foot_spa','lash','scalp','hair','mixed') then
    v_meta := v_meta || jsonb_build_object('business_type_fallback', p_business_type);
    v_type := 'nail';
  end if;

  v_locale := coalesce(p_locale, '');
  if v_locale not in ('en','zh-Hans','zh-Hant','ko','vi','es') then
    v_meta := v_meta || jsonb_build_object('locale_fallback', p_locale);
    v_locale := 'en';
  end if;

  v_plan := lower(coalesce(p_plan, ''));
  if v_plan not in ('essential','growth') then
    v_meta := v_meta || jsonb_build_object('plan_fallback', p_plan);
    v_plan := 'essential';
  end if;

  -- ⚠️ 时区认不出**不能猜也不能拒**：猜错了整家店的日程、日结、提成
  -- 全错一天；拒了则是钱收了店没有。回退到东部时间并**标记出来**，
  -- 向导第一步会把它顶到老板面前要他确认。
  v_tz := coalesce(p_timezone, '');
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_meta := v_meta || jsonb_build_object('timezone_fallback', p_timezone);
    v_tz := 'America/New_York';
  end if;

  -- ── 建 ───────────────────────────────────────────────────────────────────

  -- owner_user_id 先留占位：这一刻老板的账号还不存在。
  -- 认领那一步（setup.claimLocation）会把它改成真人。
  insert into organizations (name, owner_user_id, default_locale)
  values (v_name, '00000000-0000-4000-8000-000000000000', v_locale)
  returning id into v_org;

  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  if v_slug = '' then v_slug := 'shop'; end if;
  v_slug := left(v_slug, 40) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6);

  insert into locations (
    org_id, name, slug, timezone, business_type, public_key, phone,
    business_hours, settings, status
  ) values (
    v_org,
    -- 店名同时写进 en 和母语两个键：前台顶栏按界面语言取，
    -- 只写母语的话英文界面下顶栏是空的
    jsonb_build_object('en', v_name)
      || (case when v_locale <> 'en' then jsonb_build_object(v_locale, v_name)
               else '{}'::jsonb end),
    v_slug, v_tz, v_type,
    'pk_' || left(replace(gen_random_uuid()::text, '-', ''), 8),
    nullif(trim(coalesce(p_phone, '')), ''),
    -- 给一份能用的默认营业时间（04 §2：能给默认值就别让他填）。
    -- 向导第二步用 Yelp 一键覆盖，或者他自己改
    '{"mon":{"open":"10:00","close":"19:00"},"tue":{"open":"10:00","close":"19:00"},
      "wed":{"open":"10:00","close":"19:00"},"thu":{"open":"10:00","close":"19:00"},
      "fri":{"open":"10:00","close":"19:00"},"sat":{"open":"10:00","close":"19:00"},
      "sun":{"open":"10:00","close":"19:00"}}'::jsonb,
    '{"capacity":{"slot_minutes":15,"max_concurrent_per_slot":null,"overbook":"warn"}}'::jsonb,
    'setup'
  ) returning id into v_loc;

  -- 计费账户先占个位，Stripe 的客户号/订阅号/状态由紧接着的
  -- billing.syncSubscription 命令填 —— 那是唯一一处写订阅状态的地方
  insert into billing_accounts (org_id, location_id, plan)
  values (v_org, v_loc, v_plan)
  on conflict (location_id) do nothing;

  insert into signup_intents (
    checkout_session_id, org_id, location_id, owner_email, plan, metadata
  ) values (p_checkout_session, v_org, v_loc, v_email, v_plan, v_meta);

  return query select v_org, v_loc, false;
end $$;

revoke all on function public.gf_provision_tenant(
  text, text, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.gf_provision_tenant(
  text, text, text, text, text, text, text, text, jsonb) to app_user;

comment on function public.gf_provision_tenant(
  text, text, text, text, text, text, text, text, jsonb) is
  '自助开户建租户。幂等靠 checkout_session_id —— 重投返回已经建好的那一家'
  '（already=true），永远不建出第二家。函数里不发邮件、不调外部。';

-- ── 4. 「我能认领哪一家店」 ─────────────────────────────────────────────────
--
-- ⭐ 这是整条链路上**唯一的身份边界**（docs/12 §3 B2）。
--
-- 判定完全在函数里做，比对的是 auth.users 里那一行的邮箱 ——
-- 应用连「我是谁」这个说法都插不进来，它只能传一个 user_id，
-- 而那个 id 是从 Supabase 签的 JWT 里解出来的。
--
-- email_confirmed_at 那个条件不能省：不验的话，任何人都可以用
-- 别人的邮箱注册一个未验证的账号，然后来认领他的店。

create or replace function public.gf_signup_intent_for_user(p_user_id uuid)
returns table (
  intent_id uuid, org_id uuid, location_id uuid, owner_email text, plan text
)
language sql
security definer
set search_path = public
as $$
  select si.id, si.org_id, si.location_id, si.owner_email, si.plan
  from signup_intents si
  join auth.users u on u.id = p_user_id
  where si.claimed_at is null
    and u.email is not null
    and u.email_confirmed_at is not null
    and lower(si.owner_email) = lower(u.email)
  order by si.provisioned_at
  limit 1
$$;

revoke all on function public.gf_signup_intent_for_user(uuid) from public;
grant execute on function public.gf_signup_intent_for_user(uuid) to app_user;

comment on function public.gf_signup_intent_for_user(uuid) is
  '这个登录用户可以认领的那一家店（只读）。邮箱比对的是 auth.users 里的那一行，'
  '不是应用传进来的字符串 —— 写松了等于任何登录用户都能认领别人付了钱的店。';

-- ── 5. auth.users → public.users 的镜像 ─────────────────────────────────────
--
-- 为什么这一行非得由 definer 函数来插：
--   · users 的 RLS 策略是「和你同 org 的人才可见」，而它要 exists 一条
--     membership —— 但 membership 有外键指向 users，**先有鸡还是先有蛋**
--   · 邮箱和姓名的事实源在 auth.users，那个 schema app_user 看不到
--
-- 口子的宽度：只写 p_user_id 自己那一行，而且内容全部来自 auth.users。
-- 调用方连改一个字的余地都没有。

create or replace function public.gf_sync_user_from_auth(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_name  text;
begin
  select u.email,
         coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name')
    into v_email, v_name
  from auth.users u where u.id = p_user_id;

  if v_email is null then
    raise exception '用户 % 在 auth.users 里不存在或没有邮箱', p_user_id;
  end if;

  insert into users (id, email, full_name)
  values (p_user_id, v_email, v_name)
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(users.full_name, excluded.full_name);

  return p_user_id;
end $$;

revoke all on function public.gf_sync_user_from_auth(uuid) from public;
grant execute on function public.gf_sync_user_from_auth(uuid) to app_user;

comment on function public.gf_sync_user_from_auth(uuid) is
  '把 auth.users 里调用者自己那一行镜像进 public.users。'
  '存在的理由是两个结构性障碍：users 的 RLS 要求先有 membership（而 membership'
  '外键指向 users），以及 auth schema 对 app_user 不可见。';
