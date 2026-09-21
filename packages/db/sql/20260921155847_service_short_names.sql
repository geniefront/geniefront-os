-- Stored per service, inheriting the existing services tenant policies.
alter table public.services add column if not exists short_names jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.services'::regclass and conname='services_short_names_object') then
    alter table public.services add constraint services_short_names_object check (jsonb_typeof(short_names) = 'object');
  end if;
end $$;
comment on column public.services.short_names is 'Editable SMS service abbreviations keyed by en, zh-Hans, zh-Hant, ko, vi, es. Missing values fall back to the service name.';
