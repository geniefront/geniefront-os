-- ════════════════════════════════════════════════════════════════════════════
--  0009 · Phase 1b 新表的 RLS、财务不可删、日结与班次的完整性约束
--
--  migrate.ts 末尾那条断言会兜住漏开 RLS 的表，但它只在跑迁移时才响；
--  该主动补的还是要主动补，别把断言当设计。
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'ticket_groups','compensation_plans','earnings',
    'day_closes','cash_movements','tip_payouts',
    'shift_templates','shifts'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (org_id = app_org_id()) with check (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

grant select, insert, update, delete on
  ticket_groups, compensation_plans, earnings,
  day_closes, cash_movements, tip_payouts,
  shift_templates, shifts
  to app_user;

-- ── 财务不删除，只冲销（宪法第 9 条）─────────────────────────────────────────
--
-- ⚠️ 这条同时修掉一个 Phase 1a 的实现错误：
-- 原来的 ticket.void 走的是 `delete from tip_allocations`，
-- 而 0005 已经对 app_user 撤销了那张表的 DELETE 权限 ——
-- 「作废一张已经分过小费的单」在生产上会直接抛权限错。
-- 之所以一直没被撞见，是因为作废通常发生在结账前，那时还没有分配行。
--
-- 正确做法是冲销：写 reversed_at，钱的痕迹留着，统计里排除。
revoke delete on earnings, tip_payouts, day_closes, cash_movements from app_user;

--
-- ⚠️ 只挡 app_user，不挡迁移/种子用的那个角色。
--
-- 应用**永远**用 app_user 连库（宪法第 5 条，CI 有 lint、测试第一条就断言），
-- 所以挡住它就等于挡住了产品里的所有路径。而能用 postgres 连库的人
-- 本来就能 drop table —— 对他们摆一道触发器不增加任何安全性，
-- 只会让开发机重新灌种子数据时卡死在一堆删不掉的历史流水上。
create or replace function money_no_delete() returns trigger
language plpgsql as $$
begin
  if current_user = 'app_user' then
    raise exception '财务记录不可删除，只能冲销（reversed_at）或作废'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

-- 0005 建的 tickets/payments 触发器共用 tickets_no_delete()，一并对齐
create or replace function tickets_no_delete() returns trigger
language plpgsql as $$
begin
  if current_user = 'app_user' then
    raise exception '财务记录不可删除，只能作废（void）'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

do $$
declare t text;
begin
  foreach t in array array['earnings','tip_payouts','day_closes','cash_movements'] loop
    execute format('drop trigger if exists %I_no_delete on %I', t, t);
    execute format(
      'create trigger %I_no_delete before delete on %I
         for each row execute function money_no_delete()', t, t);
  end loop;
end $$;

-- earnings / tip_allocations 挂在 ticket 上是 on delete cascade，
-- 但 tickets 本身也不可删除，所以这条级联永远不会触发 —— 留着是防御，不是路径。

-- ── 日结：一天一条，差异大了必须写原因 ──────────────────────────────────────
alter table day_closes drop constraint if exists day_close_status_valid;
alter table day_closes add constraint day_close_status_valid
  check (status in ('open','counted','closed'));

-- 封账时点钞数与刷卡机数都必须已经填过 —— 「封了但没数」是最没用的一种日结
alter table day_closes drop constraint if exists day_close_needs_count;
alter table day_closes add constraint day_close_needs_count
  check (status <> 'closed' or counted_cash_cents is not null);

-- 差异超过 $2 必须有原因。阈值与 packages/payroll/src/settle.ts 里的
-- VARIANCE_REASON_THRESHOLD_CENTS 必须一致 —— 改一处要改两处，
-- 所以这里写死数字并留下这行注释，而不是各写各的。
alter table day_closes drop constraint if exists cash_variance_needs_reason;
alter table day_closes add constraint cash_variance_needs_reason
  check (
    status <> 'closed'
    or cash_variance_cents is null
    or abs(cash_variance_cents) < 200
    or (cash_variance_reason is not null and length(btrim(cash_variance_reason)) > 0)
  );

alter table day_closes drop constraint if exists card_variance_needs_reason;
alter table day_closes add constraint card_variance_needs_reason
  check (
    status <> 'closed'
    or card_variance_cents is null
    or card_variance_cents = 0
    or (card_variance_reason is not null and length(btrim(card_variance_reason)) > 0)
  );

-- ── 现金小费发放：发出去的钱不能是负数，账要自洽 ────────────────────────────
alter table tip_payouts drop constraint if exists tip_payout_balances;
alter table tip_payouts add constraint tip_payout_balances
  check (paid_cents >= 0 and owed_cents = paid_cents + carry_out_cents);

-- ── 收款：现金找零与「不用找了」的自洽 ──────────────────────────────────────
--
-- keep_change 时找零必须是 0（那笔钱已经变成小费了）；
-- 记了实收就必须够付。不加这两条，日结的现金永远会差出「不用找了」的那部分。
alter table payments drop constraint if exists payment_change_consistent;
alter table payments add constraint payment_change_consistent
  check (
    (not keep_change or change_cents = 0)
    and (tendered_cents is null or tendered_cents >= amount_cents + change_cents)
  );

-- ── 班次：起止合法，跨夜用 > 1440 表达 ──────────────────────────────────────
alter table shifts drop constraint if exists shift_bounds_valid;
alter table shifts add constraint shift_bounds_valid
  check (
    start_min >= 0 and start_min < 1440
    and end_min > start_min and end_min - start_min <= 1200
    and break_min >= 0 and break_min < end_min - start_min
    and status in ('planned','published','off')
  );

alter table shift_templates drop constraint if exists shift_template_bounds_valid;
alter table shift_templates add constraint shift_template_bounds_valid
  check (
    weekday between 0 and 6
    and start_min >= 0 and start_min < 1440
    and end_min > start_min and end_min - start_min <= 1200
    and break_min >= 0 and break_min < end_min - start_min
  );

-- ── 提成方案：费率必须落在 0–100%，时薪非负 ─────────────────────────────────
-- 和 tip_policies 挡 house_cut 是同一个道理：只在 UI 和 API 挡不够，
-- 迁移脚本、手工 SQL、早期版本都可能写进离谱的值，然后发一次错的工资。
alter table compensation_plans drop constraint if exists comp_plan_sane;
alter table compensation_plans add constraint comp_plan_sane
  check (
    coalesce((config->>'rateBp')::int, 0) between 0 and 10000
    and coalesce((config->>'retailRateBp')::int, 0) between 0 and 10000
    and coalesce((config->>'hourlyRateCents')::int, 0) >= 0
    and config->>'kind' in ('commission','hourly','commission_vs_hourly','booth_rent')
  );
