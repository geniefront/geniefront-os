create table if not exists public.support_request_messages (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references public.support_requests(id) on delete cascade,
 org_id uuid not null references public.organizations(id),
 location_id uuid not null references public.locations(id),
 author_kind text not null check(author_kind in ('customer','operator')),
 author_user_id uuid,
 body text not null check(length(body) between 1 and 8000),
 created_at timestamptz not null default now()
);
alter table public.support_request_messages enable row level security;
alter table public.support_request_messages force row level security;
revoke all on public.support_request_messages from public,anon,authenticated;
grant select,insert on public.support_request_messages to app_user;
drop policy if exists tenant_isolation on public.support_request_messages;
create policy tenant_isolation on public.support_request_messages for select to app_user
using ((org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid)
 or gf_platform_operator_role() is not null);
drop policy if exists support_messages_insert on public.support_request_messages;
create policy support_messages_insert on public.support_request_messages for insert to app_user with check (
 org_id=nullif(current_setting('app.org_id',true),'')::uuid and location_id=nullif(current_setting('app.location_id',true),'')::uuid
 and (author_kind='customer' or gf_platform_operator_role() is not null)
 and exists(select 1 from public.support_requests r where r.id=request_id and r.org_id=support_request_messages.org_id and r.location_id=support_request_messages.location_id)
);
create index if not exists support_messages_request_idx on public.support_request_messages(request_id,created_at,id);
