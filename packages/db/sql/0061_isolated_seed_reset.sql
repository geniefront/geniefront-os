-- 0061: allow an explicit administrator-only reset of isolated seed data
--
-- The closed-day and append-only guards added in 0058 intentionally apply to
-- ordinary administrator sessions too.  The seed runner, however, owns two
-- fixed demo tenants and must be able to rebuild those tenants in an isolated
-- test database.  The bypass is deliberately two-factor:
--   1. the session role must not be app_user; and
--   2. the transaction must explicitly set app.seed_reset = 'on'.
-- A browser/API connection uses app_user, so setting the GUC cannot bypass the
-- financial boundary.

create or replace function assert_business_day_writable(p_location uuid, p_date date)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare v_status text;
begin
  if current_user <> 'app_user'
     and current_setting('app.seed_reset', true) = 'on' then
    return;
  end if;
  if p_location is null or p_date is null then return; end if;
  select status into v_status from day_closes
   where location_id = p_location and business_date = p_date
   for share;
  if v_status = 'closed' then
    raise exception 'business day % is closed', p_date
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;
revoke all on function assert_business_day_writable(uuid, date) from public, anon, authenticated;
grant execute on function assert_business_day_writable(uuid, date) to app_user;

create or replace function immutable_financial_event() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user <> 'app_user'
     and current_setting('app.seed_reset', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception '% is append-only (attempted %)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;
revoke all on function immutable_financial_event() from public, anon, authenticated;
grant execute on function immutable_financial_event() to app_user;

create or replace function ticket_refunds_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_user <> 'app_user'
     and current_setting('app.seed_reset', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'ticket_refunds is append-only (attempted %)', tg_op
    using errcode = 'restrict_violation';
end $$;
revoke all on function ticket_refunds_immutable() from public, anon, authenticated;
grant execute on function ticket_refunds_immutable() to app_user;
