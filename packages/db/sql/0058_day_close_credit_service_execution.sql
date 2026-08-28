-- 0058: auditable close/reopen, customer store credit, service notes and room cleaning

alter table walkin_queue drop constraint if exists walkin_queue_status;
alter table walkin_queue add constraint walkin_queue_status
  check (status in ('waiting','called','seated','completed','left'));

alter table day_closes drop constraint if exists day_close_status_valid;
alter table day_closes add constraint day_close_status_valid
  check (status in ('open','counted','closed','reopened','no_business','paper_only','summary_only'));

-- ── Immutable day-close facts ──────────────────────────────────────────────
create table if not exists day_close_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  day_close_id uuid not null references day_closes(id),
  business_date date not null,
  generation integer not null check (generation > 0),
  event_type text not null check (event_type in ('closed', 'reopened')),
  snapshot jsonb not null default '{}'::jsonb,
  reason text,
  actor_membership_id uuid not null references memberships(id),
  idem_key text,
  created_at timestamptz not null default now(),
  unique (day_close_id, generation, event_type),
  check (event_type <> 'reopened' or length(btrim(reason)) >= 2)
);

create index if not exists day_close_events_day_idx
  on day_close_events(location_id, business_date, created_at);
create index if not exists day_close_events_actor_idx
  on day_close_events(actor_membership_id, created_at);
create unique index if not exists day_close_events_idem_idx
  on day_close_events(location_id, idem_key) where idem_key is not null;

alter table day_closes add column if not exists close_generation integer not null default 0;
alter table day_closes add column if not exists reopened_by uuid references memberships(id);
alter table day_closes add column if not exists reopened_at timestamptz;
alter table day_closes add column if not exists reopen_reason text;

alter table day_close_events enable row level security;
alter table day_close_events force row level security;
drop policy if exists tenant_isolation on day_close_events;
create policy tenant_isolation on day_close_events
  using (org_id = app_org_id() and location_id = app_location_id())
  with check (org_id = app_org_id() and location_id = app_location_id());
revoke all on table day_close_events from public, anon, authenticated, app_user;
grant select, insert on table day_close_events to app_user;

create or replace function immutable_financial_event() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is append-only (attempted %)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;
revoke all on function immutable_financial_event() from public, anon, authenticated;
grant execute on function immutable_financial_event() to app_user;

drop trigger if exists day_close_events_no_change on day_close_events;
create trigger day_close_events_no_change before update or delete on day_close_events
  for each row execute function immutable_financial_event();

-- Every business write takes a shared lock on the day row. Finalize takes the
-- conflicting UPDATE lock, so a close cannot race past a payment/refund/service
-- write and a writer waiting behind close observes status=closed and fails.
create or replace function assert_business_day_writable(p_location uuid, p_date date)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare v_status text;
begin
  if p_location is null or p_date is null then return; end if;
  select status into v_status from day_closes
   where location_id = p_location and business_date = p_date
   for share;
  if v_status = 'closed' then
    raise exception 'business day % is closed', p_date
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;
revoke all on function assert_business_day_writable(uuid, date) from public, anon, authenticated;
grant execute on function assert_business_day_writable(uuid, date) to app_user;

create or replace function guard_closed_business_day() returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_location uuid;
  v_date date;
  v_ticket uuid;
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
  perform assert_business_day_writable(v_location, v_date);
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function guard_closed_business_day() from public, anon, authenticated;
grant execute on function guard_closed_business_day() to app_user;

do $$
declare t text;
begin
  foreach t in array array[
    'appointments','appointment_items','tickets','ticket_items','ticket_item_staff',
    'payments','ticket_refunds','tip_allocations','earnings','cash_movements',
    'tip_payouts','customer_credit_ledger'
  ] loop
    execute format('drop trigger if exists business_day_write_guard on %I', t);
    execute format(
      'create trigger business_day_write_guard before insert or update or delete on %I '
      'for each row execute function guard_closed_business_day()', t);
  end loop;
