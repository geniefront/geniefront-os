-- Original settlement sources. Coverage cents and funded purchase value are distinct facts.
alter table ticket_refunds add column package_cents integer not null default 0 check(package_cents>=0);
alter table ticket_refunds drop constraint ticket_refunds_channels_match;
alter table ticket_refunds add constraint ticket_refunds_channels_match check(
 cash_cents+card_cents+gift_card_cents+customer_credit_cents+deposit_cents+membership_cents+package_cents=amount_cents);
create table ticket_settlement_sources(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 ticket_id uuid not null references tickets(id),source_key text not null,kind text not null check(kind in('cash','card','external','gift_card','store_credit','deposit','membership','package')),
 payment_id uuid references payments(id),credit_ledger_id uuid references customer_credit_ledger(id),
 membership_redemption_id uuid references customer_membership_ledger(id),package_redemption_id uuid references customer_package_ledger(id),
 amount_cents integer not null check(amount_cents>0),tip_cents integer not null default 0 check(tip_cents>=0 and tip_cents<=amount_cents),
 service_cents integer not null check(service_cents>=0),tax_cents integer not null default 0 check(tax_cents>=0),fee_cents integer not null default 0 check(fee_cents>=0),
 funded_value_cents integer check(funded_value_cents>=0),item_ids uuid[] not null default '{}',
 baseline_returned_cents integer not null default 0 check(baseline_returned_cents>=0 and baseline_returned_cents<=amount_cents),
 baseline_tip_cents integer not null default 0 check(baseline_tip_cents>=0 and baseline_tip_cents<=tip_cents and baseline_tip_cents<=baseline_returned_cents),
 baseline_service_cents integer not null default 0,baseline_tax_cents integer not null default 0,baseline_fee_cents integer not null default 0,
 created_at timestamptz not null default now(),unique(ticket_id,source_key),unique(id,org_id,location_id),
 check(service_cents+tax_cents+fee_cents+tip_cents=amount_cents),
 check(baseline_service_cents>=0 and baseline_service_cents<=service_cents and baseline_tax_cents>=0 and baseline_tax_cents<=tax_cents and baseline_fee_cents>=0 and baseline_fee_cents<=fee_cents),
 check(baseline_service_cents+baseline_tax_cents+baseline_fee_cents+baseline_tip_cents=baseline_returned_cents),
 check(num_nonnulls(payment_id,credit_ledger_id,membership_redemption_id,package_redemption_id)=1),
 check((kind in('cash','card','external','deposit') and payment_id is not null) or(kind in('gift_card','store_credit') and credit_ledger_id is not null)
  or(kind='membership' and membership_redemption_id is not null) or(kind='package' and package_redemption_id is not null)),
 check(kind in('cash','card','external') or tip_cents=0),
 check(kind not in('membership','package') or(tax_cents=0 and fee_cents=0))
);
create index ticket_sources_ticket on ticket_settlement_sources(ticket_id);
create table ticket_source_receipts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),ticket_id uuid not null references tickets(id),
 stage text not null check(stage in('service','tip','combined','legacy')),origin text not null check(origin in('checkout','legacy_projection')),
 total_cents integer not null check(total_cents>=0),tip_cents integer not null check(tip_cents>=0 and tip_cents<=total_cents),
 source_count integer not null check(source_count>=0),created_at timestamptz not null default now(),unique(ticket_id,stage)
);
create table ticket_source_refunds(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 ticket_refund_id uuid not null references ticket_refunds(id),source_id uuid not null,
 amount_cents integer not null check(amount_cents>0),tip_cents integer not null default 0 check(tip_cents>=0 and tip_cents<=amount_cents),
 service_cents integer not null check(service_cents>=0),tax_cents integer not null check(tax_cents>=0),fee_cents integer not null check(fee_cents>=0),
 destination text not null check(destination in('cash','card','gift_card','store_credit','deposit','membership','package')),
 check(service_cents+tax_cents+fee_cents+tip_cents=amount_cents),
 created_at timestamptz not null default now(),unique(ticket_refund_id,source_id),
 foreign key(source_id,org_id,location_id) references ticket_settlement_sources(id,org_id,location_id)
);
create index ticket_source_returns_source on ticket_source_refunds(source_id);
create function gf_ticket_source_guard() returns trigger language plpgsql as $$
declare t tickets;p payments;c customer_credit_ledger;m customer_membership_ledger;q customer_package_ledger;expected integer;ref uuid;
begin
 select * into t from tickets where id=new.ticket_id;
 if t.id is null or row(t.org_id,t.location_id) is distinct from row(new.org_id,new.location_id) then raise exception using errcode='23001',message='settlement source requires its scoped ticket';end if;
 if new.payment_id is not null then
  select * into p from payments where id=new.payment_id;ref:=p.id;expected:=p.amount_cents;
  if p.ticket_id is distinct from t.id or row(p.org_id,p.location_id) is distinct from row(new.org_id,new.location_id)
   or p.method<>new.kind or new.tip_cents<>p.tip_cents or new.funded_value_cents is distinct from p.amount_cents then raise exception using errcode='23001',message='payment source context mismatch';end if;
 elsif new.credit_ledger_id is not null then
  select * into c from customer_credit_ledger where id=new.credit_ledger_id;ref:=c.id;expected:=-c.amount_cents;
  if c.ticket_id is distinct from t.id or row(c.org_id,c.location_id) is distinct from row(new.org_id,new.location_id) or c.entry<>'redeem'
   or c.unit<>'cents' or c.kind<>new.kind then raise exception using errcode='23001',message='credit source context mismatch';end if;
 elsif new.membership_redemption_id is not null then
  select * into m from customer_membership_ledger where id=new.membership_redemption_id;ref:=m.id;expected:=m.covered_cents;
  if m.ticket_id is distinct from t.id or row(m.org_id,m.location_id) is distinct from row(new.org_id,new.location_id) or m.entry<>'redeem'
   or new.funded_value_cents is distinct from -m.value_cents or new.item_ids<>array[m.ticket_item_id] then raise exception using errcode='23001',message='membership source context mismatch';end if;
 else
  select * into q from customer_package_ledger where id=new.package_redemption_id;ref:=q.id;
  select coalesce(sum(total_cents),0)::integer into expected from ticket_items where id=any(new.item_ids) and ticket_id=t.id;
  if q.ticket_id is distinct from t.id or row(q.org_id,q.location_id) is distinct from row(new.org_id,new.location_id) or q.entry<>'redeem'
   or cardinality(new.item_ids)=0 or(new.funded_value_cents is not null and new.funded_value_cents<>-q.value_cents)
   or not exists(select 1 from customer_credit_ledger l where l.ticket_id=t.id and l.kind='package' and l.entry='redeem' and l.subject_id=q.package_id
      and l.meta->'ticketItemIds' @> to_jsonb(new.item_ids)
      and(case when l.meta ? 'unitApplications' then exists(select 1 from jsonb_array_elements(l.meta->'unitApplications')u
        where u->>'redemptionId'=q.id::text and u->'itemIds'=to_jsonb(new.item_ids))
       else q.quantity=-1 and l.meta->'ticketItemIds'=to_jsonb(new.item_ids) end)) then raise exception using errcode='23001',message='package source context mismatch';end if;
 end if;
 if ref is null or new.amount_cents<>expected or new.source_key<>new.kind||':'||ref::text
  or exists(select 1 from unnest(new.item_ids)i where not exists(select 1 from ticket_items x where x.id=i and x.ticket_id=t.id))
  or new.baseline_returned_cents-new.baseline_tip_cents>new.amount_cents-new.tip_cents then raise exception using errcode='23001',message='source must preserve original covered amounts';end if;
 return new;
