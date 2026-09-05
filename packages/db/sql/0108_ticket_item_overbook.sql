-- 服务层超排留痕。
--
-- 技师并发的闸门在 ticket.startItem（见 apps/api/src/serviceCapacity.ts）。
-- 前台带 reason 放行时，此前只有 audit_log 有记录 —— 审计能追责，但排班
-- 复盘要的是「这个月被压了多少单、都是什么理由」，那得能按列聚合。
-- appointment_items 早就有这三列，服务层补齐同名同义的一套。
--
-- 三列都可空/有默认值，历史行不需要回填：没放行过的单 overbooked = false
-- 就是事实，凭空造一个 reason 反而会污染复盘。
alter table ticket_items add column if not exists overbooked boolean not null default false;
alter table ticket_items add column if not exists overbook_reason text;
alter table ticket_items add column if not exists overbook_note text;

-- 复盘按（门店，营业日）查被放行的单。部分索引：绝大多数行是 false，
-- 全表索引在这张最大的表上纯属浪费。
create index if not exists ticket_items_overbooked_idx
  on ticket_items(location_id, ticket_id)
  where overbooked;
