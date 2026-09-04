-- AI 价目表草案支持套餐/次卡。套餐仍先进入待确认草案，不直接写业务表。
alter table blueprint_items
  add column if not exists package_sessions integer not null default 0,
  add column if not exists package_service_names jsonb not null default '[]'::jsonb,
  add column if not exists package_valid_days integer;

alter table blueprint_items drop constraint if exists blueprint_items_kind;
alter table blueprint_items add constraint blueprint_items_kind
  check (kind in ('service','addon','package','note','price_modifier'));

alter table blueprint_items drop constraint if exists blueprint_items_package_sane;
alter table blueprint_items add constraint blueprint_items_package_sane check (
  package_sessions >= 0
  and (package_valid_days is null or package_valid_days between 1 and 3650)
  and jsonb_typeof(package_service_names) = 'array'
);
