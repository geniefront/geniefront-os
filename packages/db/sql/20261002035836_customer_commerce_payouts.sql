-- Account-scoped bank payout facts are separate from customer payments and service income.
create table commerce_payouts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 account_id uuid not null,stripe_account_id text not null,livemode boolean not null,stripe_payout_id text not null,
 amount_cents integer not null check(amount_cents<>0),currency text not null check(currency~'^[a-z]{3}$'),automatic boolean not null,
 destination_type text not null check(destination_type in('bank_account','card')),provider_created_at timestamptz not null,business_date date not null,
 created_at timestamptz not null default now(),unique(id,org_id,location_id),unique(stripe_account_id,livemode,stripe_payout_id),
 foreign key(account_id,org_id,location_id) references commerce_accounts(id,org_id,location_id)
);
create table commerce_payout_observations(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 payout_id uuid not null,status text not null check(status in('pending','in_transit','paid','failed','canceled')),
 reconciliation_status text not null check(reconciliation_status in('not_applicable','in_progress','completed')),
 arrival_at timestamptz not null,failure_code text,balance_transaction_id text,failure_balance_transaction_id text,
 source_count integer,source_net_cents integer,check((source_count is null)=(source_net_cents is null) and coalesce(source_count,0)>=0),
 observed_at timestamptz not null,facts_hash text not null check(facts_hash~'^[a-f0-9]{64}$'),created_at timestamptz not null default now(),
 unique(payout_id,facts_hash),foreign key(payout_id,org_id,location_id) references commerce_payouts(id,org_id,location_id)
);
create table commerce_payout_transactions(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 payout_id uuid not null,role text not null check(role in('debit','reversal','source')),balance_transaction_id text not null,source_id text,
 currency text not null check(currency~'^[a-z]{3}$'),gross_cents integer not null,fee_cents integer not null,net_cents integer not null,
 type text not null,provider_created_at timestamptz not null,available_on timestamptz not null,created_at timestamptz not null default now(),
 check(net_cents=gross_cents-fee_cents),unique(payout_id,balance_transaction_id),
 foreign key(payout_id,org_id,location_id) references commerce_payouts(id,org_id,location_id)
);
create unique index payout_one_debit_or_reversal on commerce_payout_transactions(payout_id,role) where role in('debit','reversal');
create index payout_observation_latest on commerce_payout_observations(payout_id,observed_at desc,created_at desc);
create function gf_commerce_payout_context_guard() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from commerce_accounts a where a.id=new.account_id and a.org_id=new.org_id and a.location_id=new.location_id
  and a.stripe_account_id=new.stripe_account_id and a.livemode=new.livemode) then raise exception 'wrong payout account context' using errcode='23514';end if;
 return new;
end $$;
create trigger payout_account_context before insert on commerce_payouts for each row execute function gf_commerce_payout_context_guard();
create function gf_commerce_payout_transaction_guard() returns trigger language plpgsql as $$
declare p commerce_payouts%rowtype;
begin
 select * into p from commerce_payouts where id=new.payout_id;
 if p.id is null or new.currency<>p.currency or(new.role='debit' and (new.gross_cents<>-p.amount_cents or new.source_id is distinct from p.stripe_payout_id))
  or(new.role='reversal' and (new.gross_cents<>p.amount_cents or new.source_id is distinct from p.stripe_payout_id))
  or(new.role='source' and not p.automatic) then raise exception 'wrong payout balance fact' using errcode='23514';end if;return new;
end $$;
create trigger payout_balance_guard before insert on commerce_payout_transactions for each row execute function gf_commerce_payout_transaction_guard();
create function gf_commerce_payout_batch_guard() returns trigger language plpgsql as $$
declare p commerce_payouts%rowtype;n integer;net integer;
begin
 if new.source_count is null then return new;end if;
 select * into p from commerce_payouts where id=new.payout_id;
 select count(*)::int,coalesce(sum(net_cents),0)::int into n,net from commerce_payout_transactions where payout_id=new.payout_id and role='source';
 if not p.automatic or new.reconciliation_status<>'completed' or n<>new.source_count or net<>new.source_net_cents or net<>p.amount_cents
  then raise exception 'unverified payout source batch' using errcode='23514';end if;return new;
end $$;
create trigger payout_batch_guard before insert on commerce_payout_observations for each row execute function gf_commerce_payout_batch_guard();
-- Shared locations in one org read the same account-level record, rather than recording the payout twice.
do $$ declare t text;begin
 foreach t in array array['commerce_payouts','commerce_payout_observations','commerce_payout_transactions'] loop
  execute format('alter table %I enable row level security',t);execute format('alter table %I force row level security',t);
  if t='commerce_payouts' then
   execute format('create policy tenant_isolation on %I for select to app_user using(org_id=app_org_id() and exists(select 1 from commerce_accounts a where a.location_id=app_location_id() and a.org_id=app_org_id() and a.stripe_account_id=commerce_payouts.stripe_account_id and a.livemode=commerce_payouts.livemode))',t);
  else
   execute format('create policy tenant_isolation on %I for select to app_user using(org_id=app_org_id() and exists(select 1 from commerce_payouts p where p.id=%I.payout_id))',t,t);
  end if;
  execute format('create policy payout_write on %I for insert to app_user with check(org_id=app_org_id() and location_id=app_location_id())',t);
  execute format('revoke all on %I from public,anon,authenticated,app_user',t);execute format('grant select,insert on %I to app_user',t);
  execute format('create trigger payout_append_only before update or delete on %I for each row execute function gf_ccl_append_only()',t);
 end loop;
end $$;

-- Persist one bounded discovery page per lease. Exhausted scans restart at the newest page.
alter table commerce_accounts add column payout_scan_cursor text;
alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in('checkout','refund','expire_checkout','notification','subscription_update','reconcile','expire_deposit','membership_grant','payout_scan','payout_reconcile'));
