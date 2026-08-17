-- ════════════════════════════════════════════════════════════════════════════
--  0024 · 让账本上「钱」那两列退休（0023 的收尾）
--
--  0023 把账本从「钱」改成了「积分 / 分钟」，但 `amount_cents` /
--  `balance_after_cents` 是 `not null`，于是新行只能写 0 —— 而 0 立刻
--  撞上 0018 那条方向约束（`kind='topup' 时 amount_cents 必须 > 0`）。
--
--  写 0 本身也是错的：**0 的意思是「这笔金额是零」，而事实是「这一笔
--  跟钱没关系」**。这两件事在对账时会被读成完全不同的意思。
--
--  所以：两列改成可空，新行写 null。历史行原样留着（宪法第 9 条，
--  财务数据不删）—— 它们记录的是真实发生过的钱。
--
--  ⚠️ 方向约束换成只管新的 `amount` 列（0023 已经加了 `credit_ledger_unit_direction`）。
-- ════════════════════════════════════════════════════════════════════════════

alter table credit_ledger drop constraint if exists credit_ledger_direction;

alter table credit_ledger alter column amount_cents drop not null;
alter table credit_ledger alter column balance_after_cents drop not null;

-- 新账本的两列反过来必须有值：`amount is null` 只该出现在 0023 之前的历史行上
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'credit_ledger_new_or_legacy') then
    -- 要么是新账本的行（有 amount + balance_after），
    -- 要么是历史的钱行（有 amount_cents）。不能两边都空 —— 那是一条没有意义的记录
    alter table credit_ledger add constraint credit_ledger_new_or_legacy
      check (
        (amount is not null and balance_after is not null)
        or amount_cents is not null
      );
  end if;
end $$;
