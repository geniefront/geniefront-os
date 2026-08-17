-- ════════════════════════════════════════════════════════════════════════════
--  0020 · `stripe_events.processed_at` 把列名改对
--
--  ⚠️ 这是 10-HANDOFF §4.1 那个坑的第二次发作，值得记一笔。
--
--  schema 里写的是：
--      processedAt: createdAt(),
--
--  而 `createdAt()` 那个 helper **把列名写死成 `created_at`** 了。
--  于是字段叫 processedAt，列却叫 created_at —— typecheck 过、迁移过、
--  运行时也过（我们插入时没有显式写这一列，走的是默认值），
--  一直到有人写 `where processed_at > …` 才炸，而那时候离引入它已经很久了。
--
--  这张表是这一期新建的、只有测试数据，所以直接把列名改对，
--  而不是把字段名将就成 createdAt —— 语义上它确实是「处理时刻」：
--  一行 stripe_events 是在我们认领并处理那个事件的那一刻写下的。
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'stripe_events' and column_name = 'created_at'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'stripe_events' and column_name = 'processed_at'
  ) then
    alter table stripe_events rename column created_at to processed_at;
  end if;
end $$;
