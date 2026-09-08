-- ════════════════════════════════════════════════════════════════════════════
--  0116 · 拍照开店草案行补「同时技师人数」（U04 / 计划 §7.2）
--
--  `blueprint_items` 此前没有人数列，落地时 `services.staff_count` 只能吃 DB
--  默认 1 —— 价目表上印着「双人四手」的项目导入后也只占一个技师容量，排期
--  校验放行本不该放的单。
--
--  这里加一列 `staff_count`（**可空**）：
--    · null  = 老板没在确认页动过 → 落地按 1（与既有默认一致）；
--    · 1–5   = 老板在确认页明确设的值 → 落地透传给 `services.staff_count`。
--
--  取值范围对齐 `catalog.saveService` 契约（`z.number().int().min(1).max(5)`）。
--  纯加列，不回填、不改既有行为。
-- ════════════════════════════════════════════════════════════════════════════

alter table blueprint_items add column if not exists staff_count integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_items_staff_count') then
    alter table blueprint_items add constraint blueprint_items_staff_count
      check (staff_count is null or staff_count between 1 and 5);
  end if;
end $$;

comment on column blueprint_items.staff_count is
  '同时需要几位技师（1–5）。null = 未在确认页设置，落地按 1（0116，U04）。';
