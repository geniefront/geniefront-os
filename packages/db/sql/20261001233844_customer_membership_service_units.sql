-- New service provenance is nullable on historical issue rows; no invented historical redemption.
alter table customer_membership_ledger
 add column ticket_item_id uuid references ticket_items(id),
 add column redemption_id uuid,
 add column ticket_refund_id uuid,
 add column covered_cents integer not null default 0 check(covered_cents>=0),
 add column business_date date,
 add column meta jsonb not null default '{}';
alter table customer_membership_ledger add constraint membership_ledger_identity_scope unique(id,org_id,location_id);
alter table customer_membership_ledger add constraint membership_restoration_source_scope foreign key(redemption_id,org_id,location_id)
 references customer_membership_ledger(id,org_id,location_id);
alter table customer_membership_ledger add constraint membership_service_refund_scope foreign key(ticket_refund_id,org_id,location_id)
 references ticket_refunds(id,org_id,location_id);
create unique index membership_one_source_per_service_item on customer_membership_ledger(ticket_item_id) where entry='redeem';
create unique index membership_restore_original_unit_once on customer_membership_ledger(redemption_id) where entry='restore';
create index membership_cycles_expiry on customer_membership_cycles(membership_id,status,ends_at);
alter table customer_membership_cycles drop constraint customer_membership_cycles_status_check;
alter table customer_membership_cycles add constraint customer_membership_cycles_status_check check(status in('planned','issued','stopped','expired'));
alter table ticket_refunds add column membership_cents integer not null default 0 check(membership_cents>=0);
alter table ticket_refunds drop constraint ticket_refunds_channels_match;
alter table ticket_refunds add constraint ticket_refunds_channels_match check(
 cash_cents+card_cents+gift_card_cents+customer_credit_cents+deposit_cents+membership_cents=amount_cents);

create table customer_membership_service_refunds(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 redemption_id uuid not null,ticket_refund_id uuid not null,covered_cents integer not null check(covered_cents>0),
 created_at timestamptz not null default now(),unique(redemption_id,ticket_refund_id),
 foreign key(redemption_id,org_id,location_id) references customer_membership_ledger(id,org_id,location_id),
 foreign key(ticket_refund_id,org_id,location_id) references ticket_refunds(id,org_id,location_id)
);
alter table customer_membership_service_refunds enable row level security;
alter table customer_membership_service_refunds force row level security;
create policy tenant_isolation on customer_membership_service_refunds for all to app_user
 using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on customer_membership_service_refunds from public,anon,authenticated,app_user;
grant select,insert on customer_membership_service_refunds to app_user;
create trigger membership_service_refunds_append_only before update or delete on customer_membership_service_refunds
 for each row execute function gf_ccl_append_only();

create function commerce_internal.membership_range_value(amount integer,quantity integer,units int4multirange) returns integer
 language sql immutable strict as $$
 select coalesce(sum((amount::bigint*upper(r))/nullif(quantity,0)
  -(amount::bigint*lower(r))/nullif(quantity,0)),0)::integer from unnest(units)r
$$;
revoke all on function commerce_internal.membership_range_value(integer,integer,int4multirange) from public,anon,authenticated;
grant execute on function commerce_internal.membership_range_value(integer,integer,int4multirange) to app_user;

create function gf_membership_service_refund_guard() returns trigger language plpgsql as $$
declare original customer_membership_ledger; refund ticket_refunds; allocated integer;
begin
 select * into original from customer_membership_ledger where id=new.redemption_id;
 perform id from customer_membership_cycles where id=original.cycle_id for update;
 select * into refund from ticket_refunds where id=new.ticket_refund_id;
 if original.id is null or original.entry<>'redeem' or refund.id is null or refund.method<>'original_payment'
  or row(original.org_id,original.location_id,original.ticket_id) is distinct from row(new.org_id,new.location_id,refund.ticket_id)
  or row(refund.org_id,refund.location_id) is distinct from row(new.org_id,new.location_id) then
  raise exception using errcode='23001',message='membership refund requires its original service and refund';
 end if;
 select coalesce(sum(covered_cents),0) into allocated from customer_membership_service_refunds where redemption_id=original.id;
 if allocated+new.covered_cents>original.covered_cents or
  (select coalesce(sum(covered_cents),0) from customer_membership_service_refunds where ticket_refund_id=refund.id)+new.covered_cents>refund.membership_cents then
  raise exception using errcode='23001',message='membership service refund exceeds original coverage';
 end if;
 return new;
end $$;
create trigger membership_service_refund_guard before insert on customer_membership_service_refunds
 for each row execute function gf_membership_service_refund_guard();

create function gf_membership_unit_fact_guard() returns trigger language plpgsql as $$
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
     and t.org_id=new.org_id and t.location_id=new.location_id and t.customer_id=member.customer_id
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
create trigger membership_unit_fact_guard before insert on customer_membership_ledger for each row execute function gf_membership_unit_fact_guard();
