-- 0049_permissions_and_pairing_rls.sql
-- 1. 为既有角色补齐新权限（comms.send, marketing.manage, package.manage）
-- 2. 为 pairing_sessions 配置配对码握手 RLS 策略

-- ── 1. 补齐角色权限 ──────────────────────────────────────────────────────────
insert into role_permissions (role_id, permission)
select r.id, p.permission
from roles r
cross join (values
  ('comms.send'),
  ('marketing.manage'),
  ('package.manage')
) as p(permission)
where r.key in ('owner', 'manager')
on conflict (role_id, permission) do nothing;

insert into role_permissions (role_id, permission)
select r.id, 'comms.send'
from roles r
where r.key = 'front_desk'
on conflict (role_id, permission) do nothing;

-- ── 2. 配对码握手 RLS 策略 ──────────────────────────────────────────────────
create or replace function app_pairing_code() returns text
language sql stable as $$
  select nullif(current_setting('app.pairing_code', true), '')
$$;

drop policy if exists pairing_code_access on pairing_sessions;
create policy pairing_code_access on pairing_sessions
  for all
  using (org_id = app_org_id() or code = app_pairing_code())
  with check (org_id = app_org_id() or code = app_pairing_code());
