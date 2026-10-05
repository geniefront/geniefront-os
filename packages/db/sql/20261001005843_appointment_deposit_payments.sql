-- Deposit cash is an immutable fact, separate from service discounts and new cash at checkout.
alter table commerce_appointment_holds add column reserved_cents integer not null default 0 check(reserved_cents>=0);
alter table commerce_appointment_holds add column commerce_frozen boolean not null default false;
alter table commerce_appointment_holds add constraint commerce_hold_identity_scope unique(id,org_id,location_id);
alter table commerce_appointment_holds add constraint commerce_hold_order_scope foreign key(order_id,org_id,location_id)
 references commerce_orders(id,org_id,location_id);
create table commerce_deposit_ledger(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 hold_id uuid not null,payment_id uuid not null,ticket_id uuid references tickets(id),refund_id uuid references commerce_refunds(id),
 entry text not null check(entry in('collected','applied','restored','refund')),amount_cents integer not null check(amount_cents<>0),
 reference text not null,created_at timestamptz not null default now(),
 unique(hold_id,reference),
 foreign key(hold_id,org_id,location_id) references commerce_appointment_holds(id,org_id,location_id),
 foreign key(payment_id,org_id,location_id) references commerce_payments(id,org_id,location_id),
 check((entry in('collected','restored') and amount_cents>0) or (entry in('applied','refund') and amount_cents<0))
);
create unique index commerce_one_deposit_collection on commerce_deposit_ledger(payment_id) where entry='collected';
alter table commerce_deposit_ledger enable row level security;
alter table commerce_deposit_ledger force row level security;
create policy tenant_isolation on commerce_deposit_ledger to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on commerce_deposit_ledger from public,anon,authenticated,app_user;
grant select,insert on commerce_deposit_ledger to app_user;
create function gf_deposit_ledger_append_only() returns trigger language plpgsql as $$
begin
 if current_user='app_user' then raise exception 'Deposit ledger is append-only' using errcode='23001';end if;
 return old;
end $$;
create trigger commerce_deposit_ledger_immutable before update or delete on commerce_deposit_ledger
 for each row execute function gf_deposit_ledger_append_only();
