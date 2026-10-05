-- Customer commerce is separate from the platform's billing_accounts / AI credit domain.
-- Additive migration; existing financial ledger amounts are never rewritten.
alter table command_idempotency add column input_fingerprint text;
create table commerce_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  stripe_account_id text not null,
  livemode boolean not null,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  disconnected boolean not null default false,
  capabilities jsonb not null default '{}',
  requirements jsonb not null default '{}',
  refreshed_at timestamptz not null default now(),
  unique(location_id, livemode), unique(id, org_id, location_id)
);
create index commerce_account_external on commerce_accounts(stripe_account_id, livemode);

create table commerce_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  customer_id uuid references customers(id),
  account_id uuid,
  kind text not null check(kind in ('gift_card','package','deposit','customer_membership')),
  channel text not null check(channel in ('online','offline','complimentary')),
  status text not null default 'pending' check(status in ('pending','paid','fulfilled','refund_pending','refunded','canceled','review')),
  amount_cents integer not null check(amount_cents >= 0),
  currency text not null check(currency ~ '^[a-z]{3}$'),
  snapshot jsonb not null,
  asset_id uuid,
  idem_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(location_id, idem_key), unique(id,org_id,location_id),
  foreign key(account_id,org_id,location_id) references commerce_accounts(id,org_id,location_id)
);
create index commerce_order_customer on commerce_orders(location_id,customer_id,created_at);

create table commerce_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  order_id uuid not null,
  provider text not null check(provider in ('stripe','offline')),
  method text not null,
  status text not null default 'pending' check(status in ('pending','paid','failed','refunded','disputed')),
  amount_cents integer not null check(amount_cents > 0),
  currency text not null check(currency ~ '^[a-z]{3}$'),
  stripe_account_id text,
  livemode boolean not null default false,
  checkout_session_id text,
  checkout_url text,
  checkout_expires_at timestamptz,
  payment_intent_id text,
  external_reference text,
  recorded_by uuid references memberships(id),
  paid_at timestamptz,
  fee_cents integer,
  net_cents integer,
  balance_transaction_id text,
  created_at timestamptz not null default now(),
  unique(stripe_account_id, livemode, checkout_session_id),
  unique(stripe_account_id, livemode, payment_intent_id),
  unique(id,org_id,location_id),
  foreign key(order_id,org_id,location_id) references commerce_orders(id,org_id,location_id)
);
create unique index commerce_one_purchase_payment on commerce_payments(order_id) where method <> 'membership_invoice';

create table commerce_refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  payment_id uuid not null,
  amount_cents integer not null check(amount_cents > 0),
  asset_quantity integer not null default 0 check(asset_quantity >= 0),
  status text not null default 'pending' check(status in ('pending','succeeded','failed','review')),
  stripe_refund_id text,
  external_reference text,
  reason text not null,
  recorded_by uuid references memberships(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(payment_id,org_id,location_id) references commerce_payments(id,org_id,location_id)
);
create index commerce_refund_payment on commerce_refunds(payment_id,status);

create table commerce_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  stripe_account_id text not null,
  livemode boolean not null,
  event_id text not null,
  event_type text not null,
  object_id text not null,
  created_at timestamptz not null default now(),
  unique(stripe_account_id, livemode, event_id)
);

create table commerce_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  kind text not null check(kind in ('checkout','refund','expire_checkout','notification','subscription_update')),
  subject_id uuid not null,
  status text not null default 'pending' check(status in ('pending','processing','done','review')),
  attempts integer not null default 0,
  lease_id uuid,
  locked_until timestamptz,
  retry_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  unique(kind,subject_id)
);
create index commerce_task_due on commerce_tasks(status,retry_at,locked_until);

create table commerce_access_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  order_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(order_id,org_id,location_id) references commerce_orders(id,org_id,location_id)
);

create table customer_package_ledger (
  id uuid primary key default gen_random_uuid(),
  seq bigserial not null,
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  package_id uuid not null references customer_packages(id),
  entry text not null check(entry in ('issue','redeem','restore','purchase_refund','legacy_opening')),
  quantity integer not null,
  value_cents integer not null default 0,
  ticket_id uuid references tickets(id),
  reversal_of_id uuid references customer_package_ledger(id),
  reference text not null,
  created_at timestamptz not null default now(),
  unique(package_id,reference)
);
create index customer_package_ledger_subject on customer_package_ledger(package_id,seq);
create trigger package_ledger_append_only before update or delete on customer_package_ledger
  for each row execute function gf_ccl_append_only();

alter table gift_cards add column purchase_order_id uuid unique references commerce_orders(id),
  add column purchase_snapshot jsonb,
  add column reserved_cents integer not null default 0 check(reserved_cents >= 0);
alter table customer_packages add column purchase_order_id uuid unique references commerce_orders(id),
  add column purchase_snapshot jsonb,
  add column reserved_sessions integer not null default 0 check(reserved_sessions >= 0),
  add column refund_frozen boolean not null default false;
alter table package_templates add column coverage_mode text check(coverage_mode in ('bundle','any_included')),
  add column commission_basis text check(commission_basis in ('catalog_price','sale_price','zero'));
