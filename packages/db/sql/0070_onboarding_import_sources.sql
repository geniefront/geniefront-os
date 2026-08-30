-- 0070 · 统一开店导入来源
--
-- 图片、官网与外部商家平台都落到同一份 Shop Blueprint。草案保留来源 URL、
-- 原始结构化快照与门店字段提议；只有老板确认后的项目才进入 services。

alter table blueprint_sources
  add column if not exists source_url text,
  add column if not exists raw_snapshot jsonb;

alter table shop_blueprints
  add column if not exists location_proposal jsonb not null default '{}'::jsonb;

comment on column blueprint_sources.source_url is
  '官网/Google/Yelp 等公开来源 URL；图片来源为空';
comment on column blueprint_sources.raw_snapshot is
  '提取时的结构化来源快照，仅用于人工核对与审计，不直接驱动业务';
comment on column shop_blueprints.location_proposal is
  '从官网或商家平台提取出的门店资料提议，确认前不写 locations';
