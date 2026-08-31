-- ════════════════════════════════════════════════════════════════════════════
--  0075 · Stripe 客户/订阅 id 归系统所有（AUD-02）
--
--  ## 问题
--
--  `billing_accounts.stripe_customer_id` / `stripe_subscription_id` 被两处
--  当成**系统事实**来读：
--
--    1. `gf_billing_tenant_for_stripe_refs`（0072）—— 发票 webhook 靠它定位门店
--    2. `POST /v1/billing/portal-session` —— 拿它去开 Stripe 客户门户
--
--  而在 AUD-01 之前，这两列是**租户写得进去的**（`billing.syncSubscription`
--  的 permission 是 `billing.manage`，老板正好有）。于是：
--
--    · 把别家的 `sub_…` 写进自己这行 → 0072 的「命中多于一行就不返回」
--      被触发 → 受害门店的发票事件从此静默地认不出租户，
--      续费/欠费/退订状态**停止更新**，而两边都没有任何报错
--    · 把别家的 `cus_…` 写进自己这行 → 门户会话开到**别人的 Stripe 账户**上
--
--  AUD-01 已经把写入口关掉了（命令只能由验签后的编排调用）。
--  这一条是**第二道**：即使将来又有谁把这两列写歪了，数据库也不允许两家门店
--  指向同一个 Stripe 对象 —— 「认不出租户」这种静默失败模式从此不可达。
--
--  ## 为什么是 partial unique 而不是 not null unique
--
--  绝大多数门店在接上 Stripe 之前这两列都是 NULL，而 Postgres 的唯一索引
--  本来就不约束 NULL；写成 partial 只是把意图讲明白，顺带让索引小一点。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 一个 Stripe 对象只能属于一家门店 ─────────────────────────────────────
--
-- ⚠️ 建之前先自检：如果现网真的已经有重复，这条迁移必须**响亮地失败**，
-- 而不是悄悄跳过。重复本身就是一次需要人来看的事故。
do $$
declare
  dup_cus int;
  dup_sub int;
begin
  select count(*) into dup_cus from (
    select stripe_customer_id from billing_accounts
     where stripe_customer_id is not null
     group by stripe_customer_id having count(*) > 1) d;
  select count(*) into dup_sub from (
    select stripe_subscription_id from billing_accounts
     where stripe_subscription_id is not null
     group by stripe_subscription_id having count(*) > 1) d;

  if dup_cus > 0 or dup_sub > 0 then
    raise exception
      'billing_accounts 里已存在重复的 Stripe id（customer=% subscription=%）。'
      '这是 AUD-02 描述的那种串账，必须人工核对后再上这条迁移。',
      dup_cus, dup_sub;
  end if;
end $$;

create unique index if not exists billing_accounts_stripe_customer_uniq
  on billing_accounts (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists billing_accounts_stripe_subscription_uniq
  on billing_accounts (stripe_subscription_id)
  where stripe_subscription_id is not null;

comment on index billing_accounts_stripe_customer_uniq is
  'AUD-02：一个 Stripe customer 只能属于一家门店。重复会让 webhook 认不出租户。';
comment on index billing_accounts_stripe_subscription_uniq is
  'AUD-02：一个 Stripe subscription 只能属于一家门店。';
