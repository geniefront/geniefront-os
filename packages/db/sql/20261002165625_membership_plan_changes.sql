create table customer_membership_plan_changes(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 membership_id uuid not null,plan_version_id uuid not null,snapshot jsonb not null,consent jsonb not null,
 effective_at timestamptz not null,previous_price_id text not null,status text not null default 'pending' check(status in('pending','scheduled','applied')),
 stripe_price_id text,stripe_schedule_id text,scheduled_at timestamptz,applied_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(membership_id,org_id,location_id) references customer_paid_memberships(id,org_id,location_id),
 foreign key(plan_version_id,org_id,location_id) references customer_membership_plan_versions(id,org_id,location_id),
 unique(membership_id,effective_at)
);
create unique index customer_membership_one_pending_change on customer_membership_plan_changes(membership_id) where status in('pending','scheduled');
create index customer_membership_change_price on customer_membership_plan_changes(membership_id,stripe_price_id,effective_at);
alter table customer_membership_plan_changes enable row level security;
alter table customer_membership_plan_changes force row level security;
create policy tenant_isolation on customer_membership_plan_changes to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on customer_membership_plan_changes from public,anon,authenticated,app_user;
grant select,insert,update on customer_membership_plan_changes to app_user;
alter table customer_paid_memberships add column current_price_id text;
update customer_paid_memberships set current_price_id=stripe_price_id;
create function gf_membership_change_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if new.status<>'pending' or new.stripe_price_id is not null or new.stripe_schedule_id is not null or not exists(
   select 1 from customer_paid_memberships m join customer_membership_plan_versions v on v.id=new.plan_version_id where m.id=new.membership_id
    and m.org_id=new.org_id and m.location_id=new.location_id and v.org_id=new.org_id and v.location_id=new.location_id
    and m.provider_status='active' and not m.commerce_frozen and m.terminated_at is null and not m.cancel_at_period_end
    and m.current_period_end=new.effective_at and coalesce(m.current_price_id,m.stripe_price_id)=new.previous_price_id
    and new.snapshot->'terms'=v.terms and new.snapshot->>'currency'=v.currency and v.currency=m.snapshot->>'currency'
    and new.snapshot->>'timezone'=m.snapshot->>'timezone' and new.consent->>'accepted'='true'
    and new.consent->>'versionId'=v.id::text and new.consent->>'amountCents'=v.terms->>'amountCents'
    and new.consent->>'cadence'=v.terms->>'cadence' and (new.consent->>'effectiveAt')::timestamptz=new.effective_at) then
   raise exception using errcode='23001',message='membership change requires confirmed scoped future terms';
  end if;
 else
  if row(new.org_id,new.location_id,new.membership_id,new.plan_version_id,new.snapshot,new.consent,new.effective_at,new.previous_price_id,new.created_at)
   is distinct from row(old.org_id,old.location_id,old.membership_id,old.plan_version_id,old.snapshot,old.consent,old.effective_at,old.previous_price_id,old.created_at)
   or (old.stripe_price_id is not null and new.stripe_price_id is distinct from old.stripe_price_id)
   or (old.stripe_schedule_id is not null and new.stripe_schedule_id is distinct from old.stripe_schedule_id)
   or (old.status='applied' and new.status<>'applied') or (old.status='scheduled' and new.status='pending') then
   raise exception using errcode='23001',message='membership change consent and provider bindings are immutable';
  end if;
 end if;
 if new.status in('scheduled','applied') and (new.stripe_price_id is null or new.stripe_schedule_id is null or new.scheduled_at is null) then
  raise exception using errcode='23001',message='membership change schedule must be verified';
 end if;
 return new;
end $$;
create trigger membership_change_guard before insert or update on customer_membership_plan_changes for each row execute function gf_membership_change_guard();
revoke all on function gf_membership_change_guard() from public,anon,authenticated;
grant execute on function gf_membership_change_guard() to app_user;
create function gf_membership_current_price_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if new.current_price_id is not null and new.current_price_id is distinct from new.stripe_price_id and not exists(
  select 1 from customer_membership_plan_changes c where c.membership_id=new.id and c.org_id=new.org_id and c.location_id=new.location_id
   and c.stripe_price_id=new.current_price_id and c.status in('scheduled','applied') and new.current_period_end>c.effective_at) then
  raise exception using errcode='23001',message='current membership price requires approved effective change';
 end if;
 return new;
end $$;
create trigger membership_current_price_guard before insert or update on customer_paid_memberships for each row execute function gf_membership_current_price_guard();
revoke all on function gf_membership_current_price_guard() from public,anon,authenticated;
grant execute on function gf_membership_current_price_guard() to app_user;
alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in('checkout','refund','expire_checkout','notification','subscription_update','reconcile','expire_deposit','membership_grant','payout_scan','payout_reconcile','membership_change'));

create or replace function gf_membership_invoice_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare member customer_paid_memberships; change customer_membership_plan_changes; expected_snapshot jsonb;expected_version uuid;expected_price text;
begin
 select * into member from customer_paid_memberships where id=new.membership_id;
 select * into change from customer_membership_plan_changes where membership_id=new.membership_id and status in('scheduled','applied')
  and effective_at<=new.period_start order by effective_at desc limit 1;
 expected_snapshot:=coalesce(change.snapshot,member.snapshot);expected_version:=coalesce(change.plan_version_id,member.plan_version_id);expected_price:=coalesce(change.stripe_price_id,member.stripe_price_id);
 new.snapshot:=coalesce(new.snapshot,expected_snapshot);new.plan_version_id:=coalesce(new.plan_version_id,expected_version);new.stripe_price_id:=coalesce(new.stripe_price_id,expected_price);
 if new.snapshot is distinct from expected_snapshot or new.plan_version_id is distinct from expected_version or new.stripe_price_id is distinct from expected_price or not exists(
  select 1 from commerce_accounts a join commerce_orders o on o.id=new.order_id join commerce_payments p on p.id=new.payment_id
   where a.id=member.account_id and member.account_id=new.account_id and member.livemode=new.livemode
    and o.customer_id=member.customer_id and o.account_id=a.id and o.kind='customer_membership' and o.asset_id=member.id
    and o.snapshot->'membership'=new.snapshot and p.order_id=o.id and p.status='paid' and p.provider='stripe' and p.method='membership_invoice'
    and p.stripe_account_id=a.stripe_account_id and p.livemode=new.livemode and p.payment_intent_id is not null
    and p.amount_cents=(new.snapshot->'terms'->>'amountCents')::integer and p.currency=new.snapshot->>'currency') then
  raise exception using errcode='23001',message='membership invoice requires its verified original or approved future contract';
 end if;
 return new;
end $$;
revoke all on function gf_membership_invoice_guard() from public,anon,authenticated;
grant execute on function gf_membership_invoice_guard() to app_user;
