-- 0059: provider sync boundary, payout/payroll facts, service economics and AI records

alter table services add column if not exists cost_cents integer
  check (cost_cents is null or cost_cents >= 0);
alter table location_reviews add column if not exists service_id uuid references services(id);
alter table location_reviews add column if not exists membership_id uuid references memberships(id);
alter table location_reviews add column if not exists customer_id uuid references customers(id);
alter table location_reviews add column if not exists ticket_id uuid references tickets(id);
create index if not exists location_reviews_service_idx on location_reviews(location_id, service_id, posted_at);
create index if not exists location_reviews_membership_idx on location_reviews(location_id, membership_id, posted_at);
create index if not exists customers_acquisition_idx on customers(org_id, source, created_at);

create table if not exists provider_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  provider text not null,
  capability text not null check (capability in ('payments','payroll','reviews','ai')),
  status text not null default 'not_configured'
    check (status in ('not_configured','pending','active','error','disabled')),
  credentials_ref text,
  sync_cursor text,
  last_synced_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, provider, capability)
);

create table if not exists merchant_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  provider_connection_id uuid not null references provider_connections(id),
  available_cents integer not null check (available_cents >= 0),
  pending_cents integer not null check (pending_cents >= 0),
  processing_fee_cents integer not null default 0 check (processing_fee_cents >= 0),
  bank_name text,
  bank_last4 text check (bank_last4 is null or bank_last4 ~ '^[0-9]{4}$'),
  bank_status text check (bank_status is null or bank_status in ('verified','pending')),
  payout_schedule text check (payout_schedule is null or payout_schedule in ('daily','weekly','manual')),
  next_payout_at timestamptz,
  provider_as_of timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists merchant_balance_latest_idx
  on merchant_balance_snapshots(location_id, provider_as_of desc);

create table if not exists payout_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  provider_connection_id uuid not null references provider_connections(id),
  provider_payout_id text not null,
  amount_cents integer not null check (amount_cents >= 0),
  fee_cents integer not null default 0 check (fee_cents >= 0),
  net_cents integer not null check (net_cents >= 0),
  transaction_count integer not null default 0 check (transaction_count >= 0),
  bank_last4 text check (bank_last4 is null or bank_last4 ~ '^[0-9]{4}$'),
  status text not null check (status in ('paid','in_transit','failed')),
  arrival_date date,
  provider_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (provider_connection_id, provider_payout_id),
  check (net_cents = amount_cents - fee_cents)
);
create index if not exists payout_batches_recent_idx
  on payout_batches(location_id, provider_created_at desc);

create table if not exists provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  provider_connection_id uuid not null references provider_connections(id),
  provider_event_id text not null,
  event_type text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  signature_verified boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processed','failed','ignored')),
  error_code text,
  replay_count integer not null default 0 check (replay_count >= 0),
  unique (provider_connection_id, provider_event_id)
);
create index if not exists provider_webhook_pending_idx
  on provider_webhook_events(provider_connection_id, received_at)
  where processing_status in ('pending','failed');

create table if not exists payroll_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','pending','paid','voided')),
  provider_connection_id uuid references provider_connections(id),
  provider_batch_id text,
  approved_by uuid references memberships(id),
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (location_id, period_start, period_end)
);

create table if not exists payroll_batch_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  payroll_batch_id uuid not null references payroll_batches(id),
  membership_id uuid not null references memberships(id),
  base_salary_cents integer not null default 0,
  service_sales_cents integer not null default 0,
  service_commission_cents integer not null default 0,
  retail_sales_cents integer not null default 0,
  retail_commission_cents integer not null default 0,
  card_tips_cents integer not null default 0,
  bonus_cents integer not null default 0,
  deductions_cents integer not null default 0,
  net_pay_cents integer not null,
  created_at timestamptz not null default now(),
  unique (payroll_batch_id, membership_id)
);
create index if not exists payroll_batch_items_member_idx
  on payroll_batch_items(location_id, membership_id, payroll_batch_id);

create table if not exists ai_business_summaries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  period_start date not null,
  period_end date not null,
  generator text not null,
  generator_version text not null,
  input_facts_sha256 text not null check (input_facts_sha256 ~ '^[0-9a-f]{64}$'),
  input_record_count integer not null check (input_record_count > 0),
  content jsonb not null,
  generated_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index if not exists ai_business_summaries_recent_idx
  on ai_business_summaries(location_id, generated_at desc);

do $$
declare t text;
begin
  foreach t in array array[
    'provider_connections','merchant_balance_snapshots','payout_batches',
    'provider_webhook_events','payroll_batches','payroll_batch_items','ai_business_summaries'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id() and location_id = app_location_id()) '
      'with check (org_id = app_org_id() and location_id = app_location_id())', t);
    execute format('revoke all on %I from public, anon, authenticated, app_user', t);
  end loop;
end $$;

grant select, insert, update on provider_connections, provider_webhook_events to app_user;
grant select, insert on merchant_balance_snapshots, payout_batches to app_user;
grant select, insert, update on payroll_batches, payroll_batch_items to app_user;
grant select, insert on ai_business_summaries to app_user;

drop trigger if exists merchant_balance_snapshots_no_change on merchant_balance_snapshots;
create trigger merchant_balance_snapshots_no_change before update or delete on merchant_balance_snapshots
  for each row execute function immutable_financial_event();
drop trigger if exists payout_batches_no_change on payout_batches;
create trigger payout_batches_no_change before update or delete on payout_batches
  for each row execute function immutable_financial_event();
drop trigger if exists ai_business_summaries_no_change on ai_business_summaries;
create trigger ai_business_summaries_no_change before update or delete on ai_business_summaries
  for each row execute function immutable_financial_event();
