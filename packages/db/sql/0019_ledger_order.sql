-- ════════════════════════════════════════════════════════════════════════════
--  0019 · 余额账本要有一个**明确的顺序**
--
--  ⚠️ 这一条是被测试逼出来的，值得写清楚，因为它非常反直觉。
--
--  `credit_ledger.created_at` 原本是 `default now()`。而 Postgres 的 `now()`
--  返回的是**事务开始时刻**，不是语句执行时刻 —— 于是并发扣费时：
--
--      事务 A: 开始(t=10) → 拿行锁 → 写账本(balance_after=-4) → 提交
--      事务 B: 开始(t=9)  → 等锁 …… → 写账本(balance_after=-8) → 提交
--
--  两行的 balance_after 是**按提交顺序**串起来的（行锁保证了这一点），
--  可是按 created_at 排出来 B 在前、A 在后 —— 对账时
--  `findLedgerBreak` 立刻报一个断点，而账本本身一点问题都没有。
--
--  症状极具迷惑性：**并发越高越容易出，而且每次断点位置都不一样**，
--  看起来完全像是有人在篡改账本。
--
--  修法不是放宽检查（那等于把唯一能发现篡改的手段关掉），而是给账本
--  一个不依赖时钟的顺序：**bigserial**。序号在插入那一刻取，
--  而插入必然发生在拿到行锁之后，所以它和 balance_after 的链条严格一致。
-- ════════════════════════════════════════════════════════════════════════════

alter table credit_ledger add column if not exists seq bigserial;

-- 对账、翻流水、算余额一律按它排。created_at 留着给人看
create index if not exists credit_ledger_seq_idx on credit_ledger (location_id, seq);

-- ⚠️ bigserial 会建一个 sequence，app_user 要能取号才插得进去
do $$
begin
  if exists (select 1 from pg_class where relname = 'credit_ledger_seq_seq') then
    execute 'grant usage, select on sequence credit_ledger_seq_seq to app_user';
  end if;
end $$;

-- created_at 也顺手改成语句时刻。它不再决定顺序，但「这笔是几点记的」
-- 差上几百毫秒仍然会让人对着日志时间线看不明白
alter table credit_ledger alter column created_at set default clock_timestamp();

-- ⚠️ seq 是账本顺序的事实来源，同样不许改（只追加触发器已经挡住 update，
-- 这里再加一条 not null 让「插入时不给值」这种写法直接失败而不是静默 null）
alter table credit_ledger alter column seq set not null;
