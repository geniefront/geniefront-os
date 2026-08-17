-- ════════════════════════════════════════════════════════════════════════════
--  0023 · 从「一个钱余额」改成「AI 积分 + AI 语音分钟」两种独立额度
--
--  ## 为什么不是钱了
--
--  上一版余额是**钱**（整数分），理由是「钱不会被套利」。那个理由本身没错，
--  但老板 2026-08-17 拍板了另一套结构，它更好卖：
--
--    Essential $99   500 积分 +  60 分钟
--    Growth    $199 1200 积分 + 500 分钟
--    充值 $50 = 1000 积分  或  200 分钟
--
--  卖「积分」和「分钟」比卖「$50 余额」直观得多 —— 店主能直接回答
--  「这个月我还能打几通电话」，而余额只能回答「我还有多少钱」。
--
--  ## ⚠️ 两种额度不能互换
--
--  一分钟电话的成本是一次副驾操作的 5.6 倍（$0.056 vs $0.01）。
--  只要能换，客户就会把额度全换成最贵的那种用 —— 而那恰恰是最忙、
--  最该赚钱的客户。这是决策 8 的核心，代码里**没有任何换算函数**。
--
--  ## 账本怎么改
--
--  `credit_ledger` 加 `unit` + `amount` + `balance_after`（单位数），
--  原来的 `amount_cents` / `balance_after_cents` **留着不删**：
--  宪法第 9 条，财务数据不删除。历史那几行是真实发生过的钱，
--  只是从今往后不再往那两列写。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 账本：加单位与单位数 ─────────────────────────────────────────────────
alter table credit_ledger
  add column if not exists unit text not null default 'credit',
  add column if not exists amount integer,
  add column if not exists balance_after integer,
  -- 充值时付了多少钱。用量扣费时为 null —— 那一笔没有钱经手
  add column if not exists paid_cents integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'credit_ledger_unit') then
    alter table credit_ledger add constraint credit_ledger_unit
      check (unit in ('credit','voice_minute'));
  end if;

  -- 方向和类型对不上的行（「充值 −1000 积分」）混进账本之后，对账永远对不平
  if not exists (select 1 from pg_constraint where conname = 'credit_ledger_unit_direction') then
    alter table credit_ledger add constraint credit_ledger_unit_direction
      check (
        amount is null or
        (kind = 'topup'  and amount > 0) or
        (kind = 'usage'  and amount < 0) or
        (kind = 'refund' and amount > 0) or
        (kind in ('adjustment','reversal'))
      );
  end if;
end $$;

-- ⚠️ 历史行（钱那一套）的 amount 是 null。对账时按 unit 分组，
-- 而 `amount is null` 的行不参与新账本的链条 —— 它们属于上一套体系。
create index if not exists credit_ledger_unit_idx on credit_ledger (location_id, unit, seq);

-- ── 2. 账户：两种余额 + 两种套餐内已用 ──────────────────────────────────────
alter table billing_accounts
  add column if not exists credit_balance integer not null default 0,
  add column if not exists voice_minute_balance integer not null default 0,
  add column if not exists included_credits_used integer not null default 0,
  add column if not exists included_minutes_used integer not null default 0;

-- 上一版那个「套餐内副驾次数」改名进 included_credits_used
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name='billing_accounts' and column_name='included_assists_used') then
    update billing_accounts set included_credits_used = included_assists_used
    where included_credits_used = 0 and included_assists_used > 0;
    alter table billing_accounts drop column included_assists_used;
  end if;
end $$;

-- ── 3. 自动续充：两种额度各一套 ─────────────────────────────────────────────
--
-- 每次都是 $50，所以不再有「充多少」这个设置 —— 只有「低于多少就充」。
-- 少一个可调项就少一处能填错的地方。
alter table billing_accounts
  add column if not exists auto_topup_credits_enabled boolean not null default false,
  add column if not exists auto_topup_credits_threshold integer not null default 50,
  add column if not exists auto_topup_credits_last_at timestamptz,
  add column if not exists auto_topup_credits_failures integer not null default 0,
  add column if not exists auto_topup_minutes_enabled boolean not null default false,
  add column if not exists auto_topup_minutes_threshold integer not null default 20,
  add column if not exists auto_topup_minutes_last_at timestamptz,
  add column if not exists auto_topup_minutes_failures integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_threshold_units_sane') then
    -- 阈值太高等于一直在充钱；负数没有意义
    alter table billing_accounts add constraint billing_threshold_units_sane
      check (auto_topup_credits_threshold between 0 and 5000
         and auto_topup_minutes_threshold between 0 and 2000);
  end if;
end $$;

-- ── 4. 旧的钱余额那套约束退休 ───────────────────────────────────────────────
-- 列留着（宪法第 9 条不删财务数据），但不再有新值写进去，
-- 所以那条「只能是 $50/$100」的约束必须拿掉，否则默认值都插不进去
alter table billing_accounts drop constraint if exists billing_topup_tier;
