-- Frozen execution-item amounts and original-source return graph. New writes never reinterpret current catalog/tax/payroll rules.
alter table tickets add column settlement_tax_mode text check(settlement_tax_mode in('inclusive','exclusive'));
alter table tickets add column settlement_tax_rate_percent numeric(8,4) check(settlement_tax_rate_percent>=0 and settlement_tax_rate_percent<=100);
create table ticket_item_settlements(
 ticket_item_id uuid primary key references ticket_items(id),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),ticket_id uuid not null references tickets(id),
 original_cents integer not null check(original_cents>=0),discount_cents integer not null check(discount_cents>=0 and discount_cents<=original_cents),
 service_cents integer not null check(service_cents>=0),tax_cents integer not null check(tax_cents>=0),fee_cents integer not null check(fee_cents>=0),
 tax_mode text not null check(tax_mode in('inclusive','exclusive')),created_at timestamptz not null default now(),unique(ticket_item_id,org_id,location_id),
 check(service_cents=original_cents-discount_cents-case when tax_mode='inclusive' then tax_cents else 0 end)
);
create index item_settlements_ticket on ticket_item_settlements(ticket_id);
create table ticket_item_source_allocations(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 source_id uuid not null,ticket_item_id uuid not null,service_cents integer not null check(service_cents>=0),tax_cents integer not null check(tax_cents>=0),fee_cents integer not null check(fee_cents>=0),
 created_at timestamptz not null default now(),unique(source_id,ticket_item_id),unique(id,org_id,location_id),check(service_cents+tax_cents+fee_cents>0),
 foreign key(source_id,org_id,location_id) references ticket_settlement_sources(id,org_id,location_id),foreign key(ticket_item_id,org_id,location_id) references ticket_item_settlements(ticket_item_id,org_id,location_id)
);
create index item_sources_item on ticket_item_source_allocations(ticket_item_id);
create table ticket_item_source_returns(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 ticket_refund_id uuid not null references ticket_refunds(id),source_id uuid not null,allocation_id uuid not null,
 service_cents integer not null check(service_cents>=0),tax_cents integer not null check(tax_cents>=0),fee_cents integer not null check(fee_cents>=0),created_at timestamptz not null default now(),
 check(service_cents+tax_cents+fee_cents>0),unique(ticket_refund_id,allocation_id),
 foreign key(ticket_refund_id,source_id) references ticket_source_refunds(ticket_refund_id,source_id),foreign key(allocation_id,org_id,location_id) references ticket_item_source_allocations(id,org_id,location_id)
);
create index item_source_returns_allocation on ticket_item_source_returns(allocation_id);
create table ticket_item_commission_sources(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),earning_id uuid not null references earnings(id),
 ticket_item_id uuid not null,membership_id uuid not null references memberships(id),base_cents integer not null check(base_cents>=0),amount_cents integer not null check(amount_cents>=0),rate_bp integer not null check(rate_bp>=0 and rate_bp<=10000),
 created_at timestamptz not null default now(),unique(earning_id,ticket_item_id),unique(id,org_id,location_id),
 foreign key(ticket_item_id,org_id,location_id) references ticket_item_settlements(ticket_item_id,org_id,location_id)
);
create index item_commission_sources_item on ticket_item_commission_sources(ticket_item_id);
create table ticket_item_commission_returns(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),ticket_refund_id uuid not null references ticket_refunds(id),commission_source_id uuid not null,
 base_cents integer not null check(base_cents>=0),amount_cents integer not null check(amount_cents>=0),created_at timestamptz not null default now(),
 check(base_cents+amount_cents>0),unique(ticket_refund_id,commission_source_id),foreign key(commission_source_id,org_id,location_id) references ticket_item_commission_sources(id,org_id,location_id)
);
create index item_commission_returns_source on ticket_item_commission_returns(commission_source_id);
create table ticket_item_graph_receipts(
 ticket_id uuid primary key references tickets(id),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 origin text not null check(origin in('checkout','legacy_projection')),version integer not null default 1 check(version=1),item_count integer not null check(item_count>=0),allocation_count integer not null check(allocation_count>=0),commission_count integer not null check(commission_count>=0),created_at timestamptz not null default now()
);
create function gf_ticket_item_settlement_guard() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare i ticket_items;t tickets;discount integer;
begin
 select * into i from ticket_items where id=new.ticket_item_id;select * into t from tickets where id=i.ticket_id;
 select coalesce(sum(discount_cents),0)::integer into discount from ticket_price_adjustments where ticket_item_id=i.id;
 if i.id is null or t.id is null or new.ticket_id<>t.id or row(t.org_id,t.location_id) is distinct from row(new.org_id,new.location_id) or new.original_cents<>i.total_cents or new.discount_cents<>discount
  or(t.settlement_tax_mode is not null and new.tax_mode<>t.settlement_tax_mode) then raise exception using errcode='23001',message='item settlement must preserve original item and price adjustments';end if;
 return new;
