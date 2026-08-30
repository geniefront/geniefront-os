-- 0071 · Stripe webhook processing lease
--
-- A worker can exit after claiming an event but before it marks the row failed
-- or processed. Without a lease, every later Stripe delivery sees the primary
-- key and treats the event as a duplicate forever.

alter table stripe_events
  add column if not exists attempt_started_at timestamptz;

update stripe_events
set attempt_started_at = coalesce(processed_at, now())
where attempt_started_at is null;

alter table stripe_events
  alter column attempt_started_at set default now(),
  alter column attempt_started_at set not null;

comment on column stripe_events.attempt_started_at is
  '当前 webhook 处理尝试的开始时间；processing 超过租约后允许 Stripe 重投接管';
