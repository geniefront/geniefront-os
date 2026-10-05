-- One immutable price benefit per execution line. Historical ticket totals are not reinterpreted.
alter table tickets add constraint ticket_identity_scope unique(id,org_id,location_id);
create table ticket_price_adjustments(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 ticket_id uuid not null,ticket_item_id uuid not null references ticket_items(id),kind text not null check(kind in('manual','membership')),
 original_cents integer not null check(original_cents>0),discount_cents integer not null check(discount_cents>0 and discount_cents<=original_cents),
 customer_membership_id uuid,cycle_id uuid,plan_version_id uuid,business_date date not null,
 actor_membership_id uuid references memberships(id),rule_snapshot jsonb not null,created_at timestamptz not null default now(),
 unique(ticket_item_id),
 foreign key(ticket_id,org_id,location_id) references tickets(id,org_id,location_id),
 foreign key(customer_membership_id,org_id,location_id) references customer_paid_memberships(id,org_id,location_id),
 foreign key(cycle_id,org_id,location_id) references customer_membership_cycles(id,org_id,location_id),
 foreign key(plan_version_id,org_id,location_id) references customer_membership_plan_versions(id,org_id,location_id),
 check((kind='manual' and customer_membership_id is null and cycle_id is null and plan_version_id is null)
   or(kind='membership' and customer_membership_id is not null and cycle_id is not null and plan_version_id is not null))
);
create index ticket_price_adjustments_ticket on ticket_price_adjustments(ticket_id,kind);
-- Existing service provenance queries also need a direct ticket lookup, beyond their cycle index.
create index customer_membership_ledger_ticket on customer_membership_ledger(ticket_id,entry) where ticket_id is not null;
alter table ticket_price_adjustments enable row level security;
alter table ticket_price_adjustments force row level security;
create policy tenant_isolation on ticket_price_adjustments to app_user
 using(org_id=app_org_id() and location_id=app_location_id()) with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on ticket_price_adjustments from public,anon,authenticated,app_user;
grant select,insert on ticket_price_adjustments to app_user;
create trigger ticket_price_adjustments_append_only before update or delete on ticket_price_adjustments for each row execute function gf_ccl_append_only();
create function gf_ticket_price_adjustment_guard() returns trigger language plpgsql as $$
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
  if member.id is null or cycle.id is null or cycle.membership_id<>member.id or member.customer_id is distinct from ticket.customer_id
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
create trigger ticket_price_adjustment_guard before insert on ticket_price_adjustments for each row execute function gf_ticket_price_adjustment_guard();
