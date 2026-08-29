-- 0064 · Kiosk 企业级数据完整性与设备审计

alter table audit_log
  add column if not exists actor_device_id uuid;

create index if not exists audit_log_device_idx
  on audit_log (location_id, actor_device_id, at)
  where actor_device_id is not null;

alter table form_submissions
  add column if not exists queue_id uuid references walkin_queue(id);

create index if not exists form_submissions_queue_idx
  on form_submissions (location_id, queue_id, created_at desc)
  where queue_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_ticket_positive') then
    alter table walkin_queue add constraint walkin_queue_ticket_positive
      check (ticket_number > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_party_size_range') then
    alter table walkin_queue add constraint walkin_queue_party_size_range
      check (party_size between 1 and 20);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_quoted_wait_nonnegative') then
    alter table walkin_queue add constraint walkin_queue_quoted_wait_nonnegative
      check (quoted_wait_min is null or quoted_wait_min >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_source') then
    alter table walkin_queue add constraint walkin_queue_source
      check (source in ('kiosk','desk'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'form_submissions_source') then
    alter table form_submissions add constraint form_submissions_source
      check (source in ('kiosk','desk','link'));
  end if;
end $$;

comment on column audit_log.actor_device_id is
  '已验证设备 actor 的 device_tokens.id；用于追溯具体 Kiosk，不依赖真人 membership';
comment on column form_submissions.queue_id is
  'Kiosk walk-in 健康表关联的等位记录，保证匿名提交仍可回到当次到店流程';
