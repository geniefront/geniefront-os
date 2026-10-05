alter table commerce_refunds add constraint guest_refund_requires_allocation check(
 (guest_cancellation_id is null or deposit_guest_allocation is not null)
 and (not review_required or guest_cancellation_id is not null));
create function gf_guest_refund_context_guard() returns trigger language plpgsql as $$
declare participant integer;
begin
 if new.guest_cancellation_id is null then return new; end if;
 select c.guest_index into participant from appointment_guest_cancellations c
   join commerce_appointment_holds h on h.appointment_id=c.appointment_id and h.org_id=c.org_id and h.location_id=c.location_id
   join commerce_payments p on p.order_id=h.order_id and p.id=new.payment_id
   where c.id=new.guest_cancellation_id and c.org_id=new.org_id and c.location_id=new.location_id;
 if participant is null or new.deposit_guest_allocation is null
    or jsonb_typeof(new.deposit_guest_allocation) is distinct from 'array'
    or jsonb_array_length(new.deposit_guest_allocation)<>1
    or (new.deposit_guest_allocation->0->>'guestIndex')::integer is distinct from participant then
  raise exception using errcode='23001',message='refund must reference the cancelled guest and original deposit payment';
 end if;
 return new;
end $$;
create trigger guest_refund_context_guard before insert on commerce_refunds for each row execute function gf_guest_refund_context_guard();