end $$;
create trigger item_settlement_context before insert on ticket_item_settlements for each row execute function gf_ticket_item_settlement_guard();
create function gf_ticket_item_allocation_guard() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare s ticket_settlement_sources;i ticket_item_settlements;service integer;tax integer;fee integer;
begin
 select * into s from ticket_settlement_sources where id=new.source_id;select * into i from ticket_item_settlements where ticket_item_id=new.ticket_item_id;
 perform 1 from tickets where id=s.ticket_id for update;
 select coalesce(sum(service_cents),0)::integer,coalesce(sum(tax_cents),0)::integer,coalesce(sum(fee_cents),0)::integer into service,tax,fee from ticket_item_source_allocations where source_id=s.id;
 if s.id is null or i.ticket_item_id is null or s.ticket_id<>i.ticket_id or row(s.org_id,s.location_id) is distinct from row(new.org_id,new.location_id)
  or service+new.service_cents>s.service_cents or tax+new.tax_cents>s.tax_cents or fee+new.fee_cents>s.fee_cents
  or(s.kind in('package','membership') and(not(new.ticket_item_id=any(s.item_ids)) or new.tax_cents<>0 or new.fee_cents<>0)) then raise exception using errcode='23001',message='item allocation exceeds or changes original source';end if;
 select coalesce(sum(service_cents),0)::integer,coalesce(sum(tax_cents),0)::integer,coalesce(sum(fee_cents),0)::integer into service,tax,fee from ticket_item_source_allocations where ticket_item_id=i.ticket_item_id;
 if service+new.service_cents>i.service_cents or tax+new.tax_cents>i.tax_cents or fee+new.fee_cents>i.fee_cents then raise exception using errcode='23001',message='item allocation exceeds original item';end if;
 return new;
end $$;
create trigger item_allocation_context before insert on ticket_item_source_allocations for each row execute function gf_ticket_item_allocation_guard();
create function gf_ticket_item_commission_guard() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare e earnings;i ticket_item_settlements;line jsonb;
begin
 select * into e from earnings where id=new.earning_id;select * into i from ticket_item_settlements where ticket_item_id=new.ticket_item_id;
 select x into line from jsonb_array_elements(coalesce(e.basis->'itemLines','[]'::jsonb))x where x->>'ticketItemId'=new.ticket_item_id::text;
 if e.id is null or i.ticket_item_id is null or e.ticket_id<>i.ticket_id or row(e.org_id,e.location_id) is distinct from row(new.org_id,new.location_id) or e.kind<>'commission' or e.reversed_at is not null
  or new.membership_id<>e.membership_id or e.amount_cents<0 or e.base_cents<0 then raise exception using errcode='23001',message='item commission must preserve original earning';end if;
 if line is null then
  if (select count(*) from ticket_items where ticket_id=e.ticket_id)<>1 or new.base_cents<>e.base_cents or new.amount_cents<>e.amount_cents or new.rate_bp<>coalesce((e.basis->>'rateBp')::integer,0)
   then raise exception using errcode='23001',message='historical item commission requires review';end if;
 elsif new.base_cents<>(line->>'baseCents')::integer or new.amount_cents<>(line->>'amountCents')::integer or new.rate_bp<>(line->>'rateBp')::integer then raise exception using errcode='23001',message='item commission must match immutable original item lines';end if;
 return new;
