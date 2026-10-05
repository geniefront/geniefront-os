alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check check(method in('cash','card','external','gift_card','customer_credit','deposit'));
alter table payments add column deposit_hold_id uuid;
alter table payments add constraint payments_deposit_scope foreign key(deposit_hold_id,org_id,location_id)
 references commerce_appointment_holds(id,org_id,location_id);
alter table payments add constraint payments_deposit_source check(method<>'deposit' or (deposit_hold_id is not null and tip_cents=0));
-- A signed dispute freezes unused credit without rewriting already-performed service history.
create or replace function gf_deposit_appointment_guard() returns trigger language plpgsql as $$
begin
 if new.deposit_status in('pending','review') and new.status not in('booked','cancelled','no_show')
   and new.status<>old.status and old.status not in('in_service','done') then
  raise exception 'Deposit payment must be confirmed before service' using errcode='23001',hint='DEPOSIT_PAYMENT_REQUIRED';
 end if;
 if new.status='cancelled' and old.status<>'cancelled' and new.deposit_status='pending' then
  update commerce_appointment_holds set status='cancelled',updated_at=now() where appointment_id=new.id and status='pending';
  new.deposit_status='cancelled';
 end if;
 return new;
end $$;
