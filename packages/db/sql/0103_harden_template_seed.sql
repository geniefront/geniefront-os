-- ════════════════════════════════════════════════════════════════════════════
--  0103 · Harden gf_seed_notification_templates
--
--  1. Fix search_path to pg_catalog, public to prevent search_path shadowing.
--  2. Revoke execute from public, anon, authenticated and grant to app_user.
-- ════════════════════════════════════════════════════════════════════════════

alter function public.gf_seed_notification_templates(uuid, uuid)
  set search_path = pg_catalog, public;

revoke all on function public.gf_seed_notification_templates(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.gf_seed_notification_templates(uuid, uuid)
  to app_user;
