-- ════════════════════════════════════════════════════════════════════════════
--  0085 · 订阅生命周期补全（多店计费 / 期末取消 / 发票 / 未订阅态）
--
--  这一份补的是「Stripe 那边发生了什么，本地能不能看得见」这条不变量上
--  的五个缺口。每一条都在下面单独说明，因为它们的成因彼此无关。
--
--  ── 1. 每家门店记住自己那个 subscription item ──────────────────────────
--
--  多店经营共用**同一条订阅**（一个老板一张卡一张账单，见
--  `/v1/billing/add-store` 的长注释），每家店在这条订阅上是一个 item。
--  而 `syncSubscription` 原来取的是 `sub.items.data[0]` —— Stripe 的列表
--  顺序不作保证，第二家店加进来之后 `data[0]` 可能是新那个，
--  结果是**主店的套餐被静默改成第二家店的档位**。
--
--  `location_subscriptions.stripe_subscription_item_id` 其实早就写了，
--  但全仓库没有一处读它。与其跨表 join，不如把它放到计费账户行上 ——
--  webhook 每次都要按 item 反查门店，那是最热的一条路。
--
--  ── 2. 期末取消要看得见 ────────────────────────────────────────────────
--
--  老板在客户门户点「取消」，Stripe 给的是
--  `cancel_at_period_end = true` 而 **status 仍然是 active**。
--  本地不镜像这两列的话，界面会一直显示「下次扣款 X 日」，
--  直到那天突然全店冻结 —— 而那是最容易变成投诉的一种体验。
--
--  ── 3. 「从来没订阅过」需要一个自己的状态 ───────────────────────────────
--
--  `subscription_status` 的默认值原来是 `'trialing'`，而 `ensureAccount`
--  会在任何一次记账时自动建行。于是一家从未接过 Stripe 的门店：
--    · 写入闸门放行（trialing 不在冻结集合里）
--    · `isTrialing()` 为 false（trial_ends_at 为空）
--      → 按 **essential 档**发 500 积分 + 60 语音分钟
--    · `current_period_end` 为空 → 永不清零
--  也就是白拿一整份套餐额度。`/v1/billing/add-store` 在组织尚无生效订阅时
--  返回 `billing: 'not_linked'`，正好批量生产这种门店。
--
--  新增 `'none'` 把「没接计费」和「在试用」分开。它**不冻结写入** ——
--  门店是真的、老板只是还没接上计费，把前台挡在门外解决不了任何问题；
--  它只把套餐内 AI 额度归零（应用层 `includedFor` 的调用点判定）。
--
--  ── 4. 发票要能落库 ────────────────────────────────────────────────────
--
--  `billing_invoices` 从 0052 起只有读的一侧（`loadBillingInvoices`），
--  没有任何一条 webhook 往里写，所以「订阅发票」页恒空。补一个
--  `stripe_invoice_id` 作为幂等键（Stripe 的 invoice 事件同样是至少一次投递）。
--
--  ── 5. 试用只给第一次 ──────────────────────────────────────────────────
--
--  官网开户通道 (`/v1/public/signup-checkout`) 原来无条件给
--  `trial_period_days`，判据只存在于站内那条路。同一个人退订之后再开一次，
--  又是七天。`signup_intents` 里有全部历史，但它受 RLS 保护而开户是
--  **未登录**的公开请求 —— 所以按 0030 / 0072 的同一套路，
--  开一个只回答「这个邮箱开过户没有」的窄 SECURITY DEFINER 函数。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1 & 2. 计费账户行补四列 ─────────────────────────────────────────────────
alter table billing_accounts
  -- 这家店在共用订阅上的那个 item。单店订阅同样写，读的一侧就不用分两种情况
  add column if not exists stripe_subscription_item_id text,
  -- 期末取消：Stripe 的 subscription.cancel_at_period_end 镜像
  add column if not exists cancel_at_period_end boolean not null default false,
  -- 期末取消的确切时刻。cancel_at_period_end 为 false 时无意义
  add column if not exists cancel_at timestamptz;

comment on column billing_accounts.stripe_subscription_item_id is
  '这家门店在（可能与兄弟门店共用的）订阅上的 subscription item id。'
  'webhook 靠它把一条 subscription 事件拆回每家店自己的套餐与周期。';
