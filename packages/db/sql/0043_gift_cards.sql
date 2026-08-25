-- 0043 · 礼品卡（批 5）
--
-- ## ⭐ 一张账本装四种东西，不是四张各自为政的表
--
-- 这一批只做礼品卡，但积分 / 次卡套餐 / 优惠券和它共用同一套记账：
-- **客人预付了钱或权益，之后一点一点核销**。四条线各建一张账本的话，
-- 「这个客人手里一共有多少钱」要 union 四张表，而日结要把四张表
-- 分别对一遍 —— 而它们的对账规则一模一样。
--
-- 所以 `customer_credit_ledger` 从第一天就带 `kind`。后面三块是**加行**
-- 不是加表，现在几乎零成本，事后合并很痛。
--
-- ## ⭐ 面值 ≠ 售价
--
-- 「买 $100 的卡付 $80」是这行最常见的促销。两个数必须分开存：
--   · 卖出去那一刻：**负债 +$100，营收 +$0**（钱进了，服务没做）
--   · 核销 $30 那一刻：**负债 −$30，营收 +$30**
--   · 那 $20 的差价是**促销成本**，在核销时按比例摊，不在售出时确认
--
-- 把面值当营收记的话，一家卖了一万块卡的店会以为自己赚了一万，
-- 而那一万里有一部分是明年才要付出的服务 —— 这是会计口径的负债。

-- ── 模板 ──────────────────────────────────────────────────────────────────
create table if not exists gift_card_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  name          jsonb not null,
  -- ⭐ 面值：卡里有多少钱
  face_value_cents  integer not null check (face_value_cents > 0),
  -- ⭐ 售价：客人付多少钱。可以等于面值（不打折）
  sale_price_cents  integer not null check (sale_price_cents >= 0),
  -- 多少天后过期。null = 永不过期
  -- ⚠️ 美国多数州禁止礼品卡在 5 年内过期，有的州完全禁止。
  -- 我们不替店家判法律，但**默认 null**（不过期）是唯一安全的默认值
  valid_days    integer check (valid_days is null or valid_days > 0),
  /**
   * ⭐ 这张卡能在哪几家店用。一人多店（批 4）之后必须现在定。
   *   location —— 只能在售出的那家店用（默认）
   *   org      —— 同一个 org 下任意一家店都能核销
   */
  scope         text not null default 'location' check (scope in ('location', 'org')),
  -- 上不上架给客人在线买
  online_sale   boolean not null default false,
  active        boolean not null default true,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── 卡 ────────────────────────────────────────────────────────────────────
