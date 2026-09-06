-- Contact address is separate from login identity.
alter table staff_profiles add column if not exists contact_email text;
alter table skills add column if not exists active boolean not null default true;
alter table skills add column if not exists sort integer not null default 0;
alter table staff_levels add column if not exists active boolean not null default true;
create table if not exists staff_job_titles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  name text not null check (length(name) between 1 and 50),
  sort integer not null default 0,
  active boolean not null default true,
  unique(location_id, name)
);
alter table staff_job_titles enable row level security;
alter table staff_job_titles force row level security;
create policy tenant_isolation on staff_job_titles
  using (org_id = app_org_id() and location_id = app_location_id())
  with check (org_id = app_org_id() and location_id = app_location_id());
grant select, insert, update, delete on staff_job_titles to app_user;
insert into staff_job_titles (org_id, location_id, name)
  select distinct org_id, location_id, job_title from staff_profiles
  where nullif(trim(job_title), '') is not null
  on conflict do nothing;
