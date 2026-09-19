-- An inactive line no longer owns inbound routing; preserve its historical row.
drop index if exists public.phone_lines_e164_routable_key;
create unique index phone_lines_e164_routable_key on public.phone_lines(e164)
  where active and purpose in ('ai_voice','sms');

alter table public.phone_calls add column if not exists voice_billing_status text not null default 'legacy';
alter table public.phone_calls add column if not exists billable_seconds integer;
alter table public.phone_calls add column if not exists billing_analysis jsonb;
alter table public.phone_calls add column if not exists recording_id text;

create table public.voice_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  location_id uuid not null references public.locations(id),
  provider_call_id text not null,
  recording_id text not null,
  payload jsonb not null,
  status text not null default 'pending' check(status in ('pending','processing','done','review')),
  attempts integer not null default 0,
  lease_id uuid,
  locked_until timestamptz,
  retry_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  unique(location_id,provider_call_id)
);
alter table public.voice_processing_jobs enable row level security;
alter table public.voice_processing_jobs force row level security;
create policy tenant_isolation on public.voice_processing_jobs for all to app_user
using(org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid)
with check(org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid);
revoke all on public.voice_processing_jobs from public,anon,authenticated;
grant select,insert,update on public.voice_processing_jobs to app_user;
create index voice_processing_due on public.voice_processing_jobs(status,retry_at);

-- Internal worker discovery returns routing only, never recordings or transcripts.
create or replace function public.gf_voice_pending_tenants()
returns table(org_id uuid,location_id uuid)
language sql security definer set search_path=public as $$
 select distinct j.org_id,j.location_id from public.voice_processing_jobs j
 where (j.status='pending' and j.retry_at<=now()) or (j.status='processing' and j.locked_until<now())
 limit 50
$$;
revoke all on function public.gf_voice_pending_tenants() from public,anon,authenticated;
grant execute on function public.gf_voice_pending_tenants() to app_user;
