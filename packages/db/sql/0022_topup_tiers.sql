-- ════════════════════════════════════════════════════════════════════════════
--  0022 · 充值分档：手动三档，自动续充只给大额两档
--
--  ## 手动 $20 / $50 / $100，自动续充只有 $50 / $100
--
--  $20 那一档是留给「第一次买，先试试水」的。用它做**自动续充**的话，
--  一家 50 次/天的 Essential 店一个月要触发 1.5 次：
--
--    档位    Stripe 手续费   忙店能撑
--    $20     4.4%           0.7 个月
--    $50     3.5%           1.7 个月
--    $100    3.2%           3.3 个月
--
--  每一次自动扣款都是客户账单上的一条记录，和一通「怎么又扣我钱」的电话。
--  自动续充要的恰恰是**别让人注意到它**。
--
--  ⚠️ 这张表上的约束只管 `auto_topup_amount_cents`（自动续充的档），
--  手动充值的金额不落库 —— 它是 PaymentIntent 的参数，在路由那一层校验。
-- ════════════════════════════════════════════════════════════════════════════

alter table billing_accounts drop constraint if exists billing_topup_tier;

-- 现存的 $20 档（如果有人已经设过）抬到 $50，别让约束把他们卡死
update billing_accounts set auto_topup_amount_cents = 5000
where auto_topup_amount_cents not in (5000, 10000);

alter table billing_accounts add constraint billing_topup_tier
  check (auto_topup_amount_cents in (5000, 10000));

alter table billing_accounts alter column auto_topup_amount_cents set default 10000;
