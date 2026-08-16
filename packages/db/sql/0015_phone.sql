-- ════════════════════════════════════════════════════════════════════════════
--  0015 · Phase 2：AI 电话接单（09-TELNYX §3 / §4）
--
--  三件事：
--    1. 三张新表的 RLS
--    2. ⭐ 号码维度的解析策略 —— webhook 打进来时还不知道 org_id，
--       但这不需要绕过 RLS，只需要一个「按号码」的上下文（同 identity_self 的思路）
--    3. 值域约束：草案状态、忽略原因、通话时长
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 常规租户隔离 ────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['phone_lines','phone_calls','call_drafts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (org_id = app_org_id()) with check (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

grant select, insert, update, delete on
  phone_lines, phone_calls, call_drafts to app_user;

-- 通话记录是计费凭证，删不得（宪法第 9 条的同一条纪律）。
-- 草案可以删 —— 它只是一条待办，不是钱也不是健康数据。
revoke delete on phone_calls from app_user;

-- ── 2. ⭐ 号码维度解析 ─────────────────────────────────────────────────────
--
-- Telnyx 的 webhook 只带「谁打的」和「打给谁」，没有租户上下文。
-- 看起来像必须绕过 RLS 的场景 —— 和「登录后还没选店」一模一样，
-- 而那一次的结论是：**缺的是上下文，不是权限**（见 sql/0003 的 identity_self）。
--
-- 所以给 phone_lines 加第二条 permissive 策略：
-- 只放行 e164 **恰好等于** app.phone_lookup 的那一行。
--
-- 这条策略的安全性来自它有多窄：
--   · 只 for select，写不了
--   · 必须先说出完整号码才能查到它 —— 枚举不出号码表
--   · 查到的只有一行，别人的号码一个字节都拿不到
--
-- ⚠️ 两条 permissive 策略是 OR 的关系。正常租户上下文下
-- app.phone_lookup 是空的，`e164 = null` 恒为 null（不是 true），
-- 所以这条策略在日常路径上等于不存在。
create or replace function app_phone_lookup() returns text
language sql stable as $$
  select nullif(current_setting('app.phone_lookup', true), '')
$$;

drop policy if exists phone_line_lookup on phone_lines;
create policy phone_line_lookup on phone_lines
  for select
  using (e164 = app_phone_lookup());

-- 号码解析要顺带取门店时区与 org 的默认语言，这两张表也得让同一个上下文读到。
-- 同样窄：只放行「那个号码所属的」那一家店 / 那一个 org。
drop policy if exists location_by_phone_lookup on locations;
create policy location_by_phone_lookup on locations
  for select
  using (exists (
    select 1 from phone_lines p
    where p.location_id = locations.id and p.e164 = app_phone_lookup()));

drop policy if exists org_by_phone_lookup on organizations;
create policy org_by_phone_lookup on organizations
  for select
  using (exists (
    select 1 from phone_lines p
    where p.org_id = organizations.id and p.e164 = app_phone_lookup()));

-- ── 3. 值域约束 ────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'call_drafts_status') then
    alter table call_drafts add constraint call_drafts_status
      check (status in ('pending','confirmed','dismissed'));
  end if;

  -- 忽略必须给原因 —— 这是「AI 到底准不准」唯一诚实的度量（05 §9）。
  -- 命令层已经挡了一道，这里兜底：不强制的话，半年后回头问
  -- 「电话 AI 值不值这个钱」，没有任何数据能回答。
  if not exists (select 1 from pg_constraint where conname = 'call_drafts_dismiss_reason') then
    alter table call_drafts add constraint call_drafts_dismiss_reason
      check (status <> 'dismissed' or dismiss_reason is not null);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'call_drafts_confidence_bp') then
    alter table call_drafts add constraint call_drafts_confidence_bp
      check (confidence_bp between 0 and 10000);
  end if;

  -- 一通电话超过 24 小时一定是事件配对错了（把两通电话的首尾接在了一起）。
  -- 不挡的话会直接变成一张荒唐的账单。
  if not exists (select 1 from pg_constraint where conname = 'phone_calls_duration') then
    alter table phone_calls add constraint phone_calls_duration
      check (duration_seconds is null or duration_seconds between 0 and 86400);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'phone_lines_purpose') then
    alter table phone_lines add constraint phone_lines_purpose
      check (purpose in ('ai_voice','main','sms'));
  end if;
end $$;
