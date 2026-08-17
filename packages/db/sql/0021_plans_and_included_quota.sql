-- ════════════════════════════════════════════════════════════════════════════
--  0021 · 套餐改名对齐 Stripe + 「先用套餐里的」额度
--
--  两件事，都是老板拍板之后的对齐：
--
--  1. **套餐名以 Stripe 后台为准**：starter → essential、pro → growth。
--     Stripe 上建的是 `GenieFront Essential` ($99) / `GenieFront Growth` ($199)，
--     代码里却叫 starter/pro —— 这种漂移不会立刻出事，但等到有人对着
--     Stripe 后台查一笔账时，两边的名字对不上就没人说得清哪个是哪个。
--     决策 8 原来写的 Pro $149 也一并按实际的 $199 更新。
--
--  2. **额度先用套餐里的，用完了才扣预充值余额**（决策 8 / 04 §4.1）。
--     套餐内额度是**次数**（Essential 500 次副驾 / Growth 2000 次），
--     只管副驾 —— 电话分钟单独成包，合成一个额度必被套利。
--
--     ⚠️ 额度按订阅周期清零，而清零的时机跟着 Stripe 的续订走
--     （`customer.subscription.updated` 里 current_period_end 变了就重置），
--     不自己数日子 —— 自己数就一定会和 Stripe 的账单周期漂开。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 套餐改名 ─────────────────────────────────────────────────────────────
-- 先松开约束再改数据，否则改到一半就被 check 挡住
alter table billing_accounts drop constraint if exists billing_plan;

update billing_accounts set plan = 'essential' where plan = 'starter';
update billing_accounts set plan = 'growth'    where plan = 'pro';

alter table billing_accounts add constraint billing_plan
  check (plan in ('essential','growth'));

alter table billing_accounts alter column plan set default 'essential';

-- ── 2. 充值收窄成一档 $100 ──────────────────────────────────────────────────
-- Stripe 那边就一个 AI Minutes 价格，代码里摆三档迟早对不上。
-- 同样要先松约束再迁数据
alter table billing_accounts drop constraint if exists billing_topup_tier;

update billing_accounts set auto_topup_amount_cents = 10000
where auto_topup_amount_cents <> 10000;

alter table billing_accounts add constraint billing_topup_tier
  check (auto_topup_amount_cents = 10000);

alter table billing_accounts alter column auto_topup_amount_cents set default 10000;

-- ── 3. 套餐内额度的用量计数 ─────────────────────────────────────────────────
alter table billing_accounts
  add column if not exists included_assists_used integer not null default 0;

-- 本期从什么时候开始算。null = 还没开始记（新账户 / 刚迁移上来）
alter table billing_accounts
  add column if not exists included_period_start timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_included_sane') then
    -- 计数只增不减，不可能是负的。负数说明有人手改过，那要当事故查
    alter table billing_accounts add constraint billing_included_sane
      check (included_assists_used >= 0);
  end if;
end $$;
