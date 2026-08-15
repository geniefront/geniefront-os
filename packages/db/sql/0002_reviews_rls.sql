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

-- 「所有带 org_id 的表都开了 RLS」这条断言不放在这里：
-- 它依赖「当下所有表都已建好」，而全新数据库是先建完所有表再跑守护 SQL 的，
-- 那时后面迁移才加的表（tickets 等）已经存在但 RLS 还没轮到。
-- 断言移到 migrate.ts，每次迁移【全部跑完之后】统一检查一次。
