-- ════════════════════════════════════════════════════════════════════════════
--  0082 · 测试收件箱（local / staging 的邮件与短信捕获）
--
--  ## 问题
--
--  local 和 staging 用的是测试账号：`+1617555xxxx` 收不到短信，
--  `qa-xxx@maildrop.cc` 是公开的一次性收件箱，不适合放真实内容。于是「客人
--  收到的确认信到底长什么样、
--  里面那条链接点不点得开」在上线前**从来没有人真正看过一眼** ——
--  只能等真实客人替我们发现。E2E 也因此验不了任何一条「带链接的邮件」流程。
--
--  ## 做法
--
--  `COMMUNICATION_DELIVERY_MODE=capture` 时，发信那一下不出网，
--  发件箱里的行标成新状态 `captured`。**不新建表**：内容本来就整封存在
--  `email_outbox` / `sms_outbox` 里（0029 的设计：写入时就渲染好），
--  再建一张就等于把同一封信存两遍，而两遍迟早会不一致。
--
--  ⭐ `captured` 是独立状态，不复用 `sent`。复用的话 staging 上
--  「发信成功率」会变成一个假的 100%，真正的投递故障就藏在这个 100% 底下。
--
--  ## 为什么读要走 SECURITY DEFINER
--
--  测试收件箱是**跨租户**的：运营的人要看的是「刚才那笔单发出去的信」，
--  而那笔单在哪家店他不一定知道。跨租户读在 apps/ 里拿不到连接
--  （宪法第 5 条），和 0074 的运营台读取走的是同一条路：
--  函数内部重新核对 platform_operators，返回固定 JSON 形状。
--
--  ## 保留期
--
--  测试消息 7 天后删掉（`gf_purge_captured_messages`，由
--  apps/api/src/ops/retention.ts 每小时调一次）。
--  ⚠️ **只删 captured 的行**：真发出去的记录是「我们对客人说过什么」的凭据，
--  0029 / 0034 为此专门 revoke 掉了 app_user 的 DELETE，这里不许绕过去。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 新状态 captured ──────────────────────────────────────────────────────

alter table email_outbox drop constraint if exists email_outbox_status;
alter table email_outbox add constraint email_outbox_status
  check (status in ('pending', 'sent', 'failed', 'captured'));

alter table sms_outbox drop constraint if exists sms_outbox_status;
alter table sms_outbox add constraint sms_outbox_status
  check (status in ('pending', 'sent', 'failed', 'suppressed', 'captured'));

-- 收件箱按时间倒序翻页（跨租户），以及保留期清理各要一个索引
create index if not exists email_outbox_created_idx on email_outbox (created_at desc);
create index if not exists sms_outbox_created_idx   on sms_outbox (created_at desc);
create index if not exists email_outbox_captured_idx
  on email_outbox (created_at) where status = 'captured';
create index if not exists sms_outbox_captured_idx
  on sms_outbox (created_at) where status = 'captured';

-- ── 2. 收件箱列表 ───────────────────────────────────────────────────────────

/**
 * 邮件与短信合成一条时间线。
 *
 * ⭐ 邮件正文只回 `body_text` 的截断片段，完整正文（含 HTML）留给详情接口。
 * 列表页要的是「这封信发给谁、发出去没有、错在哪」，一次拉几十封完整 HTML
 * 只会让这一页在有几百封信之后打不开。
 *
 * ⭐ 链接单独抽出来。测试收件箱最主要的用途就是**点开那条链接**
 * （激活、重置密码、健康表、电子小票），让人从一段 HTML 源码里
 * 自己找 href 是在给每一次测试加一道无谓的手工步骤。
 */
