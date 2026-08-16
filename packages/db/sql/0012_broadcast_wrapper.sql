-- ════════════════════════════════════════════════════════════════════════════
--  0012 · 广播包装函数
--
--  0011 里那句 `grant insert on realtime.messages to app_user` **没生效**：
--  那张表的 owner 是 supabase_realtime_admin，我们的迁移角色 postgres
--  对它没有 GRANT OPTION，于是 PostgreSQL 只发了个 WARNING 就过去了
--  （"no privileges were granted"），迁移看起来是成功的。
--  症状是每条广播都在日志里留一条 "permission denied for table messages"，
--  而业务毫发无损 —— 正因为无损，这种事能潜伏很久。
--
--  正确做法：一个 owner = postgres 的 SECURITY DEFINER 包装函数。
--  postgres 自己**有** insert 权限，app_user 只拿到这个函数的执行权，
--  拿不到那张表的任何直接权限。顺带还有个好处：
--  频道名的格式校验有了唯一的落点，一个 handler 写错也广播不到别处去。
--
--  ⚠️ realtime.messages 是按天分区的，分区由 Realtime 服务自己维护。
--  分区不存在时 realtime.send 内部会吞掉错误只发 WARNING ——
--  广播丢失是**退化不是事故**（前台那条路完全不依赖它，宪法第 14 条），
--  所以这里不试图代劳建分区，那是 Supabase 的活。
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.gf_broadcast(
  p_location_id uuid,
  p_event text,
  p_payload jsonb
) returns void
language plpgsql
security definer
set search_path = public, realtime
as $$
begin
  if p_location_id is null then
    raise exception '广播必须指定门店';
  end if;
  perform realtime.send(p_payload, p_event, 'location:' || p_location_id::text, true);
end $$;

revoke all on function public.gf_broadcast(uuid, text, jsonb) from public;
grant execute on function public.gf_broadcast(uuid, text, jsonb) to app_user;

-- 0011 里那两句无效的 grant 收回来，免得下一个人以为它们起了作用
revoke insert on table realtime.messages from app_user;
