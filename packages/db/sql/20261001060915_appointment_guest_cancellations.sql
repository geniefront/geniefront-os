create table appointment_guest_cancellations(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 appointment_id uuid not null,guest_index integer not null,original_party_size integer not null check(original_party_size between 1 and 20),
 reason text not null check(length(btrim(reason)) between 2 and 500),created_by uuid not null references memberships(id),created_at timestamptz not null default now(),
 unique(appointment_id,guest_index),unique(id,org_id,location_id),check(guest_index>=0 and guest_index<original_party_size),
 foreign key(appointment_id,org_id,location_id) references appointments(id,org_id,location_id)
);
alter table appointment_guest_cancellations enable row level security;
alter table appointment_guest_cancellations force row level security;
create policy tenant_isolation on appointment_guest_cancellations to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
grant select,insert on appointment_guest_cancellations to app_user;
revoke all on appointment_guest_cancellations from public,anon,authenticated;

alter table commerce_refunds
 add column deposit_guest_allocation jsonb,
 add column guest_cancellation_id uuid,
 add column review_required boolean not null default false,
 add column approved_by uuid references memberships(id),
 add column approved_at timestamptz,
 add column approval_reason text,
 add foreign key(guest_cancellation_id,org_id,location_id) references appointment_guest_cancellations(id,org_id,location_id),
 add constraint guest_refund_review_fields check(
   (approved_at is null and approved_by is null and approval_reason is null)
   or (approved_at is not null and approved_by is not null and approval_reason is not null and length(btrim(approval_reason)) between 2 and 500));
create unique index guest_cancellation_refund_active on commerce_refunds(guest_cancellation_id)
 where guest_cancellation_id is not null and status in ('pending','review','succeeded');

create function gf_valid_deposit_refund_allocation(shares jsonb,amount integer) returns boolean
 language plpgsql immutable as $$
declare item jsonb;idx integer;value integer;seen integer[]='{}';total bigint=0;
begin
 if shares is null then return true; end if;
 if jsonb_typeof(shares)<>'array' or jsonb_array_length(shares) not between 1 and 20 then return false; end if;
 for item in select jsonb_array_elements(shares) loop
  if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'guestIndex') is distinct from 'number'
    or jsonb_typeof(item->'amountCents') is distinct from 'number' then return false; end if;
  if (item->>'guestIndex')::numeric<>trunc((item->>'guestIndex')::numeric)
    or (item->>'amountCents')::numeric<>trunc((item->>'amountCents')::numeric) then return false; end if;
  idx=(item->>'guestIndex')::integer;value=(item->>'amountCents')::integer;
  if idx<0 or idx>=20 or value<=0 or value>1000000000 or idx=any(seen) then return false; end if;
  seen=array_append(seen,idx);total=total+value;
 end loop;
 return total=amount;
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end $$;
alter table commerce_refunds add constraint deposit_refund_guest_amount check(gf_valid_deposit_refund_allocation(deposit_guest_allocation,amount_cents));
create function gf_refund_guest_contract_guard() returns trigger language plpgsql as $$
begin
 if row(new.deposit_guest_allocation,new.guest_cancellation_id,new.review_required)
    is distinct from row(old.deposit_guest_allocation,old.guest_cancellation_id,old.review_required)
    or (old.approved_at is not null and row(new.approved_at,new.approved_by,new.approval_reason)
      is distinct from row(old.approved_at,old.approved_by,old.approval_reason)) then
  raise exception using errcode='23001',message='refund guest allocation and approval are immutable';
 end if;
 return new;
end $$;
create trigger refund_guest_contract_guard before update on commerce_refunds for each row execute function gf_refund_guest_contract_guard();
