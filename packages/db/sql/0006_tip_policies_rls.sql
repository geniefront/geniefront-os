alter table tip_policies enable row level security;
alter table tip_policies force  row level security;
drop policy if exists tenant_isolation on tip_policies;
create policy tenant_isolation on tip_policies
  using (org_id = app_org_id()) with check (org_id = app_org_id());
grant select, insert, update, delete on tip_policies to app_user;

-- ⚠️ 数据库层面也挡住 house_cut：只在 UI 和 API 挡不够，
-- 迁移脚本、早期版本、手工 SQL 都可能写进非 0 值（05 §2.4）。
alter table tip_policies drop constraint if exists no_house_cut;
alter table tip_policies add constraint no_house_cut
  check (coalesce((config->>'house_cut_bp')::int, 0) = 0);
