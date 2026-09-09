-- ════════════════════════════════════════════════════════════════════════════
--  0120 · 订阅码：Stripe 之外的第二条计费权威（计划 2026-09-09 批 1）
--
--  ## 为什么要有这一层
--
--  在此之前，付费状态只有一个写入者：Stripe（`handlers/billing.ts` 的
--  `refuseLocalPaidMutation` 把本地改套餐、买加量包一律拒掉）。这条纪律
--  本身是对的 —— 钱的状态只能有一个权威 —— 但它把一类真实客户挡在门外：
--  店家用微信 / 支付宝 / Zelle / 现金私下付款，钱我们已经收了，
--  服务却开不出来。
--
--  所以这份迁移不是「绕过计费闸门」，而是把「唯一权威」扩成
--  **「每个门店恰好有一个计费权威」**：`billing_source ∈ (none, stripe, license)`。
--  两者互斥、可切换、切换有留档。
--
--  ## 三条不能破的纪律
--
--  1. **一行账户只有一个权威。** Stripe webhook 永不改写 `license` 行
--     （`applySubscriptionToRow` 批 4 加的跳过判断）；订阅码永不改写
--     `stripe` 行（`applyLicense` 的权威冲突检查）。
--  2. **额度包不引入新的余额概念。** 兑换额度包 = 往 `credit_ledger` 追加
--     一条 `kind='topup', source='license'`。账本只追加的纪律（宪法第 9 条）
--     原样保留，对账逻辑一行都不用改。
--  3. **明文码不落库。** 只存 `sha256`。运营台检索靠 `code_prefix`（前 8 位
--     可见段）。明文只在签发响应里出现一次 —— 它是「捡到就能用」的凭证，
--     和 magic link 同一个量级。
--
--  ## 表为什么不开 tenant_isolation
--
--  `license_codes` 在签发那一刻**还不属于任何租户**（未定向的码谁都能兑）。
--  没有可隔离的列，所以不给 `app_user` 任何权限，全部读写走本文件里的
--  SECURITY DEFINER 窄口函数 —— 与 sql/0074 运营台同一条路子。
--  RLS 仍然 enable + force 作为纵深防御：万一将来有人误 grant，
--  没有 policy 的表对 `app_user` 依然是空的。
--
--  幂等：全部 if not exists / create or replace，可重放。
-- ════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────── 1. 账户上的第二条权威

alter table billing_accounts
  add column if not exists billing_source text not null default 'none',
  add column if not exists license_period_end timestamptz,
  add column if not exists license_code_id uuid,
  add column if not exists license_expiry_notified_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_source_known') then
    alter table billing_accounts add constraint billing_source_known
      check (billing_source in ('none', 'stripe', 'license'));
  end if;

  -- ⭐ license 模式必须有到期时刻。没有它就没有任何东西能让服务停下来 ——
  -- 而「忘了填到期日」的表现是一家店永久免费，且不会有任何报错。
  if not exists (select 1 from pg_constraint where conname = 'billing_license_needs_period') then
    alter table billing_accounts add constraint billing_license_needs_period
      check (billing_source <> 'license' or license_period_end is not null);
  end if;
end $$;

-- 回填：接过 Stripe 订阅的都是 stripe 权威，其余留 none。
-- ⚠️ 判据用 subscription_id 而不是 status：`canceled` 的店仍然是 Stripe
-- 权威（他随时可能在客户门户里恢复），把它算成 none 会让下一次 webhook
-- 与本地状态对不上。
update billing_accounts
   set billing_source = 'stripe'
 where billing_source = 'none'
   and stripe_subscription_id is not null;

comment on column billing_accounts.billing_source is
  '这一行的付费状态由谁说了算：none=从未接计费 / stripe=订阅与账期由 Stripe 回写 / '
  'license=由运营签发的订阅码，到期时刻见 license_period_end（sql/0120）。';
comment on column billing_accounts.license_period_end is
  'license 权威下的到期时刻，也是 current_period_end 的事实来源。'
  '由签发/续期/运营改期那一刻算好写死，请求路径上不数日子（sql/0120）。';
