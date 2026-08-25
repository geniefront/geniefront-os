-- 0042 · public_key 触发器换掉 gen_random_bytes（批 4 顺带修的生产隐患）
--
-- ## 症状
--
-- 以 **app_user** 身份 `insert into locations` 会直接失败：
--   ERROR: function gen_random_bytes(integer) does not exist
--
-- ## 为什么之前没暴露
--
-- 在批 4 之前，门店只有一条出生路径：`gf_provision_tenant()` ——
-- 那是个 SECURITY DEFINER 函数，跑在 **postgres** 身份下。
-- 而 postgres 的 search_path 里有 `extensions`，app_user 的没有
-- （`pg_roles.rolconfig` 是 null，用的是默认的 `"$user", public`）。
-- pgcrypto 装在 `extensions` schema 里 → 只有 postgres 找得到它。
--
-- 批 4 加了 `location.create` 命令，那条路是 app_user 走的，当场撞上。
--
-- ## 为什么不是「把 extensions 加进 app_user 的 search_path」
--
-- 那是 Supabase 托管的角色配置，我们改它等于和平台的默认设置较劲；
-- 而且加一个 schema 进 search_path 会顺带让那里面**所有**函数
-- 变得可直接调用 —— 为了一个随机数放宽整片命名空间，不划算。
--
-- ## 换成 gen_random_uuid()
--
-- 它是 **PostgreSQL 13+ 的核心函数**（在 pg_catalog 里），
-- 任何 search_path 下都解析得到，不依赖任何扩展。
-- 熵一样：取 uuid 的 24 位 hex = 96 bit，和 gen_random_bytes(12) 相同。

create or replace function gf_ensure_public_key() returns trigger
language plpgsql as $$
begin
  if new.public_key is null or length(new.public_key) < 27 then
    -- ⚠️ 不要改回 gen_random_bytes：那个函数在 app_user 的 search_path 里
    -- 找不到（pgcrypto 在 extensions schema）。gen_random_uuid 是 pg_catalog 的
    new.public_key := 'pk_' || left(replace(gen_random_uuid()::text, '-', ''), 24);
  end if;
  return new;
end $$;
