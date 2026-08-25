-- 0045 · 建站工单（批 8，docs/17）
--
-- 我们**不做网站编辑器**（docs/01 §13）。定制官网走这条路：
-- 店主填一张结构化需求单 → AI 出三版 → 老板选一版 → 人工精修 → 上线。
--
-- ⭐ 工单的真正价值不是「省了编辑器」，是**它本身就是一张结构化的 prompt**：
-- voice + sections + 自述拼起来直接能喂给模型。竞品靠人做要 7 天，
-- 我们靠 AI 出初稿 + 人精修，目标 48 小时。

create table if not exists storefront_briefs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  /**
   * draft → submitted → drafted → chosen → live
   *              ↘ withdrawn ↗（回到 draft）
   *
   * ⭐ **draft 阶段一个字都不进我们的队列** —— 这条要在界面上明说。
   */
  status        text not null default 'draft'
                check (status in ('draft','submitted','drafted','chosen','live','withdrawn')),

  -- ① 现状与痛点
  current_site_url text,
  has_no_site   boolean not null default false,
  pain_points   jsonb not null default '[]'::jsonb,
  /** ⚠️ 问的是「**要避开什么**」不是「要什么」—— 后者人人都答"高级大气" */
  pain_free_text text,

  -- ② 我们比竞品多问的两节（docs/17 §5）
  /**
   * ⭐ 客群。竞品问了痛点、调性、卖点，**唯独没问这个** ——
   * 而它直接决定首屏说什么：勾了老年人字号就得大、电话要放首屏；
   * 勾了华人社区就要中英双语；勾了保险就要写「接受 HSA/FSA」。
   */
  audience      jsonb not null default '[]'::jsonb,
  /**
   * ⭐ 客人打电话最常问的三件事。华人店官网真正决定成交的不是品牌调性，
   * 是：停车怎么停、收不收现金/小费怎么给、会不会说中文。
   *
   * 这一节**可以不问老板** —— 从他自己店里的 AI 通话记录里挖出
   * 最高频的三个问题预填进去让他确认。竞品有通话记录但没接回建站表单。
   */
  top_questions jsonb not null default '[]'::jsonb,

  -- ③ 品牌
  brand_primary text,
  brand_accent  text,
  /** warm | luxury | modern | traditional */
  voice         text check (voice is null or voice in ('warm','luxury','modern','traditional')),
  reference_sites jsonb not null default '[]'::jsonb,

  -- ④ 区块与自述
  sections      jsonb not null default '[]'::jsonb,
  usp           text,
  tone          text,

  -- ⑤ 素材（Supabase Storage 私有桶的 key，不是 URL）
  logo_key      text,
  hero_key      text,
  gallery_keys  jsonb not null default '[]'::jsonb,

  submitted_at  timestamptz,
  drafted_at    timestamptz,
  live_at       timestamptz,
  public_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 一店一张。要重做就在原来那张上改状态，不是再开一张
create unique index if not exists storefront_briefs_loc_uidx
  on storefront_briefs (location_id);

create table if not exists storefront_drafts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  brief_id      uuid not null references storefront_briefs(id) on delete cascade,
  variant       integer not null check (variant between 1 and 3),
  content       jsonb not null,
  preview_key   text,
  chosen_at     timestamptz,
  -- 用量走 usage_events(kind='ai_assist')，这里只留够对账的几个数
  model         text,
  input_tokens  integer,
  output_tokens integer,
  cost_millicents integer,
  created_at    timestamptz not null default now()
);

create unique index if not exists storefront_drafts_variant_uidx
  on storefront_drafts (brief_id, variant);

comment on table storefront_briefs is
  '建站工单。draft 阶段不进我们的队列，submit 之后才排期。一店一张';
comment on column storefront_briefs.top_questions is
  '客人最常问的三件事 —— 可以从 AI 通话记录里挖出来预填，不必问老板';

do $$
declare t text;
begin
  foreach t in array array['storefront_briefs','storefront_drafts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) '
      || 'with check (org_id = app_org_id())', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;
