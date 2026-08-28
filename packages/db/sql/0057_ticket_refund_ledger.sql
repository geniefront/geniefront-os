-- 0057: immutable ticket refund ledger
--
-- tickets.refund_cents is a convenient cumulative snapshot, but it cannot answer
-- which channel returned the money, which part was service/tax/tip, or whether two
-- partial refunds happened. ticket_refunds is the append-only accounting source.

alter table customer_credit_ledger
  drop constraint if exists customer_credit_ledger_kind_check;
alter table customer_credit_ledger
  add constraint customer_credit_ledger_kind_check
  check (kind in ('gift_card','package','points','coupon','store_credit'));

create table if not exists ticket_refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  ticket_id uuid not null references tickets(id),
  business_date date not null,
  amount_cents integer not null check (amount_cents > 0),
  service_cents integer not null default 0 check (service_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  fee_cents integer not null default 0 check (fee_cents >= 0),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  cash_cents integer not null default 0 check (cash_cents >= 0),
  card_cents integer not null default 0 check (card_cents >= 0),
  store_credit_cents integer not null default 0 check (store_credit_cents >= 0),
  method text not null check (method in ('original_payment', 'cash', 'store_credit')),
  reason text not null check (
    reason in ('customer_dissatisfied', 'wrong_charge', 'accidental_duplicate', 'other')
  ),
  notes text,
  refunded_by uuid references memberships(id),
  created_at timestamptz not null default now(),
  constraint ticket_refunds_components_match check (
    service_cents + tax_cents + fee_cents + tip_cents = amount_cents
  ),
  constraint ticket_refunds_channels_match check (
    cash_cents + card_cents + store_credit_cents = amount_cents
  )
);

create index if not exists ticket_refunds_ticket_idx on ticket_refunds(ticket_id);
create index if not exists ticket_refunds_tenant_idx on ticket_refunds(org_id, location_id);
create index if not exists ticket_refunds_actor_idx on ticket_refunds(refunded_by);
create index if not exists ticket_refunds_day_idx
  on ticket_refunds(location_id, business_date, created_at);

-- Backfill the old cumulative snapshot before making the ledger immutable.
-- Historical rows did not retain an exact split for mixed tenders. Preserve the
-- auditable amounts by consuming available cash, then card, then stored value;
-- all newly created refunds use proportional largest-remainder allocation.
with paid as (
  select t.id as ticket_id,
         coalesce(sum(p.amount_cents) filter (where p.method = 'cash'), 0)::int as cash_paid,
         coalesce(sum(p.amount_cents) filter (where p.method in ('card','external')), 0)::int as card_paid
  from tickets t left join payments p on p.ticket_id = t.id
  where t.refund_cents > 0
  group by t.id
), component as (
  select t.*,
         least(t.refund_cents, greatest(t.subtotal_cents - t.discount_cents, 0))::int as service_part
  from tickets t where t.refund_cents > 0
    and not exists (select 1 from ticket_refunds tr where tr.ticket_id = t.id)
), component2 as (
  select c.*,
         least(c.refund_cents - c.service_part, c.tax_cents)::int as tax_part
  from component c
), component3 as (
  select c.*,
         least(c.refund_cents - c.service_part - c.tax_part,
               c.surcharge_cents + c.service_charge_cents)::int as fee_part
  from component2 c
), channel as (
  select c.*, p.cash_paid, p.card_paid,
         case when c.refund_method = 'cash' then c.refund_cents
              when c.refund_method = 'store_credit' then 0
              else least(c.refund_cents, p.cash_paid) end::int as cash_part
  from component3 c join paid p on p.ticket_id = c.id
), channel2 as (
  select c.*,
         case when c.refund_method in ('cash','store_credit') then 0
              else least(c.refund_cents - c.cash_part, c.card_paid) end::int as card_part
  from channel c
)
insert into ticket_refunds
  (org_id, location_id, ticket_id, business_date, amount_cents,
   service_cents, tax_cents, fee_cents, tip_cents,
   cash_cents, card_cents, store_credit_cents,
   method, reason, notes, refunded_by, created_at)
select org_id, location_id, id, business_date, refund_cents,
       service_part, tax_part, fee_part,
       refund_cents - service_part - tax_part - fee_part,
       cash_part, card_part, refund_cents - cash_part - card_part,
       case when refund_method in ('original_payment','cash','store_credit')
            then refund_method else 'original_payment' end,
       case when refund_reason in ('customer_dissatisfied','wrong_charge','accidental_duplicate','other')
            then refund_reason else 'other' end,
       'Backfilled from tickets.refund_cents by migration 0057', refunded_by,
       coalesce(refunded_at, now())
from channel2;