comment on column billing_accounts.subscription_status is
  'none = 从未接计费（不冻结写入，但套餐内 AI 额度为 0）；'
  'trialing / active 放行；past_due / canceled / expired 冻结写入、读照常。'
  'expired 专指订阅码到期 —— 对私下付款的客户显示「扣款失败」是错的信息（sql/0120）。';

-- ──────────────────────────────────────────── 2. 码本身

create table if not exists license_codes (
  id uuid primary key default gen_random_uuid(),

  /**
   * subscription  订阅码：买 duration_days 天的 plan
   * quota_pack    额度包码：加 amount 个 unit（走 credit_ledger）
   * store_open    开店码：运营直接建店 + 挂上订阅（批 6）
   */
  kind text not null check (kind in ('subscription', 'quota_pack', 'store_open')),

  /** sha256(规范化明文)。⚠️ 明文永不落库 */
  code_hash text not null unique,
  /** 明文的可见前缀（`GF-3F7K`）。只给运营检索用，不足以推出明文 */
  code_prefix text not null,

  -- subscription / store_open
  plan text check (plan is null or plan in ('essential', 'growth')),
  duration_days integer check (duration_days is null or duration_days between 1 and 3650),

  -- quota_pack
  unit text check (unit is null or unit in ('credit', 'voice_minute')),
  amount integer check (amount is null or amount > 0),

  /** 面值：这张码私下收了多少钱。只做对账留档，不参与任何计算（宪法第 4 条） */
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  /** 收款说明，例如 `wechat 2026-09-09 ¥1500 张老板`。必填 —— 没有出处的码查不清 */
  payment_note text not null check (char_length(btrim(payment_note)) between 1 and 500),

  /** 定向签发。空 = 任意门店可兑换 */
  target_org_id uuid references organizations(id),
  target_location_id uuid references locations(id),

  /** **码本身**的可兑换截止时刻。与订阅有效期是两件事 */
  valid_until timestamptz not null,
  max_redemptions integer not null default 1 check (max_redemptions between 1 and 50),
  redeemed_count integer not null default 0 check (redeemed_count >= 0),

  status text not null default 'active'
    check (status in ('active', 'redeemed', 'revoked')),

  issued_by_operator_id uuid not null references platform_operators(id),
  issued_at timestamptz not null default now(),

  revoked_at timestamptz,
  revoked_by_operator_id uuid references platform_operators(id),
  revoke_reason text,

  -- 各 kind 必须带齐自己那几个字段。缺了不会报错，只会在兑换那一刻
  -- 算出一个 null 天数 —— 而 null 天数的表现是「兑换成功但到期日没变」
  constraint license_terms_complete check (
    case kind
      when 'quota_pack' then unit is not null and amount is not null
                             and plan is null and duration_days is null
      else plan is not null and duration_days is not null
           and unit is null and amount is null
    end
  ),
  -- 撤销必须写原因。没有原因的撤销和一次误操作长得一模一样
  constraint license_revoke_reason check (
    status <> 'revoked' or (revoked_at is not null and revoke_reason is not null)
  ),
  constraint license_redeemed_within_max check (redeemed_count <= max_redemptions)
);

create index if not exists license_codes_status_idx
  on license_codes (status, issued_at desc);
create index if not exists license_codes_prefix_idx
  on license_codes (code_prefix);
create index if not exists license_codes_target_idx
  on license_codes (target_location_id) where target_location_id is not null;

-- 当前生效的那张码。⚠️ FK 放在建表之后 —— 第 1 节加列时这张表还不存在
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_accounts_license_code_fk') then
    alter table billing_accounts add constraint billing_accounts_license_code_fk
      foreign key (license_code_id) references license_codes(id);
  end if;
end $$;

comment on table license_codes is
  '运营签发的订阅码 / 额度包码 / 开店码。明文不落库，只存 sha256 与可见前缀。'
  '本表不开放给 app_user —— 一切读写走本文件的 SECURITY DEFINER 窄口（sql/0120）。';

-- ──────────────────────────────────────────── 3. 兑换事实（只追加）

