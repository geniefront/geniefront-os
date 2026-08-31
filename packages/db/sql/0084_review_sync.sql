-- ════════════════════════════════════════════════════════════════════════════
--  0084 · 外部评价采集的运行链路（05-AI-INTEGRATION §8）
--
--  ## 这份迁移补的是什么
--
--  `location_reviews` / `location_review_stats` / `review_summaries` 三张表
--  在 0002 就已存在，但一直没有把数据写进去的链路。真正开始抓取之前，
--  有三件事必须先在数据库里定下来：
--
--    1. **抓哪里**：Google 侧需要一个门店页 URL。`google_place_id` 不总是够用
--       （抓取器接受的是 Maps URL），因此单独存一列，由开店向导或设置页写入。
--    2. **抓到哪一步了**：Bright Data 的采集是异步的 —— 触发只拿到一个
--       `snapshot_id`，结果要在数分钟后另行下载。这个 id 不落库就等于
--       「钱已经花了，但结果永远取不回来」，而下一轮定时任务还会再触发一次，
--       重复计费。`review_sync_runs` 就是这条状态机的持久化。
--    3. **花了多少**：抓取按记录条数计费。费用与同步结果记在同一行里，
--       出问题时「哪一次抓取、抓了多少条、花了多少、错在哪」是一次查询的事。
--
--  ## 为什么同步日志是一张独立的表而不是写日志文件
--
--  这条链路的失败全部是**静默**的：抓取失败不会有人报错，表现为老板端的
--  口碑页面「最近没有新评价」—— 与「这段时间确实没人写评价」完全无法区分。
--  可查询的运行记录是把这两者分开的唯一手段。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 门店侧的采集配置 ─────────────────────────────────────────────────────
--
-- `yelp_business_id` 与 `google_place_id` 已由 0000 建表时提供。
-- 这里只补 Maps URL：Bright Data 的 Google 数据集以门店页 URL 为入参，
-- 由 place_id 拼出的跳转形式虽然可用，但老板从浏览器里复制来的短链
-- （maps.app.goo.gl/…）命中率更高，因此允许显式保存。
alter table locations add column if not exists google_maps_url text;

comment on column locations.google_maps_url is
  'Bright Data 抓取 Google 评价的入参门店页 URL。为空时由 google_place_id 拼出。';

-- ── 2. 同步运行记录 ─────────────────────────────────────────────────────────

create table if not exists review_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  location_id   uuid not null references locations(id),
  platform      text not null,
  /** bright_data（完整正文） | yelp_fusion（3 条截断摘录） | google_places（仅评分） */
  source        text not null,
  status        text not null default 'running',
  /**
   * Bright Data 的快照标识。⚠️ 触发成功之后**必须先写这一列**再做别的事 ——
   * 丢掉它意味着这次抓取的费用已经产生但结果取不回来。
   */
  snapshot_id   text,
  requested_at  timestamptz not null default now(),
  finished_at   timestamptz,
  /** 同一次采集被轮询/重试了几轮。用于识别「总是卡在 running」的门店 */
  attempts      integer not null default 0,
  fetched_count  integer not null default 0,
  /** 去重之后真正新写入的条数。它长期为 0 说明增量正常，不是故障 */
  inserted_count integer not null default 0,
  skipped_count  integer not null default 0,
  /** 失败原因原样保留，供排查；不参与任何判断逻辑 */
  error         text,
  /** 抓取费用，单位毫分（1/1000 分），与 @gf/ai 的成本口径一致 */
  cost_millicents integer not null default 0,
  meta          jsonb not null default '{}'::jsonb
);

alter table review_sync_runs drop constraint if exists review_sync_runs_platform;
alter table review_sync_runs add constraint review_sync_runs_platform
  check (platform in ('google', 'yelp'));

alter table review_sync_runs drop constraint if exists review_sync_runs_source;
alter table review_sync_runs add constraint review_sync_runs_source
  check (source in ('bright_data', 'yelp_fusion', 'google_places'));

