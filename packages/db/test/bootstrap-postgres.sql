-- Minimal Supabase-owned surface for isolated PostgreSQL tests only.
-- Production Supabase projects already own these schemas and must never run this file.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter role postgres set search_path = public, extensions;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text,
  role text,
  email text,
  encrypted_password text,
  updated_at timestamptz,
  confirmation_token text,
  recovery_token text,
  email_change_token_new text,
  email_change text,
  email_change_token_current text,
  phone_change text,
  phone_change_token text,
  reauthentication_token text,
  email_change_confirm_status integer,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- seed.ts models password identities even when remote Auth calls are disabled.
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  unique (provider_id, provider)
);
create or replace function auth.uid() returns uuid language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema if not exists realtime;
create table if not exists realtime.messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  extension text not null default 'broadcast',
  event text,
  payload jsonb,
  private boolean not null default true,
  created_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean)
returns void language sql set search_path = pg_catalog, realtime as $$
  insert into realtime.messages(payload, event, topic, private, extension)
  values (payload, event, topic, private, 'broadcast')
$$;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text not null, owner_id text, metadata jsonb, created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
language sql immutable set search_path = pg_catalog as $$
  select case when position('/' in name) = 0 then array[]::text[]
              else string_to_array(regexp_replace(name, '/[^/]+$', ''), '/') end
$$;

grant usage on schema auth, realtime, storage to anon, authenticated;
grant select, insert on realtime.messages to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;