-- Attribute historical store-credit refunds when the original ticket had a
-- customer. Anonymous historical refunds remain visible in ticket_refunds but
-- cannot safely be invented into a customer's balance.
with existing as (
  select customer_id, coalesce(sum(amount_cents), 0)::int as balance
  from customer_credit_ledger
  where kind = 'store_credit' and customer_id is not null
  group by customer_id
), rows as (
  select tr.*, t.customer_id,
         coalesce(e.balance, 0)::int as opening_balance,
         sum(tr.store_credit_cents) over (
           partition by t.customer_id order by tr.created_at, tr.id
         )::int as running_credit
  from ticket_refunds tr
  join tickets t on t.id = tr.ticket_id
  left join existing e on e.customer_id = t.customer_id
  where tr.store_credit_cents > 0 and tr.method = 'store_credit'
    and t.customer_id is not null
    and tr.notes = 'Backfilled from tickets.refund_cents by migration 0057'
)
insert into customer_credit_ledger
  (org_id, location_id, kind, subject_id, customer_id, entry,
   amount_cents, balance_after_cents, ticket_id, reason,
   actor_membership_id, idem_key, meta, created_at)
select org_id, location_id, 'store_credit', customer_id, customer_id, 'refund',
       store_credit_cents, opening_balance + running_credit, ticket_id,
       'Backfilled ticket refund', refunded_by, 'ticket-refund-' || id::text,
       jsonb_build_object('refundId', id, 'backfilled', true), created_at
from rows
on conflict (location_id, idem_key) where idem_key is not null do nothing;

-- Original-payment refunds that came from gift cards go back to those exact
-- cards. Historical mixed-card allocation is deterministic (card id order)
-- because the old snapshot did not retain per-card refund details.
with redemptions as (
  select tr.id as refund_id, tr.org_id, tr.location_id, tr.ticket_id,
         tr.reason, tr.refunded_by, tr.created_at, tr.store_credit_cents,
         ccl.subject_id as gift_card_id, -sum(ccl.amount_cents)::int as redeemed
  from ticket_refunds tr
  join customer_credit_ledger ccl on ccl.ticket_id = tr.ticket_id
    and ccl.kind = 'gift_card' and ccl.entry = 'redeem'
  where tr.method = 'original_payment' and tr.store_credit_cents > 0
    and tr.notes = 'Backfilled from tickets.refund_cents by migration 0057'
  group by tr.id, tr.org_id, tr.location_id, tr.ticket_id, tr.reason,
           tr.refunded_by, tr.created_at, tr.store_credit_cents, ccl.subject_id
), allocated as (
  select r.*,
         greatest(0, least(
           r.redeemed,
           r.store_credit_cents - coalesce(sum(r.redeemed) over (
             partition by r.refund_id order by r.gift_card_id
             rows between unbounded preceding and 1 preceding
           ), 0)
         ))::int as amount
  from redemptions r
), card_base as (
  select subject_id as gift_card_id, sum(amount_cents)::int as balance
  from customer_credit_ledger where kind = 'gift_card' group by subject_id
), rows as (
  select a.*, coalesce(cb.balance, 0)::int
         + sum(a.amount) over (
             partition by a.gift_card_id order by a.created_at, a.refund_id
           )::int as balance_after
  from allocated a left join card_base cb using (gift_card_id)
  where a.amount > 0
)
insert into customer_credit_ledger
  (org_id, location_id, kind, subject_id, entry, amount_cents,
   balance_after_cents, ticket_id, reason, actor_membership_id,
   idem_key, meta, created_at)
select org_id, location_id, 'gift_card', gift_card_id, 'refund', amount,
       balance_after, ticket_id, reason, refunded_by,
       'ticket-refund-' || refund_id::text || '-' || gift_card_id::text,
       jsonb_build_object('ticketRefund', true, 'refundId', refund_id, 'backfilled', true),
       created_at
from rows
on conflict (location_id, idem_key) where idem_key is not null do nothing;

update gift_cards gc
set balance_cents = balances.balance,
    status = case when balances.balance > 0 then 'active' else gc.status end,
    updated_at = now()
from (
  select subject_id, sum(amount_cents)::int as balance
  from customer_credit_ledger where kind = 'gift_card' group by subject_id
) balances
where gc.id = balances.subject_id;

insert into cash_movements
  (org_id, location_id, business_date, kind, amount_cents, note, actor_id, at)
select tr.org_id, tr.location_id, tr.business_date, 'refund', -tr.cash_cents,
       'Refund ' || tr.id::text, tr.refunded_by, tr.created_at
from ticket_refunds tr
where tr.cash_cents > 0
  and tr.notes = 'Backfilled from tickets.refund_cents by migration 0057'
  and not exists (
    select 1 from cash_movements cm where cm.note = 'Refund ' || tr.id::text
  );

alter table ticket_refunds enable row level security;
alter table ticket_refunds force row level security;
drop policy if exists tenant_isolation on ticket_refunds;
create policy tenant_isolation on ticket_refunds
  using (org_id = app_org_id() and location_id = app_location_id())
  with check (org_id = app_org_id() and location_id = app_location_id());

revoke all on table ticket_refunds from public, anon, authenticated, app_user;
grant select, insert on table ticket_refunds to app_user;

create or replace function ticket_refunds_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'ticket_refunds is append-only (attempted %)', tg_op
    using errcode = 'restrict_violation';
end $$;

revoke all on function ticket_refunds_immutable() from public, anon, authenticated;
grant execute on function ticket_refunds_immutable() to app_user;

drop trigger if exists ticket_refunds_no_change on ticket_refunds;
create trigger ticket_refunds_no_change
  before update or delete on ticket_refunds
  for each row execute function ticket_refunds_immutable();
