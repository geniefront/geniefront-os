-- Preserve closed sales; later original-source refunds use their own append-only business-day facts.
create or replace function guard_closed_business_day() returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_location uuid;
  v_date date;
  v_ticket uuid;
  v_refund ticket_refunds;
  v_refund_total integer;
begin
  if tg_table_name = 'ticket_item_staff' then
    select ti.location_id, t.business_date into v_location, v_date
      from ticket_items ti join tickets t on t.id = ti.ticket_id
     where ti.id = case when tg_op = 'DELETE' then old.ticket_item_id else new.ticket_item_id end;
  elsif tg_op = 'DELETE' then
    v_location := old.location_id;
  else
    v_location := new.location_id;
  end if;

  if tg_table_name in ('tickets','cash_movements','tip_payouts','earnings','ticket_refunds') then
    v_date := case when tg_op = 'DELETE' then old.business_date else new.business_date end;
  elsif tg_table_name = 'appointments' then
    v_date := case when tg_op = 'DELETE' then old.business_date else new.business_date end;
  elsif tg_table_name in ('payments','tip_allocations') then
    v_ticket := case when tg_op = 'DELETE' then old.ticket_id else new.ticket_id end;
    select business_date into v_date from tickets where id = v_ticket;
  elsif tg_table_name = 'ticket_items' then
    v_ticket := case when tg_op = 'DELETE' then old.ticket_id else new.ticket_id end;
    select business_date into v_date from tickets where id = v_ticket;
  elsif tg_table_name = 'ticket_item_staff' then
    null;
  elsif tg_table_name = 'ticket_service_notes' then
    select t.business_date into v_date
      from ticket_items ti join tickets t on t.id = ti.ticket_id
     where ti.id = case when tg_op = 'DELETE' then old.ticket_item_id else new.ticket_item_id end;
  elsif tg_table_name = 'appointment_items' then
    select business_date into v_date from appointments
     where id = case when tg_op = 'DELETE' then old.appointment_id else new.appointment_id end;
  elsif tg_table_name = 'customer_credit_ledger' then
    v_ticket := case when tg_op = 'DELETE' then old.ticket_id else new.ticket_id end;
    if v_ticket is not null then select business_date into v_date from tickets where id = v_ticket; end if;
  end if;
  -- A new, scoped refund belongs to its own business day. It cannot rewrite the sale.
  if tg_table_name='tickets' then
   if tg_op='UPDATE' and new.refund_cents>old.refund_cents then
    select coalesce(sum(amount_cents),0)::integer into v_refund_total from ticket_refunds where ticket_id=new.id;
    select * into v_refund from ticket_refunds where ticket_id=new.id and created_at=new.refunded_at and amount_cents=new.refund_cents-old.refund_cents order by id limit 1;
    if v_refund.id is null or row(v_refund.org_id,v_refund.location_id) is distinct from row(new.org_id,new.location_id)
      or new.refund_cents<>v_refund_total or new.refund_cents>new.total_cents
      or new.refund_cents-old.refund_cents<>v_refund.amount_cents
      or new.refunded_by is distinct from v_refund.refunded_by
      or new.refund_reason is distinct from v_refund.reason or new.refund_method is distinct from v_refund.method
      or new.status<>(case when new.refund_cents=new.total_cents then 'refunded' else old.status end)
      or (to_jsonb(new)-array['refund_cents','refund_reason','refund_method','refunded_at','refunded_by','status'])
        is distinct from (to_jsonb(old)-array['refund_cents','refund_reason','refund_method','refunded_at','refunded_by','status']) then
      raise exception using errcode='23001',message='closed sale may only reflect its new original-source refund';
    end if;
    v_date:=v_refund.business_date;
   end if;
  elsif tg_table_name='customer_credit_ledger' then
   if tg_op='INSERT' and new.entry='refund' and new.meta ? 'refundId' then
    select * into v_refund from ticket_refunds where id::text=new.meta->>'refundId' and ticket_id=new.ticket_id
      and org_id=new.org_id and location_id=new.location_id;
    if v_refund.id is null then raise exception using errcode='23001',message='asset return requires its scoped ticket refund';end if;
    v_date:=v_refund.business_date;
   end if;
  elsif tg_table_name='tip_allocations' then
   if tg_op='INSERT' and new.amount_cents<0 and new.basis->>'refund'='true' then
    select * into v_refund from ticket_refunds where id::text=new.basis->>'refundId' and ticket_id=new.ticket_id
      and org_id=new.org_id and location_id=new.location_id;
    if v_refund.id is null or -new.amount_cents>v_refund.tip_cents then raise exception using errcode='23001',message='tip return requires its scoped ticket refund';end if;
    v_date:=v_refund.business_date;
   end if;
  end if;
  perform assert_business_day_writable(v_location, v_date);
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function guard_closed_business_day() from public, anon, authenticated;
grant execute on function guard_closed_business_day() to app_user;
