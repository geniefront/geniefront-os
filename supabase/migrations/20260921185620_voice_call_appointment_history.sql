-- A call may concern several appointments, and an appointment may have many calls.
create table public.voice_appointment_activity (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id),
 location_id uuid not null references public.locations(id),
 appointment_id uuid not null references public.appointments(id),
 caller text not null,
 call_started_at timestamptz not null,
 action text not null check(action in ('lookup','reschedule','cancel')),
 outcome text not null check(outcome in ('requested','completed')),
 occurred_at timestamptz not null default now(),
 call_id uuid references public.phone_calls(id),
 unique(location_id,appointment_id,caller,call_started_at,action)
);
alter table public.voice_appointment_activity enable row level security;
alter table public.voice_appointment_activity force row level security;
create policy tenant_isolation on public.voice_appointment_activity for all to app_user
using(org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid)
with check(org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid);
revoke all on public.voice_appointment_activity from public,anon,authenticated;
grant select,insert,update,delete on public.voice_appointment_activity to app_user;
create index voice_activity_call on public.voice_appointment_activity(location_id,call_id);
create index voice_activity_unlinked on public.voice_appointment_activity(location_id,caller,call_started_at) where call_id is null;
-- Preserve recordings even when transcription/classification has not completed.
insert into public.phone_calls(org_id,location_id,provider_call_id,from_e164,to_e164,started_at,duration_seconds,outcome,recording_id,voice_billing_status)
select org_id,location_id,provider_call_id,payload->>'from',payload->>'to',
 nullif(payload->>'startedAt','')::timestamptz,coalesce((payload->>'durationSeconds')::integer,0),'completed',recording_id,
 case when status='review' then 'review' else 'pending' end
from public.voice_processing_jobs
on conflict(provider_call_id) do update set recording_id=coalesce(phone_calls.recording_id,excluded.recording_id)
where phone_calls.location_id=excluded.location_id;

-- Retry historical failures caused solely by optional speaker-label JSON typing.
-- Suppress delayed owner messages; completed calls and existing usage are untouched.
update public.voice_processing_jobs set status='pending',attempts=0,retry_at=now(),locked_until=null,lease_id=null,
 payload=payload||'{"suppressNotification":true}'::jsonb
where status='review' and last_error like '%"speakers"%' and last_error like '%"received": "string"%';
