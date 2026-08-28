-- 0052_financial_bi_subscription_enhancements.sql: Financial, BI & Subscription Enhancements

-- 1. 扩展 day_closes
alter table day_closes add column if not exists terminal_batches jsonb;

-- 2. 扩展 billing_accounts 增加 tax_profile 与 plan 扩展
alter table billing_accounts add column if not exists tax_profile jsonb;
alter table billing_accounts add column if not exists billing_cycle text not null default 'monthly';

-- 3. 创建 billing_invoices 表
create table if not exists billing_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid references locations(id),
  invoice_number text not null,
  period text not null,
  description text not null,
  amount_cents integer not null,
  status text not null default 'paid',
  date text not null,
  receipt_pdf_url text,
  created_at timestamptz not null default now()
);

create index if not exists billing_invoices_org_idx on billing_invoices (org_id, created_at desc);
create index if not exists billing_invoices_loc_idx on billing_invoices (location_id, created_at desc);

alter table billing_invoices enable row level security;
alter table billing_invoices force row level security;

drop policy if exists tenant_isolation on billing_invoices;
create policy tenant_isolation on billing_invoices
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update on billing_invoices to app_user;
