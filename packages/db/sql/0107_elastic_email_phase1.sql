-- Created with supabase migration new; executed by the repository's _migrations runner.
alter table email_outbox add column if not exists provider text;
alter table email_outbox add column if not exists provider_account text;
alter table email_outbox add column if not exists provider_transaction_id text;
alter table email_outbox add column if not exists claim_id uuid;
alter table email_outbox add column if not exists claimed_at timestamptz;
alter table email_outbox add column if not exists next_attempt_at timestamptz not null default now();
alter table email_outbox add column if not exists reply_to text;
alter table email_outbox add column if not exists last_reconciled_at timestamptz;
-- Historical provider cannot be inferred safely from a current environment switch.
alter table email_outbox drop constraint if exists email_outbox_status;
alter table email_outbox add constraint email_outbox_status check(status in ('pending','sending','uncertain','sent','failed','captured'));
create index if not exists email_outbox_retry_idx on email_outbox(org_id,location_id,next_attempt_at) where status='pending';

create unique index if not exists locations_email_tenant_id on locations(org_id,id);

create table email_validation_cache (
 org_id uuid not null references organizations(id), location_id uuid not null,
 email text not null, result text not null check(result in ('valid','invalid','risky','unknown')),
 reason text, suggested_email text, checked_at timestamptz not null default now(),
 expires_at timestamptz not null,
 primary key(org_id,location_id,email),
 foreign key(org_id,location_id) references locations(org_id,id)
);
alter table email_validation_cache add column requested boolean not null default false;
create table email_accounts (
 org_id uuid not null references organizations(id), location_id uuid primary key,
 account_email text not null unique, provider_account_id text, key_encrypted text,
 status text not null default 'pending' check(status in ('pending','ready','error','paused')),
 last_error text, attempted_at timestamptz, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(org_id,location_id) references locations(org_id,id)
);
create table email_domain_requests (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations(id),
 location_id uuid not null, domain text not null unique,
 managed_by text not null check(managed_by in ('platform','customer')),
 status text not null default 'requested' check(status in ('requested','dns_pending','verified','error','cancelled')),
 dns_records jsonb not null default '[]', last_error text, checked_at timestamptz,
 note text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(org_id,location_id) references locations(org_id,id)
);
create index email_domain_requests_tenant on email_domain_requests(org_id,location_id,created_at);
create table email_sender_settings (
 org_id uuid not null references organizations(id), location_id uuid primary key,
 domain_request_id uuid references email_domain_requests(id),
 use_custom boolean not null default false, from_local text not null default 'booking',
 reply_to text, updated_at timestamptz not null default now(),
 foreign key(org_id,location_id) references locations(org_id,id)
);
create table email_account_suppressions (
 provider_account text not null, email text not null, scope text not null check(scope in ('marketing','all')),
 reason text not null, updated_at timestamptz not null default now(),
 primary key(provider_account,email,scope)
);
-- Only server app_user can access this provider control plane. No Data API grants.
alter table email_account_suppressions enable row level security;
alter table email_account_suppressions force row level security;
create policy provider_control on email_account_suppressions to app_user using(true) with check(true);
grant select,insert,update on email_account_suppressions to app_user;
revoke all on email_account_suppressions from anon,authenticated;

do $$ declare t text; begin
 foreach t in array array['email_validation_cache','email_accounts','email_domain_requests','email_sender_settings'] loop
 execute format('alter table %I enable row level security',t);
 execute format('alter table %I force row level security',t);
 execute format('create policy tenant_isolation on %I to app_user using ((org_id=app_org_id() and location_id=app_location_id()) or gf_platform_operator_role() is not null) with check ((org_id=app_org_id() and location_id=app_location_id()) or gf_platform_operator_role() is not null)',t);
 execute format('grant select,insert,update on %I to app_user',t);
 execute format('revoke all on %I from anon,authenticated',t);
 end loop;
end $$;

-- Narrow scheduler discovery, no payload/credential exposure; writes still use withTenant.
create function gf_email_service_tenants(p_limit integer default 100)
returns table(org_id uuid,location_id uuid) language sql security definer set search_path=public as $$
 select l.org_id,l.id from locations l
 where l.status <> 'archived' and (
   exists(select 1 from email_validation_cache v where v.location_id=l.id and v.requested)
   or not exists(select 1 from email_accounts a where a.location_id=l.id)
   or exists(select 1 from email_accounts a where a.location_id=l.id and a.status in ('pending','error') and (a.attempted_at is null or a.attempted_at < now()-interval '15 minutes'))
   or exists(select 1 from email_domain_requests d where d.location_id=l.id and d.status <> 'cancelled' and (d.checked_at is null or d.checked_at < now()-interval '15 minutes'))
   or exists(select 1 from email_outbox e where e.location_id=l.id and (e.status='sending' and e.claimed_at < now()-interval '5 minutes' or e.provider='elasticemail' and e.status='sent' and e.sent_at > now()-interval '6 days' and (e.last_reconciled_at is null or e.last_reconciled_at < now()-interval '15 minutes')))
 ) order by l.created_at limit least(greatest(p_limit,1),100)
$$;
revoke all on function gf_email_service_tenants(integer) from public,anon,authenticated;
grant execute on function gf_email_service_tenants(integer) to app_user;

-- Resolve only a known provider message or transaction. Webhook contents never choose a tenant.
create function gf_elastic_message_tenant(p_message text,p_transaction text)
returns table(org_id uuid,location_id uuid) language sql security definer set search_path=public as $$
 select e.org_id,e.location_id from email_outbox e where e.provider='elasticemail' and e.location_id is not null
 and ((p_message<>'' and e.provider_id=p_message) or (p_transaction<>'' and e.provider_transaction_id=p_transaction)) limit 1
$$;
revoke all on function gf_elastic_message_tenant(text,text) from public,anon,authenticated;
grant execute on function gf_elastic_message_tenant(text,text) to app_user;

-- Preserve opt-outs; queued marketing is explicitly stopped, including the SMS path.
update email_outbox set status='failed',last_error='marketing_coming_soon'
where status='pending' and (unsubscribe_url is not null or kind in ('birthday','holiday','winback','review_request') or entity_type ~ '^(birthday_|holiday_|winback_|ticket_review)');
update sms_outbox set status='suppressed',last_error='marketing_coming_soon'
where status='pending' and entity_type ~ '^(birthday_|holiday_|winback_|ticket_review)';
update notification_rules set enabled=false where event_key in ('birthday','holiday','winback','review_request');
alter table email_domain_requests add column ownership_token text not null default encode(gen_random_bytes(24),'hex');
alter table email_domain_requests add constraint email_domain_request_tenant_id unique(org_id,location_id,id);
alter table email_sender_settings add constraint email_sender_request_tenant foreign key(org_id,location_id,domain_request_id) references email_domain_requests(org_id,location_id,id);
