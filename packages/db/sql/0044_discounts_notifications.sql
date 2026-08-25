-- 0044 · 折扣明细 + 通知模板（批 7）
--
-- 两块互不相干，放一条迁移是因为它们都是「解锁性的地基」：
-- 前者解锁「漏损率」这个能卖钱的指标，后者解锁技师侧那四条通知
-- （AI 改期/取消之后客人得知道，见 docs/09 批 3 那一段留的口子）。

-- ══════════════════════════════════════════════════ ① 折扣明细
--
-- 现状：只有 day_closes.discount_cents 一个汇总数。
-- 谁给的、为什么给、挂在哪个 item 上，全都没记。
--
-- ⭐ 华人店的折扣是**前台口头给的、现场给的** —— 老熟客说一句
-- 「今天给我便宜十块」，前台就按了。月底老板看到一个总数，
-- 但不知道那是二十个十块还是两个一百块，也不知道是谁批的。
-- 竞品把这个做成了「Refund + Discount Leakage」指标，我判断那是
-- 他们最容易卖钱的一个数 —— 而它全靠这张明细表。

create table if not exists discount_reasons (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  /** 预置原因，老板自己维护。如「老客关照」「服务失误补偿」「员工亲友」 */
  label       jsonb not null,
  /**
   * ⭐ 超过这个金额要授权。null = 不限。
   *
   * 前台自己能批多少是个真实的管理问题：不设限的话，一个新前台
   * 可以整天给人打五折；设死了又会让她每次都要去找老板。
   */
  max_self_approve_cents integer,
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists ticket_discounts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  ticket_id   uuid not null references tickets(id) on delete cascade,
  /** 挂在哪一项上。null = 整单折扣 */
  ticket_item_id uuid references ticket_items(id) on delete cascade,
  reason_id   uuid references discount_reasons(id),
  /** 预置原因之外的自由说明。两者至少要有一个 */
  reason_text text,
  /**
   * amount（固定金额）/ percent（百分比）。
   * ⚠️ 无论哪种，`amount_cents` 都是**折算之后的实际金额** ——
   * 报表和日结只读这一列，不需要每次再算一遍百分比。
   * `percent_bp` 只是留个痕，说明当初是怎么给的。
   */
  kind        text not null check (kind in ('amount', 'percent')),
  amount_cents integer not null check (amount_cents >= 0),
  percent_bp  integer check (percent_bp is null or (percent_bp > 0 and percent_bp <= 10000)),
  /** 谁给的。⚠️ 不可空 —— 「不知道是谁批的」正是这张表要消灭的东西 */
  granted_by  uuid not null references memberships(id),
  /** 超额时是谁批的。null = 在自助额度内 */
  approved_by uuid references memberships(id),
  /** 只冲销不删除（宪法第 9 条） */
  reversed_at timestamptz,
  reversed_by uuid references memberships(id),
  created_at  timestamptz not null default now()
);

create index if not exists ticket_discounts_ticket_idx on ticket_discounts (ticket_id);
create index if not exists ticket_discounts_day_idx
  on ticket_discounts (location_id, created_at) where reversed_at is null;

comment on table ticket_discounts is
  '每一笔折扣的明细。谁给的、为什么、多少 —— 「漏损率」这个指标全靠它';
comment on column ticket_discounts.granted_by is
  '不可空：「不知道是谁批的」正是这张表存在的理由';

-- ══════════════════════════════════════════════════ ② 通知模板
--
-- 现状：写死在 email/render.ts 和 sms/render.ts 里，店主改不了加不了关不了。
--
-- ⭐ **模板要版本化。** 改了模板之后，已经入队但还没发出去的消息
-- 必须用**旧版本**渲染 —— 不然一条昨天生成的确认信会带上今天改的措辞，
-- 而 outbox 那一行本来就该是「那封信本身」（email/render.ts 的文件头注释）。

create table if not exists notification_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  /**
   * 事件键。三组：
   *   客户侧 appointment_confirm / appointment_changed /
   *          appointment_cancelled / appointment_reminder
   *   技师侧 staff_pending_confirm / staff_assigned /
   *          staff_changed / staff_cancelled
   *   营销侧 birthday / holiday / winback / review_request
   */
  event_key   text not null,
  channel     text not null check (channel in ('sms', 'email')),
  locale      text not null default 'en',
  version     integer not null default 1,
  subject     text,
  body        text not null,
  active      boolean not null default true,
  updated_by  uuid references memberships(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 同一个事件 × 渠道 × 语言，同时只有一个**最新版本**在用；
-- 旧版本留着，因为队列里可能还有引用它的消息
create unique index if not exists notif_tpl_uidx
  on notification_templates (location_id, event_key, channel, locale, version);

create table if not exists notification_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  event_key   text not null,
  enabled     boolean not null default true,
  /**
   * 延迟多少分钟发。负数 = 事件发生**之前**（提醒类用）。
   * 例：`-1440` = 提前一天提醒
   */
  offset_min  integer not null default 0,
  /** 走哪些渠道。空数组 = 这条规则关着 */
  channels    text[] not null default '{}'::text[],
  updated_by  uuid references memberships(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists notif_rule_uidx
  on notification_rules (location_id, event_key);

comment on table notification_templates is
  '通知模板。⚠️ 版本化：改模板之后，队列里已有的消息仍用旧版本渲染 ——'
  ' outbox 那一行就是「那封信本身」，内容不该事后漂移';

-- outbox 要记住自己是用哪个模板哪一版渲染的
alter table email_outbox
  add column if not exists template_id uuid references notification_templates(id),
  add column if not exists template_version integer;

-- ══════════════════════════════════════════════════ RLS
do $$
declare t text;
begin
  foreach t in array array['discount_reasons','ticket_discounts',
                           'notification_templates','notification_rules'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) '
      || 'with check (org_id = app_org_id())', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;
