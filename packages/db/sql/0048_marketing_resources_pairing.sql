-- ════════════════════════════════════════════════════════════════════════════
--  0048 · 营销体系（次卡套餐 / 优惠券）+ 硬件副屏配对 + 短信直发
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 次卡套餐模板 ────────────────────────────────────────────────────────
create table if not exists package_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  name          jsonb not null,
  price_cents   integer not null check (price_cents >= 0),
  sessions      integer not null default 1 check (sessions >= 0),
  service_ids   uuid[] not null default '{}'::uuid[],
  valid_days    integer check (valid_days is null or valid_days > 0),
  scope         text not null default 'location' check (scope in ('location', 'org')),
  online_sale   boolean not null default false,
  active        boolean not null default true,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists package_tpl_org_idx on package_templates (org_id, location_id);

-- ── 2. 客户持有的次卡套餐 ──────────────────────────────────────────────────
create table if not exists customer_packages (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  template_id   uuid references package_templates(id),
  customer_id   uuid not null references customers(id),
  remaining_sessions integer not null check (remaining_sessions >= 0),
  total_sessions     integer not null check (total_sessions >= 0),
  status        text not null default 'active'
                check (status in ('active', 'depleted', 'expired', 'void')),
  expires_at    timestamptz,
  sold_ticket_id uuid references tickets(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists cust_pkg_customer_idx on customer_packages (customer_id, status);
create index if not exists cust_pkg_org_idx on customer_packages (org_id, location_id);

-- ── 3. 优惠券模板 ──────────────────────────────────────────────────────────
create table if not exists coupon_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  code          text not null,
  name          jsonb not null,
  kind          text not null check (kind in ('amount', 'percent')),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  percent_bp    integer not null default 0 check (percent_bp between 0 and 10000),
  min_spend_cents integer not null default 0 check (min_spend_cents >= 0),
  valid_from    timestamptz,
  valid_until   timestamptz,
  max_uses      integer check (max_uses is null or max_uses > 0),
  used_count    integer not null default 0 check (used_count >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists coupon_tpl_code_uidx on coupon_templates (location_id, code);
create index if not exists coupon_tpl_org_idx on coupon_templates (org_id, location_id, active);

-- ── 4. 硬件副屏与 Kiosk 配对会话 ──────────────────────────────────────────
create table if not exists pairing_sessions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  code          text not null,
  terminal_type text not null default 'customer-facing'
                check (terminal_type in ('customer-facing', 'kiosk')),
  status        text not null default 'pending'
                check (status in ('pending', 'paired', 'expired')),
  qr_payload    text not null,
  paired_device_id uuid,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create unique index if not exists pairing_code_uidx on pairing_sessions (code);
create index if not exists pairing_loc_status_idx on pairing_sessions (location_id, status);

-- ── 5. 更新 sms_outbox 约束允许 direct_message ─────────────────────────────
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'sms_outbox_kind') then
    alter table sms_outbox drop constraint sms_outbox_kind;
  end if;
  alter table sms_outbox add constraint sms_outbox_kind
    check (kind in ('appointment_confirm','appointment_changed',
                    'appointment_reminder','help_reply','direct_message'));
end $$;

-- ── 6. RLS ─────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['package_templates','customer_packages','coupon_templates','pairing_sessions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) '
      || 'with check (org_id = app_org_id())', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;