create table if not exists license_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references license_codes(id),
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  /** 谁兑的。运营代兑时是运营那个 user id */
  redeemed_by_user_id uuid references users(id),
  redeemed_at timestamptz not null default now(),
  /**
   * 生效前后的事实：billing_source / plan / period_end 的 before-after，
   * 或额度包的单位与数量。用来回答「这家店为什么是这个到期日」——
   * 而这正是客户会打电话来问的那个问题。
   */
  effect jsonb not null default '{}'::jsonb,

  -- 同一张码在同一家店只能生效一次。跨店的次数由 max_redemptions 管
  constraint license_redemption_once unique (code_id, location_id)
);

create index if not exists license_redemptions_location_idx
  on license_redemptions (location_id, redeemed_at desc);

comment on table license_redemptions is
  '兑换事实表，**只追加**（同 credit_ledger 的纪律）。'
  '改一行等于把「这家店为什么能用到这天」的答案改掉（sql/0120）。';

-- 兑换记录不许改也不许删。唯一的例外是 `effect` 的一次性回填 ——
-- 那一步和插入在同一个事务里，由 gf_license_record_effect 以 definer 身份做。
--
-- ⚠️ 判据是 `current_user = 'app_user'`，和 `credit_ledger` 的
-- `ledger_append_only`（sql/0018）逐字一致。**不能无条件 raise**：
-- 那样连迁移和种子重置都删不掉这些行，而它们对 locations / organizations
-- 有外键 —— 表现是 `pnpm db:seed` 在删门店那一步撞 FK 报错，
-- 而报错信息里根本不会提到订阅码。
create or replace function public.gf_license_redemption_append_only()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'app_user' then
    raise exception '兑换记录只能追加 —— 要更正请另发一张码并写清原因'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

drop trigger if exists license_redemptions_no_change on license_redemptions;
create trigger license_redemptions_no_change
  before delete on license_redemptions
  for each row execute function public.gf_license_redemption_append_only();

-- ──────────────────────────────────────────── 4. RLS

