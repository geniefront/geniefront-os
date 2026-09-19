alter table public.billing_accounts add column manual_voice_minutes integer
  check (manual_voice_minutes between 0 and 1000000);
comment on column public.billing_accounts.manual_voice_minutes is
  'Operator-set base voice quota for manual billing only. Null uses plan default; changing it never resets used minutes.';

create or replace function public.gf_voice_plan_defaults()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' and (new.plan is distinct from old.plan or (old.billing_source='license' and new.billing_source='stripe')) then
    new.manual_voice_minutes := null;
  end if;
  if new.plan='voice_booking' then
    update public.locations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{capacity}',
      coalesce(settings->'capacity','{}'::jsonb) || jsonb_build_object(
        'booking_mode','location',
        'max_concurrent_per_slot',coalesce(settings->'capacity'->'max_concurrent_per_slot','2'::jsonb)))
    where id=new.location_id;
  end if;
  return new;
end $$;
revoke all on function public.gf_voice_plan_defaults() from public,anon,authenticated;
create trigger gf_voice_plan_defaults before insert or update of plan,billing_source on public.billing_accounts
  for each row execute function public.gf_voice_plan_defaults();
update public.billing_accounts set plan=plan where plan='voice_booking';

-- Extend the existing operator-authenticated snapshot without changing its grants.
do $$
declare definition text;
begin
  select pg_get_functiondef('public.gf_platform_license_panel(uuid)'::regprocedure) into definition;
  if position('''voiceMinuteBalance'', ba.voice_minute_balance' in definition)=0 then
    raise exception 'Unexpected license panel function definition';
  end if;
  definition := replace(definition, '''voiceMinuteBalance'', ba.voice_minute_balance',
    '''voiceMinuteBalance'', ba.voice_minute_balance, ''manualVoiceMinutes'', ba.manual_voice_minutes');
  execute definition;
end $$;
