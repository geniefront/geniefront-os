-- ════════════════════════════════════════════════════════════════════════════
--  0018 · Phase 2：计费（月费 + 预充值余额 + 自动续充）
--
--  钱的表比别处狠一档：
--    · 账本**只追加**，连 update 都收回（宪法第 9 条）
--    · 余额只用整数分（宪法第 4 条），DB 约束兜底
--    · Stripe 事件按 event id 天然幂等 —— 重投不会重复充值
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array['billing_accounts','credit_ledger'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (org_id = app_org_id()) with check (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

grant select, insert, update on billing_accounts to app_user;
-- ⭐ 账本只能追加：连 update 都不给。
-- 冲一笔账要写一条反向记录，不是把原来那条改掉 ——
-- 否则「为什么少了 $12」永远查不清，而这正是客户会打电话来问的那个问题。
grant select, insert on credit_ledger to app_user;

create or replace function ledger_append_only() returns trigger
language plpgsql as $$
begin
  if current_user = 'app_user' then
    raise exception '余额账本只能追加 —— 要冲账请写一条 reversal 记录'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

drop trigger if exists credit_ledger_no_change on credit_ledger;
create trigger credit_ledger_no_change
  before update or delete on credit_ledger
  for each row execute function ledger_append_only();

-- stripe_events 没有 org_id（webhook 到达时还不知道是哪家店），
-- 所以不走 tenant_isolation。它只存「这个事件处理过了」，不含任何业务数据。
grant select, insert, update on stripe_events to app_user;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_topup_tier') then
    -- ⭐ 自动续充只有三档。让客户填任意金额会引来拿被盗的卡试活的人
    alter table billing_accounts add constraint billing_topup_tier
      check (auto_topup_amount_cents in (5000, 10000, 20000));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_threshold_sane') then
    -- 阈值太低会在半夜断服务，太高等于一直在充钱
    alter table billing_accounts add constraint billing_threshold_sane
      check (auto_topup_threshold_cents between 0 and 50000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_plan') then
    alter table billing_accounts add constraint billing_plan
      check (plan in ('starter','pro'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'credit_ledger_kind') then
    alter table credit_ledger add constraint credit_ledger_kind
      check (kind in ('topup','usage','refund','adjustment','reversal'));
  end if;

  -- 方向和类型对不上的行（「充值 −$50」）混进账本之后，对账永远对不平
  if not exists (select 1 from pg_constraint where conname = 'credit_ledger_direction') then
    alter table credit_ledger add constraint credit_ledger_direction
      check (
        (kind = 'topup'  and amount_cents > 0) or
        (kind = 'usage'  and amount_cents < 0) or
        (kind = 'refund' and amount_cents > 0) or
        (kind in ('adjustment','reversal'))
      );
  end if;

  -- 没有原因的调账是查不清的账
  if not exists (select 1 from pg_constraint where conname = 'credit_ledger_reason') then
    alter table credit_ledger add constraint credit_ledger_reason
      check (kind not in ('adjustment','reversal') or reason is not null);
  end if;
end $$;