do $$
declare t text;
begin
  foreach t in array array['license_codes', 'license_redemptions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('revoke all on table %I from public, anon, authenticated', t);
    execute format('revoke all on table %I from app_user', t);
  end loop;
end $$;

-- `license_codes` 到此为止：**没有 policy，也没有任何 grant** ——
-- 对 `app_user` 永远是一张空表。一张未定向的码在签发那一刻不属于任何租户，
-- 没有可隔离的列；而让租户能查这张表 = 让他能枚举别人的码。
-- 读写全部走本文件的窄口函数（definer 由 postgres 拥有，它有 BYPASSRLS）。

-- `license_redemptions` 不一样：它**有 org_id**，而且门店对自己那几行有
-- 正当的知情权 —— 「我的服务为什么到这一天」这个问题的答案就在这里。
--
-- ⭐ 所以给它一条标准的 tenant_isolation，**但只给 select**。
-- 写入仍然只能由 `gf_license_claim` / `gf_license_record_effect` 做：
-- 能自己插一行兑换记录 = 能自己给自己续期。
--
-- ⚠️ 这也是 `rls.test.ts` 那条「带 org_id 的表必须有隔离策略」要的形状。
-- 开了 RLS 却没有策略的表在那条测试里是**故障**，不是「更安全」。
drop policy if exists tenant_isolation on license_redemptions;
create policy tenant_isolation on license_redemptions
  using (org_id = app_org_id()) with check (org_id = app_org_id());
grant select on license_redemptions to app_user;

-- ──────────────────────────────────────────── 5. 签发 / 撤销（限 super_admin）

/**
 * 签发一张码。明文由应用侧生成，这里只收 hash 与可见前缀 ——
 * 数据库里连一次明文都不出现（连 WAL 和查询日志里都不出现）。
 */
create or replace function public.gf_license_issue(
  p_kind text,
  p_code_hash text,
  p_code_prefix text,
  p_payment_note text,
  p_valid_until timestamptz,
  p_plan text default null,
  p_duration_days integer default null,
  p_unit text default null,
  p_amount integer default null,
  p_amount_cents integer default null,
  p_target_org_id uuid default null,
  p_target_location_id uuid default null,
  p_max_redemptions integer default 1
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_operator uuid;
  v_id uuid;
begin
  v_role := gf_platform_assert_operator();
  -- 签发一张码 = 直接放行付费服务。support 能看不能发
  if v_role <> 'super_admin' then
    raise exception 'license_issue_requires_super_admin' using errcode = '42501';
  end if;

  select po.id into v_operator
    from platform_operators po where po.user_id = app_user_id();

  -- 定向到门店时把 org 一并钉死。只钉门店的话，兑换时还得再查一次
  -- 归属，而那次查询就是一个可以写错的地方
  if p_target_location_id is not null and p_target_org_id is null then
    select l.org_id into p_target_org_id from locations l where l.id = p_target_location_id;
    if p_target_org_id is null then
      raise exception 'target_location_not_found' using errcode = '22023';
    end if;
  end if;

  insert into license_codes (
    kind, code_hash, code_prefix, plan, duration_days, unit, amount,
    amount_cents, payment_note, target_org_id, target_location_id,
    valid_until, max_redemptions, issued_by_operator_id
  ) values (
    p_kind, p_code_hash, p_code_prefix, p_plan, p_duration_days, p_unit, p_amount,
    p_amount_cents, p_payment_note, p_target_org_id, p_target_location_id,
    p_valid_until, coalesce(p_max_redemptions, 1), v_operator
  ) returning id into v_id;

  return v_id;
end $$;

/**
 * 撤销一张**还没被兑换过**的码。
 *
 * ⚠️ 已经生效过的码不撤 —— 那一行是历史事实。要停一家店的服务走
 * `/v1/platform/stores/:id/license/revoke`（改账户，不改历史）。
 */
create or replace function public.gf_license_revoke(
  p_code_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_operator uuid;
  v_row license_codes;
begin
  v_role := gf_platform_assert_operator();
  if v_role <> 'super_admin' then
    raise exception 'license_revoke_requires_super_admin' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'revoke_reason_required' using errcode = '22023';
  end if;

  select po.id into v_operator
    from platform_operators po where po.user_id = app_user_id();

  select * into v_row from license_codes where id = p_code_id for update;
  if v_row.id is null then
    raise exception 'license_not_found' using errcode = '22023';
  end if;
  if v_row.redeemed_count > 0 then
    raise exception 'license_already_redeemed' using errcode = '22023';
  end if;
  if v_row.status = 'revoked' then
    -- 重放当无事发生：撤销是幂等的
    return jsonb_build_object('codeId', v_row.id, 'status', 'revoked', 'already', true);
  end if;

  update license_codes set
    status = 'revoked',
    revoked_at = now(),
    revoked_by_operator_id = v_operator,
    revoke_reason = btrim(p_reason)
  where id = p_code_id;

  return jsonb_build_object('codeId', v_row.id, 'status', 'revoked', 'already', false);
end $$;

-- ──────────────────────────────────────────── 6. 运营台读

create or replace function public.gf_platform_list_licenses(
  p_status text,
  p_kind text,
  p_query text,
  p_limit int,
  p_offset int
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  q text := btrim(coalesce(p_query, ''));
  lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  off int := greatest(coalesce(p_offset, 0), 0);
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();

  with matched as (
    select c.*,
           coalesce(l.name->>'en', l.name->>'zh-Hans', l.slug) as target_location_name
      from license_codes c
      left join locations l on l.id = c.target_location_id
     where (p_status is null or c.status = p_status)
       and (p_kind is null or c.kind = p_kind)
       and (q = ''
            or c.code_prefix ilike q || '%'
            or c.payment_note ilike '%' || q || '%'
            or c.target_location_id::text = q)
  )
  select (select count(*)::int from matched),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'codeId', m.id,
             'kind', m.kind,
             'codePrefix', m.code_prefix,
             'plan', m.plan,
             'durationDays', m.duration_days,
             'unit', m.unit,
             'amount', m.amount,
             'amountCents', m.amount_cents,
             'paymentNote', m.payment_note,
             'targetOrgId', m.target_org_id,
             'targetLocationId', m.target_location_id,
             'targetLocationName', m.target_location_name,
             'validUntil', m.valid_until,
             'maxRedemptions', m.max_redemptions,
             'redeemedCount', m.redeemed_count,
             'status', m.status,
             'issuedAt', m.issued_at,
             'revokedAt', m.revoked_at,
             'revokeReason', m.revoke_reason
           ) order by m.issued_at desc)
           from (select * from matched order by issued_at desc limit lim offset off) m
         ), '[]'::jsonb)
    into total, items;

  return jsonb_build_object('total', total, 'items', items);
