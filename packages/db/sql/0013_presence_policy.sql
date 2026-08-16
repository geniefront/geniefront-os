-- ════════════════════════════════════════════════════════════════════════════
--  0013 · 放行 presence，继续挡住客户端广播
--
--  0011 里那条 `no_client_broadcast`（insert with check false）用力过猛：
--  私有频道的 **presence 上报也走 realtime.messages 的 INSERT 检查**，
--  于是技师端 track 不上去，前台看板永远显示「0 人在线」——
--  而两边的连接状态都是正常的，所以从表面完全看不出哪里错了。
--
--  区分的依据是 `extension` 列：
--    'presence'  = 我在线（只是状态，没有内容）→ 放行
--    'broadcast' = 一条事件（会让别人的手机响）→ 只允许服务端发
--
--  为什么必须挡住客户端广播：不挡的话，任何一个登录的技师都能伪造一条
--  `ticket.assigned` 让同事的手机响。领域事件只能由命令总线在写库的
--  同一个事务里发出（见 apps/api/src/events.ts）。
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists no_client_broadcast on realtime.messages;
drop policy if exists client_presence_only on realtime.messages;

create policy client_presence_only on realtime.messages
  for insert to authenticated
  with check (
    extension = 'presence'
    and public.topic_location_id() is not null
    and public.user_in_location(public.topic_location_id())
  );

-- extension = 'broadcast' 没有任何 insert 策略命中 → 被拒。
-- 服务端走 public.gf_broadcast（SECURITY DEFINER，owner = postgres），不受 RLS 约束。