end $$;
create trigger ticket_source_guard before insert on ticket_settlement_sources for each row execute function gf_ticket_source_guard();
create function gf_ticket_source_receipt_guard() returns trigger language plpgsql as $$
declare t tickets;n integer;amount integer;tips integer;taxes integer;fees integer;
begin
 select * into t from tickets where id=new.ticket_id;
 select count(*),coalesce(sum(amount_cents),0),coalesce(sum(tip_cents),0),coalesce(sum(tax_cents),0),coalesce(sum(fee_cents),0) into n,amount,tips,taxes,fees from ticket_settlement_sources where ticket_id=new.ticket_id;
 if t.id is null or row(t.org_id,t.location_id) is distinct from row(new.org_id,new.location_id) or new.total_cents<>t.total_cents
  or new.tip_cents<>t.tip_cents or new.source_count<>n or amount<>new.total_cents or tips<>new.tip_cents or taxes<>t.tax_cents or fees<>t.surcharge_cents+t.service_charge_cents then raise exception using errcode='23001',message='complete settlement source receipt required';end if;
 return new;
end $$;
create trigger ticket_source_receipt_guard before insert on ticket_source_receipts for each row execute function gf_ticket_source_receipt_guard();
create function gf_ticket_source_refund_guard() returns trigger language plpgsql as $$
declare s ticket_settlement_sources;r ticket_refunds;amount integer;tips integer;dest integer;allocated integer;services integer;taxes integer;fees integer;
begin
 select * into s from ticket_settlement_sources where id=new.source_id;
 perform 1 from tickets where id=s.ticket_id for update;
 select * into r from ticket_refunds where id=new.ticket_refund_id;
 select coalesce(sum(amount_cents),0),coalesce(sum(tip_cents),0),coalesce(sum(service_cents),0),coalesce(sum(tax_cents),0),coalesce(sum(fee_cents),0) into amount,tips,services,taxes,fees from ticket_source_refunds where source_id=s.id;
 dest:=case new.destination when 'cash' then r.cash_cents when 'card' then r.card_cents when 'gift_card' then r.gift_card_cents when 'store_credit' then r.customer_credit_cents when 'deposit' then r.deposit_cents when 'membership' then r.membership_cents else r.package_cents end;
 select coalesce(sum(amount_cents),0) into allocated from ticket_source_refunds where ticket_refund_id=r.id and destination=new.destination;
 if s.id is null or r.id is null or s.ticket_id<>r.ticket_id or row(r.org_id,r.location_id) is distinct from row(new.org_id,new.location_id)
  or s.baseline_returned_cents+amount+new.amount_cents>s.amount_cents or s.baseline_tip_cents+tips+new.tip_cents>s.tip_cents
  or s.baseline_returned_cents-s.baseline_tip_cents+amount-tips+new.amount_cents-new.tip_cents>s.amount_cents-s.tip_cents
  or s.baseline_service_cents+services+new.service_cents>s.service_cents or s.baseline_tax_cents+taxes+new.tax_cents>s.tax_cents or s.baseline_fee_cents+fees+new.fee_cents>s.fee_cents
  or allocated+new.amount_cents>dest or(s.kind not in('cash','card','external') and new.destination<>s.kind)
  or(s.kind in('cash','card','external') and new.destination not in('cash','card','store_credit')) then raise exception using errcode='23001',message='source refund exceeds or changes original allocation';end if;
 return new;
