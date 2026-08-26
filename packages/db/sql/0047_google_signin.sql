-- 0047 · Google 账号登录：认领门店那条路要跟着改
--
-- 前端接 `signInWithOAuth({ provider: 'google' })`。JWT 那一侧什么都不用动
-- （`auth.ts` 验的是 Supabase 的 JWKS，谁签发的会话它不关心），
-- 真正会出事的是**认领门店**那一步 —— 它比对的是邮箱字符串。
--
-- ## 会出事的那个场景
--
--   1. 老板在官网结账，邮箱框里手打 `john.doe@gmail.com`
--   2. 我们把这个字符串存进 `signup_intents.owner_email`
--   3. 他回头点「用 Google 登录」，Google 返回的是规范形式 `johndoe@gmail.com`
--   4. `lower(si.owner_email) = lower(u.email)` → 不相等 → 认领返回 404
--
-- **他付了钱，而且进不去。** 报错还是「没有可认领的门店」——
-- 客服看到这句话第一反应是去查 webhook，而 webhook 一切正常。
--
-- Gmail 忽略本地部分里的点、也忽略 `+` 之后的部分。这两条在美国小店老板
-- 身上命中率极高：这一行几乎人人用 Gmail，而结账时手打邮箱带不带点
-- 完全看当时怎么顺手。
--
-- ## 只对 Gmail 做规范化
--
-- ⚠️ 点号规则**只有 gmail.com / googlemail.com 成立**。
-- Google Workspace 的自建域名（`john.doe@corp.com`）**不忽略点** ——
-- 那里 `john.doe@` 和 `johndoe@` 是两个人。一视同仁地去点，
-- 会让 A 认领到 B 付钱的店，比原来的问题严重得多。
--
-- `+` 标签同理只在 Gmail 上剥：别的域名剥掉，
-- 会把「同一个老板故意用 `owner+store1@` / `owner+store2@` 分开两家店」
-- 折叠成一条，而那是他有意为之的区分。

create or replace function public.gf_canonical_email(p_email text)
returns text
language sql
immutable
as $$
  select case
    when p_email is null or position('@' in p_email) = 0 then lower(trim(p_email))
    when lower(split_part(trim(p_email), '@', 2)) in ('gmail.com', 'googlemail.com')
      -- 先剥 +tag，再去点，域名统一收敛到 gmail.com
      then replace(split_part(lower(split_part(trim(p_email), '@', 1)), '+', 1), '.', '')
           || '@gmail.com'
    else lower(trim(p_email))
  end
$$;

comment on function public.gf_canonical_email(text) is
  'Gmail 的规范邮箱：忽略本地部分的点、剥掉 +tag、googlemail 收敛成 gmail。'
  '⚠️ 只对 gmail.com/googlemail.com 生效 —— Workspace 自建域名不忽略点，'
  '一视同仁地去点会让 A 认领到 B 付钱的店。';

-- 认领用的索引跟着换。老的那条（lower(owner_email)）留着不动 ——
-- 别处（客服按邮箱查开户状态）还在用它，而这张表小到多一条索引无所谓
create index if not exists signup_intents_unclaimed_canon
  on signup_intents (public.gf_canonical_email(owner_email)) where claimed_at is null;

-- ── 认领判定：改成按规范邮箱比对，并把店名一起带出来 ───────────────────────
--
-- 店名是给前端用的：Google 登录之后那一屏要写
-- 「你有一家 Lotus Nails & Spa 等着开通」，而不是一个光秃秃的「认领」按钮。
--
-- `email_confirmed_at is not null` 这一条**一个字都不能松**：
-- 不验的话任何人都可以用别人的邮箱注册一个未验证账号来认领他的店。
-- Google 登录天然满足它（OAuth 回来的邮箱是已验证的），
-- 所以这一条对 Google 那条路不构成任何摩擦。

drop function if exists public.gf_signup_intent_for_user(uuid);

create or replace function public.gf_signup_intent_for_user(p_user_id uuid)
returns table (
  intent_id uuid, org_id uuid, location_id uuid, owner_email text, plan text,
  shop_name text
)
language sql
security definer
set search_path = public
as $$
  select si.id, si.org_id, si.location_id, si.owner_email, si.plan,
         coalesce(l.name->>'en', l.name->>'zh-Hans', l.slug)
  from signup_intents si
  join auth.users u on u.id = p_user_id
  join locations l on l.id = si.location_id
  where si.claimed_at is null
    and u.email is not null
    and u.email_confirmed_at is not null
    and public.gf_canonical_email(si.owner_email) = public.gf_canonical_email(u.email)
  order by si.provisioned_at
  limit 1
$$;

revoke all on function public.gf_signup_intent_for_user(uuid) from public;
grant execute on function public.gf_signup_intent_for_user(uuid) to app_user;

comment on function public.gf_signup_intent_for_user(uuid) is
  '这个登录用户可以认领的那一家店（只读）。邮箱比对的是 auth.users 里的那一行，'
  '不是应用传进来的字符串 —— 写松了等于任何登录用户都能认领别人付了钱的店。'
  '0047 起按 gf_canonical_email 比对，Gmail 的点与 +tag 不再造成「付了钱进不去」。';

-- ── 头像：Google 登录白送的一张脸 ───────────────────────────────────────────
--
-- `users.avatar_url` 这一列从 0001 就在，但没有任何地方往里写过。
-- Google 的 OAuth 回包里带 `avatar_url` / `picture`，同步过来是一行的事，
-- 而它会出现在员工列表、审计流水的操作人旁边 —— 十个人的店里，
-- 认脸比认名字快。
--
-- 语义和 full_name 一致：**本地有值就不覆盖**。老板在系统里改过的显示名
-- 和头像，不该被他某天换了一张 Google 头像给冲掉。

create or replace function public.gf_sync_user_from_auth(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text;
  v_name   text;
  v_avatar text;
begin
  select u.email,
         coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
         -- Google 用 avatar_url，OIDC 标准字段是 picture。两个都认
         coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
    into v_email, v_name, v_avatar
  from auth.users u where u.id = p_user_id;

  if v_email is null then
    raise exception '用户 % 在 auth.users 里不存在或没有邮箱', p_user_id;
  end if;

  insert into users (id, email, full_name, avatar_url)
  values (p_user_id, v_email, v_name, v_avatar)
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(users.full_name, excluded.full_name),
    avatar_url = coalesce(users.avatar_url, excluded.avatar_url);

  return p_user_id;
end $$;

revoke all on function public.gf_sync_user_from_auth(uuid) from public;
grant execute on function public.gf_sync_user_from_auth(uuid) to app_user;

comment on function public.gf_sync_user_from_auth(uuid) is
  '把 auth.users 里调用者自己那一行镜像进 public.users（含 Google 头像）。'
  '存在的理由是两个结构性障碍：users 的 RLS 要求先有 membership（而 membership'
  '外键指向 users），以及 auth schema 对 app_user 不可见。';