end $$;

-- ── Distinguish gift-card liability from customer store credit ────────────
alter table ticket_refunds add column if not exists gift_card_cents integer not null default 0
  check (gift_card_cents >= 0);
alter table ticket_refunds add column if not exists customer_credit_cents integer not null default 0
  check (customer_credit_cents >= 0);

update ticket_refunds set
  gift_card_cents = case when method = 'original_payment' then store_credit_cents else 0 end,
  customer_credit_cents = case when method = 'store_credit' then store_credit_cents else 0 end
where store_credit_cents > 0 and gift_card_cents = 0 and customer_credit_cents = 0;

alter table ticket_refunds drop constraint if exists ticket_refunds_channels_match;
alter table ticket_refunds add constraint ticket_refunds_channels_match check (
  cash_cents + card_cents + gift_card_cents + customer_credit_cents = amount_cents
);
alter table ticket_refunds drop column if exists store_credit_cents;

alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash','card','external','gift_card','customer_credit'));

create index if not exists customer_credit_balance_idx
  on customer_credit_ledger(customer_id, created_at, id)
  where kind = 'store_credit' and customer_id is not null;
create unique index if not exists customer_credit_ticket_entry_idem
  on customer_credit_ledger(location_id, idem_key) where idem_key is not null;

-- ── Service execution facts and resource cleaning ─────────────────────────
alter table ticket_items add column if not exists resource_id uuid references resources(id);
create index if not exists ticket_items_resource_idx on ticket_items(resource_id);

create table if not exists ticket_service_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  ticket_item_id uuid not null references ticket_items(id),
  author_membership_id uuid not null references memberships(id),
  visibility text not null default 'management' check (visibility in ('management','assigned_staff')),
  content text not null check (length(btrim(content)) between 1 and 2000),
  contains_sensitive_data boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ticket_item_id, author_membership_id)
);
create index if not exists ticket_service_notes_item_idx on ticket_service_notes(ticket_item_id);
create index if not exists ticket_service_notes_author_idx on ticket_service_notes(author_membership_id, created_at);

create table if not exists resource_occupancies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  resource_id uuid not null references resources(id),
  ticket_item_id uuid not null references ticket_items(id),
  status text not null check (status in ('in_use','cleaning_required','cleaning','released')),
  occupied_at timestamptz not null default now(),
  cleaning_started_at timestamptz,
  released_at timestamptz,
  updated_by uuid references memberships(id),
  unique (ticket_item_id, resource_id)
);
create index if not exists resource_occupancies_active_idx
  on resource_occupancies(resource_id, status)
  where status <> 'released';

alter table ticket_service_notes enable row level security;
alter table ticket_service_notes force row level security;
drop policy if exists tenant_isolation on ticket_service_notes;
create policy tenant_isolation on ticket_service_notes
  using (org_id = app_org_id() and location_id = app_location_id())
  with check (org_id = app_org_id() and location_id = app_location_id());

alter table resource_occupancies enable row level security;
alter table resource_occupancies force row level security;
drop policy if exists tenant_isolation on resource_occupancies;
create policy tenant_isolation on resource_occupancies
  using (org_id = app_org_id() and location_id = app_location_id())
  with check (org_id = app_org_id() and location_id = app_location_id());

revoke all on ticket_service_notes, resource_occupancies from public, anon, authenticated, app_user;
grant select, insert, update on ticket_service_notes, resource_occupancies to app_user;

alter table resources drop constraint if exists resources_status_check;
alter table resources add constraint resources_status_check
  check (status in ('available','in_service','in_use','cleaning_required','cleaning','maintenance'));

drop trigger if exists business_day_write_guard on ticket_service_notes;
create trigger business_day_write_guard before insert or update or delete on ticket_service_notes
  for each row execute function guard_closed_business_day();
