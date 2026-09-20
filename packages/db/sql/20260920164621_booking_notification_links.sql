-- Staff links are identifiers, never authentication credentials. Existing appointment RLS applies.
alter table public.appointments add column if not exists staff_link_code text
  not null default substr(replace(gen_random_uuid()::text,'-',''),1,16);
create unique index if not exists appointments_staff_link_code_idx on public.appointments(staff_link_code);
alter table public.appointments add column if not exists provider_call_id text;
create index if not exists appointments_provider_call_idx on public.appointments(location_id,provider_call_id)
  where provider_call_id is not null;