-- Generated units preserve the append-only ledger, including historical monetary issue rows.
alter table customer_credit_ledger add column unit text generated always as
  (case when kind = 'points' then 'points'
        when kind = 'package' and entry = 'issue' then 'cents'
        when kind = 'package' and entry in ('redeem','refund') then 'sessions'
        when kind = 'package' then 'unknown' else 'cents' end) stored;

-- Preserve availability; capture currently enforceable legacy rules without claiming
-- they were the original purchase rules. Unknown/multiple issue rows remain reviewable.
with history as (
  select subject_id,count(*) as issue_count,max(amount_cents) as price
  from customer_credit_ledger where kind='package' and entry='issue' group by subject_id
)
update customer_packages cp set purchase_snapshot=jsonb_build_object(
  'version',1,'origin','legacy_migration','paymentVerified',false,'rulesProven',false,
  'capturedAt',now(),'requiresReview',true,'amountCents',case when h.issue_count=1 then h.price else null end,
  'serviceIds',coalesce(pt.service_ids,'{}'::uuid[]),'scope',coalesce(pt.scope,'location'),
  'name',pt.name,'totalSessions',cp.total_sessions,'validDays',pt.valid_days,
  'coverageMode',coalesce(pt.coverage_mode,l.settings->'checkout'->>'packageCoverageMode','bundle'),
  'commissionBasis',case when coalesce(pt.commission_basis,l.settings->'checkout'->>'packageCommissionBasis')='catalog_price' then 'catalog_price'
    when coalesce(pt.commission_basis,l.settings->'checkout'->>'packageCommissionBasis')='zero' then 'zero' else 'sale_price' end)
from package_templates pt join locations l on l.id=pt.location_id
left join history h on true
where cp.template_id=pt.id and h.subject_id=cp.id and cp.purchase_snapshot is null;
-- Also mark records with no monetary issue provenance; no new money or rights are granted.
update customer_packages cp set purchase_snapshot=jsonb_build_object(
  'version',1,'origin','legacy_migration','paymentVerified',false,'rulesProven',false,'requiresReview',true,
  'capturedAt',now(),'amountCents',null,'serviceIds',coalesce(pt.service_ids,'{}'::uuid[]),
  'scope',coalesce(pt.scope,'location'),'name',pt.name,'totalSessions',cp.total_sessions,'validDays',pt.valid_days,
  'coverageMode',coalesce(pt.coverage_mode,'bundle'),'commissionBasis','catalog_price')
from package_templates pt where cp.template_id=pt.id and cp.purchase_snapshot is null;
insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,reference)
select cp.org_id,cp.location_id,cp.id,'legacy_opening',cp.remaining_sessions,0,'commerce_migration_opening'
from customer_packages cp on conflict(package_id,reference) do nothing;

do $$ declare t text; begin
  foreach t in array array['commerce_accounts','commerce_orders','commerce_payments','commerce_refunds',
    'commerce_events','commerce_tasks','commerce_access_tokens','customer_package_ledger'] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format('create policy tenant_isolation on %I for all to app_user using
      (org_id = app_org_id() and location_id = app_location_id()) with check
      (org_id = app_org_id() and location_id = app_location_id())',t);
    execute format('revoke all on %I from public,anon,authenticated',t);
    execute format('grant select,insert,update on %I to app_user',t);
  end loop;
end $$;
grant usage,select on sequence customer_package_ledger_seq_seq to app_user;

-- Internal discovery only returns tenant routing, never orders, tokens, or customer details.
create schema if not exists commerce_internal;
revoke all on schema commerce_internal from public,anon,authenticated;
grant usage on schema commerce_internal to app_user;
create function commerce_internal.pending_tenants()
returns table(org_id uuid,location_id uuid) language sql security definer
set search_path = pg_catalog as $$
  select distinct t.org_id,t.location_id from public.commerce_tasks t
  where (t.status='pending' and t.retry_at<=now())
     or (t.status='processing' and t.locked_until<now()) limit 50
$$;
revoke all on function commerce_internal.pending_tenants() from public,anon,authenticated;
grant execute on function commerce_internal.pending_tenants() to app_user;
create function commerce_internal.account_tenants(account_id text,mode boolean)
returns table(org_id uuid,location_id uuid) language sql security definer set search_path=pg_catalog as $$
  select a.org_id,a.location_id from public.commerce_accounts a where a.stripe_account_id=account_id and a.livemode=mode
$$;
revoke all on function commerce_internal.account_tenants(text,boolean) from public,anon,authenticated;
grant execute on function commerce_internal.account_tenants(text,boolean) to app_user;

-- Add explicit commerce permissions without altering custom roles or denied overrides.
insert into role_permissions(role_id,permission)
select r.id,p.permission from roles r cross join (values
  ('commerce.read'),('commerce.sell'),('commerce.configure'),('commerce.refund'),('commerce.gift')) p(permission)
where r.key in ('owner','manager') or (r.key='front_desk' and p.permission in ('commerce.read','commerce.sell'))
on conflict do nothing;
