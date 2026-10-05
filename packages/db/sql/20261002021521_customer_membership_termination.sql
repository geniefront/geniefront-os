create table customer_membership_terminations(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 membership_id uuid not null unique,unused_benefits text not null check(unused_benefits in('revoke_all','keep_current_paid')),
 reason text not null check(length(reason)>=2),requested_by uuid not null references memberships(id),business_date date not null,
 review_snapshot jsonb not null,status text not null default 'pending' check(status in('pending','provider_canceled','complete','review')),
 provider_canceled_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(id,org_id,location_id),foreign key(membership_id,org_id,location_id) references customer_paid_memberships(id,org_id,location_id),
 check((status='pending' and provider_canceled_at is null) or(status<>'pending' and provider_canceled_at is not null))
);
create table customer_membership_termination_cycles(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 termination_id uuid not null,cycle_id uuid not null unique,stop_benefits boolean not null,reviewed_state jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(termination_id,org_id,location_id) references customer_membership_terminations(id,org_id,location_id),
 foreign key(cycle_id,org_id,location_id) references customer_membership_cycles(id,org_id,location_id)
);
create table customer_membership_refund_requests(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 membership_id uuid not null,termination_id uuid not null,reason text not null check(length(reason)>=2),review_snapshot jsonb not null,
 requested_by uuid not null references memberships(id),business_date date not null,created_at timestamptz not null default now(),unique(id,org_id,location_id),
 foreign key(membership_id,org_id,location_id) references customer_paid_memberships(id,org_id,location_id),
 foreign key(termination_id,org_id,location_id) references customer_membership_terminations(id,org_id,location_id)
);
alter table customer_paid_memberships add column termination_id uuid;
alter table customer_paid_memberships add constraint membership_termination_scope foreign key(termination_id,org_id,location_id)
 references customer_membership_terminations(id,org_id,location_id);
alter table commerce_refunds add column membership_refund_request_id uuid;
alter table commerce_refunds add constraint membership_refund_request_scope foreign key(membership_refund_request_id,org_id,location_id)
 references customer_membership_refund_requests(id,org_id,location_id);
alter table customer_membership_ledger add column termination_id uuid;
alter table customer_membership_ledger add constraint membership_stop_fact_scope foreign key(termination_id,org_id,location_id)
 references customer_membership_terminations(id,org_id,location_id);
alter table customer_membership_ledger drop constraint customer_membership_ledger_entry_check;
alter table customer_membership_ledger add constraint customer_membership_ledger_entry_check check(entry in('issue','redeem','restore','expire','freeze','purchase_refund','stop','revoke'));
create unique index membership_one_stop_fact_per_cycle on customer_membership_ledger(cycle_id) where entry in('stop','revoke');
create index membership_refund_request_parent on customer_membership_refund_requests(termination_id,created_at);
create index commerce_refunds_membership_request on commerce_refunds(membership_refund_request_id) where membership_refund_request_id is not null;
create function gf_membership_termination_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then
  if current_user='app_user' then raise exception 'membership termination history is immutable' using errcode='23514';end if;
  return old;
 end if;
 if tg_op='INSERT' and (new.status<>'pending' or new.provider_canceled_at is not null) then raise exception 'new termination must await provider' using errcode='23514';end if;
 if tg_op='UPDATE' then
  if (to_jsonb(new)-array['status','provider_canceled_at','updated_at']) is distinct from (to_jsonb(old)-array['status','provider_canceled_at','updated_at'])
   or(old.provider_canceled_at is not null and new.provider_canceled_at is distinct from old.provider_canceled_at)
   or(old.status<>'pending' and new.status='pending') then raise exception 'membership termination decision is immutable' using errcode='23514';end if;
 end if;return new;
end $$;
create trigger membership_termination_guard before insert or update or delete on customer_membership_terminations for each row execute function gf_membership_termination_guard();
create function gf_membership_termination_link_guard() returns trigger language plpgsql as $$
begin
 if tg_table_name='customer_membership_termination_cycles' then
  if not exists(select 1 from customer_membership_terminations t join customer_membership_cycles c on c.membership_id=t.membership_id
   where t.id=new.termination_id and c.id=new.cycle_id) then raise exception 'wrong termination cycle' using errcode='23514';end if;
 else
  if not exists(select 1 from customer_membership_terminations t where t.id=new.termination_id and t.membership_id=new.membership_id)
   then raise exception 'wrong membership refund request' using errcode='23514';end if;
 end if;return new;