end $$;

/**
 * 一家店的订阅码现状 + 兑换历史。
 *
 * 与 `gf_platform_store_detail` 分开一个函数：那一份是两百行的
 * `jsonb_build_object`，为几个字段去改它等于把整份函数体重抄一遍
 * （sql/0089 的同一条判断）。
 */
create or replace function public.gf_platform_license_panel(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  acct jsonb;
  history jsonb;
begin
  perform gf_platform_assert_operator();
  if p_location_id is null then
    raise exception 'location_required' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'billingSource', ba.billing_source,
    'plan', ba.plan,
    'subscriptionStatus', ba.subscription_status,
    'licensePeriodEnd', ba.license_period_end,
    'currentPeriodEnd', ba.current_period_end,
    'licenseCodeId', ba.license_code_id,
    'licenseCodePrefix', c.code_prefix,
    'stripeSubscriptionId', ba.stripe_subscription_id,
    'stripeSubscriptionItemId', ba.stripe_subscription_item_id,
    'creditBalance', ba.credit_balance,
    'voiceMinuteBalance', ba.voice_minute_balance
  )
  into acct
  from billing_accounts ba
  left join license_codes c on c.id = ba.license_code_id
  where ba.location_id = p_location_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'redemptionId', r.id,
    'codeId', r.code_id,
    'codePrefix', c.code_prefix,
    'kind', c.kind,
    'paymentNote', c.payment_note,
    'amountCents', c.amount_cents,
    'redeemedAt', r.redeemed_at,
    'redeemedByUserId', r.redeemed_by_user_id,
    'effect', r.effect
  ) order by r.redeemed_at desc), '[]'::jsonb)
  into history
  from license_redemptions r
  join license_codes c on c.id = r.code_id
  where r.location_id = p_location_id;

  return jsonb_build_object('account', acct, 'history', history);
end $$;

-- ──────────────────────────────────────────── 7. 兑换（店主与运营共用）

/**
 * 认领一张码：校验 → 锁行 → 记兑换 → 计数。**不碰 billing_accounts，也不碰账本。**
 *
 * ## 为什么把生效那一步留给应用
 *
 * 额度包生效 = 往 `credit_ledger` 追加一笔，而余额链条（`balance_after`）
 * 的算法在 `packages/payroll` 的 `applyEntry` 里，只有一份。在 plpgsql 里
 * 抄第二遍，迟早两边对不上 —— 而对不上的表现是对账报出一个不存在的断点。
 *
 * ## 租户从会话里取，不从入参取
 *
 * `app_org_id()` / `app_location_id()` 由 `withTenant` 设定。接受 org 入参
 * 的话，「知道别人的 org id 就能替他兑一张码」—— 而 org id 会出现在日志、
 * 工单和 URL 里（同 `setup.location.create` 不接受 org 入参的理由）。
 */
