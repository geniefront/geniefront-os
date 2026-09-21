-- Store-only snapshots. Caller records must never be written here.
create table public.voice_availability_snapshots (
  location_id uuid primary key references public.locations(id),
  org_id uuid not null references public.organizations(id),
  scope text not null default '',
  payload jsonb,
  revision bigint not null default 0,
  built_revision bigint not null default -1,
  last_changed_xid bigint,
  generated_at timestamptz,
  refresh_after timestamptz not null default now(),
  retry_after timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text
);
alter table public.voice_availability_snapshots enable row level security;
alter table public.voice_availability_snapshots force row level security;
create policy tenant_isolation on public.voice_availability_snapshots for all to app_user
using (org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid)
with check (org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid);
revoke all on public.voice_availability_snapshots from public,anon,authenticated;
grant select,insert,update,delete on public.voice_availability_snapshots to app_user;

-- Invalidation remains in the business transaction. Once per transaction/location,
-- including changes made through web/desk/voice or direct operator maintenance.
create or replace function gf_private.invalidate_voice_snapshot() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  new_row jsonb := case when TG_OP='DELETE' then '{}'::jsonb else to_jsonb(NEW) end;
  old_row jsonb := case when TG_OP='INSERT' then '{}'::jsonb else to_jsonb(OLD) end;
  loc uuid;
  candidate text;
begin
  for candidate in select distinct value from jsonb_array_elements_text(
    case when TG_TABLE_NAME='locations' then jsonb_build_array(new_row->>'id',old_row->>'id')
    else jsonb_build_array(new_row->>'location_id',old_row->>'location_id') end
  ) where value is not null loop
    loc := candidate::uuid;
    update public.voice_availability_snapshots set revision=revision+1,last_changed_xid=txid_current(),refresh_after=least(refresh_after,now()+interval '2 seconds')
      where location_id=loc and last_changed_xid is distinct from txid_current();
  end loop;
  if TG_TABLE_NAME='staff_skills' then
    for loc in select distinct location_id from public.memberships where id in ((new_row->>'membership_id')::uuid,(old_row->>'membership_id')::uuid) loop
      update public.voice_availability_snapshots set revision=revision+1,last_changed_xid=txid_current(),refresh_after=least(refresh_after,now()+interval '2 seconds')
        where location_id=loc and last_changed_xid is distinct from txid_current();
    end loop;
  end if;
  return null;
end $$;
revoke all on function gf_private.invalidate_voice_snapshot() from public,anon,authenticated;
grant execute on function gf_private.invalidate_voice_snapshot() to app_user;
do $$ declare t text; begin
  foreach t in array array['locations','appointments','appointment_items','shifts','services','service_skill_requirements','staff_profiles','staff_skills','memberships','resources','phone_lines'] loop
    execute format('create trigger voice_snapshot_changed after insert or update or delete on public.%I for each row execute function gf_private.invalidate_voice_snapshot()',t);
  end loop;
end $$;

-- Backend-only work discovery returns tenant routing, never customers, credentials or snapshots.
create or replace function gf_private.voice_snapshot_tenants()
returns table(org_id uuid,location_id uuid)
language sql security definer set search_path=pg_catalog,public as $$
 select distinct p.org_id,p.location_id from public.phone_lines p
 join public.locations l on l.id=p.location_id
 left join public.voice_availability_snapshots s on s.location_id=p.location_id
 where p.active and p.purpose='ai_voice' and p.ai_answer and p.assistant_id like 'agent_%' and p.tool_token_digest is not null
   and l.status not in ('closed','suspended')
   and (s.location_id is null or (s.refresh_after<=now() and s.retry_after<=now() and (s.lease_until is null or s.lease_until<now())))
 order by p.location_id limit 100
$$;
revoke all on function gf_private.voice_snapshot_tenants() from public,anon,authenticated;
grant execute on function gf_private.voice_snapshot_tenants() to app_user;
