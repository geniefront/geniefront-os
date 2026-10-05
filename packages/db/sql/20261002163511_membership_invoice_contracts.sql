-- Every paid invoice owns the immutable terms for its funded benefit periods.
-- Backfill only from the existing immutable original membership contract; no cash or units are created.
begin;
alter table customer_membership_invoices add column plan_version_id uuid,add column snapshot jsonb,add column stripe_price_id text;
do $$begin
 if exists(select 1 from customer_membership_invoices i join customer_paid_memberships m on m.id=i.membership_id
  join commerce_payments p on p.id=i.payment_id where m.stripe_price_id is null
   or p.amount_cents<>(m.snapshot->'terms'->>'amountCents')::integer or p.currency<>m.snapshot->>'currency') then
  raise exception 'Historical membership invoice contract requires review';
 end if;
end $$;
alter table customer_membership_invoices disable trigger customer_membership_invoices_append_only;
update customer_membership_invoices i set plan_version_id=m.plan_version_id,snapshot=m.snapshot,stripe_price_id=m.stripe_price_id
 from customer_paid_memberships m where m.id=i.membership_id;
alter table customer_membership_invoices enable trigger customer_membership_invoices_append_only;
alter table customer_membership_invoices alter column plan_version_id set not null,alter column snapshot set not null,alter column stripe_price_id set not null,
 add foreign key(plan_version_id,org_id,location_id) references customer_membership_plan_versions(id,org_id,location_id);

create or replace function gf_membership_invoice_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 -- Omitted fields are compatible with the previous API, which could only bill original terms.
 if new.plan_version_id is null or new.snapshot is null or new.stripe_price_id is null then
  select coalesce(new.plan_version_id,m.plan_version_id),coalesce(new.snapshot,m.snapshot),coalesce(new.stripe_price_id,m.stripe_price_id)
   into new.plan_version_id,new.snapshot,new.stripe_price_id from customer_paid_memberships m where m.id=new.membership_id;
 end if;
 if not exists(select 1 from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id
  join commerce_orders o on o.id=new.order_id join commerce_payments p on p.id=new.payment_id
  where m.id=new.membership_id and m.account_id=new.account_id and m.livemode=new.livemode
   and o.customer_id=m.customer_id and o.account_id=a.id and o.kind='customer_membership' and o.asset_id=m.id
   and p.order_id=o.id and p.status='paid' and p.provider='stripe' and p.method='membership_invoice'
   and p.stripe_account_id=a.stripe_account_id and p.livemode=new.livemode and p.payment_intent_id is not null
   and new.plan_version_id=m.plan_version_id and new.stripe_price_id=m.stripe_price_id and new.snapshot=m.snapshot
   and o.snapshot->'membership'=new.snapshot and p.amount_cents=(new.snapshot->'terms'->>'amountCents')::int and p.currency=new.snapshot->>'currency') then
  raise exception using errcode='23001',message='membership invoice requires its own verified paid order';
 end if;
 return new;
end $$;
create or replace function gf_membership_cycle_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if not(new.available_units <@ int4multirange(int4range(0,new.quantity,'[)'))) then
  raise exception using errcode='23001',message='membership units outside purchased quota';
 end if;
 if tg_op='INSERT' then
  if new.status<>'planned' or new.issued_at is not null or new.available_units<>'{}'::int4multirange or not exists(
   select 1 from customer_membership_invoices i join customer_paid_memberships m on m.id=i.membership_id
   where i.id=new.invoice_id and i.membership_id=new.membership_id and new.starts_at>=i.period_start and new.ends_at<=i.period_end
    and new.quantity=(i.snapshot->'terms'->>'quantity')::int) then
   raise exception using errcode='23001',message='membership cycle requires paid coverage and purchased quota';
  end if;
 else
  if row(new.org_id,new.location_id,new.membership_id,new.invoice_id,new.cycle_index,new.starts_at,new.ends_at,new.quantity,new.value_cents)
   is distinct from row(old.org_id,old.location_id,old.membership_id,old.invoice_id,old.cycle_index,old.starts_at,old.ends_at,old.quantity,old.value_cents)
   or (old.issued_at is not null and new.issued_at is distinct from old.issued_at) or (old.status<>'planned' and new.status='planned') then
   raise exception using errcode='23001',message='membership benefit schedule is immutable';
  end if;
 end if;
 return new;
end $$;
create or replace function gf_membership_unit_fact_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare cycle customer_membership_cycles; member customer_paid_memberships; original customer_membership_ledger; contract jsonb; unit_count integer; unit_value integer;
begin
 select * into cycle from customer_membership_cycles where id=new.cycle_id for update;
 select * into member from customer_paid_memberships where id=cycle.membership_id;
 select snapshot into contract from customer_membership_invoices where id=cycle.invoice_id;
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
     and i.total_cents=new.covered_cents and contract->'terms'->'serviceIds' ? i.service_id::text)
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
create or replace function gf_ticket_price_adjustment_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare item ticket_items%rowtype;ticket tickets%rowtype;member customer_paid_memberships%rowtype;cycle customer_membership_cycles%rowtype;bps integer; contract customer_membership_invoices;
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
  select * into contract from customer_membership_invoices where id=cycle.invoice_id;
  if member.id is null or cycle.id is null or cycle.membership_id<>member.id or gf_customer_root(member.customer_id) is null or gf_customer_root(member.customer_id) is distinct from gf_customer_root(ticket.customer_id)
    or contract.id is null or contract.plan_version_id<>new.plan_version_id or member.commerce_frozen or member.terminated_at is not null
    or cycle.status<>'issued' or cycle.starts_at>now() or cycle.ends_at<=now() or item.bundle_instance_id is not null or item.discount_cents<>0
    or item.kind not in('service','addon') or item.service_id is null or not(contract.snapshot->'terms'->'discountServiceIds' ? item.service_id::text)
    then raise exception 'invalid paid membership discount source' using errcode='23514';end if;
  bps:=(contract.snapshot->'terms'->>'discountBps')::integer;
  if bps<=0 or new.discount_cents<>(item.total_cents::bigint*bps+5000)/10000
    or (new.rule_snapshot->>'discountBps')::integer is distinct from bps
    then raise exception 'membership discount amount mismatch' using errcode='23514';end if;
 end if;
 return new;
end $$;
revoke all on function gf_membership_invoice_guard() from public,anon,authenticated;
grant execute on function gf_membership_invoice_guard() to app_user;
revoke all on function gf_membership_cycle_guard() from public,anon,authenticated;
grant execute on function gf_membership_cycle_guard() to app_user;
revoke all on function gf_membership_unit_fact_guard() from public,anon,authenticated;
grant execute on function gf_membership_unit_fact_guard() to app_user;
revoke all on function gf_ticket_price_adjustment_guard() from public,anon,authenticated;
grant execute on function gf_ticket_price_adjustment_guard() to app_user;
commit;
