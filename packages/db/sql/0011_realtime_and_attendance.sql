-- ════════════════════════════════════════════════════════════════════════════
--  0011 · Phase 1c：实时广播授权 + 打卡流水
--
--  ⭐ 广播走 `realtime.send()`，**在业务事务内**调用。
--
--  01 §6 原本写的是「事务提交之后 broadcast」。改成事务内更好，
--  而且不是妥协：realtime.send 往 realtime.messages 里插一行，
--  事务回滚它就跟着回滚 —— 于是**永远不会有一条对应不上任何事实的事件**。
--  提交后再发的做法，一旦发完那一瞬间进程挂了，事件就永久丢了；
--  或者事务回滚了事件却已经发出去，技师手机响了却看不到单。
--
--  扇出仍然在 Supabase 侧完成，两台应用实例之间零协调（宪法第 10 条）。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 让 app_user 能发广播 ────────────────────────────────────────────────
grant usage on schema realtime to app_user;
grant execute on function realtime.send(jsonb, text, text, boolean) to app_user;
-- realtime.send 内部往 realtime.messages 插行
grant insert on table realtime.messages to app_user;

-- ── 2. 谁能订阅：只有该门店的活跃 membership ───────────────────────────────
--
-- Realtime 的 private channel 会拿连接用户的 JWT（role = authenticated）
-- 去查 realtime.messages 的 RLS。所以授权策略写在这里，
-- 而不是我们自己写一层订阅鉴权 —— 那又会变成"自建扇出"的第一步。
--
-- ⚠️ 策略里不能直接查 public.memberships：那张表开了 force RLS，
-- 而 Realtime 的连接不会设 app.org_id / app.user_id，查出来永远是 0 行。
-- 所以走一个 security definer 函数（owner = postgres，有 BYPASSRLS）。
create or replace function public.user_in_location(loc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.location_id = loc
      and m.status = 'active'
  )
$$;

revoke all on function public.user_in_location(uuid) from public;
grant execute on function public.user_in_location(uuid) to authenticated;

-- 频道名固定为 location:{uuid}。解析不出 uuid 的 topic 一律拒绝。
create or replace function public.topic_location_id()
returns uuid
language plpgsql
stable
as $$
declare t text := realtime.topic();
begin
  if t is null or t !~ '^location:[0-9a-f-]{36}$' then
    return null;
  end if;
  return substring(t from 10)::uuid;
exception when others then
  return null;
end $$;

grant execute on function public.topic_location_id() to authenticated;

drop policy if exists staff_can_subscribe_own_location on realtime.messages;
create policy staff_can_subscribe_own_location on realtime.messages
  for select to authenticated
  using (
    public.topic_location_id() is not null
    and public.user_in_location(public.topic_location_id())
  );

-- 客户端**不许自己发**广播：所有事件都必须由命令总线在写库的同一个事务里发出。
-- 少了这一条，技师端可以伪造一条 "ticket.assigned" 让别人的手机响。
drop policy if exists no_client_broadcast on realtime.messages;
create policy no_client_broadcast on realtime.messages
  for insert to authenticated
  with check (false);

-- ── 3. 打卡流水 ────────────────────────────────────────────────────────────
alter table time_punches enable row level security;
alter table time_punches force  row level security;
drop policy if exists tenant_isolation on time_punches;
create policy tenant_isolation on time_punches
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update on time_punches to app_user;

-- 打卡记录是劳资纠纷里的证据，只能补录不能删（宪法第 9 条同源）
drop trigger if exists time_punches_no_delete on time_punches;
create trigger time_punches_no_delete before delete on time_punches
  for each row execute function money_no_delete();

alter table time_punches drop constraint if exists punch_kind_valid;
alter table time_punches add constraint punch_kind_valid
  check (kind in ('clock_in','clock_out','break_start','break_end')
     and method in ('pin','desk','app'));

-- ── 4. 开始/完成时间的自洽 ─────────────────────────────────────────────────
-- 完成不能早于开始。听起来废话，但前台代点「完成」时如果那一单
-- 从来没被点过「开始」，我们要的是当场拒绝而不是一条负数工时。
alter table ticket_items drop constraint if exists item_finish_after_start;
alter table ticket_items add constraint item_finish_after_start
  check (finished_at is null or (started_at is not null and finished_at >= started_at));
