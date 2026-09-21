-- Deploy the application without confirmation-code reads/writes before this migration.
-- Management tokens, appointment IDs and staff short links remain independent.
begin;
drop index if exists public.appointments_confirm_code_uidx;
alter table public.appointments drop column if exists confirmation_code;
commit;
