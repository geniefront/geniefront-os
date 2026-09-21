-- Capacity holds are deliberately separate from assigned staff.
alter table public.appointment_items add column if not exists reserved_membership_id uuid references public.memberships(id);
comment on column public.appointment_items.reserved_membership_id is 'Internal capacity hold for a booking awaiting manual assignment. Not an assigned specialist and never a notification recipient.';
create or replace function public.booking_assignment_reservation_guard() returns trigger
language plpgsql set search_path=public as $$
begin
  if new.membership_id is not null then new.reserved_membership_id := null; end if;
  if new.reserved_membership_id is not null and not exists (
    select 1 from staff_profiles sp where sp.membership_id=new.reserved_membership_id
      and sp.location_id=new.location_id and sp.org_id=new.org_id
  ) then
    raise exception 'Invalid booking capacity reservation' using errcode='foreign_key_violation';
  end if;
  return new;
end $$;
revoke all on function public.booking_assignment_reservation_guard() from public,anon,authenticated;
drop trigger if exists booking_assignment_reservation_guard on public.appointment_items;
create trigger booking_assignment_reservation_guard before insert or update of membership_id,reserved_membership_id,location_id,org_id on public.appointment_items
for each row execute function public.booking_assignment_reservation_guard();

-- Count party seats by guest, preserving legacy single-guest grouping and resource locking.
create or replace function resource_capacity_guard() returns trigger
language plpgsql set search_path=public as $$
declare
  cap        int;
  max_staff  int;
  res_name   text;
  used       int;
  staff_used int;
  new_group text;
  effective_staff uuid;
begin
  if new.resource_id is null then return new; end if;

  -- 只有真正占用资源的状态才算数
  if TG_TABLE_NAME = 'appointment_items' then
    if new.status not in ('booked','in_service') then return new; end if;
    effective_staff := coalesce(new.membership_id,new.reserved_membership_id);
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
    select case when a.party_size>1 then a.id::text||':'||coalesce(new.details->>'publicGuestIndex',new.id::text)
      else a.id::text end into new_group from appointments a where a.id=new.appointment_id;
    select count(distinct q.guest_key) filter (where q.guest_key<>new_group),count(distinct q.membership_id)
      into used,staff_used from (
        select coalesce(ai.membership_id,ai.reserved_membership_id) as membership_id,case when a.party_size>1 then a.id::text||':'||coalesce(ai.details->>'publicGuestIndex',ai.id::text)
          else a.id::text end as guest_key
        from appointment_items ai join appointments a on a.id=ai.appointment_id
        where ai.resource_id=new.resource_id and ai.id<>new.id and ai.status in ('booked','in_service')
          and tstzrange(ai.starts_at,ai.ends_at)&&tstzrange(new.starts_at,new.ends_at)
      ) q;
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
     and effective_staff is not null then
    -- distinct 里要把自己算进去
    if staff_used + (case when exists (
         select 1 from appointment_items ai
          where ai.resource_id = new.resource_id and ai.id <> new.id
            and coalesce(ai.membership_id,ai.reserved_membership_id) = effective_staff
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

-- Changes to a hold must run the same resource-capacity checks as assignment changes.
drop trigger if exists resource_capacity_guard on public.appointment_items;
create trigger resource_capacity_guard before insert or update of resource_id,starts_at,ends_at,status,membership_id,reserved_membership_id
on public.appointment_items for each row execute function public.resource_capacity_guard();
