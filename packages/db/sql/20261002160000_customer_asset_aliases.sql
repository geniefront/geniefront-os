-- Explicit customer aliases preserve original contracts and service provenance.
create function gf_customer_root(p_id uuid) returns uuid language plpgsql security invoker
set search_path=pg_catalog,public,pg_temp as $$
declare current_id uuid:=p_id;next_id uuid;seen uuid[]:='{}';
begin
 if p_id is null then return null;end if;
 perform pg_advisory_xact_lock_shared(hashtext(app_org_id()::text),hashtext('customer.merge'));
 loop
  if current_id=any(seen) then raise exception using errcode='23001',message='customer identity cycle';end if;
  seen:=array_append(seen,current_id);
  select merged_into_id into next_id from customers where id=current_id and org_id=app_org_id();
  if not found then return null;end if;
  if next_id is null then return current_id;end if;
  current_id:=next_id;
 end loop;
end $$;
revoke all on function gf_customer_root(uuid) from public,anon,authenticated;
grant execute on function gf_customer_root(uuid) to app_user;

create or replace function gf_membership_unit_fact_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare cycle customer_membership_cycles; member customer_paid_memberships; original customer_membership_ledger; unit_count integer; unit_value integer;
begin
 select * into cycle from customer_membership_cycles where id=new.cycle_id for update;
 select * into member from customer_paid_memberships where id=cycle.membership_id;
 select coalesce(sum(upper(r)-lower(r)),0)::integer into unit_count from unnest(new.unit_ranges)r;
 unit_value:=commerce_internal.membership_range_value(cycle.value_cents,cycle.quantity,new.unit_ranges);
 if cycle.id is null or row(new.org_id,new.location_id) is distinct from row(cycle.org_id,cycle.location_id)
  or not(new.unit_ranges <@ int4multirange(int4range(0,cycle.quantity,'[)'))) then
  raise exception using errcode='23001',message='membership unit fact requires scoped purchased units';
 end if;
 if new.entry='redeem' then
  if new.quantity<>-1 or unit_count<>1 or new.value_cents<>-unit_value or new.covered_cents<=0 or new.business_date is null
   or not(new.unit_ranges <@ cycle.available_units) or cycle.status<>'issued' or cycle.starts_at>now() or cycle.ends_at<=now()
   or member.commerce_frozen or member.terminated_at is not null or new.redemption_id is not null or new.ticket_refund_id is not null
   or not exists(select 1 from tickets t join ticket_items i on i.ticket_id=t.id
    where t.id=new.ticket_id and i.id=new.ticket_item_id and i.bundle_instance_id is null
     and t.org_id=new.org_id and t.location_id=new.location_id and gf_customer_root(t.customer_id)=gf_customer_root(member.customer_id)
     and i.total_cents=new.covered_cents and member.snapshot->'terms'->'serviceIds' ? i.service_id::text)
   or exists(select 1 from customer_credit_ledger l where l.kind='package' and l.entry='redeem' and l.ticket_id=new.ticket_id
    and l.meta->'ticketItemIds' ? new.ticket_item_id::text) then
   raise exception using errcode='23001',message='membership redemption requires one eligible paid service unit';
  end if;
 elsif new.entry='restore' then
  select * into original from customer_membership_ledger where id=new.redemption_id;
  if original.id is null or original.entry<>'redeem' or new.quantity<>1 or new.value_cents<>-original.value_cents
   or new.unit_ranges<>original.unit_ranges or new.cycle_id<>original.cycle_id or new.ticket_id is distinct from original.ticket_id
   or new.ticket_item_id is distinct from original.ticket_item_id or new.business_date is null
   or new.unit_ranges&&cycle.available_units or new.covered_cents<>original.covered_cents
   or (select coalesce(sum(covered_cents),0) from customer_membership_service_refunds where redemption_id=original.id)<>original.covered_cents
   or not exists(select 1 from customer_membership_service_refunds r where r.redemption_id=original.id and r.ticket_refund_id=new.ticket_refund_id) then
   raise exception using errcode='23001',message='membership restoration requires fully refunded original service';
  end if;
 elsif new.entry='expire' then
  if new.quantity<>-unit_count or new.value_cents<>-unit_value or new.business_date is null
   or not(new.unit_ranges <@ cycle.available_units) or (cycle.ends_at>now() and member.terminated_at is null) then
   raise exception using errcode='23001',message='membership expiry requires original unused ended units';
  end if;
 end if;
 return new;
end $$;
revoke all on function gf_membership_unit_fact_guard() from public,anon,authenticated;
grant execute on function gf_membership_unit_fact_guard() to app_user;

create or replace function gf_ticket_price_adjustment_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare item ticket_items%rowtype;ticket tickets%rowtype;member customer_paid_memberships%rowtype;cycle customer_membership_cycles%rowtype;bps integer;
begin
 select * into item from ticket_items where id=new.ticket_item_id;
 select * into ticket from tickets where id=new.ticket_id;
 if item.id is null or ticket.id is null or item.ticket_id<>ticket.id or item.org_id<>new.org_id
   or item.total_cents<>new.original_cents or ticket.service_settled_at is not null or ticket.status not in('open','in_service','ready_to_pay')
   or ticket.business_date<>new.business_date then raise exception 'invalid ticket price source' using errcode='23514';end if;
 if exists(select 1 from customer_membership_ledger where ticket_item_id=item.id and entry='redeem')
   or exists(select 1 from customer_credit_ledger where ticket_id=ticket.id and kind='package' and entry='redeem'
     and meta->'ticketItemIds' ? item.id::text) then raise exception 'covered item cannot receive price discount' using errcode='23514';end if;
 if new.kind='membership' then
  select * into member from customer_paid_memberships where id=new.customer_membership_id;
  select * into cycle from customer_membership_cycles where id=new.cycle_id for update;
  if member.id is null or cycle.id is null or cycle.membership_id<>member.id or gf_customer_root(member.customer_id) is null or gf_customer_root(member.customer_id) is distinct from gf_customer_root(ticket.customer_id)
    or member.plan_version_id<>new.plan_version_id or member.commerce_frozen or member.terminated_at is not null
    or cycle.status<>'issued' or cycle.starts_at>now() or cycle.ends_at<=now() or item.bundle_instance_id is not null or item.discount_cents<>0
    or item.kind not in('service','addon') or item.service_id is null or not(member.snapshot->'terms'->'discountServiceIds' ? item.service_id::text)
    then raise exception 'invalid paid membership discount source' using errcode='23514';end if;
  bps:=(member.snapshot->'terms'->>'discountBps')::integer;
  if bps<=0 or new.discount_cents<>(item.total_cents::bigint*bps+5000)/10000
    or (new.rule_snapshot->>'discountBps')::integer is distinct from bps
    then raise exception 'membership discount amount mismatch' using errcode='23514';end if;
 end if;
 return new;
end $$;
revoke all on function gf_ticket_price_adjustment_guard() from public,anon,authenticated;
grant execute on function gf_ticket_price_adjustment_guard() to app_user;
