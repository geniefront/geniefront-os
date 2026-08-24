-- ════════════════════════════════════════════════════════════════════════════
--  0033 · 公开预约 API（docs/13）
--
--  这一份撑起门店官网上的「在线预约」。它是这个系统里**唯一一个
--  不需要任何身份就能写库的入口**，所以三件事必须在数据库这一层就立住：
--
--    1. `public_key` 要有足够熵 —— 它明文躺在官网的 JS 里，不是密钥，
--       但短到能枚举时，有人可以扫出「哪些 key 是活的」批量骚扰所有门店
--    2. **公开维度的解析策略** —— 官网只带得出一个 public_key，带不出 org_id。
--       和门口 iPad 的令牌（0016）、电话的被叫号码（0015）一样：
--       **缺的是上下文，不是权限**
--    3. 域名白名单是一张**有 RLS 的业务表**，不是环境变量 ——
--       每家店的官网域名不一样，而且老板要能自己改
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. public_key 加长到 24 位 hex ─────────────────────────────────────────
--
-- 原来是 `pk_` + 8 位 hex（32 bit）。**不是因为它是密钥**才加长 ——
-- 它本来就要给全世界看。加长是为了让「枚举出所有活门店」这件事不可行：
-- 32 bit 用一台机器几个小时就扫完了，96 bit 扫不完。
--
-- ⚠️ 用触发器而不是改 0030 里那个建租户函数：那个函数有 155 行，
-- 为了一个字面量把它复制一份到这里，两份必然会漂移。
-- 放在触发器里是**一处**保证，所有插入路径（建租户函数、种子、以后新增的）
-- 都自动守住。
create or replace function gf_ensure_public_key() returns trigger
language plpgsql as $$
begin
  -- 只在没给或者给得太短时才生成。老板将来要「重置官网密钥」时
  -- 传一个空串进来就能换一把新的
  if new.public_key is null or length(new.public_key) < 27 then
    new.public_key := 'pk_' || encode(gen_random_bytes(12), 'hex');
  end if;
  return new;
end $$;

drop trigger if exists locations_public_key on locations;
create trigger locations_public_key
  before insert or update of public_key on locations
  for each row execute function gf_ensure_public_key();

-- 老库里那些 8 位的换掉。换掉之后老板官网上那一串要重新复制一次 ——
-- 现在还没有任何一家店真的在用公开预约，所以这是最便宜的时候做
update locations
   set public_key = 'pk_' || encode(gen_random_bytes(12), 'hex')
 where public_key is null or length(public_key) < 27;

create unique index if not exists locations_public_key_uidx on locations (public_key);

-- ── 2. 预约上的两列：确认码 + 管理令牌摘要 ─────────────────────────────────
--
-- `confirmation_code`  客人念得出来的短码（`LN-4K2P`），前台也能搜。明文存
-- `manage_token_digest` 自助取消的唯一凭证。**只存 SHA-256 摘要**，
--                       明文只在建单响应和确认信里出现过一次 ——
--                       和设备令牌、技师会话令牌同一个套路（库被拖走也换不回令牌）
--
-- ⚠️ 两列都可空：前台手工建的单没有这两样，也不该有。
alter table appointments add column if not exists confirmation_code   text;
alter table appointments add column if not exists manage_token_digest text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_manage_digest_sha256') then
    alter table appointments add constraint appointments_manage_digest_sha256
      check (manage_token_digest is null or manage_token_digest ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- 确认码在一家店内唯一 —— 前台按码搜出两条单是没法处理的
create unique index if not exists appointments_confirm_code_uidx
  on appointments (location_id, confirmation_code)
  where confirmation_code is not null;

-- ── 3. 每店的官网域名白名单 ────────────────────────────────────────────────
--
-- ⚠️ CORS 不是鉴权，这张表也不是。它挡的是「别人的网站嵌一个我们的预约表单」，
-- 挡不住 curl。真正挡机器人的是 Turnstile + 限频 + 蜜罐（docs/13 §6）。
-- 它的价值在于：**把一个公开 key 的使用面收回到老板自己的站点上**。
create table if not exists location_allowed_origins (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  /** 规范形式：小写、含协议、不带路径、不带尾斜杠。如 https://lotusnails.com */
  origin      text not null,
  label       text,
  created_at  timestamptz not null default now()
);

create unique index if not exists location_allowed_origins_uidx
  on location_allowed_origins (location_id, origin);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'location_allowed_origins_shape') then
    alter table location_allowed_origins add constraint location_allowed_origins_shape
      check (origin ~ '^https?://[a-z0-9.*-]+(:[0-9]{1,5})?$');
  end if;
end $$;

alter table location_allowed_origins enable row level security;
alter table location_allowed_origins force  row level security;
drop policy if exists tenant_isolation on location_allowed_origins;
create policy tenant_isolation on location_allowed_origins
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update, delete on location_allowed_origins to app_user;

-- ── 4. ⭐ public_key 维度解析 ──────────────────────────────────────────────
--
-- 官网打进来时我们只知道一个 public_key。和 0016 的设备令牌一模一样的道理：
-- 策略只放行 **key 恰好相等**的那一行，只 for select。
--
-- ⚠️ 正常租户上下文下 app.public_key 是空的，`public_key = null` 恒为 null
-- （不是 true），所以这几条策略在日常路径上等于不存在。
create or replace function app_public_key() returns text
language sql stable as $$
  select nullif(current_setting('app.public_key', true), '')
$$;

drop policy if exists location_by_public_key on locations;
create policy location_by_public_key on locations
  for select
  using (public_key = app_public_key());

drop policy if exists org_by_public_key on organizations;
create policy org_by_public_key on organizations
  for select
  using (exists (
    select 1 from locations l
    where l.org_id = organizations.id and l.public_key = app_public_key()));

drop policy if exists origins_by_public_key on location_allowed_origins;
create policy origins_by_public_key on location_allowed_origins
  for select
  using (exists (
    select 1 from locations l
    where l.id = location_allowed_origins.location_id
      and l.public_key = app_public_key()));

-- ── 5. 在线预约的门店配置默认值 ────────────────────────────────────────────
--
-- 放在 settings 的 online_booking 块里，和 capacity 一个层级。
-- ⭐ **默认 enabled = false**：一家店在老板明确打开之前，
-- 官网上不该能订到它 —— 项目、价格、排班可能都还没配全，
-- 而一个订到空排班上的单，前台是看不到人的。
update locations
   set settings = jsonb_set(
         settings, '{online_booking}',
         '{"enabled": false, "max_days_ahead": 60, "min_minutes_ahead": 120,
           "require_phone_verification": false, "cancel_cutoff_hours": 4}'::jsonb,
         true)
 where not (settings ? 'online_booking');
