-- ════════════════════════════════════════════════════════════════════════════
--  0097 · appointment_items.staff_own_only 必须是 RESTRICTIVE
--
--  0001 给 appointment_items 叠了第二条 SELECT 策略：
--
--      app_role_scope() <> 'staff_self' OR membership_id = app_membership_id()
--
--  Postgres 的 PERMISSIVE 策略之间是 OR。默认 role_scope 是 'full'，
--  于是这条策略在「没有 org_id 的会话」里恒为 true。
--
--  0033 的 public_key 会话和 0096 的 public_slug 会话都不设 org_id。
--  它们本来只该看见 locations / organizations / allowed_origins，
--  但这条 OR 把 appointment_items 整表对公开入口打开了。
--
--  改成 RESTRICTIVE 之后：结果 = (PERMISSIVE 的并) AND (RESTRICTIVE 的交)。
--  没有 org_id 时 tenant_isolation 为 false，行不可见；
--  技师端 staff_self 仍然要过 membership_id 这一关。
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists staff_own_only on appointment_items;
create policy staff_own_only on appointment_items
  as restrictive
  for select
  using (
    app_role_scope() <> 'staff_self'
    or membership_id = app_membership_id()
  );
