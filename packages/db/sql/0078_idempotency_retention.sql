-- ════════════════════════════════════════════════════════════════════════════
--  0078 · 幂等表的保留期（AUD-09）
--
--  ## 问题
--
--  `runCommand` 给**每一次** desk 写操作都新生成一个 `crypto.randomUUID()`，
--  总线把整个 `result_json` 存进 `command_idempotency`。这张表：
--
--    · 有 `at` 列，但没有 TTL、没有分区、没有任何清理任务
--      （全仓唯一的 `delete from command_idempotency` 都在测试文件里）
--    · 按 01-ARCHITECTURE 的目标量级（1000 店 × 100 单/天 × 约 10 条命令/单）
--      大约每天一百万行 JSONB，压在那个被文档自己称作核心单点的托管 Postgres 上
--
--  文档 §4 给 `appointments` / `ticket_items` / `audit_log` / `messages`
--  预留了按月分区，**唯独漏了长得最快的这一张**。
--
--  ## 保留期为什么是 48 小时
--
--  这张表存在的唯一理由是「网络差的门店重试要安全」。重试窗口的实际上界是
--  用户重开页面重试的时间，以小时计；48 小时给足了余量，包括门店周末断网
--  第二天补录的情况。
--
--  ⚠️ 只删**过了窗口的**行。窗口内的行删掉的话，一次合法重试会被当成新请求
--  重新执行一遍 —— 那正是这张表要防的事故。清理函数因此没有「全清」这个入口。
--
--  ## 为什么是函数而不是 pg_cron
--
--  Supabase 托管实例上 `pg_cron` 不一定开着，而「上线时忘了开扩展」这种
--  失败是静默的。做成一个函数，由应用侧在启动和每小时调一次
--  （`apps/api/src/ops/retention.ts`）—— 那条路径有日志，跑没跑得起来看得见。
-- ════════════════════════════════════════════════════════════════════════════

create index if not exists command_idempotency_at_idx
  on command_idempotency (at);

/**
 * 删掉超出保留期的幂等记录，返回删除行数。
 *
 * SECURITY DEFINER：清理是跨租户的维护动作，没有单一的 app.org_id 上下文。
 * 但它**只能删过期行** —— 保留期是参数，下限被钳在 24 小时，
 * 调用方传 0 也删不掉窗口内的东西。
 */
create or replace function public.gf_purge_command_idempotency(p_retain_hours int default 48)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  hours int := greatest(coalesce(p_retain_hours, 48), 24);
  removed int;
begin
  delete from command_idempotency
   where at < now() - (hours || ' hours')::interval;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.gf_purge_command_idempotency(int) from public;
grant execute on function public.gf_purge_command_idempotency(int) to app_user;

comment on function public.gf_purge_command_idempotency(int) is
  'AUD-09：删除超出保留期的幂等记录。保留期下限 24 小时，窗口内的重放不受影响。';