create table if not exists gift_cards (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  -- ⚠️ 这是**售出**门店，不是「只能在这里用」。能在哪用看 scope
  location_id   uuid not null references locations(id),
  template_id   uuid references gift_card_templates(id),
  /**
   * 卡号。⚠️ **不可自增、不可按时间生成。**
   *
   * 一个能猜的卡号等于把店里的钱放在门口 —— 拿到一张卡的人
   * 试相邻几个号就能刷别人的余额。这一列由应用生成（22 位 base32），
   * 数据库只保证唯一。
   */
  code          text not null,
  face_value_cents  integer not null check (face_value_cents > 0),
  sale_price_cents  integer not null check (sale_price_cents >= 0),
  /**
   * ⚠️ **余额是账本推出来的缓存，不是事实源。**
   * 事实源是 customer_credit_ledger 的求和。这一列存在只是为了
   * 前台刷卡时不用每次扫全表 —— 对不上时以账本为准（同 billing_accounts）。
   */
  balance_cents integer not null,
  scope         text not null default 'location' check (scope in ('location', 'org')),
  -- 买的人 / 收的人。都可空：柜台现金买卡不留信息是常态
  purchaser_customer_id uuid references customers(id),
  holder_customer_id    uuid references customers(id),
  recipient_name  text,
  recipient_note  text,
  -- front_desk | online | bulk | auto（生日/节日自动赠送）
  source        text not null default 'front_desk'
                check (source in ('front_desk','online','bulk','auto')),
  status        text not null default 'active'
                check (status in ('active','depleted','expired','void')),
  expires_at    timestamptz,
  -- 售出时挂在哪张单上（前台卖卡也是一笔生意）
  sold_ticket_id uuid references tickets(id),
  issued_by     uuid references memberships(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists gift_cards_code_uidx on gift_cards (code);
create index if not exists gift_cards_holder_idx on gift_cards (holder_customer_id)
  where holder_customer_id is not null;
create index if not exists gift_cards_org_active_idx on gift_cards (org_id, status);

-- ── ⭐ 统一账本：只追加，永不 UPDATE ──────────────────────────────────────
create table if not exists customer_credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  seq           bigserial not null,
  org_id        uuid not null references organizations(id),
  /**
   * ⭐ **发生这笔账的门店**，不一定等于卡的售出门店。
   *
   * org 范围的卡在 A 店卖、B 店核销：售出行的 location 是 A，
   * 核销行的 location 是 B。两家店的日结各取各的行，
   * 负债从 A 挪到 B 的收入 —— 这一列现在不记，以后补不出来。
   */
  location_id   uuid not null references locations(id),
  -- gift_card | package | points | coupon（后三种是后续批次，结构已经留好）
  kind          text not null default 'gift_card'
                check (kind in ('gift_card','package','points','coupon')),
  -- 指向具体那张卡 / 那份套餐。同一个 kind 内唯一
  subject_id    uuid not null,
  customer_id   uuid references customers(id),
  /**
   * issue   发卡（+面值，进负债）
   * redeem  核销（−，转收入）
   * refund  退卡（+，冲销）
   * adjust  人工调整（±，必须写 reason）
   * expire  过期作废（−，转收入或转其它科目，看各州法规）
   */
  entry         text not null
                check (entry in ('issue','redeem','refund','adjust','expire')),
  -- ⚠️ 有符号：issue 为正，redeem 为负。求和 = 当前余额
  amount_cents  integer not null,
  balance_after_cents integer not null,
  ticket_id     uuid references tickets(id),
  /** 冲销指向被冲的那一行。**永不删除、永不 UPDATE**（宪法第 9 条） */
  reversal_of_id uuid references customer_credit_ledger(id),
  reason        text,
  actor_membership_id uuid references memberships(id),
  /** 幂等键。前台手抖点两次不能扣两次 */
  idem_key      text,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists ccl_subject_idx on customer_credit_ledger (kind, subject_id, seq);
create index if not exists ccl_location_day_idx on customer_credit_ledger (location_id, created_at);
create unique index if not exists ccl_idem_uidx
  on customer_credit_ledger (location_id, idem_key) where idem_key is not null;

comment on table customer_credit_ledger is
  '客人预付资产的统一账本（礼品卡/套餐/积分/优惠券共用）。只追加，'
  ' 冲销走 reversal_of_id，永不 UPDATE、永不 DELETE。余额 = 按 subject 求和';

-- ── 只追加的守卫（和 credit_ledger 同一个套路）────────────────────────────
create or replace function gf_ccl_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '客人资产账本只能追加：要冲销就插一条 reversal_of_id 指过去的反向记录'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists ccl_no_update on customer_credit_ledger;
create trigger ccl_no_update before update or delete on customer_credit_ledger
  for each row execute function gf_ccl_append_only();

-- ── 日结要认得这两笔 ──────────────────────────────────────────────────────
alter table day_closes
  -- 当日售卡收到的钱。⚠️ **进负债不进营收**
  add column if not exists gift_card_sold_cents integer not null default 0,
  -- 当日核销掉的卡面额。⚠️ **这才是营收**
  add column if not exists gift_card_redeemed_cents integer not null default 0;

comment on column day_closes.gift_card_sold_cents is
  '当日售卡收到的现金/刷卡。进负债不进营收 —— 服务还没做';
comment on column day_closes.gift_card_redeemed_cents is
  '当日核销掉的卡面额。这一笔才是确认的营收';

-- ── 提成基数：老板设（批 5 的可配项）──────────────────────────────────────
--
-- 用礼品卡付的单，技师的提成按**面值**还是按**售价**算？
-- 这是业务决定不是技术决定：
--   face —— 客人享受了 $100 的服务，技师就按 $100 提。店家吃掉折扣
--   sale —— 店家只收到 $80，技师按 $80 提。折扣由双方分担
-- 没有哪个更对，但选错了技师会当场发现，所以必须让老板自己定。
update locations
set settings = jsonb_set(settings, '{gift_card}',
      coalesce(settings->'gift_card', '{}'::jsonb) || jsonb_build_object(
        'commission_basis', coalesce(settings->'gift_card'->'commission_basis', '"face"'::jsonb),
        'default_scope',    coalesce(settings->'gift_card'->'default_scope', '"location"'::jsonb)
      ), true)
where settings->'gift_card' is null;

-- ── RLS ───────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['gift_card_templates','gift_cards','customer_credit_ledger'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    /**
     * ⚠️ 按 **org_id** 隔离，不是 location_id —— 因为 scope='org' 的卡
     * 要在同 org 的另一家店核销得到。跨 org 仍然一个字节都看不见。
     */
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) '
      || 'with check (org_id = app_org_id())', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

-- ⚠️ bigserial 会建一个 sequence，app_user 要能取号才插得进去。
-- 这和 sql/0019 给 credit_ledger_seq_seq 授权是同一件事 ——
-- 漏了的表现是 "permission denied for sequence"，而它只在第一次
-- 真的写账本时才出现（建表和 grant 表都不会报）。
do $$
begin
  if exists (select 1 from pg_class where relname = 'customer_credit_ledger_seq_seq'
             and relkind = 'S') then
    execute 'grant usage, select on sequence customer_credit_ledger_seq_seq to app_user';
  end if;
end $$;