create or replace function gf_platform_test_inbox(
  p_channel text,
  p_status  text,
  p_search  text,
  p_limit   int,
  p_offset  int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  lim int;
  off int;
  chan text;
  needle text;
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();
  lim := least(greatest(coalesce(p_limit, 50), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);
  chan := nullif(coalesce(p_channel, ''), '');
  needle := nullif(btrim(coalesce(p_search, '')), '');

  with unified as (
    select
      'email'::text as channel,
      e.id,
      e.org_id,
      e.location_id,
      e.kind,
      e.to_email as recipient,
      e.subject,
      e.body_text as body,
      e.status,
      e.attempts,
      e.last_error,
      e.provider_id,
      e.created_at,
      e.sent_at
    from email_outbox e
    where chan is null or chan = 'email'
    union all
    select
      'sms'::text,
      s.id,
      s.org_id,
      s.location_id,
      s.kind,
      s.to_e164,
      null::text,
      s.body,
      s.status,
      s.attempts,
      s.last_error,
      s.provider_id,
      s.created_at,
      s.sent_at
    from sms_outbox s
    where chan is null or chan = 'sms'
  ), filtered as (
    select u.*, count(*) over () as total_count
    from unified u
    where (p_status is null or p_status = '' or u.status = p_status)
      and (needle is null
           or u.recipient ilike '%' || needle || '%'
           or coalesce(u.subject, '') ilike '%' || needle || '%'
           or u.body ilike '%' || needle || '%')
  ), paged as (
    select * from filtered order by created_at desc limit lim offset off
  )
  select
    coalesce((select max(total_count)::int from filtered), 0),
    coalesce(
      (select jsonb_agg(to_jsonb(x) order by x."createdAt" desc)
       from (
         select
           p.channel,
           p.id,
           p.location_id as "locationId",
           coalesce(l.name->>'en', l.slug) as "locationName",
           p.kind,
           p.recipient,
           p.subject,
           left(p.body, 240) as preview,
           p.status,
           p.attempts,
           p.last_error as "lastError",
           p.provider_id as "providerId",
           p.created_at as "createdAt",
           p.sent_at as "sentAt",
           (select coalesce(jsonb_agg(distinct m[1]), '[]'::jsonb)
              from regexp_matches(p.body, 'https?://[^\s"''<>)]+', 'g') m) as links
         from paged p
         left join locations l on l.id = p.location_id
       ) x),
      '[]'::jsonb)
  into total, items;

  return jsonb_build_object('total', total, 'items', items);
end;
$$;

-- ── 3. 单封详情（完整正文，含 HTML） ───────────────────────────────────────

create or replace function gf_platform_test_message(p_channel text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  out jsonb;
begin
  perform gf_platform_assert_operator();

  if p_channel = 'email' then
    select to_jsonb(x) into out
    from (
      select
        'email'::text as channel,
        e.id,
        e.location_id as "locationId",
        coalesce(l.name->>'en', l.slug) as "locationName",
        e.kind,
        e.to_email as recipient,
        e.subject,
        e.body_text as "bodyText",
        e.body_html as "bodyHtml",
        e.status,
        e.attempts,
        e.last_error as "lastError",
        e.provider_id as "providerId",
        e.entity_type as "entityType",
        e.entity_id as "entityId",
        e.created_at as "createdAt",
        e.sent_at as "sentAt",
        -- 正文与 HTML 里是同一批链接，distinct：列两遍只会让人怀疑发了两封
        (select coalesce(jsonb_agg(distinct m[1]), '[]'::jsonb)
           from regexp_matches(e.body_text || ' ' || e.body_html,
                               'https?://[^\s"''<>)]+', 'g') m) as links
      from email_outbox e
      left join locations l on l.id = e.location_id
      where e.id = p_id
    ) x;
  elsif p_channel = 'sms' then
    select to_jsonb(x) into out
    from (
      select
        'sms'::text as channel,
        s.id,
        s.location_id as "locationId",
        coalesce(l.name->>'en', l.slug) as "locationName",
        s.kind,
        s.to_e164 as recipient,
        null::text as subject,
        s.body as "bodyText",
        null::text as "bodyHtml",
        s.status,
        s.attempts,
        s.last_error as "lastError",
        s.provider_id as "providerId",
        s.entity_type as "entityType",
        s.entity_id as "entityId",
        s.created_at as "createdAt",
        s.sent_at as "sentAt",
        s.segments,
        s.from_e164 as "fromE164",
        (select coalesce(jsonb_agg(distinct m[1]), '[]'::jsonb)
           from regexp_matches(s.body, 'https?://[^\s"''<>)]+', 'g') m) as links
      from sms_outbox s
      left join locations l on l.id = s.location_id
      where s.id = p_id
    ) x;
  else
    out := null;
  end if;

  return out;
end;
$$;

-- ── 4. 保留期清理 ───────────────────────────────────────────────────────────

/**
 * 删掉过了保留期的**测试消息**，返回删除行数。
 *
 * ⚠️ `where status = 'captured'` 这个条件是这个函数的全部意义所在：
 * 真发出去的记录一行都不许碰（0029 / 0034 为此 revoke 掉了 app_user 的
 * DELETE 权限）。保留期下限钳在 1 天，调用方传 0 也删不掉今天的东西 ——
 * 昨天跑的那次测试今天还要能查（和 gf_purge_command_idempotency 同一个套路）。
 */
create or replace function gf_purge_captured_messages(p_retain_days int default 7)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  days int := greatest(coalesce(p_retain_days, 7), 1);
  removed int;
  total int := 0;
begin
  delete from email_outbox
   where status = 'captured' and created_at < now() - (days || ' days')::interval;
  get diagnostics removed = row_count;
  total := total + removed;

  delete from sms_outbox
   where status = 'captured' and created_at < now() - (days || ' days')::interval;
  get diagnostics removed = row_count;
  return total + removed;
end;
$$;

-- ── 5. 权限 ────────────────────────────────────────────────────────────────

revoke all on function public.gf_platform_test_inbox(text, text, text, int, int)
  from public, anon, authenticated;
revoke all on function public.gf_platform_test_message(text, uuid)
  from public, anon, authenticated;
revoke all on function public.gf_purge_captured_messages(int) from public, anon, authenticated;

grant execute on function public.gf_platform_test_inbox(text, text, text, int, int) to app_user;
grant execute on function public.gf_platform_test_message(text, uuid) to app_user;
grant execute on function public.gf_purge_captured_messages(int) to app_user;

comment on function public.gf_platform_test_inbox(text, text, text, int, int) is
  '测试收件箱列表（运营台）。跨租户读，函数内部重新核对 platform_operators。';
comment on function public.gf_purge_captured_messages(int) is
  '删除过了保留期的 captured 测试消息。只删 captured：真发出去的记录是凭据。';
