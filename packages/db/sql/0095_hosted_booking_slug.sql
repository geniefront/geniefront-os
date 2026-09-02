-- ════════════════════════════════════════════════════════════════════════════
--  0095 · 托管预约页的门店 slug：平台级唯一、规范化、可安全重放
--
--  book.geniefront.com/{slug} 是没有独立官网的店的预约入口。slug 是查找键，
--  不是密钥；public_key 的行为不变。
--
--  规范化规则与 packages/contracts/src/shopSlug.ts 必须一致：
--    · 小写 ASCII
--    · 只保留字母、数字、单个连字符
--    · 去掉首尾连字符
--    · 长度 2–64
--    · 拒绝保留路径 l / g / b / assets / api / public / health / login / admin
--
--  已有合法且不冲突的 slug 原样保留。非法或撞车的，追一段由 location id
--  决定的短后缀 —— 绝不把已有链接悄悄指到另一家店。
-- ════════════════════════════════════════════════════════════════════════════

create or replace function gf_normalize_shop_slug(raw text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    trim(both '-' from regexp_replace(lower(trim(coalesce(raw, ''))), '[^a-z0-9]+', '-', 'g')),
    ''
  );
$$;

create or replace function gf_shop_slug_reserved(p_slug text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_slug in (
    'l', 'g', 'b', 'assets', 'api', 'public', 'health', 'login', 'admin'
  );
$$;

create or replace function gf_shop_slug_canonical(p_slug text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_slug is not null
     and p_slug = gf_normalize_shop_slug(p_slug)
     and char_length(p_slug) between 2 and 64
     and p_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     and not gf_shop_slug_reserved(p_slug);
$$;

-- 跨租户查重。SECURITY DEFINER 是因为 locations 有 FORCE RLS，
-- 普通 withTenant 查询看不见别的店，而 slug 的唯一性是平台级的。
create or replace function gf_shop_slug_taken(p_slug text, p_except_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.locations
     where slug = p_slug
       and id is distinct from p_except_id
  );
$$;

create or replace function gf_repair_shop_slugs()
returns integer
language plpgsql
as $$
declare
  rec record;
  candidate text;
  suffix text;
  changed int := 0;
begin
  for rec in
    select id, slug, created_at
      from locations
     order by created_at asc, id asc
  loop
    -- 已经合法、且没有更早的同行占用同一 slug → 原样留下
    if gf_shop_slug_canonical(rec.slug)
       and not exists (
         select 1
           from locations k
          where k.id <> rec.id
            and k.slug = rec.slug
            and gf_shop_slug_canonical(k.slug)
            and (k.created_at, k.id) < (rec.created_at, rec.id)
       )
    then
      continue;
    end if;

    candidate := gf_normalize_shop_slug(rec.slug);
    if candidate is null
       or char_length(candidate) < 2
       or gf_shop_slug_reserved(candidate)
    then
      candidate := 'shop';
    elsif char_length(candidate) > 64 then
      candidate := trim(both '-' from left(candidate, 64));
      if candidate is null or candidate = '' or char_length(candidate) < 2 then
        candidate := 'shop';
      end if;
    end if;

    if exists (select 1 from locations where slug = candidate and id <> rec.id) then
      suffix := left(replace(rec.id::text, '-', ''), 8);
      candidate := trim(both '-' from left(candidate, 64 - 1 - length(suffix)))
                   || '-' || suffix;
      if candidate is null
         or not (candidate ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
         or exists (select 1 from locations where slug = candidate and id <> rec.id)
      then
        candidate := 'shop-' || replace(rec.id::text, '-', '');
      end if;
    end if;

    if candidate is distinct from rec.slug then
      -- 不碰 updated_at：这是一次平台修复，不是老板改了资料
      update locations set slug = candidate where id = rec.id;
      changed := changed + 1;
    end if;
  end loop;

  return changed;
end;
$$;

comment on function gf_normalize_shop_slug(text) is
  'Hosted booking slug canonical form. Must match packages/contracts shopSlug.ts.';
comment on function gf_shop_slug_taken(text, uuid) is
  'Platform-wide slug occupancy. SECURITY DEFINER because uniqueness is not tenant-scoped.';
comment on function gf_repair_shop_slugs() is
  'Idempotent rewrite of invalid/duplicate location slugs. Safe to call more than once.';

select gf_repair_shop_slugs();

alter table locations drop constraint if exists locations_slug_format_chk;
alter table locations
  add constraint locations_slug_format_chk
  check (gf_shop_slug_canonical(slug));

create unique index if not exists locations_slug_uidx on locations (slug);

revoke all on function public.gf_normalize_shop_slug(text)
  from public, anon, authenticated;
revoke all on function public.gf_shop_slug_reserved(text)
  from public, anon, authenticated;
revoke all on function public.gf_shop_slug_canonical(text)
  from public, anon, authenticated;
revoke all on function public.gf_shop_slug_taken(text, uuid)
  from public, anon, authenticated;
revoke all on function public.gf_repair_shop_slugs()
  from public, anon, authenticated;

grant execute on function public.gf_normalize_shop_slug(text) to app_user;
grant execute on function public.gf_shop_slug_reserved(text) to app_user;
grant execute on function public.gf_shop_slug_canonical(text) to app_user;
grant execute on function public.gf_shop_slug_taken(text, uuid) to app_user;
