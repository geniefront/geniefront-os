-- ════════════════════════════════════════════════════════════════════════════
--  0008 · 房间多容量：一间房同时服务多人多技师
--
--  真店里「一房一客」是少数：足疗房排 6 张躺椅、双人房两张床两个技师、
--  美甲区整片当一个资源用。0001 里那两条 GiST 排他约束表达的是
--  「同一资源永不重叠」，容量一旦大于 1 就没法用它表达（排他约束不会计数）。
--
--  所以换成**计数触发器**。资源仍然是数据库硬约束（宪法第 15 条）——
--  换的只是实现方式，不是约束强度：
--    · 资源超容量 = 数据库直接拒绝，前台带 reason 也覆盖不了
--    · 技师并发 / 门店容量 = 依旧在应用层软告警（0001 末尾那段注释仍然成立）
--
--  并发安全：插入前先 `select ... for update` 锁住那一行 resources，
--  把同一间房的并发写入串起来。不锁的话，两个前台同时排最后一个位置，
--  各自都只看到 5 个占用，双双通过 —— 排他约束原本免费提供的保证，
--  换成触发器之后必须自己拿回来。
-- ════════════════════════════════════════════════════════════════════════════

alter table resources drop constraint if exists resources_capacity_positive;
alter table resources add constraint resources_capacity_positive
  check (capacity >= 1 and (max_staff is null or max_staff >= 1));

-- ── 通用检查函数 ────────────────────────────────────────────────────────────
-- 两张表（appointment_items 与 appointment_item_blocks）用同一套逻辑，
-- 靠 TG_TABLE_NAME 分流。写两份迟早会漂移。
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
    select count(*), count(distinct ai.membership_id)
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

-- ── 换掉排他约束 ────────────────────────────────────────────────────────────
alter table appointment_items       drop constraint if exists no_resource_overlap;
alter table appointment_item_blocks drop constraint if exists no_resource_block_overlap;

drop trigger if exists resource_capacity_guard on appointment_items;
create trigger resource_capacity_guard
  before insert or update of resource_id, starts_at, ends_at, status, membership_id
  on appointment_items
  for each row execute function resource_capacity_guard();

drop trigger if exists resource_capacity_guard on appointment_item_blocks;
create trigger resource_capacity_guard
  before insert or update of resource_id, starts_at, ends_at, kind
  on appointment_item_blocks
  for each row execute function resource_capacity_guard();
