-- ════════════════════════════════════════════════════════════════════════════
--  0004 · 让权限也能在身份解析模式下读到
--
--  buildContext 原来要两个事务：withUser 拿门店归属，再 withTenant 拿权限。
--  每个事务都是一轮 BEGIN/set_config/COMMIT，在跨区往返下很贵。
--
--  把 role_permissions / permission_overrides 也纳入 identity_self，
--  buildContext 就能在一个 withUser 事务里做完。
--  放行范围仍然是「我自己那几条」，且全部 for select。
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists identity_self on role_permissions;
create policy identity_self on role_permissions for select
  using (app_identity_mode() and exists (
    select 1 from membership_roles mr
    join memberships m on m.id = mr.membership_id
    where mr.role_id = role_permissions.role_id
      and m.user_id = app_user_id()));

drop policy if exists identity_self on permission_overrides;
create policy identity_self on permission_overrides for select
  using (app_identity_mode() and exists (
    select 1 from memberships m
    where m.id = permission_overrides.membership_id
      and m.user_id = app_user_id()));
