-- Voice booking: weekly staff schedules, with a separately limited unassigned slot.
create or replace function public.gf_voice_plan_defaults()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='UPDATE' and (new.plan is distinct from old.plan or (old.billing_source='license' and new.billing_source='stripe')) then
    new.manual_voice_minutes := null;
  end if;
  if new.plan='voice_booking' then
    update public.locations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{capacity}',
      coalesce(settings->'capacity','{}'::jsonb) || jsonb_build_object(
        'booking_mode','staff','use_recurring_staff',true,'strict_staff',true,
        'max_concurrent_per_slot',null,'buffer_enabled',true,'buffer_extra',1,'request_buffer_enabled',false))
    where id=new.location_id and coalesce((settings->'capacity'->>'use_recurring_staff')::boolean,false)=false;
  end if;
  return new;
end $$;
revoke all on function public.gf_voice_plan_defaults() from public,anon,authenticated;
update public.billing_accounts set plan=plan where plan='voice_booking';
-- Snapshot existing staff's initial week, preserving schedules already edited.
update public.locations l set settings=jsonb_set(l.settings,'{staff_booking_schedules}',
  coalesce((select jsonb_object_agg(sp.membership_id::text,l.business_hours) from public.staff_profiles sp where sp.location_id=l.id),'{}'::jsonb)
  || coalesce(l.settings->'staff_booking_schedules','{}'::jsonb))
where exists(select 1 from public.billing_accounts b where b.location_id=l.id and b.plan='voice_booking');
