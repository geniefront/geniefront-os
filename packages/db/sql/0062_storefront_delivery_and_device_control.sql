-- 0062 · 微店交付协作 + 门店设备遥测/命令

alter table storefront_briefs
  add column if not exists store_name text,
  add column if not exists slogan text,
  add column if not exists photo_source_url text,
  add column if not exists launch_requested_at timestamptz;

create table if not exists storefront_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  brief_id uuid not null references storefront_briefs(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 4000),
  status text not null default 'submitted'
    check (status in ('submitted','in_progress','accepted','declined')),
  response text,
  created_by_membership_id uuid references memberships(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists storefront_revisions_brief_created_idx
  on storefront_revisions (brief_id, created_at desc);

alter table device_tokens
  add column if not exists terminal_type text
    check (terminal_type is null or terminal_type in ('customer-facing','kiosk')),
  add column if not exists model text,
  add column if not exists ip_address inet,
  add column if not exists battery_level integer
    check (battery_level is null or battery_level between 0 and 100),
  add column if not exists wifi_signal_dbm integer
    check (wifi_signal_dbm is null or wifi_signal_dbm between -150 and 0),
  add column if not exists app_version text;

create table if not exists device_commands (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  device_id uuid not null references device_tokens(id) on delete cascade,
  kind text not null check (kind in ('wake','reset_home')),
  status text not null default 'pending'
    check (status in ('pending','acknowledged','failed','expired')),
  requested_by_membership_id uuid references memberships(id),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  error_message text
);

create index if not exists device_commands_pending_idx
  on device_commands (device_id, created_at)
  where status = 'pending';

alter table location_intake_templates
  add column if not exists require_body_soreness_map boolean not null default true,
  add column if not exists auto_create_crm_profile boolean not null default true,
  add column if not exists auto_prompt_tip_percentages boolean not null default true;

do $$
declare t text;
begin
  foreach t in array array['storefront_revisions','device_commands'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) '
      || 'with check (org_id = app_org_id())', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

comment on table storefront_revisions is
  '门店对微店交付稿的修改意见；团队处理状态和回复与意见一起留存';
comment on table device_commands is
  '后台发给已配对终端的短命令队列；终端通过心跳拉取并回执';
