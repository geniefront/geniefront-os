-- ════════════════════════════════════════════════════════════════════════════
--  0080 · 修正 0075：Stripe id 归属于**一个 org**，而不是一个 location
--
--  ## 0075 错在哪
--
--  它给 `stripe_customer_id` / `stripe_subscription_id` 建了全局唯一索引。
--  但多店经营是**故意共用同一个 Stripe 客户和同一条订阅**的
--  （`handlers/setup.ts` 的长注释：一个老板一张卡一张账单；
--   `/v1/billing/add-store` 往同一条订阅上加 item，不新建订阅）。
--  全局唯一直接把「老板开第二家店」打死了 —— 被 multistore 套件当场抓住。
--
--  ## 真正要守的不变量
--
--  AUD-02 的攻击是「把**别家 org** 的 cus_/sub_ 写进自己这一行」，
--  后果是发票 webhook 认不出租户（静默停更），以及客户门户开到别人账上。
--
--  所以约束不是「一个 id 一行」，是 **「一个 id 只能属于一个 org」** ——
--  同一个 org 内部想挂几家店就挂几家。这是一条函数依赖
--  （stripe_customer_id → org_id），唯一索引表达不了，用触发器。
--
--  ## 顺带修好一件本来就坏着的事
--
--  0072 的 `gf_billing_tenant_for_stripe_refs` 在「命中多于一行」时返回空。
--  而多店共用订阅**必然**命中多行 —— 也就是说：**多店老板的发票事件
--  今天就已经认不出租户了**，续费/欠费状态静默停止更新，没有任何报错。
--  这不是 AUD-02 带来的，是它一直如此，只是没人从这个角度看过。
--
--  改法：多行时如果它们**同属一个 org**，就不算歧义 —— 返回该 org 中
--  建得最早的那家店作为计费锚点（就是当初建 Stripe 客户的那一家）。
--  跨 org 命中多行仍然一律返回空，那才是真的歧义，永远不猜。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 撤掉 0075 的全局唯一索引 ─────────────────────────────────────────────
drop index if exists billing_accounts_stripe_customer_uniq;
drop index if exists billing_accounts_stripe_subscription_uniq;

-- 查找用的普通索引留着：触发器和租户解析都要走它
create index if not exists billing_accounts_stripe_customer_idx
  on billing_accounts (stripe_customer_id) where stripe_customer_id is not null;
create index if not exists billing_accounts_stripe_subscription_idx
  on billing_accounts (stripe_subscription_id) where stripe_subscription_id is not null;

-- ── 2. 一个 Stripe id 只能属于一个 org ──────────────────────────────────────
do $$
declare bad int;
begin
  select count(*) into bad from (
    select stripe_customer_id from billing_accounts
     where stripe_customer_id is not null
     group by stripe_customer_id having count(distinct org_id) > 1
    union all
    select stripe_subscription_id from billing_accounts
     where stripe_subscription_id is not null
     group by stripe_subscription_id having count(distinct org_id) > 1) d;
  if bad > 0 then
    raise exception
      '有 % 个 Stripe id 跨了多个 org。这正是 AUD-02 描述的串账，必须人工核对。', bad;
  end if;
end $$;

create or replace function public.gf_assert_stripe_ids_single_org()
returns trigger
language plpgsql
as $$
begin
  if new.stripe_customer_id is not null and exists (
    select 1 from billing_accounts b
     where b.stripe_customer_id = new.stripe_customer_id
       and b.org_id <> new.org_id
  ) then
    raise exception
      'stripe_customer_id % 已属于另一个 org（AUD-02）', new.stripe_customer_id
      using errcode = '23505';
  end if;

  if new.stripe_subscription_id is not null and exists (
    select 1 from billing_accounts b
     where b.stripe_subscription_id = new.stripe_subscription_id
       and b.org_id <> new.org_id
  ) then
    raise exception
      'stripe_subscription_id % 已属于另一个 org（AUD-02）', new.stripe_subscription_id
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists billing_accounts_stripe_single_org on billing_accounts;
create trigger billing_accounts_stripe_single_org
  before insert or update of stripe_customer_id, stripe_subscription_id, org_id
  on billing_accounts
  for each row execute function public.gf_assert_stripe_ids_single_org();

comment on function public.gf_assert_stripe_ids_single_org() is
  'AUD-02：一个 Stripe customer/subscription 只能属于一个 org。'
  '同一个 org 内多家门店共用是正常的（一个老板一张卡一张账单）。';

-- ── 3. 租户解析：同 org 的多行不算歧义 ──────────────────────────────────────
create or replace function public.gf_billing_tenant_for_stripe_refs(
  p_subscription_id text,
  p_customer_id text
) returns table (org_id uuid, location_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub_id text := nullif(trim(coalesce(p_subscription_id, '')), '');
  v_cus_id text := nullif(trim(coalesce(p_customer_id, '')), '');
  v_orgs int;
  v_org uuid;
  v_loc uuid;
  v_row_customer text;
begin
  -- ① 优先用订阅 id
  if v_sub_id is not null then
    select count(distinct ba.org_id) into v_orgs
      from billing_accounts ba where ba.stripe_subscription_id = v_sub_id;

    -- 跨 org 命中 = 真歧义，永远不猜
    if v_orgs > 1 then return; end if;

    if v_orgs = 1 then
      -- 同 org 内多店共用一条订阅是正常的：取建得最早的那家作为计费锚点
      select ba.org_id, ba.location_id, ba.stripe_customer_id
        into v_org, v_loc, v_row_customer
        from billing_accounts ba
        join locations l on l.id = ba.location_id
       where ba.stripe_subscription_id = v_sub_id
       order by l.created_at asc, ba.location_id asc
       limit 1;

      -- 事件同时带了 customer 而对不上 → 不猜
      if v_cus_id is not null and v_row_customer is not null
         and v_row_customer <> v_cus_id then
        return;
      end if;

      org_id := v_org; location_id := v_loc; return next; return;
    end if;
  end if;

  -- ② 退回客户 id
  if v_cus_id is not null then
    select count(distinct ba.org_id) into v_orgs
      from billing_accounts ba where ba.stripe_customer_id = v_cus_id;
    if v_orgs <> 1 then return; end if;

    select ba.org_id, ba.location_id into v_org, v_loc
      from billing_accounts ba
      join locations l on l.id = ba.location_id
     where ba.stripe_customer_id = v_cus_id
     order by l.created_at asc, ba.location_id asc
     limit 1;

    org_id := v_org; location_id := v_loc; return next;
  end if;
end;
$$;

revoke all on function public.gf_billing_tenant_for_stripe_refs(text, text) from public;
grant execute on function public.gf_billing_tenant_for_stripe_refs(text, text) to app_user;

comment on function public.gf_billing_tenant_for_stripe_refs(text, text) is
  'Signed Stripe webhook only. 同 org 的多店共用不算歧义（取最早那家为锚点）；'
  '跨 org 命中一律返回空，绝不猜（sql/0080, AUD-02）。';