alter table review_sync_runs drop constraint if exists review_sync_runs_status;
alter table review_sync_runs add constraint review_sync_runs_status
  check (status in ('running', 'done', 'failed'));

-- 同步日志按门店倒序翻页
create index if not exists review_sync_runs_recent
  on review_sync_runs (location_id, platform, requested_at desc);

/**
 * ⭐ 一家店的一个平台上**同时只允许有一次进行中的采集**。
 *
 * 这不是整洁性约束，是费用约束：Bright Data 按记录条数计费，而定时任务
 * 与 staging 手动入口可能在同一分钟内都判断「该同步了」。没有这条唯一索引，
 * 两次触发都会成功，同一批评价被抓取并计费两次，而结果因为去重完全一致 ——
 * 从数据上看不出任何异常。
 */
create unique index if not exists review_sync_runs_one_active
  on review_sync_runs (location_id, platform) where status = 'running';

alter table review_sync_runs enable row level security;
alter table review_sync_runs force  row level security;
drop policy if exists tenant_isolation on review_sync_runs;
create policy tenant_isolation on review_sync_runs
  using       (org_id = app_org_id())
  with check  (org_id = app_org_id());

grant select, insert, update, delete on review_sync_runs to app_user;

-- ── 3. 待同步门店的跨租户枚举 ───────────────────────────────────────────────
--
-- 定时任务面对的问题和 Telnyx 通话对账一样：开始的时候不知道 org_id。
-- 这里**缺的是一个上下文，不是权限**，所以走和 0072 发票定位同一条路 ——
-- 一个 SECURITY DEFINER 函数，返回面窄到只够开出租户上下文：
-- org_id、location_id、平台、时区、语言。门店名称、地址、电话一个字都不返回。
--
-- ⚠️ 执行权只给 app_user（0083 的教训：Supabase 会给 public schema 的新函数
-- 默认授予 anon / authenticated 各一份独立的 EXECUTE，收 public 收不掉）。

create or replace function gf_review_sync_due(
  p_stale_minutes int,
  p_limit         int
)
returns table (
  org_id      uuid,
  location_id uuid,
  platform    text,
  timezone    text,
  locale      text,
  reason      text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with configured as (
    select l.org_id, l.id as location_id, o.default_locale as locale, l.timezone,
           p.platform
    from locations l
    join organizations o on o.id = l.org_id
    cross join lateral (values ('google'), ('yelp')) as p(platform)
    where l.status in ('trial', 'active')
      and (
        (p.platform = 'google' and (l.google_maps_url is not null or l.google_place_id is not null))
        or (p.platform = 'yelp' and l.yelp_business_id is not null)
      )
  ),
  latest as (
    select distinct on (r.location_id, r.platform)
           r.location_id, r.platform, r.status, r.requested_at
    from review_sync_runs r
    order by r.location_id, r.platform, r.requested_at desc
  )
  select c.org_id, c.location_id, c.platform, c.timezone, c.locale,
         -- 进行中的采集要去取结果，其余是该开新一轮了。
         -- 两种都必须返回：只返回后者的话，一次已经付过费的抓取永远没人去下载。
         case when l.status = 'running' then 'poll' else 'start' end as reason
  from configured c
  left join latest l on l.location_id = c.location_id and l.platform = c.platform
  where l.location_id is null
     or l.status = 'running'
     or l.requested_at < now() - make_interval(mins => greatest(coalesce(p_stale_minutes, 720), 5))
  order by coalesce(l.requested_at, to_timestamp(0))
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
$$;

revoke all on function public.gf_review_sync_due(int, int)
  from public, anon, authenticated;
grant execute on function public.gf_review_sync_due(int, int) to app_user;

comment on function public.gf_review_sync_due(int, int) is
  '评价同步的跨租户待办枚举（05 §8）。返回面仅够开出租户上下文，不含任何门店资料。'
  '⚠️ 只有 app_user 可执行（0083）。';
