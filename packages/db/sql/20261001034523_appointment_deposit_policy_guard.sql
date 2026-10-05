-- CHECK treats NULL as unknown/allowed; percentage rules must have an explicit ratio.
alter table location_scheduling_rules drop constraint scheduling_deposit_method_fields;
alter table location_scheduling_rules add constraint scheduling_deposit_method_fields check(
 (deposit_method='fixed' and deposit_percent_bps is null)
 or (deposit_method='percentage' and deposit_percent_bps is not null
     and deposit_percent_bps between 1 and 10000 and deposit_amount_cents=0));

-- Operational state and reservations may advance; the purchased contract and first payment association may not change.
create function gf_deposit_hold_contract_guard() returns trigger language plpgsql as $$
begin
 if row(new.org_id,new.location_id,new.appointment_id,new.amount_cents,new.service_total_cents,new.currency,
        new.policy_snapshot,new.business_key,new.request_hash,new.created_at)
    is distinct from row(old.org_id,old.location_id,old.appointment_id,old.amount_cents,old.service_total_cents,old.currency,
        old.policy_snapshot,old.business_key,old.request_hash,old.created_at)
    or (old.order_id is not null and new.order_id is distinct from old.order_id) then
  raise exception using errcode='23001',message='appointment deposit contract is immutable';
 end if;
 return new;
end $$;
create trigger deposit_hold_contract_guard before update on commerce_appointment_holds
 for each row execute function gf_deposit_hold_contract_guard();
