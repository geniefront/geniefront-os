-- 0063 · stripe_events.status — webhook 处理状态列
--
-- ## 背景
--
-- 原来的 webhook 错误处理流程：
--   1. 处理失败 → update error
--   2. delete 这一行（让 Stripe 重投时能重新 insert）
--   3. 抛出 → Stripe 重投
--
-- delete 把 error 字段一并抹掉，失去唯一的排查线索。
--
-- ## 新方案
--
-- 加 status 列（processing / processed / failed）。
-- 失败时只写 failed + error，不删行。
-- Stripe 重投时 ON CONFLICT DO UPDATE WHERE status = 'failed' 重新认领。
-- 成功的行永远是 processed，不会被覆盖。

alter table stripe_events
  add column if not exists status text not null default 'processing';

-- processed_at 改为可 null（processing 阶段还没有处理完成时间）
alter table stripe_events
  alter column processed_at drop not null;

-- 回填：无 error 且 processed_at 不为空的认为已成功
update stripe_events
  set status = 'processed'
  where error is null and processed_at is not null and status = 'processing';

-- 回填：有 error 的标记为 failed
update stripe_events
  set status = 'failed'
  where error is not null and status = 'processing';

-- check 约束防止写入未知值
alter table stripe_events
  add constraint stripe_events_status_check
  check (status in ('processing', 'processed', 'failed'));

comment on column stripe_events.status is
  'processing = 已认领正在处理；processed = 处理成功；failed = 处理失败可重试';
