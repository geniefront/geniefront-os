-- ════════════════════════════════════════════════════════════════════════════
--  0038 · 把健康表发给客人：一次性填表链接（docs/15）
--
--  ## 起因
--
--  门口那台 iPad 只解决「已经站在店里的人」。而健康表最该在**到店之前**
--  填完：客人站在柜台前、后面排着队、用一台公用 iPad 回答「有没有血栓史」，
--  那种情况下他会一路点「否」—— 而这张表的全部意义就在他答的是不是真话。
--
--  ## 令牌解析：和 0016 的设备令牌一模一样的思路
--
--  客人点开链接时我们不知道 org_id，能用的只有一个令牌。
--  **缺的是上下文，不是权限**（同 identity_self / phone_line_lookup /
--  public_key）。所以策略只放行**摘要恰好相等**的那一行：
--
--    · 只 for select
--    · 必须先说出完整的 SHA-256 摘要 —— 枚举不出这张表
--    · 查到的只有一行
--
--  ⚠️ 正常租户上下文下 app.form_token_hash 是空的，`token_hash = null`
--  恒为 null（不是 true），所以这条策略在日常路径上等于不存在。
--
--  ## ⚠️ 为什么链接不删只吊销
--
--  「这份免责书是怎么签的」和「他签了什么」一样是证据的一部分：
--  是当面扫的码，还是发去了某个邮箱、而那个邮箱后来被人说不是本人的。
--  删掉那一行，出事时这一段就断了。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. 建表 ────────────────────────────────────────────────────────────────
--
-- ⚠️ 手写建表（同 0029 / 0034 的口径）：drizzle 的快照和这几份手写迁移
-- 早就分了叉，跑 drizzle-kit generate 会连带把别的表重画一遍。
-- `src/schema/kiosk.ts` 里那份定义仍然是类型的来源，两边要一起改。
create table if not exists form_share_links (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  location_id     uuid not null references locations(id),

  customer_id     uuid references customers(id),
  appointment_id  uuid references appointments(id),

  -- 模板**行**的 id（每一版是单独一行）。发出去之后老板再发新版本，
  -- 客人手里那条链接仍然指着他被要求签的那一版
  template_ids    jsonb not null default '[]'::jsonb,

  -- SHA-256(明文令牌)。明文只在生成那一次的返回里出现
  token_hash      text not null,

  channel         text not null default 'qr',   -- qr | email（**没有 sms**）
  sent_to         text,                          -- 发去哪个邮箱
  locale          text not null default 'en',

  created_by      uuid references memberships(id),
  expires_at      timestamptz not null,
  opened_at       timestamptz,
  submitted_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create unique index if not exists form_share_links_token_key
  on form_share_links (token_hash);

-- ⭐ 这一份表是从哪条链接签进来的。两个用途：
--
--   1. **证据链**：出事时能说清「这份免责书是当面扫码签的，还是发去了
--      某个邮箱、而那个邮箱后来被说不是本人的」
--   2. **算「还剩几份没填」**：⚠️ 不能靠 (customer_id, 时间) 去凑 ——
--      两条**匿名**链接（customer_id 都是 null）同时在外面时，
--      A 填完会把 B 也算成填完了，而 B 那位客人还没动过手
alter table form_submissions
  add column if not exists share_link_id uuid references form_share_links(id);

create index if not exists form_submissions_share_idx
  on form_submissions (share_link_id) where share_link_id is not null;
create index if not exists form_share_links_customer_idx
  on form_share_links (location_id, customer_id, created_at);

-- ── 1. 常规租户隔离 ────────────────────────────────────────────────────────
alter table form_share_links enable row level security;
alter table form_share_links force  row level security;
drop policy if exists tenant_isolation on form_share_links;
create policy tenant_isolation on form_share_links
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update on form_share_links to app_user;

-- 不删只吊销（宪法第 9 条，和 form_submissions 同一条口径）
revoke delete on form_share_links from app_user;

create or replace function form_share_no_delete() returns trigger
language plpgsql as $$
begin
  if current_user = 'app_user' then
    raise exception '填表链接不可删除，只能吊销（revoked_at）'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

drop trigger if exists form_share_links_no_delete on form_share_links;
create trigger form_share_links_no_delete
  before delete on form_share_links
  for each row execute function form_share_no_delete();

-- ── 2. ⭐ 令牌维度解析 ─────────────────────────────────────────────────────
create or replace function app_form_token_hash() returns text
language sql stable as $$
  select nullif(current_setting('app.form_token_hash', true), '')
$$;

drop policy if exists form_share_token_lookup on form_share_links;
create policy form_share_token_lookup on form_share_links
  for select
  using (token_hash = app_form_token_hash());

-- 点开要记 opened_at、填完要记 submitted_at —— 前台靠这两个时间分辨
-- 「他没收到」和「他收到了没填」，那是决定要不要打电话的唯一依据
drop policy if exists form_share_token_touch on form_share_links;
create policy form_share_token_touch on form_share_links
  for update
  using (token_hash = app_form_token_hash())
  with check (token_hash = app_form_token_hash());

-- 令牌解析要顺带取门店时区、店名和 org 默认语言（客人那一页要显示是哪家店）
drop policy if exists location_by_form_token on locations;
create policy location_by_form_token on locations
  for select
  using (exists (
    select 1 from form_share_links f
    where f.location_id = locations.id and f.token_hash = app_form_token_hash()));

drop policy if exists org_by_form_token on organizations;
create policy org_by_form_token on organizations
  for select
  using (exists (
    select 1 from form_share_links f
    where f.org_id = organizations.id and f.token_hash = app_form_token_hash()));

-- ⚠️ **到此为止。** 题目和交表都**不**开令牌维度的策略 ——
-- 认出是哪家店之后，后面的读写走正常的 withTenant（和门口 iPad 一模一样，
-- 见 packages/db/src/formShare.ts 文件头）。多开一条按令牌放行的写策略，
-- 等于给「捡到链接的人」在租户隔离之外再开一扇门，而它一分钱好处都没有。

-- ── 3. 值域约束 ────────────────────────────────────────────────────────────
do $$
begin
  -- ⚠️ 刻意没有 'sms'（docs/09 §5）：平台号发陌生短链是 10DLC 通道被掐的
  -- 头号原因，掐掉影响的是所有店的预约确认短信，不只是这一条
  if not exists (select 1 from pg_constraint where conname = 'form_share_links_channel') then
    alter table form_share_links add constraint form_share_links_channel
      check (channel in ('qr', 'email'));
  end if;

  -- 发邮件必须有收件人：channel 是 email 而 sent_to 为空 = 一条谁也没收到的链接，
  -- 而前台会以为已经发出去了
  if not exists (select 1 from pg_constraint where conname = 'form_share_links_email_target') then
    alter table form_share_links add constraint form_share_links_email_target
      check (channel <> 'email' or sent_to is not null);
  end if;

  -- form_submissions.source 现在多一档 link（客人自己手机上填的）
  if not exists (select 1 from pg_constraint where conname = 'form_submissions_source') then
    alter table form_submissions add constraint form_submissions_source
      check (source in ('kiosk', 'desk', 'link'));
  end if;
  -- email_outbox 多一档 kind：给客人的填表邀请信（0029 那条 check 是白名单）
  if exists (select 1 from pg_constraint where conname = 'email_outbox_kind') then
    alter table email_outbox drop constraint email_outbox_kind;
  end if;
  alter table email_outbox add constraint email_outbox_kind
    check (kind in ('appointment_confirm','appointment_changed','receipt',
                    'platform_notice','form_invite'));
end $$;

comment on table form_share_links is
  '发给客人的一次性填表链接。明文令牌只出现一次，库里只有 SHA-256 摘要';
