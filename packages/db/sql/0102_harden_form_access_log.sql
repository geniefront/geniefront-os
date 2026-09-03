-- ════════════════════════════════════════════════════════════════════════════
--  0102 · Harden form_access_log table
--
--  1. Revoke UPDATE from app_user so access records cannot be rewritten.
--  2. Add immutable trigger on form_access_log to prevent UPDATE and DELETE,
--     guaranteeing tamper-proof access audit logging for HIPAA/compliance.
-- ════════════════════════════════════════════════════════════════════════════

revoke update on form_access_log from app_user;

create or replace function form_access_log_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'form_access_log 是只追加日志，不可修改或删除（HIPAA/合规）'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists guard_form_access_log_immutable on form_access_log;
create trigger guard_form_access_log_immutable
  before update or delete on form_access_log
  for each row execute function form_access_log_immutable();
