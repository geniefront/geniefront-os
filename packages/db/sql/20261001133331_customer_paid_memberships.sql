-- Customer paid memberships are separate from identity.memberships and platform billing_accounts.
create table customer_membership_plans(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 active boolean not null default true,online_sale boolean not null default false,created_at timestamptz not null default now(),
 unique(id,org_id,location_id)
);
create table customer_membership_plan_versions(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 plan_id uuid not null,version integer not null check(version>0),terms jsonb not null,currency text not null check(currency ~ '^[a-z]{3}$'),
 created_by uuid not null references memberships(id),created_at timestamptz not null default now(),
 foreign key(plan_id,org_id,location_id) references customer_membership_plans(id,org_id,location_id),
 unique(plan_id,version),unique(id,org_id,location_id)
);
create table customer_paid_memberships(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 customer_id uuid not null references customers(id),plan_version_id uuid not null,account_id uuid not null,original_order_id uuid not null,
 snapshot jsonb not null,consent jsonb not null,livemode boolean not null,
 stripe_customer_id text,stripe_subscription_id text,stripe_price_id text,
 provider_status text not null default 'pending' check(provider_status in('pending','incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
 cancel_at_period_end boolean not null default false,current_period_end timestamptz,provider_observed_at timestamptz,
 ended_at timestamptz,terminated_at timestamptz,commerce_frozen boolean not null default false,
 manage_token_hash text not null unique,manage_token_wrapped bytea not null,manage_token_expires_at timestamptz not null,manage_token_revoked_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(plan_version_id,org_id,location_id) references customer_membership_plan_versions(id,org_id,location_id),
 foreign key(account_id,org_id,location_id) references commerce_accounts(id,org_id,location_id),
 foreign key(original_order_id,org_id,location_id) references commerce_orders(id,org_id,location_id),
 unique(original_order_id),unique(id,org_id,location_id)
);
create unique index customer_one_open_paid_membership on customer_paid_memberships(location_id,customer_id) where ended_at is null;
create unique index customer_paid_subscription on customer_paid_memberships(account_id,livemode,stripe_subscription_id) where stripe_subscription_id is not null;
create table customer_membership_invoices(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 membership_id uuid not null,account_id uuid not null,livemode boolean not null,stripe_invoice_id text not null,
 order_id uuid not null,payment_id uuid not null,period_start timestamptz not null,period_end timestamptz not null,paid_at timestamptz not null,
 created_at timestamptz not null default now(),check(period_end>period_start),
 foreign key(membership_id,org_id,location_id) references customer_paid_memberships(id,org_id,location_id),
 foreign key(account_id,org_id,location_id) references commerce_accounts(id,org_id,location_id),
 foreign key(order_id,org_id,location_id) references commerce_orders(id,org_id,location_id),
 foreign key(payment_id,org_id,location_id) references commerce_payments(id,org_id,location_id),
 unique(account_id,livemode,stripe_invoice_id),unique(membership_id,period_start,period_end),unique(order_id),unique(payment_id),unique(id,org_id,location_id)
);
create table customer_membership_cycles(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 membership_id uuid not null,invoice_id uuid not null,cycle_index integer not null check(cycle_index between 0 and 11),
 starts_at timestamptz not null,ends_at timestamptz not null,quantity integer not null check(quantity between 0 and 1000),
 value_cents integer not null check(value_cents>=0),status text not null default 'planned' check(status in('planned','issued','stopped')),
 available_units int4multirange not null default '{}'::int4multirange,issued_at timestamptz,
 created_at timestamptz not null default now(),check(ends_at>starts_at),
 foreign key(membership_id,org_id,location_id) references customer_paid_memberships(id,org_id,location_id),
 foreign key(invoice_id,org_id,location_id) references customer_membership_invoices(id,org_id,location_id),
 unique(invoice_id,cycle_index),unique(id,org_id,location_id)
);
create index customer_membership_cycles_due on customer_membership_cycles(membership_id,status,starts_at);
create table customer_membership_ledger(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 cycle_id uuid not null,entry text not null check(entry in('issue','redeem','restore','expire','freeze','purchase_refund')),
 quantity integer not null,value_cents integer not null,unit_ranges int4multirange not null default '{}'::int4multirange,
 ticket_id uuid references tickets(id),reference text not null,created_at timestamptz not null default now(),
 foreign key(cycle_id,org_id,location_id) references customer_membership_cycles(id,org_id,location_id),unique(cycle_id,reference)
);
create trigger customer_membership_versions_append_only before update or delete on customer_membership_plan_versions for each row execute function gf_ccl_append_only();
create trigger customer_membership_invoices_append_only before update or delete on customer_membership_invoices for each row execute function gf_ccl_append_only();
create trigger customer_membership_ledger_append_only before update or delete on customer_membership_ledger for each row execute function gf_ccl_append_only();
create function gf_paid_membership_guard() returns trigger language plpgsql as $$
begin
 if tg_op='INSERT' then
  if not exists(select 1 from customers c join commerce_orders o on o.id=new.original_order_id
   join customer_membership_plan_versions v on v.id=new.plan_version_id join commerce_accounts a on a.id=new.account_id
   where c.id=new.customer_id and c.org_id=new.org_id and c.merged_into_id is null and o.customer_id=c.id and o.kind='customer_membership'
    and o.account_id=a.id and o.org_id=new.org_id and o.location_id=new.location_id and a.livemode=new.livemode
    and new.snapshot->'terms'=v.terms and new.snapshot->>'currency'=v.currency and new.consent->>'accepted'='true'
    and new.consent->>'versionId'=v.id::text and new.consent->>'amountCents'=v.terms->>'amountCents'
    and new.consent->>'cadence'=v.terms->>'cadence') then
   raise exception using errcode='23001',message='paid membership requires scoped customer, purchase, plan and consent';
  end if;
 else
  if row(new.org_id,new.location_id,new.customer_id,new.account_id,new.original_order_id,new.plan_version_id,new.snapshot,new.consent,new.livemode)
   is distinct from row(old.org_id,old.location_id,old.customer_id,old.account_id,old.original_order_id,old.plan_version_id,old.snapshot,old.consent,old.livemode)
   or (old.stripe_customer_id is not null and new.stripe_customer_id is distinct from old.stripe_customer_id)
   or (old.stripe_subscription_id is not null and new.stripe_subscription_id is distinct from old.stripe_subscription_id)
   or (old.stripe_price_id is not null and new.stripe_price_id is distinct from old.stripe_price_id)
   or (old.provider_status in('canceled','incomplete_expired') and new.provider_status<>old.provider_status) then
   raise exception using errcode='23001',message='membership purchase and provider binding are immutable';
  end if;
 end if;
 return new;
end $$;
create trigger paid_membership_guard before insert or update on customer_paid_memberships for each row execute function gf_paid_membership_guard();
create function gf_membership_invoice_guard() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id
  join commerce_orders o on o.id=new.order_id join commerce_payments p on p.id=new.payment_id
  where m.id=new.membership_id and m.account_id=new.account_id and m.livemode=new.livemode
   and o.customer_id=m.customer_id and o.account_id=a.id and o.kind='customer_membership' and o.asset_id=m.id
   and p.order_id=o.id and p.status='paid' and p.provider='stripe' and p.method='membership_invoice'
   and p.stripe_account_id=a.stripe_account_id and p.livemode=new.livemode and p.payment_intent_id is not null
   and p.amount_cents=(m.snapshot->'terms'->>'amountCents')::int and p.currency=m.snapshot->>'currency') then
  raise exception using errcode='23001',message='membership invoice requires its own verified paid order';
 end if;
 return new;
end $$;
create trigger membership_invoice_guard before insert on customer_membership_invoices for each row execute function gf_membership_invoice_guard();
create function gf_membership_cycle_guard() returns trigger language plpgsql as $$
begin
 if not(new.available_units <@ int4multirange(int4range(0,new.quantity,'[)'))) then
  raise exception using errcode='23001',message='membership units outside purchased quota';
 end if;
 if tg_op='INSERT' then
  if new.status<>'planned' or new.issued_at is not null or new.available_units<>'{}'::int4multirange or not exists(
   select 1 from customer_membership_invoices i join customer_paid_memberships m on m.id=i.membership_id
   where i.id=new.invoice_id and i.membership_id=new.membership_id and new.starts_at>=i.period_start and new.ends_at<=i.period_end
    and new.quantity=(m.snapshot->'terms'->>'quantity')::int) then
   raise exception using errcode='23001',message='membership cycle requires paid coverage and purchased quota';
  end if;
 else
  if row(new.org_id,new.location_id,new.membership_id,new.invoice_id,new.cycle_index,new.starts_at,new.ends_at,new.quantity,new.value_cents)
   is distinct from row(old.org_id,old.location_id,old.membership_id,old.invoice_id,old.cycle_index,old.starts_at,old.ends_at,old.quantity,old.value_cents)
   or (old.issued_at is not null and new.issued_at is distinct from old.issued_at) or (old.status<>'planned' and new.status='planned') then
   raise exception using errcode='23001',message='membership benefit schedule is immutable';
  end if;
 end if;
 return new;
end $$;
create trigger membership_cycle_guard before insert or update on customer_membership_cycles for each row execute function gf_membership_cycle_guard();
do $$ declare t text;begin
 foreach t in array array['customer_membership_plans','customer_membership_plan_versions','customer_paid_memberships','customer_membership_invoices','customer_membership_cycles','customer_membership_ledger'] loop
  execute format('alter table %I enable row level security',t);
  execute format('alter table %I force row level security',t);
  execute format('create policy tenant_isolation on %I to app_user using(org_id=app_org_id() and location_id=app_location_id()) with check(org_id=app_org_id() and location_id=app_location_id())',t);
  execute format('revoke all on %I from public,anon,authenticated,app_user',t);
  if t in('customer_membership_plan_versions','customer_membership_invoices','customer_membership_ledger') then
   execute format('grant select,insert on %I to app_user',t);
  else execute format('grant select,insert,update on %I to app_user',t);end if;
 end loop;
end $$;
alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in('checkout','refund','expire_checkout','notification','subscription_update','reconcile','expire_deposit','membership_grant'));