create or replace function public.gf_license_claim(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid := app_org_id();
  v_loc uuid := app_location_id();
  v_user uuid := app_user_id();
  v_row license_codes;
  v_redemption uuid;
begin
  if v_org is null or v_loc is null then
    raise exception 'tenant_context_required' using errcode = '42501';
  end if;
  if coalesce(btrim(p_code_hash), '') = '' then
    raise exception 'license_invalid' using errcode = '22023';
  end if;

  /*
   * ⭐ 先锁住这一行再判次数。不锁的话两个并发兑换会同时看到
   * redeemed_count < max_redemptions，各自加一次额度 —— 而唯一约束
   * 只挡得住「同一张码同一家店」，两家不同的店会双双成功。
   */
  select * into v_row from license_codes where code_hash = p_code_hash for update;

  -- ⚠️ 下面这些原因**一律不回给调用方**（路由会统一收敛成一个
  -- code_invalid）。区分开的话，这个接口就成了一个可以拿来枚举码的探针。
  if v_row.id is null then
    raise exception 'license_invalid' using errcode = '22023';
  end if;
  if v_row.status <> 'active' then
    raise exception 'license_invalid' using errcode = '22023';
  end if;
  if v_row.valid_until <= now() then
    raise exception 'license_invalid' using errcode = '22023';
  end if;
  if v_row.redeemed_count >= v_row.max_redemptions then
    raise exception 'license_invalid' using errcode = '22023';
  end if;
  if v_row.target_org_id is not null and v_row.target_org_id <> v_org then
    raise exception 'license_invalid' using errcode = '22023';
  end if;
  if v_row.target_location_id is not null and v_row.target_location_id <> v_loc then
    raise exception 'license_invalid' using errcode = '22023';
  end if;
  if exists (select 1 from license_redemptions r
              where r.code_id = v_row.id and r.location_id = v_loc) then
    raise exception 'license_invalid' using errcode = '22023';
  end if;

  insert into license_redemptions (code_id, org_id, location_id, redeemed_by_user_id)
  values (v_row.id, v_org, v_loc, v_user)
  returning id into v_redemption;

  update license_codes set
    redeemed_count = redeemed_count + 1,
    status = case when redeemed_count + 1 >= max_redemptions then 'redeemed' else 'active' end
  where id = v_row.id;

  return jsonb_build_object(
    'codeId', v_row.id,
    'redemptionId', v_redemption,
    'kind', v_row.kind,
    'codePrefix', v_row.code_prefix,
    'plan', v_row.plan,
    'durationDays', v_row.duration_days,
    'unit', v_row.unit,
    'amount', v_row.amount,
    'amountCents', v_row.amount_cents,
    'paymentNote', v_row.payment_note
  );
end $$;

/**
 * 把生效结果写回兑换记录。和 `gf_license_claim` 在同一个事务里调 ——
 * 分成两步是因为「生效」那一段必须在应用侧做（见上面的长注释）。
 */
create or replace function public.gf_license_record_effect(
  p_redemption_id uuid,
  p_effect jsonb
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_loc uuid := app_location_id();
begin
  if v_loc is null then
    raise exception 'tenant_context_required' using errcode = '42501';
  end if;
  update license_redemptions set effect = coalesce(p_effect, '{}'::jsonb)
   where id = p_redemption_id and location_id = v_loc;
  if not found then
    raise exception 'redemption_not_found' using errcode = '22023';
  end if;
end $$;

-- ──────────────────────────────────────────── 8. 执行权

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.gf_license_issue(text, text, text, text, timestamptz, text, integer, text, integer, integer, uuid, uuid, integer)',
    'public.gf_license_revoke(uuid, text)',
    'public.gf_platform_list_licenses(text, text, text, int, int)',
    'public.gf_platform_license_panel(uuid)',
    'public.gf_license_claim(text)',
    'public.gf_license_record_effect(uuid, jsonb)'
  ] loop
    -- 同 sql/0083：收 PUBLIC 收不掉 Supabase 给 anon / authenticated 的那两份
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to app_user', fn);
  end loop;
end $$;

comment on function public.gf_license_claim(text) is
  '兑换一张码：校验 + 锁行 + 记兑换。租户取自会话（app_org_id/app_location_id），'
  '不接受 org 入参。失败原因一律不外泄，避免变成枚举探针（sql/0120）。';
comment on function public.gf_license_issue(
  text, text, text, text, timestamptz, text, integer, text, integer, integer, uuid, uuid, integer) is
  '签发一张码，限 super_admin。只收 sha256 与可见前缀 —— 明文在数据库里一次都不出现（sql/0120）。';
