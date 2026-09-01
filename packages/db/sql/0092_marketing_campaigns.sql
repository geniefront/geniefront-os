-- ════════════════════════════════════════════════════════════════════════════
--  0092 · 营销四事件的取件口径
--
--  批 7 定了四个营销事件键（birthday / holiday / winback / review_request）、
--  建了模板表与规则表，`offset_min` 也存了值 —— 但**全仓没有任何代码读它们**。
--  也就是说这四条从来没发过，而设置页上那几个开关看起来是好的。
--
--  ## ⚠️ 这四个函数只负责「该发给谁」
--
--  发不发得出去由应用侧的两道闸门决定（`sms/gate.ts`：门店 10DLC 未获批
--  一条不发；`notify/dispatch.ts`：营销邮件要门店专属发件域名）。取件函数
--  不重复这两条判断 —— 判据只应有一处，重复一遍就多一处会写反的地方。
--
--  ## 去重靠发件箱的唯一索引，不建新表
--
--  `(entity_type, entity_id, kind)` 上有唯一索引（sql/0029）。把**周期**编进
--  `entity_type` 就得到天然的去重：
--
--    birthday_2026            一位顾客一年最多一封生日祝福
--    holiday_<holiday_id>     一个节日一位顾客一封
--    winback_2026-09          一位顾客一个月最多一封唤回
--    ticket_review            一张工单一封求评
--
--  另建一张「发过没有」的表意味着它与发件箱可能不一致，而不一致时以哪边
--  为准没有答案。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 节日：哪一天、叫什么，只能由人来定 ─────────────────────────────────
--
-- 生日、唤回、求评都能从既有数据推出触发时刻，节日不能：「感恩节」是哪天、
-- 中文店要不要发中秋，系统无从判断。`{{holiday_name}}` 这个模板变量的存在
-- 本身就说明了这一点 —— 它要一个名字。
create table if not exists marketing_holidays (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  location_id uuid not null references locations(id) on delete cascade,
  /** 填进 {{holiday_name}} 的那个名字。顾客看得到，所以是英文 */
  name        text not null,
  /** 门店本地日期。当天到点就发 */
  send_on     date not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 同一家店同一天只留一个节日：两条一起发，顾客一天收两封
create unique index if not exists marketing_holidays_uidx
  on marketing_holidays (location_id, send_on);

alter table marketing_holidays enable row level security;
alter table marketing_holidays force  row level security;
drop policy if exists tenant_isolation on marketing_holidays;
create policy tenant_isolation on marketing_holidays
  using (org_id = app_org_id()) with check (org_id = app_org_id());
grant select, insert, update, delete on marketing_holidays to app_user;

comment on table marketing_holidays is
  '门店自己定的节日营销日程。哪一天、叫什么，系统无从推断（0092）。';

-- ── 2. 取件：生日 ─────────────────────────────────────────────────────────
--
-- ⚠️ 按**月日**比对，不是按完整日期 —— 生日年年过。
-- ⚠️ 2 月 29 日出生的人：平年没有 2/29，因此当年不发。补到 2/28 或 3/1 都是
--    替顾客做决定，而少发一封远比发错日子安全。
create or replace function gf_marketing_birthdays_due(
  p_send_hour integer default 10,
  p_limit integer default 200
) returns table (
  org_id uuid, location_id uuid, customer_id uuid, period text
)
language sql security definer set search_path = public
as $$
  select c.org_id, l.id, c.id,
         'birthday_' || extract(year from (now() at time zone l.timezone))::int
  from customers c
  join locations l on l.id = c.primary_location_id
  where c.birthday is not null
    and c.merged_into_id is null
    and c.blocked_at is null
    and l.status <> 'archived'
    and extract(month from c.birthday) = extract(month from (now() at time zone l.timezone))
    and extract(day   from c.birthday) = extract(day   from (now() at time zone l.timezone))
    and extract(hour from (now() at time zone l.timezone)) >= p_send_hour
  order by c.id
  limit p_limit
$$;

-- ── 3. 取件：节日 ─────────────────────────────────────────────────────────
create or replace function gf_marketing_holidays_due(
  p_send_hour integer default 10,
  p_limit integer default 500
) returns table (
  org_id uuid, location_id uuid, customer_id uuid, period text, holiday_name text
)
language sql security definer set search_path = public
as $$
  select c.org_id, l.id, c.id, 'holiday_' || h.id::text, h.name
  from marketing_holidays h
  join locations l on l.id = h.location_id
  join customers c on c.primary_location_id = l.id
  where h.enabled
    and h.send_on = (now() at time zone l.timezone)::date
    and extract(hour from (now() at time zone l.timezone)) >= p_send_hour
    and c.merged_into_id is null
    and c.blocked_at is null
    and l.status <> 'archived'
  order by c.id
  limit p_limit
$$;

-- ── 4. 取件：唤回 ─────────────────────────────────────────────────────────
--
-- ⚠️ 只算**已结的单**（`status = 'closed'`）。作废与退款的单在账上是冲销的，
--    把它算成「来过」会让一个退过款的顾客一直不被唤回。
-- ⚠️ 从没来过的顾客不唤回：`{{days_since}}` 填不出数字，而「我们想你了」
--    发给一个从未到店的人是荒谬的。
create or replace function gf_marketing_winback_due(
  p_days integer default 90,
  p_send_hour integer default 10,
  p_limit integer default 200
) returns table (
  org_id uuid, location_id uuid, customer_id uuid, period text, days_since integer
)
language sql security definer set search_path = public
as $$
  with last_visit as (
    select t.customer_id, t.location_id, max(t.business_date) as last_on
    from tickets t
    where t.status = 'closed' and t.customer_id is not null
    group by t.customer_id, t.location_id
  )
  select c.org_id, l.id, c.id,
         'winback_' || to_char(now() at time zone l.timezone, 'YYYY-MM'),
         ((now() at time zone l.timezone)::date - v.last_on)::int
  from last_visit v
  join locations l on l.id = v.location_id
  join customers c on c.id = v.customer_id
  where c.merged_into_id is null
    and c.blocked_at is null
    and l.status <> 'archived'
    and ((now() at time zone l.timezone)::date - v.last_on) >= p_days
    and extract(hour from (now() at time zone l.timezone)) >= p_send_hour
  order by v.last_on
  limit p_limit
$$;

-- ── 5. 取件：求评 ─────────────────────────────────────────────────────────
--
-- ⚠️ 结账之后隔 `p_delay_hours` 才问。刚付完钱就被问「给个好评吧」，
--    顾客还没走出店门 —— 而且那时他还没形成评价。
-- ⚠️ 只问**没有退款**的单。退过款的顾客最不该被请去写公开评价。
create or replace function gf_marketing_review_requests_due(
  p_delay_hours integer default 3,
  p_send_hour integer default 10,
  p_limit integer default 200
) returns table (
  org_id uuid, location_id uuid, customer_id uuid, ticket_id uuid
)
language sql security definer set search_path = public
as $$
  select t.org_id, t.location_id, t.customer_id, t.id
  from tickets t
  join locations l on l.id = t.location_id
  join customers c on c.id = t.customer_id
  where t.status = 'closed'
    and t.customer_id is not null
    and t.closed_at is not null
    and t.closed_at < now() - make_interval(hours => p_delay_hours)
    and t.closed_at > now() - interval '7 days'
    and coalesce(t.refund_cents, 0) = 0
    and c.merged_into_id is null
    and c.blocked_at is null
    and l.status <> 'archived'
    and extract(hour from (now() at time zone l.timezone)) >= p_send_hour
  order by t.closed_at
  limit p_limit
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'gf_marketing_birthdays_due(integer,integer)',
    'gf_marketing_holidays_due(integer,integer)',
    'gf_marketing_winback_due(integer,integer,integer)',
    'gf_marketing_review_requests_due(integer,integer,integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to app_user', f);
  end loop;
end $$;
