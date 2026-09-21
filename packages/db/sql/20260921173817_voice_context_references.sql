-- Shared, expiring voice references survive rolling deployments and multiple API nodes.
create table public.voice_context_references (
  id text primary key,
  org_id uuid not null references public.organizations(id),
  location_id uuid not null references public.locations(id),
  kind text not null check (kind in ('offers','management')),
  scope text not null,
  payload jsonb not null,
  expires_at timestamptz not null default now() + interval '15 minutes'
);
alter table public.voice_context_references enable row level security;
alter table public.voice_context_references force row level security;
create policy tenant_isolation on public.voice_context_references for all to app_user
using (org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid)
with check (org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid);
revoke all on public.voice_context_references from public, anon, authenticated;
grant select, insert, delete on public.voice_context_references to app_user;
create index voice_context_expiry on public.voice_context_references(location_id,expires_at);
