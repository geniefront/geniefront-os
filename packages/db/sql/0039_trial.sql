-- 0039 · 七天免费试用（批 1，docs/03 Phase 2.9）
--
-- 试用走 Stripe 的 trial_period_days，**仍然绑卡** —— 卡在 Stripe 那边，
-- 我们碰不到。所以建租户那条链路一个字都不用改：幂等键仍然是
-- checkout session id，`gf_provision_tenant()` 原样保留。
--
-- 这里只加两列，都是从 Stripe 同步下来的镜像，不是我们自己算的。

alter table billing_accounts
  -- Stripe 订阅上的 trial_end。null = 不在试用期（从未试用，或已经转正）
  add column if not exists trial_ends_at timestamptz,
  -- ⭐ 「还有 3 天到期」那封信发过没有。
  -- Stripe 的 customer.subscription.trial_will_end 会重投，
  -- 没有这一列的话老板会收到好几封一模一样的催款信。
  add column if not exists trial_will_end_notified_at timestamptz;

comment on column billing_accounts.trial_ends_at is
  '试用结束时刻，镜像 Stripe subscription.trial_end。null = 不在试用期';
comment on column billing_accounts.trial_will_end_notified_at is
  '到期前提醒信已发出的时刻。Stripe 会重投 trial_will_end，靠这一列去重';

-- 在试用期内、且还没到期的账户
create index if not exists billing_accounts_trialing_idx
  on billing_accounts (trial_ends_at)
  where trial_ends_at is not null;

-- 试用提醒信是一种新的 outbox 类型。
--
-- ⚠️⚠️ email_outbox.kind 是**白名单 check**（sql/0029 建，0038 扩过一次）。
-- 加一档只能「drop 掉整条再按全量列表重建」——所以下面这一行必须是
-- **当前全部类型的完整清单**，漏掉任何一个，那个类型的历史行会让
-- 这条迁移直接失败（0039 第一版就漏了 form_invite，撞了一次）。
--
-- 再加新类型时：复制下面这一行，在末尾追加，不要凭记忆重写。
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'email_outbox_kind') then
    alter table email_outbox drop constraint email_outbox_kind;
  end if;
  alter table email_outbox add constraint email_outbox_kind
    check (kind in ('appointment_confirm','appointment_changed','receipt',
                    'platform_notice','form_invite','trial_ending'));
end $$;
