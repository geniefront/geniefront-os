-- Count seats by guest appointment while retaining distinct staff limits and the resource row lock.
create or replace function resource_capacity_guard() returns trigger
language plpgsql as $$
declare
  cap        int;
  max_staff  int;
  res_name   text;
  used       int;
  staff_used int;
begin
  if new.resource_id is null then return new; end if;

  -- 只有真正占用资源的状态才算数
  if TG_TABLE_NAME = 'appointment_items' then
    if new.status not in ('booked','in_service') then return new; end if;
  else
    if new.kind <> 'active' then return new; end if;
  end if;

  select r.capacity, r.max_staff, r.name
    into cap, max_staff, res_name
    from resources r
   where r.id = new.resource_id
   for update;                      -- ← 并发闸门，见文件头

  if cap is null then
    raise exception '资源 % 不存在', new.resource_id
      using errcode = 'foreign_key_violation';
  end if;

  if TG_TABLE_NAME = 'appointment_items' then
    select count(distinct ai.appointment_id) filter (where ai.appointment_id <> new.appointment_id),
           count(distinct ai.membership_id)
      into used, staff_used
      from appointment_items ai
     where ai.resource_id = new.resource_id
       and ai.id <> new.id
       and ai.status in ('booked','in_service')
       and tstzrange(ai.starts_at, ai.ends_at) && tstzrange(new.starts_at, new.ends_at);
  else
    select count(*), 0
      into used, staff_used
      from appointment_item_blocks b
     where b.resource_id = new.resource_id
       and b.id <> new.id
       and b.kind = 'active'
       and tstzrange(b.starts_at, b.ends_at) && tstzrange(new.starts_at, new.ends_at);
  end if;

  if used + 1 > cap then
    -- 报错文案是给前台看的，不是给工程师看的：
    -- "23P01 conflicting key value violates exclusion constraint" 没人看得懂
    raise exception '% 这个时段已经满了（最多 % 位，已排 % 位）', res_name, cap, used
      using errcode = 'restrict_violation',
            hint = 'RESOURCE_FULL';
  end if;

  if TG_TABLE_NAME = 'appointment_items' and max_staff is not null
     and new.membership_id is not null then
    -- distinct 里要把自己算进去
    if staff_used + (case when exists (
         select 1 from appointment_items ai
          where ai.resource_id = new.resource_id and ai.id <> new.id
            and ai.membership_id = new.membership_id
            and ai.status in ('booked','in_service')
            and tstzrange(ai.starts_at, ai.ends_at) && tstzrange(new.starts_at, new.ends_at)
       ) then 0 else 1 end) > max_staff then
      raise exception '% 这个时段最多 % 位技师', res_name, max_staff
        using errcode = 'restrict_violation',
              hint = 'RESOURCE_STAFF_LIMIT';
    end if;
  end if;

  return new;
end $$;

