-- 0069: checkout timing snapshots and staged settlement.
-- A ticket keeps the timing selected at opening so later store-setting changes do
-- not rewrite an in-flight visit's financial contract.

begin;

-- Historical backfill touches already-closed tickets.  The bypass is accepted
-- only for the administrator migration role (0061); app_user can never use it.
select set_config('app.seed_reset', 'on', true);

alter table location_checkout_settings
  add column if not exists checkout_timing text not null default 'after_service_combined'
  check (checkout_timing in ('service_then_tip', 'upfront_combined', 'after_service_combined'));

alter table tickets
  add column if not exists checkout_timing_snapshot text not null default 'after_service_combined'
  check (checkout_timing_snapshot in ('service_then_tip', 'upfront_combined', 'after_service_combined')),
  add column if not exists service_settled_at timestamptz,
  add column if not exists tip_settled_at timestamptz;

alter table payments
  add column if not exists stage text not null default 'combined'
  check (stage in ('service', 'tip', 'combined'));

-- Existing visits retain the legacy C contract.  Closed/refunded records have
-- already completed every relevant financial stage, so their terminal time is a
-- conservative immutable settlement snapshot.
update tickets
set checkout_timing_snapshot = 'after_service_combined'
where checkout_timing_snapshot is null;

update tickets
set service_settled_at = coalesce(service_settled_at, closed_at, refunded_at),
    tip_settled_at = coalesce(tip_settled_at, closed_at, refunded_at)
where status in ('closed', 'refunded');

update payments set stage = 'combined' where stage is null;

-- A fully refunded visit is terminal.  A replacement ticket for its appointment
-- is a new visit, rather than a resurrection of reversed financial activity.
drop index if exists tickets_one_live_per_appointment_idx;
create unique index tickets_one_live_per_appointment_idx
  on tickets (appointment_id)
  where appointment_id is not null and status not in ('voided', 'refunded');

create index if not exists tickets_checkout_timing_open_idx
  on tickets(location_id, checkout_timing_snapshot, status)
  where status not in ('closed', 'voided', 'refunded');

commit;