end $$;
create trigger item_commission_context before insert on ticket_item_commission_sources for each row execute function gf_ticket_item_commission_guard();
create function gf_ticket_item_graph_seal() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare t tickets;items integer;allocations integer;commissions integer;discount integer;service integer;tax integer;fee integer;
begin
 select * into t from tickets where id=new.ticket_id for update;
 select count(*),coalesce(sum(discount_cents),0)::integer,coalesce(sum(service_cents),0)::integer,coalesce(sum(tax_cents),0)::integer,coalesce(sum(fee_cents),0)::integer into items,discount,service,tax,fee from ticket_item_settlements where ticket_id=t.id;
 select count(*) into allocations from ticket_item_source_allocations a join ticket_settlement_sources s on s.id=a.source_id where s.ticket_id=t.id;
 select count(*) into commissions from ticket_item_commission_sources c join earnings e on e.id=c.earning_id where e.ticket_id=t.id;
 if t.id is null or row(t.org_id,t.location_id) is distinct from row(new.org_id,new.location_id) or new.item_count<>items or new.allocation_count<>allocations or new.commission_count<>commissions
  or items<>(select count(*) from ticket_items where ticket_id=t.id) or discount<>t.discount_cents or tax<>t.tax_cents or fee<>t.surcharge_cents+t.service_charge_cents or service+tax+fee<>t.total_cents-t.tip_cents
  or exists(select 1 from ticket_settlement_sources s where s.ticket_id=t.id and row(s.service_cents,s.tax_cents,s.fee_cents) is distinct from(select row(coalesce(sum(a.service_cents),0)::integer,coalesce(sum(a.tax_cents),0)::integer,coalesce(sum(a.fee_cents),0)::integer) from ticket_item_source_allocations a where a.source_id=s.id))
  or exists(select 1 from ticket_item_settlements i where i.ticket_id=t.id and row(i.service_cents,i.tax_cents,i.fee_cents) is distinct from(select row(coalesce(sum(a.service_cents),0)::integer,coalesce(sum(a.tax_cents),0)::integer,coalesce(sum(a.fee_cents),0)::integer) from ticket_item_source_allocations a where a.ticket_item_id=i.ticket_item_id))
  or exists(select 1 from earnings e where e.ticket_id=t.id and e.kind='commission' and e.amount_cents>=0 and e.base_cents>=0 and e.reversed_at is null and row(e.base_cents,e.amount_cents) is distinct from(select row(coalesce(sum(c.base_cents),0)::integer,coalesce(sum(c.amount_cents),0)::integer) from ticket_item_commission_sources c where c.earning_id=e.id))
  then raise exception using errcode='23001',message='complete original item graph required';end if;
 if exists(select 1 from ticket_item_source_allocations a join ticket_settlement_sources s on s.id=a.source_id where s.ticket_id=t.id and s.kind in('package','membership') and a.service_cents>0
  and exists(select 1 from ticket_item_source_allocations b join ticket_settlement_sources other on other.id=b.source_id where b.ticket_item_id=a.ticket_item_id and b.service_cents>0 and b.source_id<>a.source_id)) then raise exception using errcode='23001',message='quota item service cannot be covered twice';end if;
 return new;
end $$;
create trigger item_graph_complete before insert on ticket_item_graph_receipts for each row execute function gf_ticket_item_graph_seal();
create function gf_ticket_item_return_guard() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare a ticket_item_source_allocations;s ticket_settlement_sources;r ticket_refunds;service integer;tax integer;fee integer;
begin
 select * into a from ticket_item_source_allocations where id=new.allocation_id;select * into s from ticket_settlement_sources where id=a.source_id;select * into r from ticket_refunds where id=new.ticket_refund_id;
 perform 1 from tickets where id=s.ticket_id for update;
 select coalesce(sum(service_cents),0)::integer,coalesce(sum(tax_cents),0)::integer,coalesce(sum(fee_cents),0)::integer into service,tax,fee from ticket_item_source_returns where allocation_id=a.id;
 if a.id is null or r.id is null or new.source_id<>a.source_id or r.ticket_id<>s.ticket_id or row(r.org_id,r.location_id) is distinct from row(new.org_id,new.location_id)
  or service+new.service_cents>a.service_cents or tax+new.tax_cents>a.tax_cents or fee+new.fee_cents>a.fee_cents then raise exception using errcode='23001',message='item return exceeds or changes original allocation';end if;
 return new;
end $$;
create trigger item_return_context before insert on ticket_item_source_returns for each row execute function gf_ticket_item_return_guard();
create function gf_ticket_item_commission_return_guard() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare c ticket_item_commission_sources;r ticket_refunds;i ticket_item_settlements;amount integer;base integer;
begin
 select * into c from ticket_item_commission_sources where id=new.commission_source_id;select * into i from ticket_item_settlements where ticket_item_id=c.ticket_item_id;select * into r from ticket_refunds where id=new.ticket_refund_id;
 perform 1 from tickets where id=i.ticket_id for update;
 select coalesce(sum(amount_cents),0)::integer,coalesce(sum(base_cents),0)::integer into amount,base from ticket_item_commission_returns where commission_source_id=c.id;
 if c.id is null or r.id is null or r.ticket_id<>i.ticket_id or row(r.org_id,r.location_id) is distinct from row(new.org_id,new.location_id) or amount+new.amount_cents>c.amount_cents or base+new.base_cents>c.base_cents
  then raise exception using errcode='23001',message='commission return exceeds original item earning';end if;
 return new;