end $$;
create trigger membership_termination_cycle_link before insert on customer_membership_termination_cycles for each row execute function gf_membership_termination_link_guard();
create trigger membership_refund_request_link before insert on customer_membership_refund_requests for each row execute function gf_membership_termination_link_guard();
create function gf_membership_purchase_refund_guard() returns trigger language plpgsql as $$
declare paid integer;reserved integer;held integer;parent uuid;policy text;
begin
 if new.membership_refund_request_id is null then return new;end if;
 select t.membership_id,t.unused_benefits into parent,policy from customer_membership_refund_requests q
  join customer_membership_terminations t on t.id=q.termination_id join customer_membership_invoices i on i.membership_id=q.membership_id
  where q.id=new.membership_refund_request_id and i.payment_id=new.payment_id and q.requested_by=new.recorded_by;
 if parent is null or new.asset_quantity<>0 then raise exception 'wrong membership refund source' using errcode='23514';end if;
 perform id from customer_paid_memberships where id=parent for update;
 select amount_cents into paid from commerce_payments where id=new.payment_id and status='paid' for update;
 select coalesce(sum(amount_cents),0)::int into reserved from commerce_refunds where payment_id=new.payment_id and status in('pending','succeeded','review');
 select coalesce(sum(c.value_cents),0)::int into held from customer_membership_termination_cycles d join customer_membership_cycles c on c.id=d.cycle_id
  join customer_membership_invoices i on i.id=c.invoice_id where not d.stop_benefits and i.payment_id=new.payment_id and c.ends_at>now();
 if paid is null or exists(select 1 from commerce_review_items where payment_id=new.payment_id and status in('open','lost','review'))
  or new.amount_cents>(paid-reserved-(case when policy='keep_current_paid' then held else 0 end))
  then raise exception 'membership refund exceeds paid invoice' using errcode='23514';end if;return new;
end $$;
create trigger membership_purchase_refund_guard before insert on commerce_refunds for each row execute function gf_membership_purchase_refund_guard();
create function gf_membership_stop_fact_guard() returns trigger language plpgsql as $$
declare cycle customer_membership_cycles%rowtype;quantity integer;value integer;
begin
 if new.entry not in('stop','revoke') then return new;end if;
 select * into cycle from customer_membership_cycles where id=new.cycle_id for update;
 if cycle.id is null or not exists(select 1 from customer_membership_termination_cycles d join customer_membership_terminations t on t.id=d.termination_id
  where d.cycle_id=cycle.id and d.stop_benefits and t.id=new.termination_id and t.membership_id=cycle.membership_id and t.status<>'pending')
  then raise exception 'unverified membership stop' using errcode='23514';end if;
 select coalesce(sum(upper(r)-lower(r)),0)::int into quantity from unnest(cycle.available_units)r;
 value:=commerce_internal.membership_range_value(cycle.value_cents,cycle.quantity,cycle.available_units);
 if (new.entry='stop' and (cycle.status<>'planned' or new.quantity<>0 or new.value_cents<>0 or new.unit_ranges<>'{}'::int4multirange))
  or(new.entry='revoke' and (cycle.status<>'issued' or new.quantity<>-quantity or new.value_cents<>-value or new.unit_ranges<>cycle.available_units))
  then raise exception 'membership stop value mismatch' using errcode='23514';end if;return new;
end $$;
create trigger membership_stop_fact_guard before insert on customer_membership_ledger for each row execute function gf_membership_stop_fact_guard();
do $$ declare name text;begin
 foreach name in array array['customer_membership_terminations','customer_membership_termination_cycles','customer_membership_refund_requests'] loop
  execute format('alter table %I enable row level security',name);execute format('alter table %I force row level security',name);
  execute format('create policy tenant_isolation on %I to app_user using(org_id=app_org_id() and location_id=app_location_id()) with check(org_id=app_org_id() and location_id=app_location_id())',name);
  execute format('revoke all on %I from public,anon,authenticated,app_user',name);
  execute format('grant select,insert on %I to app_user',name);
  if name='customer_membership_terminations' then execute format('grant update on %I to app_user',name);
  else execute format('create trigger membership_decision_append_only before update or delete on %I for each row execute function gf_ccl_append_only()',name);end if;
 end loop;
end $$;
