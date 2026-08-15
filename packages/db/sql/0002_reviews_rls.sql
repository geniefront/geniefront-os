-- ════════════════════════════════════════════════════════════════════════════
--  0002 · 新增评价相关表的 RLS
--
--  新建的业务表默认【没有】RLS。0001 里那个批量循环只覆盖了当时存在的表，
--  所以每加一张带 org_id 的表，都要在这里补一条 —— 漏了就是租户数据泄露。
--  最后那段断言会把漏网的表直接报出来。
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  t text;
begin
  foreach t in array array['location_reviews','location_review_stats','review_summaries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using       (org_id = app_org_id())
        with check  (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

grant select, insert, update, delete
  on location_reviews, location_review_stats, review_summaries to app_user;

-- ────────────────────────────────────────────────────────────────────────────
-- 兜底断言：任何带 org_id 却没开 RLS 的表，迁移直接失败
--
-- 这条比上面的循环重要 —— 循环要人记得改，断言不用。
-- 以后谁新建了业务表忘了开 RLS，跑迁移时就会被拦下，而不是等上线泄露数据。
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  missing text[];
begin
  select array_agg(c.relname order by c.relname) into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if missing is not null then
    raise exception '这些表有 org_id 但没开强制 RLS：%。补上 enable + force + tenant_isolation 策略。', missing;
  end if;
end $$;
