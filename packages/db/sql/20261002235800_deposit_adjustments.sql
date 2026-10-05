-- Original deposit contracts stay immutable. Later agreed quotes and payment requests have their own identities.
alter table commerce_appointment_holds drop constraint commerce_appointment_holds_status_check;
alter table commerce_appointment_holds add constraint commerce_appointment_holds_status_check
 check(status in('pending','paid','waived','not_required','expired','cancelled','refund_pending','refunded','review','retained'));
alter table appointments drop constraint appointments_deposit_status_check;
alter table appointments add constraint appointments_deposit_status_check
 check(deposit_status in('none','pending','paid','waived','not_required','expired','cancelled','refund_pending','refunded','review','retained'));
alter table commerce_appointment_holds add column has_confirmed_booking boolean not null default false;
update commerce_appointment_holds h set has_confirmed_booking=true from appointments a
 where a.id=h.appointment_id and a.status<>'cancelled'
 and (h.waived_at is not null or (a.deposit_status not in('none','pending','expired','cancelled')
  and exists(select 1 from commerce_deposit_ledger l where l.hold_id=h.id and l.entry='collected')));

create table commerce_deposit_requotes(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 hold_id uuid not null,revision integer not null check(revision>0),service_total_cents integer not null check(service_total_cents>=0),
 required_cents integer not null check(required_cents>=0 and required_cents<=service_total_cents),
 available_cents integer not null check(available_cents>=0),request_cents integer not null check(request_cents=greatest(0,required_cents-available_cents)),
 excess_cents integer not null check(excess_cents=greatest(0,available_cents-required_cents)),currency text not null check(currency~'^[a-z]{3}$'),
 policy_version text not null,quote_hash text not null,snapshot jsonb not null,consent jsonb not null,
 created_by uuid references memberships(id),created_at timestamptz not null default now(),
 unique(hold_id,revision),unique(id,org_id,location_id),
 foreign key(hold_id,org_id,location_id) references commerce_appointment_holds(id,org_id,location_id),
 check(jsonb_typeof(snapshot)='object' and jsonb_typeof(consent)='object' and consent->>'accepted'='true')
);
create table commerce_deposit_requests(
 order_id uuid primary key,org_id uuid not null references organizations(id),location_id uuid not null references locations(id),hold_id uuid not null,
 quote_id uuid,purpose text not null check(purpose in('initial','replacement','supplement')),
 state text not null default 'open' check(state in('open','paid','expired','superseded','cancelled')),
 expires_at timestamptz not null,created_at timestamptz not null default now(),
 unique(order_id,hold_id,org_id,location_id),
 foreign key(order_id,org_id,location_id) references commerce_orders(id,org_id,location_id),
 foreign key(hold_id,org_id,location_id) references commerce_appointment_holds(id,org_id,location_id),
 foreign key(quote_id,org_id,location_id) references commerce_deposit_requotes(id,org_id,location_id),
 check((purpose='initial' and quote_id is null) or (purpose<>'initial' and quote_id is not null))
);
create unique index commerce_one_open_deposit_request on commerce_deposit_requests(hold_id) where state='open';
create index commerce_deposit_requests_hold on commerce_deposit_requests(hold_id,created_at,order_id);
insert into commerce_deposit_requests(order_id,org_id,location_id,hold_id,purpose,state,expires_at,created_at)
 select h.order_id,h.org_id,h.location_id,h.id,'initial',
  case when o.asset_id is not null then 'paid' when h.status='expired' then 'expired'
   when h.status in('cancelled','waived') or o.status='canceled' then 'cancelled' else 'open' end,h.expires_at,o.created_at
 from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id;

alter table commerce_deposit_requotes enable row level security;
alter table commerce_deposit_requotes force row level security;
create policy tenant_isolation on commerce_deposit_requotes to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
alter table commerce_deposit_requests enable row level security;
alter table commerce_deposit_requests force row level security;
create policy tenant_isolation on commerce_deposit_requests to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on commerce_deposit_requotes,commerce_deposit_requests from public,anon,authenticated,app_user;
grant select,insert on commerce_deposit_requotes to app_user;
grant select,insert,update on commerce_deposit_requests to app_user;

create function gf_deposit_requote_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare hold commerce_appointment_holds;
begin
 if tg_op<>'INSERT' then
  if current_user='app_user' then raise exception using errcode='23001',message='deposit quotes are append-only';end if;
  return old;
 end if;
 select * into hold from commerce_appointment_holds where id=new.hold_id for update;
 if hold.id is null or hold.currency<>new.currency or hold.policy_snapshot->>'version' is distinct from new.policy_version
  or new.revision<>(select coalesce(max(revision),0)+1 from commerce_deposit_requotes where hold_id=new.hold_id)
  or new.snapshot->>'quoteHash' is distinct from new.quote_hash then
  raise exception using errcode='23001',message='deposit requote must extend its original contract';
 end if;
 return new;
