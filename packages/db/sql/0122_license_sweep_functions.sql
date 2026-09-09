-- ════════════════════════════════════════════════════════════════════════════
--  0122 · 订阅码到期扫描要用的三个窄口（计划批 5）
--
--  ## 为什么扫描不能直接写 SQL
--
--  `billing_accounts` 是 enable + force RLS + tenant_isolation。定时任务
--  跑在**没有租户上下文**的连接上（`app_org_id()` 为 null），于是一句
--  `update billing_accounts … where license_period_end <= now()` 会**匹配零行**
--  —— 不报错、不告警，只是什么都没发生。
--
--  这一条踩过：`ops/licenseSweep.ts` 第一版正是那么写的，三个用例全绿地
--  返回 0。跨租户扫描必须走 SECURITY DEFINER 窄口，和
--  `gf_outbox_pending_tenants`（sql/0090）、`gf_appointments_due_for_reminder`
--  （sql/0088）、`gf_purge_command_idempotency`（sql/0078）完全一样。
--
--  ## 三个函数各自只做一件事
--
--    · gf_license_expire_due()      到期 → expired，返回被改的门店
--    · gf_license_expiring_soon()   还有几天到期的（只读，给提醒信取件）
--    · gf_license_roll_included()   套餐内额度按整段推进 + 清零
--
--  提醒信本身**不在这里发**：那要按门店语言渲染、要写 outbox，是应用的事。
--  这里只回答「哪几家店该发」。
-- ════════════════════════════════════════════════════════════════════════════

/**
 * 到期 → `expired`（冻结写入，读照常）。
 *
 * ⚠️ 只动 `billing_source = 'license'` 的行。Stripe 权威的行由 webhook 说了算；
 * 在这里顺手改一把的话，两个权威就同时在写同一列 —— 那正是 0120 要防的事。
 */
create or replace function public.gf_license_expire_due(p_limit int default 500)
returns table (org_id uuid, location_id uuid, license_period_end timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select ba.id from billing_accounts ba
     where ba.billing_source = 'license'
       and ba.license_period_end is not null
       and ba.license_period_end <= now()
       and ba.subscription_status <> 'expired'
     order by ba.license_period_end
     limit greatest(coalesce(p_limit, 500), 1)
  )
  update billing_accounts b set subscription_status = 'expired'
   where b.id in (select id from due)
  returning b.org_id, b.location_id, b.license_period_end;
end $$;

/**
 * 还有几天到期、且这一轮还没发过提醒的门店。
 *
 * `days_left` 用 `ceil` —— 还剩 6.4 天要算 7 天那一档，
 * 而不是掉进「6 天」这个没有任何档位的缝里（那家店就此收不到提醒）。
 */
create or replace function public.gf_license_expiring_soon(
  p_horizon_days int,
  p_limit int default 200
) returns table (
  org_id uuid, location_id uuid, license_period_end timestamptz, days_left int
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  return query
  select ba.org_id, ba.location_id, ba.license_period_end,
         ceil(extract(epoch from (ba.license_period_end - now())) / 86400)::int
    from billing_accounts ba
   where ba.billing_source = 'license'
     and ba.license_period_end is not null
     and ba.license_period_end > now()
     and ba.license_period_end <= now() + (greatest(coalesce(p_horizon_days, 7), 1) || ' days')::interval
     and ba.license_expiry_notified_at is null
   order by ba.license_period_end
   limit greatest(coalesce(p_limit, 200), 1);
end $$;

/**
 * 套餐内额度按固定周期滚动清零。
 *
 * Stripe 权威下清零跟着 `customer.subscription.updated` 里 period_end 的变化走
 * （`applySubscriptionToRow` 的 `renewed`）。license 模式没有那条事件，
 * 只能自己划边界。
 *
 * ⭐ **推进 `included_period_start += 整数个周期`，而不是设成 `now()`。**
 * 设成 now() 的话，每一轮扫描的时刻抖动都会累加进账期起点，
 * 半年之后「这个月」的边界已经漂到月中 —— 而老板算的是自然月。
 *
 * ⚠️ 一次补齐多段（`floor(已过去 / 周期)`）：一家停用三个月又续期的店，
 * 起点要一次跳到最近的那个边界，不能只推一格。
 */
create or replace function public.gf_license_roll_included(
  p_period_days int default 30,
  p_limit int default 500
) returns table (org_id uuid, location_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
declare
  v_days int := greatest(coalesce(p_period_days, 30), 1);
begin
  return query
  with due as (
    select ba.id from billing_accounts ba
     where ba.billing_source = 'license'
       and ba.included_period_start is not null
       and now() - ba.included_period_start >= (v_days || ' days')::interval
       -- 已经到期的店不必清零：它一次调用也发不出去（写入被冻结），
       -- 而清零会让「他上个月用了多少」在续期后没法回答
       and ba.subscription_status <> 'expired'
     limit greatest(coalesce(p_limit, 500), 1)
  )
  update billing_accounts b set
    included_credits_used = 0,
    included_minutes_used = 0,
    included_period_start = b.included_period_start
      + (floor(extract(epoch from (now() - b.included_period_start)) / (v_days * 86400))
         * v_days || ' days')::interval
   where b.id in (select id from due)
  returning b.org_id, b.location_id;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.gf_license_expire_due(int)',
    'public.gf_license_expiring_soon(int, int)',
    'public.gf_license_roll_included(int, int)'
  ] loop
    -- 同 sql/0083：收 PUBLIC 收不掉 Supabase 给 anon / authenticated 的那两份
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to app_user', fn);
  end loop;
end $$;

comment on function public.gf_license_expire_due(int) is
  '订阅码到期 → subscription_status = expired。只动 billing_source = license 的行。'
  '由 ops/licenseSweep.ts 定时调用（sql/0122）。';
