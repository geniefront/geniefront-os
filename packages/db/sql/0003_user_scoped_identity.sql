-- ════════════════════════════════════════════════════════════════════════════
--  0003 · 身份解析改走「用户维度」的 RLS，不再需要绕过
--
--  背景：登录后用户还没选店，我们不知道 org_id，而所有 RLS 策略读的都是
--  app.org_id。之前的做法是用 postgres 角色绕过 —— 那意味着 API 进程必须
--  持有能无视 RLS 的凭据，和宪法第 5 条直接冲突（部署时才暴露出来）。
--
--  正确的解法：这从来不是「先有鸡还是先有蛋」，只是缺一个【用户维度】的上下文。
--  设 app.user_id 而不设 app.org_id，用一组只在这种模式下生效的策略，
--  让 app_user 恰好能看到「我自己的身份」——不多不少。
--
--  收益：**应用运行时再也不需要任何能绕过 RLS 的凭据。**
-- ════════════════════════════════════════════════════════════════════════════

create or replace function app_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- 只在「身份解析模式」下生效：设了 user_id 且【没设】org_id。
-- 这样在正常的租户上下文里，这组策略完全不参与判断，不会意外放宽权限。
create or replace function app_identity_mode() returns boolean
language sql stable as $$
  select app_user_id() is not null and app_org_id() is null
$$;

-- ── 我自己的身份 ────────────────────────────────────────────────────────────
drop policy if exists identity_self on memberships;
create policy identity_self on memberships for select
  using (app_identity_mode() and user_id = app_user_id());

drop policy if exists identity_self on users;
create policy identity_self on users for select
  using (app_identity_mode() and id = app_user_id());

-- ── 我有身份的那些门店 / 组织 ───────────────────────────────────────────────
drop policy if exists identity_self on locations;
create policy identity_self on locations for select
  using (app_identity_mode() and exists (
    select 1 from memberships m
    where m.location_id = locations.id
      and m.user_id = app_user_id()
      and m.status = 'active'));

drop policy if exists identity_self on organizations;
create policy identity_self on organizations for select
  using (app_identity_mode() and exists (
    select 1 from memberships m
    where m.org_id = organizations.id
      and m.user_id = app_user_id()
      and m.status = 'active'));

-- ── 角色（选店器要显示「你在这家店是什么身份」）──────────────────────────────
drop policy if exists identity_self on membership_roles;
create policy identity_self on membership_roles for select
  using (app_identity_mode() and exists (
    select 1 from memberships m
    where m.id = membership_roles.membership_id
      and m.user_id = app_user_id()));

drop policy if exists identity_self on roles;
create policy identity_self on roles for select
  using (app_identity_mode() and exists (
    select 1 from memberships m
    where m.org_id = roles.org_id
      and m.user_id = app_user_id()
      and m.status = 'active'));

-- 注意这些策略全是 for select：身份解析只读，永远不写。
-- 写操作照常要完整的租户上下文。
