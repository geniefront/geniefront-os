-- ════════════════════════════════════════════════════════════════════════════
--  0081 · 修正 0080：跨 org 检查必须 SECURITY DEFINER
--
--  ## 0080 的触发器为什么没用
--
--  `gf_assert_stripe_ids_single_org()` 是普通 plpgsql 函数，**跟着调用者的
--  身份跑**。运行时的调用者是 `app_user`，而 `billing_accounts` 的 RLS 是
--  `org_id = app_org_id()` —— 于是那句
--
--      exists (select 1 from billing_accounts b
--               where b.stripe_customer_id = new.stripe_customer_id
--                 and b.org_id <> new.org_id)
--
--  **永远为假**：它要找的正是「别的 org 的行」，而 RLS 恰好把那些行滤掉了。
--  检查在 psql 里（postgres 角色，不受 RLS）跑得好好的，
--  一到应用路径就静默失效 —— 最坏的那一类：看起来有防护，实际没有。
--
--  这正是 01-ARCHITECTURE §4 警告过的形状：
--  「你写的租户隔离测试会全部通过但毫无意义」。这次是反过来的方向 ——
--  **依赖跨租户可见性的检查，在 RLS 下会静默变成空操作**。
--
--  ⭐ 抓住它的是回归测试本身（`webhook.tenant.test.ts` 那条
--  "cross-org Stripe id sharing is rejected"），因为它跑在 app_user 身份下。
--  用 postgres 身份写的手工验证是看不出来的。
--
--  ## 修法
--
--  加 `security definer` + 固定 search_path，和 0072 / 0074 那几个
--  跨租户读取函数同一套写法。函数体不变 —— 它本来就只回答一个
--  布尔问题，不返回任何别的 org 的数据。
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.gf_assert_stripe_ids_single_org()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
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

comment on function public.gf_assert_stripe_ids_single_org() is
  'AUD-02：一个 Stripe customer/subscription 只能属于一个 org。'
  'SECURITY DEFINER —— 检查要看的正是别的 org 的行，'
  '跟着 app_user 跑会被 RLS 滤成永远为假（sql/0081）。';
