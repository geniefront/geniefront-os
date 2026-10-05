-- Preserve existing Accounts v1 mappings; only new Connect merchants use v2.
alter table commerce_accounts add column if not exists api_version text not null default 'v1'
  check (api_version in ('v1','v2'));
