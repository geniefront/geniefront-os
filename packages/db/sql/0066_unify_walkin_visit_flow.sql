-- 0066 · Walk-in 与预约共用 visit 主记录
--
-- appointments 是到店生命周期的主记录；walkin_queue 只保存排队号码与时间状态。
-- 新代码会在 queue.join 的同一事务里建立两者。本迁移回填历史未关联队列。

insert into appointments (
  org_id, location_id, customer_id, walk_in_name, business_date,
  starts_at, ends_at, status, source, booking_channel_ref,
  party_size, cancelled_at, cancel_reason, created_at
)
select
  q.org_id, q.location_id, q.customer_id, q.walk_in_name, q.business_date,
  q.joined_at,
  q.joined_at + make_interval(mins => coalesce(s.duration_min, 40)),
  case when q.status = 'left' then 'cancelled'
       when q.status = 'seated' then 'in_service'
       else 'checked_in' end,
  'walkin', 'walkin_queue:' || q.id::text, q.party_size,
  case when q.status = 'left' then coalesce(q.left_at, q.joined_at) else null end,
  case when q.status = 'left' then 'walk_out' else null end,
  q.joined_at
from walkin_queue q
left join services s on s.id = q.requested_service_id
where q.appointment_id is null
  and not exists (
    select 1 from appointments a
    where a.location_id = q.location_id
      and a.booking_channel_ref = 'walkin_queue:' || q.id::text
  );

update walkin_queue q
set appointment_id = a.id
from appointments a
where q.appointment_id is null
  and a.location_id = q.location_id
  and a.booking_channel_ref = 'walkin_queue:' || q.id::text;

insert into appointment_items (
  org_id, location_id, appointment_id, service_id, membership_id,
  is_request, starts_at, ends_at, price_cents_snapshot, duration_min,
  seq, status
)
select
  q.org_id, q.location_id, q.appointment_id, s.id, q.requested_staff_id,
  q.requested_staff_id is not null, q.joined_at,
  q.joined_at + make_interval(mins => s.duration_min),
  s.base_price_cents, s.duration_min, 0,
  case when q.status = 'left' then 'cancelled'
       when q.status = 'seated' then 'in_service'
       else 'booked' end
from walkin_queue q
join services s on s.id = q.requested_service_id
where q.appointment_id is not null
  and not exists (
    select 1 from appointment_items ai
    where ai.appointment_id = q.appointment_id
  );

create unique index if not exists appointments_walkin_queue_ref_idx
  on appointments (location_id, booking_channel_ref)
  where source = 'walkin' and booking_channel_ref is not null;

comment on column appointments.booking_channel_ref is
  '来源侧引用；Walk-in 使用 walkin_queue:<queueId>，其余渠道保留各自外部引用';
