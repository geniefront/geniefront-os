-- Durable, actor-scoped AI copilot history. Images and executable proposal tokens
-- are intentionally never stored here; only the human/model transcript and audit metadata.

create table if not exists copilot_sessions (
  id uuid primary key,
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  membership_id uuid not null references memberships(id),
  title text not null check (length(title) between 1 and 120),
  question_count integer not null default 0 check (question_count between 0 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (id, org_id, location_id, membership_id)
);

create index if not exists copilot_sessions_actor_idx
  on copilot_sessions(location_id, membership_id, updated_at desc);
create index if not exists copilot_sessions_expiry_idx
  on copilot_sessions(expires_at);

create table if not exists copilot_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  membership_id uuid not null references memberships(id),
  session_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) between 1 and 12000),
  had_image boolean not null default false,
  source text check (source is null or source in ('local', 'model')),
  proposal_command text,
  proposal_summary text,
  tool_names text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  foreign key (session_id, org_id, location_id, membership_id)
    references copilot_sessions(id, org_id, location_id, membership_id)
    on delete cascade
);

create index if not exists copilot_messages_session_idx
  on copilot_messages(session_id, created_at, id);

alter table copilot_sessions enable row level security;
alter table copilot_sessions force row level security;
drop policy if exists tenant_isolation on copilot_sessions;
create policy tenant_isolation on copilot_sessions
  using (
    org_id = app_org_id()
    and location_id = app_location_id()
    and membership_id = app_membership_id()
  )
  with check (
    org_id = app_org_id()
    and location_id = app_location_id()
    and membership_id = app_membership_id()
  );

alter table copilot_messages enable row level security;
alter table copilot_messages force row level security;
drop policy if exists tenant_isolation on copilot_messages;
create policy tenant_isolation on copilot_messages
  using (
    org_id = app_org_id()
    and location_id = app_location_id()
    and membership_id = app_membership_id()
  )
  with check (
    org_id = app_org_id()
    and location_id = app_location_id()
    and membership_id = app_membership_id()
  );

revoke all on table copilot_sessions, copilot_messages from public, anon, authenticated, app_user;
grant select, insert, update, delete on table copilot_sessions to app_user;
grant select, insert, delete on table copilot_messages to app_user;
