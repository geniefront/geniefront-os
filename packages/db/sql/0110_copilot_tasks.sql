-- 0110_copilot_tasks.sql
-- Durable copilot task state machine, revisions, steps, and lifecycle events (29 §8.1)

create table if not exists copilot_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  membership_id uuid not null references memberships(id),
  session_id uuid not null references copilot_sessions(id) on delete cascade,
  original_goal text not null,
  status text not null check (status in (
    'collecting', 'needs_input', 'ready', 'running',
    'partially_completed', 'completed', 'failed', 'cancelled'
  )),
  current_revision integer not null default 1,
  time_anchor jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (id, org_id, location_id, membership_id)
);

create index if not exists copilot_tasks_session_idx
  on copilot_tasks(session_id, created_at desc);
create index if not exists copilot_tasks_actor_idx
  on copilot_tasks(location_id, membership_id, updated_at desc);

create table if not exists copilot_plan_revisions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  org_id uuid not null,
  location_id uuid not null,
  membership_id uuid not null,
  revision integer not null,
  canonical_hash text not null,
  preview_payload jsonb not null,
  execution_mode text not null check (execution_mode in ('atomic', 'independent_sequential')),
  created_at timestamptz not null default now(),
  foreign key (task_id, org_id, location_id, membership_id)
    references copilot_tasks(id, org_id, location_id, membership_id) on delete cascade,
  unique (task_id, revision)
);

create index if not exists copilot_revisions_task_idx
  on copilot_plan_revisions(task_id, revision desc);

create table if not exists copilot_task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  revision integer not null,
  step_index integer not null,
  org_id uuid not null,
  location_id uuid not null,
  membership_id uuid not null,
  command text not null,
  resolved_input jsonb not null,
  summary text not null,
  operation_key text not null,
  status text not null check (status in (
    'pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'skipped', 'cancelled'
  )),
  execution_result jsonb,
  error_details jsonb,
  undo_token text,
  undo_expires_at timestamptz,
  attempt integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (task_id, revision, step_index)
);

create index if not exists copilot_steps_opkey_idx
  on copilot_task_steps(operation_key);
create index if not exists copilot_steps_task_rev_idx
  on copilot_task_steps(task_id, revision, step_index);

create table if not exists copilot_task_events (
  id bigserial primary key,
  task_id uuid not null,
  org_id uuid not null,
  location_id uuid not null,
  membership_id uuid not null,
  seq integer not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (task_id, seq)
);

create index if not exists copilot_events_task_seq_idx
  on copilot_task_events(task_id, seq);

-- RLS
alter table copilot_tasks enable row level security;
alter table copilot_tasks force row level security;
drop policy if exists tenant_isolation on copilot_tasks;
create policy tenant_isolation on copilot_tasks
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

alter table copilot_plan_revisions enable row level security;
alter table copilot_plan_revisions force row level security;
drop policy if exists tenant_isolation on copilot_plan_revisions;
create policy tenant_isolation on copilot_plan_revisions
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

alter table copilot_task_steps enable row level security;
alter table copilot_task_steps force row level security;
drop policy if exists tenant_isolation on copilot_task_steps;
create policy tenant_isolation on copilot_task_steps
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

alter table copilot_task_events enable row level security;
alter table copilot_task_events force row level security;
drop policy if exists tenant_isolation on copilot_task_events;
create policy tenant_isolation on copilot_task_events
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

-- Permissions
revoke all on table copilot_tasks, copilot_plan_revisions, copilot_task_steps, copilot_task_events
  from public, anon, authenticated, app_user;

grant select, insert, update, delete on table
  copilot_tasks, copilot_plan_revisions, copilot_task_steps, copilot_task_events
  to app_user;

grant usage, select on sequence copilot_task_events_id_seq to app_user;
