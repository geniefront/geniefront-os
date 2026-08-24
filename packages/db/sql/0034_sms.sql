-- ════════════════════════════════════════════════════════════════════════════
--  0034 · 短信：发件箱 + 同意状态 + 收件留档
--
--  10DLC 在 2026-08-22 批准（brand BC024MG / campaign CFH5JPS ACTIVE），
--  宪法第 13 条「门店数 ≥ 10 家之前不写短信依赖」由店主明确解除。
--
--  ⭐ 三张表，各自回答一个问题：
--     sms_outbox   我们要对这个号说什么（写在事务里，发在事务外）
--     sms_consent  这个号还让不让我们发（**平台级**，见下面那段长注释）
--     sms_inbound  这个号对我们说过什么（凭据，永不删）
--
--  ⚠️ 短信仍然**不进依赖链**（宪法第 14 条没解除）：发不出去照样建单，
--     最坏是前台打个电话。解除的只是「不许写」，不是「可以阻断」。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 发件箱（结构照抄 email_outbox，理由见 0029 的头注释）─────────────────
create table if not exists sms_outbox (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid references locations(id),

  -- appointment_confirm | appointment_changed | appointment_reminder | help_reply
  kind          text not null,

  to_e164       text not null,
  from_e164     text not null,
  -- ⭐ 写入时就渲染好。发的时候数据可能已经变了（预约被改期），
  -- 那样发出去的内容和「当时发生了什么」对不上
  body          text not null,

  -- ⭐ 计费凭据：**按 segment 记，不按条**。
  -- 一条 160 字符以内的英文是 1 段，超了按 153 切；一旦混进非 GSM 字符
  -- 整条转 UCS-2，70/67 切 —— 按条记会低估一倍以上（docs/09 §5）
  segments      integer not null default 1,

  -- 幂等键：同一件事只发一条
  entity_type   text not null,
  entity_id     uuid not null,

  status        text not null default 'pending',   -- pending | sent | failed | suppressed
  attempts      integer not null default 0,
  last_error    text,
  provider_id   text,                              -- Telnyx message id

  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_outbox_status') then
    alter table sms_outbox add constraint sms_outbox_status
      check (status in ('pending','sent','failed','suppressed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sms_outbox_kind') then
    alter table sms_outbox add constraint sms_outbox_kind
      check (kind in ('appointment_confirm','appointment_changed',
                      'appointment_reminder','help_reply'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sms_outbox_e164') then
    alter table sms_outbox add constraint sms_outbox_e164
      check (to_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;

create unique index if not exists sms_outbox_dedupe
  on sms_outbox (entity_type, entity_id, kind);

create index if not exists sms_outbox_pending
  on sms_outbox (location_id, created_at)
  where status = 'pending';

alter table sms_outbox enable row level security;
alter table sms_outbox force  row level security;
drop policy if exists tenant_isolation on sms_outbox;
create policy tenant_isolation on sms_outbox
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update on sms_outbox to app_user;
-- 发过什么是「我们对客人说过什么」的凭据，和邮件、通话记录同一条纪律
revoke delete on sms_outbox from app_user;

-- ── 2. ⭐ 同意状态：**平台级，不分租户** ───────────────────────────────────
--
-- 这是这份迁移里唯一一张**没有 org_id** 的业务表，是想清楚了的：
--
-- 所有门店的短信都从**同一个号**（TELNYX_SMS_FROM）、以**同一个 brand**
-- （GenieFront）发出去。客人回 STOP 是对**这个发送者**说的，不是对某一家店 ——
-- 法律上和运营商那一层都是如此：运营商会在网络层直接掐掉这个号到他的所有短信。
--
-- 所以按 org 存 opt-out 是错的：A 店收到 STOP、B 店照发，
-- 客人看到的是「我明明退订了还在发」，而运营商看到的是我们无视 STOP。
--
-- 代价（认了）：任何一家店的上下文都能查到「某个号退订过」。
-- 这一行里除了号码本身没有别的东西 —— 而发信的人本来就有这个号码。
create table if not exists sms_consent (
  phone_e164    text primary key,
  -- opted_out = 收到过 STOP 类关键词；opted_in = 之后又发了 START 类
  state         text not null,
  -- 触发这次变更的原话关键词，出事时要拿得出「他当时发的是哪个词」
  keyword       text,
  updated_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_consent_state') then
    alter table sms_consent add constraint sms_consent_state
      check (state in ('opted_out','opted_in'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sms_consent_e164') then
    alter table sms_consent add constraint sms_consent_e164
      check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;

alter table sms_consent enable row level security;
alter table sms_consent force  row level security;
drop policy if exists platform_wide on sms_consent;
-- ⚠️ 故意不按 org 隔离，理由见上面。RLS 仍然开着（force），
-- 只是策略是「所有 app_user 都能读写」—— 写成 `using (true)` 而不是
-- 关掉 RLS，是为了让「这张表是有意敞开的」在 pg_policies 里查得到
create policy platform_wide on sms_consent
  using (true) with check (true);

grant select, insert, update on sms_consent to app_user;
revoke delete on sms_consent from app_user;

-- ── 3. 收件留档 ────────────────────────────────────────────────────────────
--
-- ⚠️ **CANCEL 这个词在预约系统里是有歧义的**（docs/09 §5.3）：
-- 运营商规定它必须触发退订，而客人打这四个字母多半是想取消预约。
-- 两件事我们都做不了主 —— 但至少要把原话留下来，
-- 前台事后能看到「这个人 3 点 12 分发过 CANCEL」。
create table if not exists sms_inbound (
  id            uuid primary key default gen_random_uuid(),
  from_e164     text not null,
  to_e164       text not null,
  body          text not null,
  -- opt_out | opt_in | help | unknown
  intent        text not null,
  provider_id   text,
  received_at   timestamptz not null default now()
);

create index if not exists sms_inbound_from on sms_inbound (from_e164, received_at desc);

alter table sms_inbound enable row level security;
alter table sms_inbound force  row level security;
drop policy if exists platform_wide on sms_inbound;
-- 同 sms_consent：入站 webhook 没有租户上下文（`to` 是平台号，不属于任何店）
create policy platform_wide on sms_inbound
  using (true) with check (true);

grant select, insert on sms_inbound to app_user;

comment on table sms_consent is
  '短信同意状态。⚠️ 平台级、不分租户 —— 所有门店共用一个发送号和一个 10DLC '
  'brand，客人回 STOP 是对这个发送者说的，按 org 存会导致「A 店退订 B 店照发」。';