end $$;
create trigger deposit_requote_guard before insert or update or delete on commerce_deposit_requotes for each row execute function gf_deposit_requote_guard();
create function gf_deposit_request_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare purchase commerce_orders;contract commerce_appointment_holds;
begin
 if tg_op='UPDATE' then
  if row(new.order_id,new.org_id,new.location_id,new.hold_id,new.quote_id,new.purpose,new.expires_at,new.created_at)
   is distinct from row(old.order_id,old.org_id,old.location_id,old.hold_id,old.quote_id,old.purpose,old.expires_at,old.created_at)
   or (new.state is distinct from old.state and (old.state in('paid','superseded','cancelled')
    or (old.state='expired' and new.state not in('paid','superseded','cancelled')))) then
   raise exception using errcode='23001',message='deposit payment request contract is immutable';
  end if;
 end if;
 select * into purchase from commerce_orders where id=new.order_id;
 select * into contract from commerce_appointment_holds where id=new.hold_id;
 if new.state='paid' and not exists(select 1 from commerce_payments p where p.order_id=new.order_id and p.status in('paid','disputed','refunded')) then
  raise exception using errcode='23001',message='a paid deposit request needs an observed payment';
 end if;
 if purchase.kind<>'deposit' or purchase.snapshot->>'depositHoldId' is distinct from new.hold_id::text
  or purchase.snapshot->>'appointmentId' is distinct from contract.appointment_id::text
  or purchase.currency<>contract.currency
  or (new.purpose='initial' and contract.order_id is distinct from new.order_id)
  or (new.purpose<>'initial' and not exists(select 1 from commerce_deposit_requotes q
   where q.id=new.quote_id and q.hold_id=new.hold_id and q.request_cents=purchase.amount_cents
    and purchase.snapshot->>'depositQuoteId'=q.id::text)) then
  raise exception using errcode='23001',message='deposit payment request does not match its contract';
 end if;
 return new;
end $$;
create trigger deposit_request_guard before insert or update on commerce_deposit_requests for each row execute function gf_deposit_request_guard();
-- Keep the first-order association usable by old callers while projecting it into the full source list.
create function gf_deposit_initial_request() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if new.order_id is not null then
  insert into commerce_deposit_requests(order_id,org_id,location_id,hold_id,purpose,expires_at)
   values(new.order_id,new.org_id,new.location_id,new.id,'initial',new.expires_at) on conflict(order_id) do nothing;
 end if;
 return new;
end $$;
create trigger deposit_initial_request after insert or update of order_id on commerce_appointment_holds
 for each row execute function gf_deposit_initial_request();

-- A ticket may consume several original deposit payments. Each service source keeps that identity.
alter table payments add column deposit_commerce_payment_id uuid;
alter table payments add constraint payments_deposit_commerce_scope foreign key(deposit_commerce_payment_id,org_id,location_id)
 references commerce_payments(id,org_id,location_id);
update payments p set deposit_commerce_payment_id=cp.id from commerce_appointment_holds h join commerce_payments cp on cp.order_id=h.order_id
 where p.method='deposit' and p.deposit_hold_id=h.id;
create function gf_deposit_service_payment_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare source_id uuid;source_count integer;
begin
 if new.method<>'deposit' then
  if new.deposit_commerce_payment_id is not null then raise exception using errcode='23001',message='deposit source requires deposit method';end if;
  return new;
 end if;
 if new.deposit_commerce_payment_id is null then
  select count(*),min(p.id::text)::uuid into source_count,source_id from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id where r.hold_id=new.deposit_hold_id;
  if source_count<>1 then raise exception using errcode='23001',message='multiple deposits require an explicit payment source';end if;
  new.deposit_commerce_payment_id=source_id;
 end if;
 if not exists(select 1 from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id
  where r.hold_id=new.deposit_hold_id and p.id=new.deposit_commerce_payment_id and r.org_id=new.org_id and r.location_id=new.location_id) then
  raise exception using errcode='23001',message='service deposit source must belong to the reservation';
 end if;
 if tg_op='UPDATE' and row(new.deposit_hold_id,new.deposit_commerce_payment_id) is distinct from row(old.deposit_hold_id,old.deposit_commerce_payment_id) then
  raise exception using errcode='23001',message='service deposit source is immutable';
 end if;
 return new;
end $$;
create trigger deposit_service_payment_source before insert or update on payments for each row execute function gf_deposit_service_payment_source();

create function gf_deposit_ledger_payment_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare balance integer;paid integer;used integer;payment_status text;
begin
 perform id from commerce_appointment_holds where id=new.hold_id for update;
 select p.amount_cents,p.status into paid,payment_status from commerce_payments p join commerce_deposit_requests r on r.order_id=p.order_id
  where p.id=new.payment_id and r.hold_id=new.hold_id and p.org_id=new.org_id and p.location_id=new.location_id;
 if paid is null then raise exception using errcode='23001',message='deposit ledger requires an original payment source';end if;
 select coalesce(sum(amount_cents),0)::integer,-coalesce(sum(amount_cents) filter(where entry in('applied','restored') and ticket_id=new.ticket_id),0)::integer into balance,used
  from commerce_deposit_ledger where hold_id=new.hold_id and payment_id=new.payment_id;
 if balance+new.amount_cents<0 or balance+new.amount_cents>paid or (new.entry='collected' and new.amount_cents<>paid)
  or (new.entry='collected' and payment_status not in('paid','disputed'))
  or (new.entry='restored' and new.amount_cents>used) then
  raise exception using errcode='23001',message='deposit ledger exceeds its original payment source';
 end if;
 return new;
