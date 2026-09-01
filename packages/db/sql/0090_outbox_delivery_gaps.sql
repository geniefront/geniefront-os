-- ════════════════════════════════════════════════════════════════════════════
--  0090 · 补上发件箱的两个投递缺口
--
--  两个缺陷的共同点：**都不报错**。信老老实实躺在发件箱里，状态是
--  `pending`，没有任何日志说它发不出去。
--
--  ## 缺口一：`appointment_reminder` 不在邮件 kind 白名单里
--
--  0029 建 `email_outbox` 时白名单只有四个值，后续几批陆续补进了
--  `form_invite` / `trial_ending` / `payment_failed` / `subscription_canceled`，
--  唯独漏了 `appointment_reminder` —— 而次日提醒是 0088 才做的调度器，
--  它走**邮件**渠道时每一条都会撞这条 check。
--
--  ⚠️ 撞了之后被通知链路的 try/catch 吞掉（那一层的纪律是「通知永不阻断
--  业务」），于是表现为：短信提醒正常，邮件提醒一条没有，日志里只有一行
--  「该门店本轮失败」。
--
--  ## 缺口二：没有兜底的投递扫描
--
--  投递此前**只由业务动作触发**：`appointment.create` 之后、公开预约之后、
--  入站短信之后。由此产生一个方向反了的后果 ——
--
--    · Stripe webhook 写进来的三封计费信，没有任何触发点会投递它们；
--    · 而**扣款失败的门店会被冻结成只读**，开不了单，也就永远触发不了
--      那一次 `appointment.create`。
--
--  也就是说：最需要收到「你的卡扣不上了」这封信的店，恰恰是唯一收不到的。
--
--  本函数给一个兜底扫描用：找出还有待发件的租户，由应用逐个 flush。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 邮件 kind 白名单补上次日提醒 ───────────────────────────────────────
alter table email_outbox drop constraint if exists email_outbox_kind;
alter table email_outbox add constraint email_outbox_kind
  check (kind in (
    'appointment_confirm', 'appointment_changed', 'appointment_reminder',
    'receipt', 'platform_notice', 'form_invite',
    'trial_ending', 'payment_failed', 'subscription_canceled'
  ));

/*
 * ⚠️ `receipt` 保留在白名单里，尽管小票功能已于 2026-09-01 移除。
 * 历史行还带着这个值，收窄白名单会让那些行在任何一次 update 时失败 ——
 * 而它们是「我们对顾客说过什么」的凭据，不能动。
 */

-- ── 2. 兜底投递扫描的取件函数 ─────────────────────────────────────────────
--
-- ## 为什么必须是 SECURITY DEFINER
--
-- 「哪些租户还有信没发」是跨租户的问题，而 `apps/` 拿不到能看见所有租户的
-- 连接（宪法第 5 条）。与 `gf_appointments_due_for_reminder`（0088）同一个
-- 套路：函数只回答「该找谁」，真正读写发件箱仍要按门店 withTenant 进去。
--
-- ⚠️ `p_older_than_seconds` 不能省。入队之后调用方通常会立刻 flush 一次，
-- 兜底扫描如果连刚入队的行也算进去，两边会同时对同一封信发起投递。
create or replace function gf_outbox_pending_tenants(
  p_older_than_seconds integer default 120,
  p_limit integer default 100
) returns table (
  org_id uuid,
  location_id uuid,
  email_pending bigint,
  sms_pending bigint
)
language sql security definer set search_path = public
as $$
  with pending as (
    select e.org_id, e.location_id, 1 as is_email, 0 as is_sms
    from email_outbox e
    where e.status = 'pending'
      and e.attempts < 3
      and e.created_at < now() - make_interval(secs => p_older_than_seconds)
    union all
    select s.org_id, s.location_id, 0, 1
    from sms_outbox s
    where s.status = 'pending'
      and s.attempts < 3
      and s.created_at < now() - make_interval(secs => p_older_than_seconds)
      -- 静默时段内的营销短信不算「待投递」：现在扫到它也发不出去，
      -- 只会让每一轮都白唤醒一次这家店（判定口径在 sms/flush.ts）
      and (s.quiet_hours = false or exists (
        select 1 from locations l
        where l.id = s.location_id
          and extract(hour from (now() at time zone l.timezone)) between 8 and 20
      ))
  )
  select
    p.org_id,
    p.location_id,
    sum(p.is_email)::bigint as email_pending,
    sum(p.is_sms)::bigint   as sms_pending
  from pending p
  where p.location_id is not null
  group by p.org_id, p.location_id
  order by p.org_id, p.location_id
  limit p_limit
$$;

revoke all on function public.gf_outbox_pending_tenants(integer, integer)
  from public, anon, authenticated;
grant execute on function public.gf_outbox_pending_tenants(integer, integer) to app_user;

comment on function public.gf_outbox_pending_tenants(integer, integer) is
  '还有待发件的租户。跨租户只读，调用方仍须按门店进 withTenant 才发得动。'
  '⚠️ 只返回入队超过 p_older_than_seconds 的，避免与入队后的即时投递重复（0090）。';
