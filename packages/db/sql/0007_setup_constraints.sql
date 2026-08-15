-- rotation_participants 的复合主键就是 (location, date, membership)，
-- 但 on conflict 需要它是一个具名约束才认得出来
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rotation_participants_unique'
  ) then
    alter table rotation_participants
      add constraint rotation_participants_unique
      unique (location_id, business_date, membership_id);
  end if;
exception when duplicate_table then null;
end $$;
