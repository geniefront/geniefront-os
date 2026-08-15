-- ════════════════════════════════════════════════════════════════════════════
--  0005 · 工单相关表的 RLS
--  0002 末尾那条断言会兜住漏网的表，但该补的还是要主动补。
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array['tickets','ticket_items','payments','tip_allocations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (org_id = app_org_id()) with check (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

-- ticket_item_staff 有 org_id，一并纳入
alter table ticket_item_staff enable row level security;
alter table ticket_item_staff force  row level security;
drop policy if exists tenant_isolation on ticket_item_staff;
create policy tenant_isolation on ticket_item_staff
  using (org_id = app_org_id()) with check (org_id = app_org_id());

grant select, insert, update, delete
  on tickets, ticket_items, ticket_item_staff, payments, tip_allocations to app_user;

-- ── 财务只作废不删除（宪法第 9 条）───────────────────────────────────────────
-- 现金业务里一定会有人要求"删掉这条"。产品立场是拒绝：
-- 只能 void，且必须留原因、留操作人（04 §6）。
revoke delete on tickets, payments, tip_allocations from app_user;

create or replace function tickets_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception '财务记录不可删除，只能作废（void）'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists tickets_no_delete on tickets;
create trigger tickets_no_delete before delete on tickets
  for each row execute function tickets_no_delete();

drop trigger if exists payments_no_delete on payments;
create trigger payments_no_delete before delete on payments
  for each row execute function tickets_no_delete();

-- 作废必须带原因，和超卖放行同一个道理
alter table tickets drop constraint if exists void_needs_reason;
alter table tickets add constraint void_needs_reason
  check (status <> 'voided' or void_reason is not null);
