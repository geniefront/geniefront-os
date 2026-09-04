-- 0106: preserve immutable form access audit records while allowing isolated
-- administrator-owned seed tenants to be rebuilt in test environments.
--
-- The bypass mirrors the financial-ledger reset boundary introduced in 0061:
-- the runtime app_user can never use it, and an administrator must explicitly
-- opt in for the current transaction with app.seed_reset = 'on'.

create or replace function form_access_log_immutable() returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_user <> 'app_user'
     and current_setting('app.seed_reset', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  raise exception 'form_access_log 是只追加日志，不可修改或删除（HIPAA/合规）'
    using errcode = 'restrict_violation';
end $$;

revoke all on function form_access_log_immutable() from public, anon, authenticated;
grant execute on function form_access_log_immutable() to app_user;
