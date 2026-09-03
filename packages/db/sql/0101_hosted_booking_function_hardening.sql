-- ════════════════════════════════════════════════════════════════════════════
--  0101 · Hosted-booking helper hardening
--
--  Fix the function search path so unqualified built-ins and the explicitly
--  public slug helpers cannot be shadowed by a caller-controlled schema.
--  The notification seed trigger is invoked only by PostgreSQL; clients never
--  need EXECUTE on the trigger function itself.
-- ════════════════════════════════════════════════════════════════════════════

alter function public.gf_normalize_shop_slug(text)
  set search_path = pg_catalog, public;
alter function public.gf_shop_slug_reserved(text)
  set search_path = pg_catalog, public;
alter function public.gf_shop_slug_canonical(text)
  set search_path = pg_catalog, public;
alter function public.gf_repair_shop_slugs()
  set search_path = pg_catalog, public;
alter function public.app_public_slug()
  set search_path = pg_catalog, public;

revoke all on function public.gf_locations_seed_notifications()
  from public, anon, authenticated;
