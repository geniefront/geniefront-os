-- Voice Booking is a real plan, including manual provisioning.
alter table public.billing_accounts drop constraint if exists billing_plan;
alter table public.billing_accounts add constraint billing_plan check (plan in ('voice_booking', 'essential', 'growth'));
alter table public.license_codes drop constraint if exists license_codes_plan_check;
alter table public.license_codes add constraint license_codes_plan_check check (plan is null or plan in ('voice_booking', 'essential', 'growth'));

-- Preserve the existing tenant provisioning function and its grants.
do $$
declare fn regprocedure; definition text;
begin
  select p.oid::regprocedure into fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='gf_provision_tenant';
  if fn is null then raise exception 'gf_provision_tenant missing'; end if;
  definition := pg_get_functiondef(fn);
  if position('voice_booking' in definition) = 0 then
    if position('not in (''essential'',''growth'')' in definition) = 0 then
      raise exception 'Unexpected provisioning plan validation';
    end if;
    execute replace(definition, 'not in (''essential'',''growth'')', 'not in (''voice_booking'',''essential'',''growth'')');
  end if;
end $$;

-- Every writer, including operations and provider synchronization, shares this rule.
create or replace function public.gf_guard_voice_plan_transition() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.plan='voice_booking' and new.plan not in ('voice_booking','growth') then
    raise exception 'voice_booking_can_only_switch_to_growth' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.gf_guard_voice_plan_transition() from public, anon, authenticated;
drop trigger if exists voice_plan_transition on public.billing_accounts;
create trigger voice_plan_transition before update of plan on public.billing_accounts
for each row execute function public.gf_guard_voice_plan_transition();
