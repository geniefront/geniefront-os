-- ════════════════════════════════════════════════════════════════════════════
--  0077 · 内部运营备注对租户不可见（AUD-08）
--
--  ## 问题
--
--  `support_request_notes` 的表注释写着「Internal operator notes on a support
--  request. Not shown to customers.」，而它的 RLS 策略是：
--
--      using (org_id = app_org_id()) with check (org_id = app_org_id())
--      grant select, insert, update, delete on support_request_notes to app_user
--
--  也就是说**租户完全读得到**。今天没漏出去，唯一的原因是 desk 侧还没有
--  任何一处查询读它 —— 而那是「碰巧」，不是隔离。
--  批 8 一旦给 desk 加一个「工单历史」页面，内部备注就跟着出去了，
--  而写那个页面的人看到 RLS 是 org 维度的，会理所当然地认为它是安全的。
--
--  ## 修法
--
--  备注表的可见性判据从「同一个 org」改成「你是不是运营」。
--  租户上下文（`app.org_id` 有值、`gf_platform_operator_role()` 为空）读不到任何一行。
--
--  ⚠️ 运营侧的写入走 `withTenant(目标租户)`（`platform/commands.ts`），
--  那条路径下 `app.org_id` 是目标 org、`app.user_id` 是运营本人 ——
--  所以策略必须同时接受这两种身份，判据落在 `gf_platform_operator_role()` 上。
--
--  工单主表 `support_requests` **不动**：客户本来就该看得到自己提的工单
--  和它的状态（那正是 AUD-08 的另一半）。
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists tenant_isolation on support_request_notes;

-- 运营专属：必须是 active 的 platform_operators，才看得到 / 写得了备注。
create policy operator_only on support_request_notes
  using (gf_platform_operator_role() is not null)
  with check (gf_platform_operator_role() is not null);

comment on table support_request_notes is
  'Internal operator notes on a support request. Tenant users cannot select '
  'these rows: RLS requires an active platform_operators row (sql/0077, AUD-08).';

-- ── 客户侧要看得到自己工单的状态流转 ────────────────────────────────────────
--
-- 平台把状态改成 `waiting`（= 等客户回话）之后，客户那边没有任何东西显示 ——
-- 工单是个单向投递口。补一列「最后一次由运营更新的时间」，
-- 让 desk 能显示「客服已于 X 时更新」，而不用去碰备注表。
alter table support_requests
  add column if not exists last_operator_update_at timestamptz;

comment on column support_requests.last_operator_update_at is
  'AUD-08：运营最后一次改状态/加备注的时刻。给客户看「有人在处理」，不含备注内容。';