end $$;
create trigger ticket_source_refund_guard before insert on ticket_source_refunds for each row execute function gf_ticket_source_refund_guard();
create function gf_ticket_refund_sources_complete() returns trigger language plpgsql as $$
declare rid uuid;r ticket_refunds;amount integer;tips integer;services integer;taxes integer;fees integer;
begin
 if tg_table_name='ticket_refunds' then rid:=new.id;else rid:=new.ticket_refund_id;end if;
 select * into r from ticket_refunds where id=rid;
 if exists(select 1 from ticket_source_receipts where ticket_id=r.ticket_id) then
  select coalesce(sum(amount_cents),0),coalesce(sum(tip_cents),0),coalesce(sum(service_cents),0),coalesce(sum(tax_cents),0),coalesce(sum(fee_cents),0) into amount,tips,services,taxes,fees from ticket_source_refunds where ticket_refund_id=rid;
  if amount<>r.amount_cents or tips<>r.tip_cents or services<>r.service_cents or taxes<>r.tax_cents or fees<>r.fee_cents then raise exception using errcode='23001',message='refund must return all original sources exactly once';end if;
 end if;return null;
end $$;
create constraint trigger refund_sources_complete after insert on ticket_refunds deferrable initially deferred for each row execute function gf_ticket_refund_sources_complete();
create constraint trigger source_returns_complete after insert on ticket_source_refunds deferrable initially deferred for each row execute function gf_ticket_refund_sources_complete();
do $$declare n text;begin
 foreach n in array array['ticket_settlement_sources','ticket_source_receipts','ticket_source_refunds'] loop
  execute format('alter table %I enable row level security',n);execute format('alter table %I force row level security',n);
  execute format('create policy tenant_isolation on %I to app_user using(org_id=app_org_id() and location_id=app_location_id()) with check(org_id=app_org_id() and location_id=app_location_id())',n);
  execute format('revoke all on %I from public,anon,authenticated,app_user',n);execute format('grant select,insert on %I to app_user',n);
  execute format('create trigger immutable_source before update or delete on %I for each row execute function gf_ccl_append_only()',n);
 end loop;
end $$;
-- Returned usage after expiry or full purchase refund remains unavailable, with an explicit reversal.
alter table customer_package_ledger drop constraint customer_package_ledger_entry_check;
alter table customer_package_ledger add constraint customer_package_ledger_entry_check check(entry in('issue','redeem','restore','purchase_refund','legacy_opening','expire'));
