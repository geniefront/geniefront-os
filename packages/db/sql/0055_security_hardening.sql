-- 0055: Supabase 暴露面安全收口
--
-- 目标：
--   1. public 中所有运行时表都启用强制 RLS；
--   2. SECURITY DEFINER 函数只向确有需要的角色开放；
--   3. 所有项目函数固定 search_path，避免对象劫持。

-- ── 1. 迁移账本不是业务 API ───────────────────────────────────────────────
alter table _migrations enable row level security;
alter table _migrations force row level security;
revoke all on table _migrations from public, anon, authenticated, app_user;

-- ── 2. 两张旧表补齐 RLS ───────────────────────────────────────────────────
alter table command_idempotency enable row level security;
alter table command_idempotency force row level security;
drop policy if exists tenant_isolation on command_idempotency;
create policy tenant_isolation on command_idempotency
  using (location_id = app_location_id())
  with check (location_id = app_location_id());

alter table stripe_events enable row level security;
alter table stripe_events force row level security;
drop policy if exists tenant_isolation on stripe_events;
create policy tenant_isolation on stripe_events
  using (location_id = app_location_id())
  with check (location_id = app_location_id());

-- ── 3. 固定项目函数的 search_path ─────────────────────────────────────────
-- 只处理当前迁移角色在 public 拥有、且尚未显式固定 search_path 的函数。
-- pg_catalog 放在最前，public 仅用于项目自己的表和函数。
do $$
declare
  f record;
begin
  for f in
    select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proowner = (select oid from pg_roles where rolname = current_user)
      and not exists (
        select 1
        from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
        where cfg like 'search_path=%'
      )
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = pg_catalog, public',
      f.nspname, f.proname, f.args
    );
  end loop;
end $$;

-- ── 4. SECURITY DEFINER 默认不对 Data API 角色开放 ─────────────────────────
revoke all on function public.user_in_location(uuid) from public, anon, authenticated;
revoke all on function public.gf_broadcast(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.gf_provision_tenant(text, text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.gf_signup_intent_for_user(uuid) from public, anon, authenticated;
revoke all on function public.gf_sync_user_from_auth(uuid) from public, anon, authenticated;
revoke all on function public.gf_redeem_staff_claim_code(text) from public, anon, authenticated;
revoke all on function public.gf_staff_by_phone(text) from public, anon, authenticated;

-- Realtime 的私有频道策略需要 authenticated 调用这一个布尔判定函数。
grant execute on function public.user_in_location(uuid) to authenticated;

-- 其余窄口只允许受限的服务端数据库角色调用。
grant execute on function public.gf_broadcast(uuid, text, jsonb) to app_user;
grant execute on function public.gf_provision_tenant(text, text, text, text, text, text, text, text, jsonb)
  to app_user;
grant execute on function public.gf_signup_intent_for_user(uuid) to app_user;
grant execute on function public.gf_sync_user_from_auth(uuid) to app_user;
grant execute on function public.gf_redeem_staff_claim_code(text) to app_user;
grant execute on function public.gf_staff_by_phone(text) to app_user;
