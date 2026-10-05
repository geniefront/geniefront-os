-- A waiver is a reasoned booking decision, never a fabricated collection or refund.
alter table commerce_appointment_holds drop constraint commerce_appointment_holds_status_check;
alter table commerce_appointment_holds add constraint commerce_appointment_holds_status_check
 check(status in ('pending','paid','waived','expired','cancelled','refund_pending','refunded','review'));
alter table commerce_appointment_holds
 add column waived_at timestamptz,
 add column waived_by uuid references memberships(id),
 add column waiver_reason text,
 add constraint deposit_waiver_fields check(
  (waived_at is null and waived_by is null and waiver_reason is null and status<>'waived')
  or (waived_at is not null and waived_by is not null and waiver_reason is not null
      and length(btrim(waiver_reason)) between 2 and 500));

create or replace function gf_deposit_hold_contract_guard() returns trigger language plpgsql as $$
begin
 if row(new.org_id,new.location_id,new.appointment_id,new.amount_cents,new.service_total_cents,new.currency,
        new.policy_snapshot,new.business_key,new.request_hash,new.created_at)
    is distinct from row(old.org_id,old.location_id,old.appointment_id,old.amount_cents,old.service_total_cents,old.currency,
        old.policy_snapshot,old.business_key,old.request_hash,old.created_at)
    or (old.order_id is not null and new.order_id is distinct from old.order_id)
    or (old.waived_at is not null and row(new.waived_at,new.waived_by,new.waiver_reason)
        is distinct from row(old.waived_at,old.waived_by,old.waiver_reason)) then
  raise exception using errcode='23001',message='appointment deposit contract and waiver are immutable';
 end if;
 return new;
end $$;

-- Existing custom roles and membership-level denied overrides retain their meaning.
insert into role_permissions(role_id,permission)
 select id,'commerce.waiveDeposit' from roles where key in ('owner','manager') on conflict do nothing;
