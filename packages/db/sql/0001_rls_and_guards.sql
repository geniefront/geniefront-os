-- ════════════════════════════════════════════════════════════════════════════
--  0001 · RLS、排他约束、审计不可变
--
--  这条迁移必须跟着建表一起跑，不能后补。
--  后补 RLS 是最常见的翻车方式：开发期没开一切正常，等你补上时几十个查询
--  同时挂掉，而且分不清哪些是真越权、哪些只是漏了 SET LOCAL。
--
--  全文可重复执行。
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists btree_gist;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. 受限应用角色
--
--    应用永远用 app_user 连库，绝不用 service_role/postgres 跑业务查询。
--    app_user 没有 BYPASSRLS，所以漏写 WHERE 也不会串租户。
--    登录密码在 migrate.ts 里单独设 —— 不写进这个要提交的文件。
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. 租户上下文
--
--    每个命令在事务开头执行 set_config('app.org_id', ..., true)。
--    绝不用裸 SET —— 会话级设置会泄漏到下一个租户的请求（CI 有 lint 挡）。
-- ────────────────────────────────────────────────────────────────────────────

create or replace function app_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app_location_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.location_id', true), '')::uuid
$$;

create or replace function app_membership_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.membership_id', true), '')::uuid
$$;

-- 'staff_self' = 技师端，只能看自己的单
create or replace function app_role_scope() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('app.role_scope', true), ''), 'full')
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. 带 org_id 的表：直接按 org 隔离
--
--    force row level security：连表的 owner 也受策略约束，
--    否则用 owner 身份连库时 RLS 形同虚设。
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  org_scoped text[] := array[
    'locations','location_subscriptions','location_features','usage_events',
    'memberships','roles','staff_levels','staff_profiles','skills','device_tokens',
    'customers','customer_preferences',
    'service_categories','services','resource_types','resources','service_option_defs',
    'appointments','appointment_items','appointment_item_blocks',
    'rotation_policies','rotation_participants','rotation_events',
    'audit_log'
  ];
begin
  foreach t in array org_scoped loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    -- 1000 个租户，一次 WHERE 写漏就是数据泄露事故
    execute format($f$
      create policy tenant_isolation on %I
        using       (org_id = app_org_id())
        with check  (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

-- organizations 自己按 id 隔离
alter table organizations enable row level security;
alter table organizations force  row level security;
drop policy if exists tenant_isolation on organizations;
create policy tenant_isolation on organizations
  using (id = app_org_id()) with check (id = app_org_id());

-- ────────────────────────────────────────────────────────────────────────────
-- 4. 没有 org_id 的关联表：靠父表的 EXISTS 判定
--
--    这几张是纯连接表（复合主键，无 org_id）。给它们加 org_id 会引入
--    冗余和不一致的风险，所以走父表推导。
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('role_permissions',    'exists (select 1 from roles r where r.id = role_id and r.org_id = app_org_id())'),
      ('membership_roles',    'exists (select 1 from memberships m where m.id = membership_id and m.org_id = app_org_id())'),
      ('permission_overrides','exists (select 1 from memberships m where m.id = membership_id and m.org_id = app_org_id())'),
      ('staff_skills',        'exists (select 1 from memberships m where m.id = membership_id and m.org_id = app_org_id())'),
      -- users 是全局表：只有和你同 org 的人才可见
      ('users',               'exists (select 1 from memberships m where m.user_id = users.id and m.org_id = app_org_id())'),
      ('user_last_location',  'exists (select 1 from memberships m where m.user_id = user_last_location.user_id and m.org_id = app_org_id())')
    ) as v(tbl, pred)
  loop
    execute format('alter table %I enable row level security', spec.tbl);
    execute format('alter table %I force  row level security', spec.tbl);
    execute format('drop policy if exists tenant_isolation on %I', spec.tbl);
    execute format(
      'create policy tenant_isolation on %I using (%s) with check (%s)',
      spec.tbl, spec.pred, spec.pred);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. 技师端只看自己的单（叠加策略）
--
--    决策 16 的一半：技师看不到别人的单。
--    另一半（手机号脱敏）在应用层做，因为技师需要看到「客人是谁」。
-- ────────────────────────────────────────────────────────────────────────────

drop policy if exists staff_own_only on appointment_items;
create policy staff_own_only on appointment_items
  for select using (
    app_role_scope() <> 'staff_self'
    or membership_id = app_membership_id()
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 6. 约束分层（01 §7.1）—— 整条迁移里最容易做错的一节
-- ────────────────────────────────────────────────────────────────────────────

-- 资源 = 硬约束。房间/床/椅物理上不可能同时两人。
alter table appointment_items drop constraint if exists no_resource_overlap;
alter table appointment_items add constraint no_resource_overlap
  exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (resource_id is not null and status in ('booked','in_service'));

-- 处理时间拆段后，资源占用只算 active 段（美甲泡脚/等干、染烫等待段）
alter table appointment_item_blocks drop constraint if exists no_resource_block_overlap;
alter table appointment_item_blocks add constraint no_resource_block_overlap
  exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (resource_id is not null and kind = 'active');

-- ⚠️⚠️ 这里【故意】不给 membership_id 建排他约束。
--
-- 决策 17：客人到店泡脚等待是常态，系统默认允许超卖与时间重叠排单。
-- DB 级硬拒绝会在上线第一天炸掉，而且前台看不懂
-- "23P01 conflicting key value violates exclusion constraint"。
-- 技师并发上限（staff_profiles.max_concurrent_appointments）与门店时段上限
-- 都在应用层检查，超出时写 overbooked=true + overbook_reason 放行。
--
-- 想加这条约束之前，先读 03-ROADMAP 宪法第 15 条。
-- scripts/lint-guards.sh 也会拦。

-- 放行了就必须留下原因，否则决策 12 的「可解释审计流水」是空话
alter table appointment_items drop constraint if exists overbook_needs_reason;
alter table appointment_items add constraint overbook_needs_reason
  check (not overbooked or overbook_reason is not null);

-- 客户：手机号是查找键不是唯一键（夫妻/母女共号很普遍），
-- 只挡「同号 + 同名」的真重复录入。
drop index if exists customers_no_exact_dup;
create unique index customers_no_exact_dup on customers (
  org_id, phone_e164, lower(btrim(display_name))
) where merged_into_id is null and phone_e164 is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. audit_log append-only —— 真的强制，不是只写在文档里
-- ────────────────────────────────────────────────────────────────────────────

revoke update, delete, truncate on audit_log from app_user;

create or replace function audit_log_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only (attempted %)', tg_op
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists audit_log_no_change on audit_log;
create trigger audit_log_no_change
  before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- 迁移用的 postgres 角色能 disable trigger 绕过，所以
-- service_role / postgres 凭据不进应用运行时环境变量（宪法第 5 条）。