end $$;
create trigger item_commission_return_context before insert on ticket_item_commission_returns for each row execute function gf_ticket_item_commission_return_guard();
create function gf_ticket_item_refund_complete() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
declare refund uuid;r ticket_refunds;
begin
 if tg_table_name='ticket_refunds' then refund:=new.id;else refund:=new.ticket_refund_id;end if;
 select * into r from ticket_refunds where id=refund;
 if not exists(select 1 from ticket_item_graph_receipts where ticket_id=r.ticket_id) then return new;end if;
 if exists(select 1 from ticket_source_refunds s where s.ticket_refund_id=refund and row(s.service_cents,s.tax_cents,s.fee_cents) is distinct from(select row(coalesce(sum(i.service_cents),0)::integer,coalesce(sum(i.tax_cents),0)::integer,coalesce(sum(i.fee_cents),0)::integer) from ticket_item_source_returns i where i.ticket_refund_id=refund and i.source_id=s.source_id))
  or exists(select 1 from ticket_item_commission_returns c join ticket_item_commission_sources s on s.id=c.commission_source_id where c.ticket_refund_id=refund and not exists(select 1 from earnings e where e.ticket_id=r.ticket_id and e.membership_id=s.membership_id and e.kind='commission' and e.basis->>'refundId'=refund::text and e.basis->>'itemSourceGraph'='true'))
  or exists(select 1 from earnings e where e.ticket_id=r.ticket_id and e.kind='commission' and e.basis->>'refundId'=refund::text and e.basis->>'itemSourceGraph'='true' and row(-e.base_cents,-e.amount_cents) is distinct from(select row(coalesce(sum(c.base_cents),0)::integer,coalesce(sum(c.amount_cents),0)::integer) from ticket_item_commission_returns c join ticket_item_commission_sources s on s.id=c.commission_source_id where c.ticket_refund_id=refund and s.membership_id=e.membership_id))
  or exists(select 1 from ticket_item_settlements i
   cross join lateral(select coalesce(sum(ret.service_cents),0)::numeric as amount from ticket_item_source_returns ret join ticket_item_source_allocations a on a.id=ret.allocation_id where a.ticket_item_id=i.ticket_item_id) used
   cross join lateral(select coalesce(sum(base_cents),0)::numeric as base,coalesce(sum(amount_cents),0)::numeric as amount from ticket_item_commission_sources where ticket_item_id=i.ticket_item_id) original
   cross join lateral(select coalesce(sum(ret.base_cents),0)::numeric as base,coalesce(sum(ret.amount_cents),0)::numeric as amount from ticket_item_commission_returns ret join ticket_item_commission_sources s on s.id=ret.commission_source_id where s.ticket_item_id=i.ticket_item_id) returned
   where i.ticket_id=r.ticket_id and(row(returned.base,returned.amount) is distinct from row(
    case when i.service_cents=0 then 0::numeric else round(original.base*used.amount/i.service_cents) end,
    case when i.service_cents=0 then 0::numeric else round(original.amount*used.amount/i.service_cents) end)))
  then raise exception using errcode='23001',message='complete original item return and commission ledger required';end if;
 return new;
end $$;
create constraint trigger item_refund_complete after insert on ticket_refunds deferrable initially deferred for each row execute function gf_ticket_item_refund_complete();
create constraint trigger item_return_complete after insert on ticket_item_source_returns deferrable initially deferred for each row execute function gf_ticket_item_refund_complete();
create constraint trigger item_commission_return_complete after insert on ticket_item_commission_returns deferrable initially deferred for each row execute function gf_ticket_item_refund_complete();
do $$declare name text;begin
 foreach name in array array['ticket_item_settlements','ticket_item_source_allocations','ticket_item_source_returns','ticket_item_commission_sources','ticket_item_commission_returns','ticket_item_graph_receipts'] loop
  execute format('alter table %I enable row level security',name);execute format('alter table %I force row level security',name);
  execute format('create policy tenant_isolation on %I to app_user using(org_id=app_org_id() and location_id=app_location_id()) with check(org_id=app_org_id() and location_id=app_location_id())',name);
  execute format('revoke all on %I from public,anon,authenticated,app_user',name);execute format('grant select,insert on %I to app_user',name);
  execute format('create trigger immutable_item_fact before update or delete on %I for each row execute function gf_ccl_append_only()',name);
 end loop;
end $$;
