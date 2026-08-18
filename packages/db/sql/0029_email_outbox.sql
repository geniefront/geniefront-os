-- ════════════════════════════════════════════════════════════════════════════
--  0029 · 邮件发件箱（预约确认信 / 收据 / 平台通知）
--
--  ⭐ **不引队列。** 路线图里那条待办原文写的是「邮件 + BullMQ」，
--     而 BullMQ 要 Redis —— 直接撞宪法「不自管 Redis」「不在应用节点之间
--     同步状态」。这三种邮件都是「一家店一天几封、晚一秒没人在意、
--     由某个刚发生的动作触发」，一张 outbox 表就够。
--
--  ⭐ **写在事务里，发在事务外。**
--     在事务里发的话：事务回滚了但邮件已经飞出去了 ——
--     客人收到「您的预约已确认」，而库里根本没有这条预约。
--     这和 Stripe 那条纪律是同一件事：**邮件和扣款一样收不回来**。
--
--  ⭐ **内容在写入时就渲染好**，不是发的时候再去查库拼。
--     发的时候数据可能已经变了（预约被改期），那样发出去的内容
--     和「当时发生了什么」对不上，事后查一封信到底写了什么也无从查起。
--     这一行就是那封信本身。
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists email_outbox (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid references locations(id),

  -- appointment_confirm | appointment_changed | receipt | platform_notice
  kind          text not null,

  to_email      text not null,
  subject       text not null,
  body_html     text not null,
  body_text     text not null,

  -- ⭐ 幂等键：同一件事只发一封。
  -- 邮件发出去收不回来 —— 重复的确认信会让客人以为自己订了两次，
  -- 然后打电话来问，而前台在系统里只看得到一条预约。
  entity_type   text not null,
  entity_id     uuid not null,

  status        text not null default 'pending',   -- pending | sent | failed
  attempts      integer not null default 0,
  last_error    text,
  provider_id   text,                              -- Resend 的 message id

  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_outbox_status') then
    alter table email_outbox add constraint email_outbox_status
      check (status in ('pending','sent','failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_outbox_kind') then
    alter table email_outbox add constraint email_outbox_kind
      check (kind in ('appointment_confirm','appointment_changed','receipt','platform_notice'));
  end if;
end $$;

-- 同一个实体的同一种信只发一封
create unique index if not exists email_outbox_dedupe
  on email_outbox (entity_type, entity_id, kind);

-- 补发时按租户扫自己的待发 —— **绝不跨租户扫**（宪法第 5 条：
-- 那需要一个能看到所有店的连接，apps/ 拿不到）。触发点挂在这家店
-- 自己的请求后面，和 maybeAutoTopup 同一个套路。
create index if not exists email_outbox_pending
  on email_outbox (location_id, created_at)
  where status = 'pending';

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table email_outbox enable row level security;
alter table email_outbox force  row level security;
drop policy if exists tenant_isolation on email_outbox;
create policy tenant_isolation on email_outbox
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update on email_outbox to app_user;

-- 发件记录是「我们对客人说过什么」的凭据，和通话记录同一条纪律：
-- 客人说「你们从来没通知过我」时，这是唯一能拿出来的东西。
revoke delete on email_outbox from app_user;

comment on table email_outbox is
  '邮件发件箱。写在业务事务里、发在事务外 —— 邮件和扣款一样收不回来，'
  '在事务里发的话回滚之后客人已经收到了「预约已确认」而库里没有这条预约。';