comment on column billing_accounts.cancel_at_period_end is
  '老板已在客户门户点了取消，订阅将在当期结束时终止。此时 status 仍是 active。';

create index if not exists billing_accounts_stripe_sub_item_idx
  on billing_accounts (stripe_subscription_item_id)
  where stripe_subscription_item_id is not null;

-- 已经写进 location_subscriptions 的 item id 回填过来，别丢掉历史
update billing_accounts ba
   set stripe_subscription_item_id = ls.stripe_subscription_item_id
  from location_subscriptions ls
 where ls.location_id = ba.location_id
   and ls.stripe_subscription_item_id is not null
   and ba.stripe_subscription_item_id is null;

-- ── 3. 「从未接计费」单独一个状态 ────────────────────────────────────────────
alter table billing_accounts alter column subscription_status set default 'none';

-- 回填：既没有 Stripe 客户、也没有订阅、也没试用过的行，就是从没接过计费。
-- ⚠️ 判据必须三条都满足 —— 只看 subscription_id 的话，会把「退订后
-- 清过 id 的老行」误判成从未订阅，那家店会因此白拿一份额度。
update billing_accounts
   set subscription_status = 'none'
 where subscription_status = 'trialing'
   and stripe_customer_id is null
   and stripe_subscription_id is null
   and trial_ends_at is null;

comment on column billing_accounts.subscription_status is
  'none = 从未接计费（不冻结写入，但套餐内 AI 额度为 0）；'
  'trialing / active 放行；past_due / canceled 冻结写入。';

-- ── 4. 发票落库的幂等键 ─────────────────────────────────────────────────────
alter table billing_invoices
  add column if not exists stripe_invoice_id text,
  add column if not exists hosted_invoice_url text;

-- 部分唯一索引而不是 not null unique：0052 之前手工造的行没有这个 id
create unique index if not exists billing_invoices_stripe_id_uniq
  on billing_invoices (stripe_invoice_id)
  where stripe_invoice_id is not null;

comment on column billing_invoices.stripe_invoice_id is
  'Stripe invoice id。invoice.* 事件是至少一次投递，这一列是唯一的幂等依据。';

-- ── 5. email_outbox 新增两种信 ──────────────────────────────────────────────
--
-- ⚠️⚠️ email_outbox.kind 是**白名单 check**（0029 建，0038 / 0039 各扩过一次）。
-- 加一档只能「drop 掉整条再按全量列表重建」——所以下面这一行必须是
-- **当前全部类型的完整清单**，漏掉任何一个，那个类型的历史行会让
-- 这条迁移直接失败。
--
-- 再加新类型时：复制下面这一行，在末尾追加，不要凭记忆重写。
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'email_outbox_kind') then
    alter table email_outbox drop constraint email_outbox_kind;
  end if;
  alter table email_outbox add constraint email_outbox_kind
    check (kind in ('appointment_confirm','appointment_changed','receipt',
                    'platform_notice','form_invite','trial_ending',
                    'payment_failed','subscription_canceled'));
end $$;

-- ── 6. 「这个邮箱开过户没有」──────────────────────────────────────────────
--
-- 只回答一个布尔值。不返回门店、不返回时间、不返回任何可以用来枚举客户的
-- 东西 —— 它挂在一条**未登录**可达的路由后面（`/v1/public/signup-checkout`），
-- 而那条路由本身已经有按 IP 与按邮箱的限频。
create or replace function public.gf_signup_email_seen(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from signup_intents
     where lower(owner_email) = lower(trim(coalesce(p_email, '')))
       and trim(coalesce(p_email, '')) <> ''
  );
$$;

-- 0083 的纪律：definer 函数一律先对 public/anon/authenticated 全撤，
-- 再显式授给运行时角色。Supabase 会给 public schema 的新函数发默认执行权，
-- 只 revoke from public 收不掉 anon / authenticated 那两份。
revoke all on function public.gf_signup_email_seen(text)
  from public, anon, authenticated;
grant execute on function public.gf_signup_email_seen(text) to app_user;

comment on function public.gf_signup_email_seen(text) is
  '这个邮箱是否开过户。用于「七天试用只给第一次」的判定（0085）。'
  '⚠️ 只有 app_user 可执行 —— 它绕过 RLS，不能对 anon 开放（0083）。';
