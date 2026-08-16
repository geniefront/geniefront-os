-- ════════════════════════════════════════════════════════════════════════════
--  0014 · Phase 2：AI 拍照开店的草案表 RLS、约束与价目表照片私有桶
--
--  这一份守住三件事：
--    1. 草案和业务表一样受租户隔离 —— 草案里有店主的定价，泄露了就是泄露了
--    2. 已落地/已放弃的草案不可再改 —— 否则「回填过的东西」会被悄悄篡改
--    3. 价目表照片走 Supabase Storage 私有桶，授权复用 0011 的 user_in_location()
--       （应用侧一行 Storage 代码都不写，也就没有 service_role 的口子）
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. RLS ─────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['shop_blueprints','blueprint_sources','blueprint_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (org_id = app_org_id()) with check (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

grant select, insert, update, delete on
  shop_blueprints, blueprint_sources, blueprint_items
  to app_user;

-- 草案是**可以**整份删掉的（宪法第 9 条只管财务与健康数据）。
-- 一次拍歪了的提取没有留档价值，逼老板在列表里看着一堆垃圾草案才是坏设计。

-- ── 2. 值域约束 ────────────────────────────────────────────────────────────
--
-- 这些在 Zod 里也校验一遍。写两遍不是重复：Zod 挡的是「这次请求」，
-- 约束挡的是「将来某个手滑的迁移脚本」。confidence 一旦混进 0–1 的小数，
-- 确认页的标黄阈值会静默失效 —— 所有行都不标黄，看起来像提取得特别准。
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_items_confidence_bp') then
    alter table blueprint_items add constraint blueprint_items_confidence_bp
      check (confidence_bp between 0 and 10000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'blueprint_items_decision') then
    alter table blueprint_items add constraint blueprint_items_decision
      check (decision in ('pending','accepted','rejected'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'blueprint_items_kind') then
    alter table blueprint_items add constraint blueprint_items_kind
      check (kind in ('service','addon','note','price_modifier'));
  end if;

  -- 负价格与荒唐时长在 UI 上表现成「一单 -$40」，前台会当系统坏了。
  -- 上限 600 分钟和 services.duration_min 的 Zod 上限对齐。
  if not exists (select 1 from pg_constraint where conname = 'blueprint_items_sane') then
    alter table blueprint_items add constraint blueprint_items_sane
      check (
        (price_cents is null or price_cents >= 0) and
        (duration_min is null or duration_min between 1 and 600)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'shop_blueprints_status') then
    alter table shop_blueprints add constraint shop_blueprints_status
      check (status in ('draft','applied','discarded'));
  end if;
end $$;

-- ── 3. 封板：applied / discarded 的草案不可再改 ────────────────────────────
--
-- 落地那一刻草案就变成了一张「当时提取成了什么」的凭证。
-- 之后还能改的话，老板发现某个项目价格不对时，改的到底是草案还是真项目
-- 就永远说不清了 —— 真项目在 services 里，改那边才对。
-- ⚠️ 不能写 coalesce(new.blueprint_id, old.blueprint_id)：
-- plpgsql 在 INSERT 触发器里 OLD 是未赋值的 record，而 coalesce 两个参数都会求值，
-- 于是每一次插入都会炸在 "record old is not assigned yet" 上 —— 且只在插入时炸。
create or replace function blueprint_frozen() returns trigger
language plpgsql as $$
declare st text;
begin
  select status into st from shop_blueprints where id = new.blueprint_id;
  if st is distinct from 'draft' then
    raise exception '这份开店草案已经%了，不能再改',
      case st when 'applied' then '回填落地' else '放弃' end
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

-- 草案本身同样单向：draft → applied / discarded，不能倒回去。
-- 倒回去意味着「已经建出来的 services 对应的那份凭证又变成可编辑的了」。
create or replace function blueprint_status_forward_only() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' and new.status <> old.status then
    raise exception '开店草案已经是 % 状态，不能再改回 %', old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

drop trigger if exists shop_blueprints_forward_only on shop_blueprints;
create trigger shop_blueprints_forward_only
  before update on shop_blueprints
  for each row execute function blueprint_status_forward_only();

drop trigger if exists blueprint_items_frozen on blueprint_items;
create trigger blueprint_items_frozen
  before insert or update on blueprint_items
  for each row
  -- 落地时要写 applied_service_id，那一步走的是同一个事务里的
  -- shop_blueprints 更新之前，所以此刻 status 还是 draft，不会被自己挡住。
  execute function blueprint_frozen();

-- ── 4. 价目表照片的私有桶 ──────────────────────────────────────────────────
--
-- ⭐ 照片由前台浏览器**直接**传给 Supabase Storage，用店主自己的会话令牌，
--    授权由 Storage 的 RLS 判定。API 侧一行 Storage 代码都不写。
--
--    这不是图省事：让 API 代传就得拿 service_role 或自己签 URL，
--    那正是宪法第 5 条要挡的那条路 —— 一旦开了口子，
--    「哪些请求绕过了 RLS」就不再是一个能靠 CI 回答的问题。
--
--    路径约定 `{location_id}/{blueprint_id}/{seq}.jpg`，
--    第一段必须是 uuid，且必须是调用者有身份的那家店（复用 0011 的函数）。
--
-- ⚠️ storage schema 的属主是 supabase_storage_admin，不是我们。
--    权限不够时不该让整个迁移失败 —— 照片是增强项，提取本身不依赖它。
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('price-lists', 'price-lists', false, 15728640,
          array['image/jpeg','image/png','image/webp'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists price_lists_rw on storage.objects$p$;
  execute $p$
    create policy price_lists_rw on storage.objects
      for all to authenticated
      using (
        bucket_id = 'price-lists'
        and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        and public.user_in_location(((storage.foldername(name))[1])::uuid)
      )
      with check (
        bucket_id = 'price-lists'
        and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        and public.user_in_location(((storage.foldername(name))[1])::uuid)
      )
  $p$;

  raise notice '✓ price-lists 私有桶与策略已就绪';
exception
  when insufficient_privilege or undefined_table then
    raise warning '跳过 price-lists 桶（storage schema 不可写）：% —— 提取仍可用，只是确认页没有原图对照', sqlerrm;
end $$;
