-- Atomic SMS claims prevent two post-commit flushes sending the same row.
-- Existing rows keep their state. An interrupted provider request is uncertain,
-- never blindly retried; operators retain its complete audit record.
alter table sms_outbox add column if not exists claim_id uuid;
alter table sms_outbox add column if not exists claimed_at timestamptz;
alter table sms_outbox drop constraint if exists sms_outbox_status;
alter table sms_outbox add constraint sms_outbox_status
  check(status in ('pending','sending','uncertain','sent','failed','suppressed','captured'));

-- Also discover abandoned claims so they become visibly uncertain.
create or replace function gf_outbox_pending_tenants(
  p_older_than_seconds integer default 120,
  p_limit integer default 100
) returns table (
  org_id uuid,
  location_id uuid,
  email_pending bigint,
  sms_pending bigint
)
language sql security definer set search_path = public
as $$
  with pending as (
    select e.org_id, e.location_id, 1 as is_email, 0 as is_sms
    from email_outbox e
    where e.status = 'pending'
      and e.attempts < 3
      and e.created_at < now() - make_interval(secs => p_older_than_seconds)
    union all
    select s.org_id, s.location_id, 0, 1
    from sms_outbox s
    where ((s.status = 'pending' and s.attempts < 3
      and s.created_at < now() - make_interval(secs => p_older_than_seconds))
      or (s.status = 'sending' and s.claimed_at < now() - interval '5 minutes'))
      -- 静默时段内的营销短信不算「待投递」：现在扫到它也发不出去，
      -- 只会让每一轮都白唤醒一次这家店（判定口径在 sms/flush.ts）
      and (s.quiet_hours = false or exists (
        select 1 from locations l
        where l.id = s.location_id
          and extract(hour from (now() at time zone l.timezone)) between 8 and 20
      ))
  )
  select
    p.org_id,
    p.location_id,
    sum(p.is_email)::bigint as email_pending,
    sum(p.is_sms)::bigint   as sms_pending
  from pending p
  where p.location_id is not null
  group by p.org_id, p.location_id
  order by p.org_id, p.location_id
  limit p_limit
$$;

revoke all on function public.gf_outbox_pending_tenants(integer, integer)
  from public, anon, authenticated;
grant execute on function public.gf_outbox_pending_tenants(integer, integer) to app_user;