end $$;
create trigger deposit_ledger_payment_source before insert on commerce_deposit_ledger for each row execute function gf_deposit_ledger_payment_source();

alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in('checkout','refund','expire_checkout','notification','subscription_update','reconcile','expire_deposit','membership_grant','payout_scan','payout_reconcile','membership_change','membership_change_withdraw','expire_deposit_request'));

create or replace function gf_guest_refund_context_guard() returns trigger language plpgsql as $$
declare participant integer;
begin
 if new.guest_cancellation_id is null then return new; end if;
 select c.guest_index into participant from appointment_guest_cancellations c
   join commerce_appointment_holds h on h.appointment_id=c.appointment_id and h.org_id=c.org_id and h.location_id=c.location_id
   join commerce_deposit_requests dr on dr.hold_id=h.id join commerce_payments p on p.order_id=dr.order_id and p.id=new.payment_id
   where c.id=new.guest_cancellation_id and c.org_id=new.org_id and c.location_id=new.location_id;
 if participant is null or new.deposit_guest_allocation is null
    or jsonb_typeof(new.deposit_guest_allocation) is distinct from 'array'
    or jsonb_array_length(new.deposit_guest_allocation)<>1
    or (new.deposit_guest_allocation->0->>'guestIndex')::integer is distinct from participant then
  raise exception using errcode='23001',message='refund must reference the cancelled guest and original deposit payment';
 end if;
 return new;
end $$;

create or replace function gf_deposit_retention_guard() returns trigger language plpgsql as $$
begin
 if tg_op<>'INSERT' then
   if current_user='app_user' then raise exception using errcode='23001',message='deposit retention decisions are append-only'; end if;
   return old;
 end if;
 if not exists(select 1 from commerce_appointment_holds h join commerce_deposit_requests dr on dr.hold_id=h.id join commerce_payments p on p.order_id=dr.order_id
   where h.id=new.hold_id and h.org_id=new.org_id and h.location_id=new.location_id and p.id=new.payment_id
     and p.status='paid' and h.waived_at is null and not h.commerce_frozen
     and h.policy_snapshot->>'version'=new.policy_version and h.policy_snapshot->>'retainAfterCutoff'='true'
     and h.policy_snapshot->'consent'->>'accepted'='true') then
   raise exception using errcode='23001',message='retention requires the original paid deposit policy and consent';
 end if;
 return new;
end $$;

create or replace function gf_retention_release_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare original commerce_deposit_retentions;share jsonb;prior integer;maximum integer;
begin
 if tg_op<>'INSERT' then
  if current_user='app_user' then raise exception using errcode='23001',message='retention releases are append-only';end if;
  return old;
 end if;
 perform id from commerce_appointment_holds where id=new.hold_id for update;
 select * into original from commerce_deposit_retentions where id=new.retention_id;
 if original.id is null or row(original.org_id,original.location_id,original.hold_id,original.payment_id) is distinct from row(new.org_id,new.location_id,new.hold_id,new.payment_id)
  or not exists(select 1 from commerce_appointment_holds h join commerce_deposit_requests dr on dr.hold_id=h.id join commerce_payments p on p.id=new.payment_id and p.order_id=dr.order_id
   where h.id=new.hold_id and not h.commerce_frozen and h.waived_at is null and p.status='paid') then
  raise exception using errcode='23001',message='retention release requires original paid and unfrozen deposit';
 end if;
 select coalesce(sum(amount_cents),0)::integer into prior from commerce_deposit_retention_releases where retention_id=original.id;
 if new.amount_cents>original.amount_cents-prior then raise exception using errcode='23001',message='retention release exceeds original amount';end if;
 for share in select * from jsonb_array_elements(new.guest_allocation) loop
  select (g->>'amountCents')::integer into maximum from jsonb_array_elements(original.guest_allocation)g where g->>'guestIndex'=share->>'guestIndex';
  select coalesce(sum((g->>'amountCents')::integer),0)::integer into prior from commerce_deposit_retention_releases r,
   jsonb_array_elements(r.guest_allocation)g where r.retention_id=original.id and g->>'guestIndex'=share->>'guestIndex';
  if maximum is null or (share->>'amountCents')::integer>maximum-prior then raise exception using errcode='23001',message='retention release exceeds original guest share';end if;
 end loop;
 return new;
end $$;

-- One guest cancellation may return several original payments, once per source.
drop index guest_cancellation_refund_active;
create unique index guest_cancellation_refund_active on commerce_refunds(guest_cancellation_id,payment_id)
 where guest_cancellation_id is not null and status in('pending','review','succeeded');
