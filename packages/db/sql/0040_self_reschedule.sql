-- 0040 · 客人自助改期（批 2，docs/13 §4.6）
--
-- 推翻了初版的两条决定（「没有自助改期」「确认邮件里不放取消链接」）。
-- 那两条的顾虑都是真的：
--   · 改期变成「取消+重订」两步，中间那格会被人订走
--       → 解法是原子改期。appointment.reschedule 本来就在一个事务里
--         先占新格再放旧格，撞了整体回滚。这里不需要新逻辑
--   · 邮件会被转发，捡到链接的人能改掉别人的预约
--       → 解法是**手机后四位**二次校验。这一条需要下面的计数列
--
-- ⚠️ 政策本身（截止小时数、次数上限）**不建新表** —— 它和
-- max_days_ahead / cancel_cutoff_hours 是同一类东西，
-- 继续放 locations.settings.online_booking，由 location.saveOnlineBooking 写。
-- 为三个数字建一张表，只会多出一处「两边不一致」的可能。

alter table appointments
  add column if not exists self_reschedule_count integer not null default 0;

comment on column appointments.self_reschedule_count is
  '客人自己在网上改过几次期。到达 settings.online_booking.self_reschedule_max 之后'
  ' 只能打电话 —— 无限次自助改期等于把日程表交给客人随便拖';

-- 后四位连续输错的锁定。**按预约维度锁，不按 IP** ——
-- 按 IP 锁会让同一个 WiFi 下的第二位客人被前一位连累；
-- 而攻击者要猜的是「某一条特定预约」的后四位，按预约锁正好卡住他。
create table if not exists booking_manage_attempts (
  appointment_id  uuid primary key references appointments(id) on delete cascade,
  org_id          uuid not null references organizations(id),
  location_id     uuid not null references locations(id),
  failed_count    integer not null default 0,
  locked_until    timestamptz,
  last_failed_at  timestamptz,
  updated_at      timestamptz not null default now()
);

comment on table booking_manage_attempts is
  '自助管理页「手机后四位」的失败计数。一万种可能里连猜三次就锁 15 分钟';

-- ⚠️ 有 org_id 的表**必须** enable + force + 一条叫 tenant_isolation 的策略 ——
-- 迁移末尾的 RLS 覆盖检查会逐张核对（0040 第一版只写了 enable，被当场拦下）。
-- force 的意义是连表的 owner 也受策略约束，否则 postgres 角色能绕过去。
alter table booking_manage_attempts enable row level security;
alter table booking_manage_attempts force  row level security;
drop policy if exists tenant_isolation on booking_manage_attempts;
create policy tenant_isolation on booking_manage_attempts
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update, delete on booking_manage_attempts to app_user;
