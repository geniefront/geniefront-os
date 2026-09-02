-- ════════════════════════════════════════════════════════════════════════════
--  0098 · 管理令牌跨租户解析
--
--  托管管理页 URL 是 /l/{slug}/g/{token}，没有 public_key，也没有预约 id。
--  库里只存 SHA-256 摘要。这一份提供：
--
--    1. 非空 digest 的全局部分唯一索引（lookup 恰好一行）
--    2. 一条 SECURITY DEFINER 只读函数：digest → org/location/appointment
--       认出来之后立刻切回 withTenant()，不把 slug 会话扩到预约表
--
--  这是计划里「明确记录的 token-resolution read」例外。
--  函数不返回明文令牌、顾客电话、备注。anon 不可执行。
-- ════════════════════════════════════════════════════════════════════════════

create unique index if not exists appointments_manage_digest_uidx
  on appointments (manage_token_digest)
  where manage_token_digest is not null;

create or replace function gf_booking_by_manage_digest(p_digest text)
returns table (
  appointment_id uuid,
  org_id uuid,
  location_id uuid,
  slug text,
  appointment_status text,
  location_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.org_id, a.location_id, l.slug, a.status, l.status
    from public.appointments a
    join public.locations l on l.id = a.location_id
   where a.manage_token_digest = p_digest
   limit 1;
$$;

comment on function gf_booking_by_manage_digest(text) is
  'Token-resolution read: digest to appointment tenant. Does not return the raw token or customer PII.';

revoke all on function public.gf_booking_by_manage_digest(text)
  from public, anon, authenticated;
grant execute on function public.gf_booking_by_manage_digest(text) to app_user;
