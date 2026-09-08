-- ════════════════════════════════════════════════════════════════════════════
--  0118 · 组合套餐目录 + 订单实例 + 执行项关联列（U10 / 计划 §5）
--
--  组合套餐（service bundle）：一次消费里固定几个项目一起买、走固定组合价，
--  当场展开成实际子项目履约。与次卡（package_templates / customer_packages）
--  是两回事 —— 次卡是购买后留在顾客账户、跨消费按次数核销的预付资产。
--
--  本迁移只建目录与订单快照结构、开 RLS、授权，并给 appointment_items /
--  ticket_items 补**可空**的套餐来源关联列。不接任何创建 / 结账链路 ——
--  那是计划 P2–P5 的工作。纯加法：既有行为与历史金额完全不受影响。
--
--  幂等：全部 create/alter ... if not exists + 具名约束存在性判断，可重放。
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────── 目录：模板

create table if not exists service_bundles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  name jsonb not null,
  description jsonb,
  price_cents integer not null check (price_cents >= 0),
  online_bookable boolean not null default false,
  active boolean not null default true,
  version integer not null default 1 check (version >= 1),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_bundles_location_idx
  on service_bundles(location_id, active);

-- 复用 0117 的通用触发器函数推进 updated_at（供批量编辑 / 版本比对用）。
drop trigger if exists service_bundles_touch_updated_at on service_bundles;
create trigger service_bundles_touch_updated_at
  before update on service_bundles
  for each row execute function gf_touch_updated_at();

create table if not exists service_bundle_components (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references service_bundles(id) on delete cascade,
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  service_id uuid not null references services(id),
  qty integer not null default 1 check (qty between 1 and 20),
  seq integer not null default 0,
  included_addon_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now()
);

create index if not exists service_bundle_components_bundle_idx
  on service_bundle_components(bundle_id, seq);
create index if not exists service_bundle_components_service_idx
  on service_bundle_components(service_id);

-- ─────────────────────────────────────────────────────────── 订单：套餐实例

create table if not exists order_bundle_instances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  customer_id uuid references customers(id),
  appointment_id uuid references appointments(id) on delete cascade,
  ticket_id uuid references tickets(id) on delete cascade,
  bundle_id uuid references service_bundles(id),
  template_version integer not null,
  name_snapshot jsonb not null,
  original_total_cents integer not null check (original_total_cents >= 0),
  bundle_price_cents integer not null check (bundle_price_cents >= 0),
  discount_cents integer not null check (discount_cents >= 0),
  extra_discount_cents integer not null default 0 check (extra_discount_cents >= 0),
  source text not null default 'desk',
  status text not null default 'active' check (status in ('active', 'split', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 至少一个归属存在（预约或工单）。
  constraint order_bundle_instances_owner_chk
    check (appointment_id is not null or ticket_id is not null),
  -- 套餐内建优惠恒等于原价合计减组合价（计划 §5.3 不变量）。
  constraint order_bundle_instances_discount_chk
    check (discount_cents = original_total_cents - bundle_price_cents),
  -- 首版组合价不超过组成原价合计（计划 §4.1）。
  constraint order_bundle_instances_price_le_original_chk
    check (bundle_price_cents <= original_total_cents)
);

create index if not exists order_bundle_instances_appointment_idx
  on order_bundle_instances(appointment_id);
create index if not exists order_bundle_instances_ticket_idx
  on order_bundle_instances(ticket_id);
create index if not exists order_bundle_instances_bundle_idx
  on order_bundle_instances(bundle_id);
create index if not exists order_bundle_instances_customer_idx
  on order_bundle_instances(customer_id);

drop trigger if exists order_bundle_instances_touch_updated_at on order_bundle_instances;
create trigger order_bundle_instances_touch_updated_at
  before update on order_bundle_instances
  for each row execute function gf_touch_updated_at();

-- ─────────────────────────────────────────────────────────── 执行项关联列
--
-- 全部可空，普通历史行为空。不按数组 seq / service_id 配对（计划 §5.2）：
-- 关联三元组 (bundle_instance_id, bundle_component_id, bundle_unit_index)
-- 唯一确定一个执行单元。

alter table appointment_items
  add column if not exists bundle_instance_id uuid references order_bundle_instances(id) on delete set null,
  add column if not exists bundle_component_id uuid,
  add column if not exists bundle_unit_index integer,
  add column if not exists bundle_list_price_cents integer;

alter table ticket_items
  add column if not exists bundle_instance_id uuid references order_bundle_instances(id) on delete set null,
  add column if not exists bundle_component_id uuid,
  add column if not exists bundle_unit_index integer,
  add column if not exists bundle_list_price_cents integer;

create index if not exists appointment_items_bundle_idx
  on appointment_items(bundle_instance_id);
create index if not exists ticket_items_bundle_idx
  on ticket_items(bundle_instance_id);

-- 一个执行单元最多映射一条 item：开单 / 重试不会重复展开（计划 §5.3）。
create unique index if not exists appointment_items_bundle_unit_uidx
  on appointment_items(bundle_instance_id, bundle_component_id, bundle_unit_index)
  where bundle_instance_id is not null;
create unique index if not exists ticket_items_bundle_unit_uidx
  on ticket_items(bundle_instance_id, bundle_component_id, bundle_unit_index)
  where bundle_instance_id is not null;

-- ─────────────────────────────────────────────────────────── RLS + 授权

alter table service_bundles enable row level security;
alter table service_bundles force  row level security;
drop policy if exists tenant_isolation on service_bundles;
create policy tenant_isolation on service_bundles
  using       (org_id = app_org_id() and location_id = app_location_id())
  with check  (org_id = app_org_id() and location_id = app_location_id());

alter table service_bundle_components enable row level security;
alter table service_bundle_components force  row level security;
drop policy if exists tenant_isolation on service_bundle_components;
create policy tenant_isolation on service_bundle_components
  using       (org_id = app_org_id() and location_id = app_location_id())
  with check  (org_id = app_org_id() and location_id = app_location_id());

alter table order_bundle_instances enable row level security;
alter table order_bundle_instances force  row level security;
drop policy if exists tenant_isolation on order_bundle_instances;
create policy tenant_isolation on order_bundle_instances
  using       (org_id = app_org_id() and location_id = app_location_id())
  with check  (org_id = app_org_id() and location_id = app_location_id());

revoke all on table service_bundles, service_bundle_components, order_bundle_instances
  from public, anon, authenticated;
grant select, insert, update, delete on table
  service_bundles, service_bundle_components, order_bundle_instances
  to app_user;

comment on table service_bundles is
  '组合套餐模板：固定组成 + 固定组合价，下单当场展开成实际子项目（U10 / 0118）。'
  '与 package_templates（次卡预付资产）互不相关。';
comment on column order_bundle_instances.template_version is
  '下单时锁定的 service_bundles.version；模板改价 / 停用不影响历史订单（0118）。';
comment on column appointment_items.bundle_instance_id is
  '属于哪一份 order_bundle_instances；配 bundle_component_id + bundle_unit_index 唯一定位执行单元（0118，U10）。';
