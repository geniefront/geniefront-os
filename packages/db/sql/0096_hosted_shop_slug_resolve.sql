-- ════════════════════════════════════════════════════════════════════════════
--  0096 · 托管预约页按 slug 认店
--
--  book.geniefront.com/{slug} 进门时浏览器没有 public_key。和 0033 的
--  public_key 策略同一条纪律：
--
--    · 只 for select
--    · 只放行 slug 恰好相等的那一行
--    · 不给顾客 / 预约 / 报表 / 配置表开任何口子
--    · 日常租户上下文里 app.public_slug 为空，这条策略等于不存在
--
--  slug 是查找键，不是密钥。认出来之后公开接口仍然走原来的 public_key
--  会话；这一份只负责把可读路径换成那把本来就是公开的 key。
--
--  ⚠️ appointment_items 另有一条 staff_own_only 策略。它在 0001 里是
--  PERMISSIVE，会把无 org_id 的公开会话整表放行。0097 把它改成
--  RESTRICTIVE，本文件的 slug 策略才能守住「只看见这一家店」。
-- ════════════════════════════════════════════════════════════════════════════

create or replace function app_public_slug() returns text
language sql stable as $$
  select nullif(current_setting('app.public_slug', true), '')
$$;

drop policy if exists location_by_public_slug on locations;
create policy location_by_public_slug on locations
  for select
  using (slug = app_public_slug());

drop policy if exists org_by_public_slug on organizations;
create policy org_by_public_slug on organizations
  for select
  using (exists (
    select 1 from locations l
    where l.org_id = organizations.id and l.slug = app_public_slug()));

drop policy if exists origins_by_public_slug on location_allowed_origins;
create policy origins_by_public_slug on location_allowed_origins
  for select
  using (exists (
    select 1 from locations l
    where l.id = location_allowed_origins.location_id
      and l.slug = app_public_slug()));

revoke all on function public.app_public_slug()
  from public, anon, authenticated;
grant execute on function public.app_public_slug() to app_user;
