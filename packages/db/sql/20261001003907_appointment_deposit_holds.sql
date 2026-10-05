alter table appointments add column deposit_status text not null default 'none'
 check(deposit_status in ('none','pending','paid','waived','expired','cancelled','refund_pending','refunded','review'));
create unique index if not exists appointments_identity_scope on appointments(id,org_id,location_id);
create table commerce_appointment_holds(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 appointment_id uuid not null unique,order_id uuid unique references commerce_orders(id),
 status text not null default 'pending' check(status in ('pending','paid','expired','cancelled','refund_pending','refunded','review')),
 amount_cents integer not null check(amount_cents>0),service_total_cents integer not null check(service_total_cents>=amount_cents),
 currency text not null check(currency~'^[a-z]{3}$'),expires_at timestamptz not null,
 policy_snapshot jsonb not null,business_key text not null,request_hash text not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(location_id,business_key),foreign key(appointment_id,org_id,location_id) references appointments(id,org_id,location_id)
);
alter table commerce_appointment_holds enable row level security;
alter table commerce_appointment_holds force row level security;
create policy tenant_isolation on commerce_appointment_holds to app_user using(
 org_id=app_org_id() and location_id=app_location_id()) with check(org_id=app_org_id() and location_id=app_location_id());
grant select,insert,update on commerce_appointment_holds to app_user;
revoke all on commerce_appointment_holds from public,anon,authenticated;
create index commerce_appointment_holds_due on commerce_appointment_holds(expires_at) where status='pending';
alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in('checkout','refund','reconcile','expire_checkout','notification','subscription_update','expire_deposit'));
create or replace function gf_deposit_appointment_guard() returns trigger language plpgsql as $$
begin
 if new.deposit_status in ('pending','review') and new.status not in ('booked','cancelled','no_show') then
  raise exception 'Deposit payment must be confirmed before service' using errcode='23001',hint='DEPOSIT_PAYMENT_REQUIRED';
 end if;
 if new.status='cancelled' and old.status<>'cancelled' and new.deposit_status='pending' then
  update commerce_appointment_holds set status='cancelled',updated_at=now() where appointment_id=new.id and status='pending';
  new.deposit_status='cancelled';
 end if;
 return new;
end $$;
create trigger appointment_deposit_guard before update on appointments for each row execute function gf_deposit_appointment_guard();
