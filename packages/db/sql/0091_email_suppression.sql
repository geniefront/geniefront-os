-- ════════════════════════════════════════════════════════════════════════════
--  0091 · 退信 / 投诉回流与邮件抑制名单
--
--  ## 此前的缺口
--
--  信发出去之后，系统对它的下场**一无所知**：`email_outbox.status` 停在
--  `sent`，那只表示 Resend 收下了这一封，不表示收件方收下了。于是
--
--    · 一个早已不存在的邮箱，每次预约都再退信一次；
--    · 一位点了「举报垃圾邮件」的顾客，下个月照样收到营销邮件。
--
--  两者都直接损害发信域名信誉，而信誉一旦掉下去，受损的是**所有门店的
--  事务性邮件送达率** —— 预约确认进垃圾箱这件事，没有任何人会来投诉。
--
--  ## ⚠️ 抑制名单是平台级的，不按 org 隔离
--
--  与 `sms_consent`（0034）完全同一条理由：退信与投诉是**收件人与我们这个
--  发信域名之间**的事实，不是与某一家门店之间的。按 org 存的话，A 店把某个
--  地址发到硬退，B 店照发 —— 而收件方看到的是同一个发信域名反复投递到
--  不存在的邮箱，那正是信誉的扣分项。
--
--  代价（认了）：任何一家店的上下文都能查到「某个地址退过信」。
--  这一行里除了地址本身没有别的东西，而发信的人本来就有这个地址。
--
--  ## 硬退与软退分开
--
--    hard_bounce  地址不存在 / 域名不存在 → **永久**不再发
--    complaint    收件人点了「举报垃圾邮件」→ **永久**不再发，且关掉他的营销订阅
--    soft_bounce  临时性（对方邮箱满了、服务器暂时拒收）→ **不进抑制名单**
--
--  软退也拦的话，一次对方服务器抖动就会让这个顾客永远收不到预约确认。
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists email_suppressions (
  -- 小写后的地址。大小写不同的同一个邮箱是同一个收件人
  email       text primary key,
  -- hard_bounce | complaint
  reason      text not null,
  /** 供应商侧的事件 id / 邮件 id，出事时要对得回去 */
  provider_id text,
  /** 供应商给的原始描述，截断存。排查「为什么这个地址被拦了」用 */
  detail      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table email_suppressions drop constraint if exists email_suppressions_reason;
alter table email_suppressions add constraint email_suppressions_reason
  check (reason in ('hard_bounce', 'complaint', 'manual'));

alter table email_suppressions enable row level security;
alter table email_suppressions force  row level security;
drop policy if exists platform_wide on email_suppressions;
-- ⚠️ 故意不按 org 隔离，理由见文件头。RLS 仍然开着（force），
-- 策略写成 `using (true)` 而不是关掉 RLS —— 让「这张表是有意敞开的」
-- 在 pg_policies 里查得到（与 sms_consent 同一种写法）。
create policy platform_wide on email_suppressions
  using (true) with check (true);

grant select, insert, update on email_suppressions to app_user;
-- ⚠️ 不给 delete：解除抑制是一次需要人来负责的决定，走运维而不是应用
revoke delete on email_suppressions from app_user;

comment on table email_suppressions is
  '硬退信与垃圾邮件投诉的地址。平台级，不按 org 隔离（与 sms_consent 同理）。'
  '⚠️ 软退不进这张表 —— 一次对方服务器抖动不该让顾客永远收不到预约确认（0091）。';

-- ── 发件箱记住这一封的下场 ────────────────────────────────────────────────
--
-- `sent` 只表示 Resend 收下了。真正的下场由 webhook 回流，落在这两列上。
alter table email_outbox
  add column if not exists delivery_state text,
  add column if not exists delivery_at timestamptz;

alter table email_outbox drop constraint if exists email_outbox_delivery_state;
alter table email_outbox add constraint email_outbox_delivery_state
  check (delivery_state is null or delivery_state in (
    'delivered', 'delayed', 'soft_bounce', 'hard_bounce', 'complained'
  ));

comment on column email_outbox.delivery_state is
  '供应商回流的最终下场。null = 还没有回流（0091）。'
  '⚠️ 与 status 是两回事：status=sent 只表示 Resend 收下了这一封。';

create index if not exists email_outbox_provider_idx
  on email_outbox (provider_id) where provider_id is not null;

-- ── 跨租户写回：webhook 背后没有租户上下文 ────────────────────────────────
--
-- 供应商回调只带得出一个邮件 id，带不出 org / location。而 `email_outbox`
-- 有 RLS。与 `gf_billing_tenant_for_stripe_refs`（0072）同一个套路：
-- 开一个极窄的 SECURITY DEFINER 口子，它只按 provider_id 更新两列。
create or replace function gf_record_email_delivery(
  p_provider_id text, p_state text
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  if p_provider_id is null or p_provider_id = '' then
    return false;
  end if;

  /*
   * ⚠️ 只写 `delivery_state` / `delivery_at`，**不动 `status`**。
   *
   * `status` 记的是「我们这一侧把它交出去了没有」，是重试逻辑的依据；
   * `delivery_state` 记的是「对方收下了没有」。把退信写回 status='failed'
   * 会让补发扫描把一封**已经发出去过**的信再发一遍。
   */
  update email_outbox
     set delivery_state = p_state,
         delivery_at = now()
   where provider_id = p_provider_id;

  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.gf_record_email_delivery(text, text)
  from public, anon, authenticated;
grant execute on function public.gf_record_email_delivery(text, text) to app_user;

comment on function public.gf_record_email_delivery(text, text) is
  '把供应商回流的投递结果写回发件箱。⚠️ 只动 delivery_state，不动 status ——'
  '后者是重试依据，写成 failed 会让已发出的信被补发一遍（0091）。';

-- ── 投诉时关掉该地址的营销订阅 ────────────────────────────────────────────
create or replace function gf_marketing_opt_out_by_email(p_email text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  if p_email is null or p_email = '' then
    return 0;
  end if;

  /*
   * ⚠️ 只关营销，事务性一个字都不动。
   *
   * 顾客点「举报垃圾邮件」表达的是不想再收推广，而他下次自己下单时仍然
   * 需要那封确认信。抑制名单已经拦住了一切发往该地址的邮件；这一步管的
   * 是日后人工解除抑制之后的状态。
   */
  update customers
     set marketing_email_opt_in = false
   where lower(email) = lower(p_email)
     and marketing_email_opt_in = true;

  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.gf_marketing_opt_out_by_email(text)
  from public, anon, authenticated;
grant execute on function public.gf_marketing_opt_out_by_email(text) to app_user;

comment on function public.gf_marketing_opt_out_by_email(text) is
  '收到垃圾邮件投诉时关掉该地址的营销订阅。⚠️ 只关营销，事务性不动（0091）。';
