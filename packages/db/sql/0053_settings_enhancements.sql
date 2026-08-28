-- 0053_settings_enhancements.sql: Comprehensive Settings Schema Enhancements

-- 1. 门店扩展字段
alter table locations add column if not exists business_type text not null default 'mixed';
alter table locations add column if not exists phone text;
alter table locations add column if not exists email text;
alter table locations add column if not exists address_street text;
alter table locations add column if not exists address_city text;
alter table locations add column if not exists address_state text;
alter table locations add column if not exists address_zip text;

-- 2. 收银偏好与小费税率配置
create table if not exists location_checkout_settings (
  location_id uuid primary key references locations(id) on delete cascade,
  sales_tax_rate_percent numeric(6, 4) not null default 8.8750,
  tax_calculation_mode text not null default 'exclusive',
  suggested_tip_percentages integer[] not null default '{15, 18, 20, 25}',
  allow_custom_tip boolean not null default true,
  default_cash_float_cents integer not null default 20000,
  receipt_footer_message text,
  auto_print_receipt boolean not null default true,
  auto_send_sms_receipt boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table location_checkout_settings enable row level security;
alter table location_checkout_settings force row level security;

drop policy if exists tenant_isolation on location_checkout_settings;
create policy tenant_isolation on location_checkout_settings
  using (location_id = app_location_id()) with check (location_id = app_location_id());

grant select, insert, update on location_checkout_settings to app_user;

-- 3. 在线预约与排班规则表
create table if not exists location_scheduling_rules (
  location_id uuid primary key references locations(id) on delete cascade,
  slot_interval_minutes integer not null default 30,
  cancel_cutoff_hours integer not null default 4,
  deposit_required boolean not null default false,
  deposit_amount_cents integer not null default 2000,
  allow_client_pick_staff boolean not null default true,
  require_card_on_file boolean not null default false,
  cancellation_policy_notice text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table location_scheduling_rules enable row level security;
alter table location_scheduling_rules force row level security;

drop policy if exists tenant_isolation on location_scheduling_rules;
create policy tenant_isolation on location_scheduling_rules
  using (location_id = app_location_id()) with check (location_id = app_location_id());

grant select, insert, update on location_scheduling_rules to app_user;

-- 4. 大堂 iPad 免责告知书与健康问卷模板
create table if not exists location_intake_templates (
  location_id uuid primary key references locations(id) on delete cascade,
  waiver_title text not null default '顾客服务知情同意书与健康声明',
  waiver_content text,
  require_signature boolean not null default true,
  require_health_allergies boolean not null default true,
  require_pressure_preference boolean not null default true,
  auto_sync_to_profile boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table location_intake_templates enable row level security;
alter table location_intake_templates force row level security;

drop policy if exists tenant_isolation on location_intake_templates;
create policy tenant_isolation on location_intake_templates
  using (location_id = app_location_id()) with check (location_id = app_location_id());

grant select, insert, update on location_intake_templates to app_user;

-- 5. 10DLC 品牌认证资质代办信息表
create table if not exists location_10dlc_registrations (
  location_id uuid primary key references locations(id) on delete cascade,
  status text not null default 'not_submitted',
  legal_business_name text,
  ein text,
  business_structure text not null default 'llc',
  registered_address text,
  rep_name text,
  rep_title text,
  rep_email text,
  rep_phone text,
  opt_in_method text,
  sample_message_1 text,
  sample_message_2 text,
  sample_messages text[] not null default '{}',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table location_10dlc_registrations enable row level security;
alter table location_10dlc_registrations force row level security;

drop policy if exists tenant_isolation on location_10dlc_registrations;
create policy tenant_isolation on location_10dlc_registrations
  using (location_id = app_location_id()) with check (location_id = app_location_id());

grant select, insert, update on location_10dlc_registrations to app_user;

-- 6. Webhook 回调配置表
create table if not exists location_webhooks (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  url text not null,
  events text[] not null default '{booking.created, ticket.paid}',
  active boolean not null default true,
  secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table location_webhooks enable row level security;
alter table location_webhooks force row level security;

drop policy if exists tenant_isolation on location_webhooks;
create policy tenant_isolation on location_webhooks
  using (location_id = app_location_id()) with check (location_id = app_location_id());

grant select, insert, update, delete on location_webhooks to app_user;
