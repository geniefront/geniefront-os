-- ════════════════════════════════════════════════════════════════════════════
--  0074 · GenieFront operator console (apps/platform)
--
--  Why this exists
--  ---------------
--  Desk memberships are tenant roles. They must never become platform roles.
--  Cross-tenant operator reads cannot use ordinary withTenant() (that would
--  either see one shop or require BYPASSRLS). The runtime still uses app_user
--  with FORCE RLS; this file adds:
--
--    1. platform_operators     explicit allow-list (user_id + role)
--    2. support_requests       smallest production ticket model
--    3. Narrow SECURITY DEFINER readers that:
--         • require app.user_id (set by withUser)
--         • check platform_operators inside the DB
--         • return a fixed JSON shape (no arbitrary SQL, no secrets)
--
--  Mutations do NOT go through these functions. Operator writes set the
--  target tenant via withTenant() only after the API has verified the
--  caller is an active operator. That keeps FORCE RLS on every table.
--
--  Must be applied in production. Do not rewrite earlier numbered files.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Operator allow-list ──────────────────────────────────────────────────

create table if not exists platform_operators (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references users(id),
  role        text not null check (role in ('super_admin', 'support')),
  status      text not null default 'active' check (status in ('active', 'revoked')),
  notes       text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

comment on table platform_operators is
  'GenieFront internal operators. Independent of customer memberships/roles. '
  'A store owner is never an operator unless a row here says so.';

alter table platform_operators enable row level security;
alter table platform_operators force row level security;

drop policy if exists operator_self_read on platform_operators;
create policy operator_self_read on platform_operators
  for select using (user_id = app_user_id());

-- app_user may read its own row (so /v1/platform/session can work without
-- a definer function). It cannot insert, update, or delete operators.
grant select on platform_operators to app_user;
revoke insert, update, delete on platform_operators from app_user;

-- ── 2. Support requests ─────────────────────────────────────────────────────

create table if not exists support_requests (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations(id),
  location_id                 uuid not null references locations(id),
  submitted_by_user_id        uuid references users(id),
  submitted_by_membership_id  uuid references memberships(id),
  category                    text not null default 'general'
    check (category in (
      'general', 'onboarding', 'billing', 'sms_10dlc', 'storefront',
      'technical', 'other'
    )),
  subject                     text not null check (char_length(subject) between 1 and 200),
  description                 text not null check (char_length(description) between 1 and 8000),
  status                      text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
  priority                    text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_operator_id        uuid references platform_operators(id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  resolved_at                 timestamptz
);

create index if not exists support_requests_status_idx
  on support_requests (status, created_at desc);
create index if not exists support_requests_location_idx
  on support_requests (location_id, created_at desc);

create table if not exists support_request_notes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  location_id     uuid not null references locations(id),
  request_id      uuid not null references support_requests(id) on delete cascade,
  author_operator_id uuid references platform_operators(id),
  body            text not null check (char_length(body) between 1 and 8000),
  created_at      timestamptz not null default now()
);

create index if not exists support_request_notes_request_idx
  on support_request_notes (request_id, created_at);

comment on table support_requests is
  'Customer support tickets. Tenant-scoped. Platform operators manage them '
  'through /v1/platform after explicit operator authorization.';
comment on table support_request_notes is
  'Internal operator notes on a support request. Not shown to customers.';

do $$
declare t text;
begin
  foreach t in array array['support_requests', 'support_request_notes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = app_org_id()) '
      || 'with check (org_id = app_org_id())', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

-- ── 3. 10DLC internal workflow: under_review ────────────────────────────────
-- pending_review = received by GenieFront, waiting.
-- under_review   = an operator is looking at it.
-- approved       = internal review passed; NOT a carrier/TCR filing.
-- rejected       = internal reject / request changes (notes explain which).
-- Customer resubmit (settings.apply10dlc) returns the row to pending_review.

alter table location_10dlc_registrations
  drop constraint if exists location_10dlc_status;

alter table location_10dlc_registrations
  add constraint location_10dlc_status
  check (status in (
    'not_submitted', 'pending_review', 'under_review',
    'approved', 'rejected'
  ));

-- ── 4. Audit lookup index for operator investigation ────────────────────────

create index if not exists audit_log_location_at_idx
  on audit_log (location_id, at desc);

-- ── 5. Operator identity helper ─────────────────────────────────────────────
-- Reads app.user_id. Does not take a user id argument: a caller cannot
-- pass someone else's id and inherit their privilege.

create or replace function gf_platform_operator_role()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  uid uuid;
  r text;
begin
  uid := app_user_id();
  if uid is null then
    return null;
  end if;
  select po.role into r
    from platform_operators po
   where po.user_id = uid
     and po.status = 'active'
     and po.revoked_at is null;
  return r;
end;
$$;

create or replace function gf_platform_assert_operator()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  r text;
begin
  r := gf_platform_operator_role();
  if r is null then
    raise exception 'not_platform_operator'
      using errcode = '42501';
  end if;
  return r;
end;
$$;

-- ── 6. Narrow cross-tenant readers ──────────────────────────────────────────
-- Each function:
--   • asserts the session user is an active operator
--   • returns a fixed JSON object
--   • never returns pin hashes, token hashes, webhook secrets, or card numbers

create or replace function gf_platform_dashboard_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  out jsonb;
begin
  perform gf_platform_assert_operator();
  select jsonb_build_object(
    'activeStores',      (select count(*)::int from locations l where l.status = 'active'),
    'trialStores',       (select count(*)::int from billing_accounts ba where ba.subscription_status = 'trialing'),
    'pastDueStores',     (select count(*)::int from billing_accounts ba where ba.subscription_status = 'past_due'),
    'setupIncomplete',   (select count(*)::int from locations l where l.status = 'setup'),
    'openSupport',       (select count(*)::int from support_requests sr where sr.status in ('open', 'in_progress', 'waiting')),
    'pending10Dlc',      (select count(*)::int from location_10dlc_registrations r where r.status in ('pending_review', 'under_review')),
    'websiteRequests',   (select count(*)::int from storefront_briefs b
                            where b.status in ('submitted', 'drafted', 'chosen')
                               or b.launch_requested_at is not null)
  ) into out;
  return out;
end;
$$;

create or replace function gf_platform_search_stores(
  p_query text,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  q text;
  lim int;
  off int;
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();
  q := lower(trim(coalesce(p_query, '')));
  lim := least(greatest(coalesce(p_limit, 50), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);

  with matched as (
    select
      l.id as location_id,
      l.org_id,
      coalesce(l.name->>'en', l.name->>'zh-Hans', l.slug) as location_name,
      o.name as organization_name,
      u.email as owner_email,
      l.status as location_status,
      l.timezone,
      ba.plan,
      ba.subscription_status,
      ba.trial_ends_at,
      l.created_at,
      l.updated_at
    from locations l
    join organizations o on o.id = l.org_id
    left join users u on u.id = o.owner_user_id
    left join billing_accounts ba on ba.location_id = l.id
    where q = ''
       or l.id::text ilike '%' || q || '%'
       or l.slug ilike '%' || q || '%'
       or o.name ilike '%' || q || '%'
       or coalesce(u.email, '') ilike '%' || q || '%'
       or coalesce(l.name->>'en', '') ilike '%' || q || '%'
       or coalesce(l.name->>'zh-Hans', '') ilike '%' || q || '%'
  )
  select
    (select count(*)::int from matched),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'locationId', m.location_id,
        'orgId', m.org_id,
        'locationName', m.location_name,
        'organizationName', m.organization_name,
        'ownerEmail', m.owner_email,
        'locationStatus', m.location_status,
        'timezone', m.timezone,
        'plan', m.plan,
        'subscriptionStatus', m.subscription_status,
        'trialEndsAt', m.trial_ends_at,
        'createdAt', m.created_at,
        'updatedAt', m.updated_at
      ) order by m.created_at desc)
      from (select * from matched order by created_at desc limit lim offset off) m
    ), '[]'::jsonb)
  into total, items;

  return jsonb_build_object('total', total, 'items', items);
end;
$$;

create or replace function gf_platform_store_detail(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  loc record;
  people jsonb;
  billing jsonb;
  dlc jsonb;
  brief jsonb;
  setup jsonb;
begin
  perform gf_platform_assert_operator();
  if p_location_id is null then
    raise exception 'location_required' using errcode = '22023';
  end if;

  select
    l.id, l.org_id, l.name, l.slug, l.timezone, l.status, l.business_type,
    l.created_at, l.updated_at, l.phone, l.currency,
    o.name as org_name, o.owner_user_id, u.email as owner_email, u.full_name as owner_name
  into loc
  from locations l
  join organizations o on o.id = l.org_id
  left join users u on u.id = o.owner_user_id
  where l.id = p_location_id;

  if loc.id is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'membershipId', m.id,
    'userId', m.user_id,
    'status', m.status,
    'employmentType', m.employment_type,
    'email', u.email,
    'fullName', u.full_name,
    'displayName', sp.display_name,
    'isBookable', coalesce(sp.is_bookable, false),
    'jobTitle', sp.job_title,
    'roles', coalesce((
      select array_agg(r.key order by r.key)
      from membership_roles mr
      join roles r on r.id = mr.role_id
      where mr.membership_id = m.id
    ), '{}'::text[])
  ) order by m.created_at), '[]'::jsonb)
  into people
  from memberships m
  left join users u on u.id = m.user_id
  left join staff_profiles sp on sp.membership_id = m.id
  where m.location_id = p_location_id or (m.location_id is null and m.org_id = loc.org_id);

  select jsonb_build_object(
    'stripeCustomerId', ba.stripe_customer_id,
    'stripeSubscriptionId', ba.stripe_subscription_id,
    'plan', ba.plan,
    'subscriptionStatus', ba.subscription_status,
    'trialEndsAt', ba.trial_ends_at,
    'currentPeriodEnd', ba.current_period_end,
    'paymentMethodLabel', ba.payment_method_label,
    'creditBalance', ba.credit_balance,
    'voiceMinuteBalance', ba.voice_minute_balance,
    'includedCreditsUsed', ba.included_credits_used,
    'includedMinutesUsed', ba.included_minutes_used,
    'autoTopupCreditsEnabled', ba.auto_topup_credits_enabled,
    'autoTopupMinutesEnabled', ba.auto_topup_minutes_enabled
  )
  into billing
  from billing_accounts ba
  where ba.location_id = p_location_id;

  select jsonb_build_object(
    'status', r.status,
    'legalBusinessName', r.legal_business_name,
    'ein', r.ein,
    'submittedAt', r.submitted_at,
    'reviewedAt', r.reviewed_at
  )
  into dlc
  from location_10dlc_registrations r
  where r.location_id = p_location_id;

  select jsonb_build_object(
    'briefId', b.id,
    'status', b.status,
    'submittedAt', b.submitted_at,
    'launchRequestedAt', b.launch_requested_at,
    'publicUrl', b.public_url
  )
  into brief
  from storefront_briefs b
  where b.location_id = p_location_id;

  setup := jsonb_build_object(
    'locationStatus', loc.status,
    'setupComplete', loc.status is distinct from 'setup',
    'businessType', loc.business_type,
    'hasPhone', loc.phone is not null,
    'tenDlcStatus', dlc ->> 'status',
    'storefrontStatus', brief ->> 'status'
  );

  return jsonb_build_object(
    'overview', jsonb_build_object(
      'locationId', loc.id,
      'orgId', loc.org_id,
      'locationName', coalesce(loc.name->>'en', loc.name->>'zh-Hans', loc.slug),
      'organizationName', loc.org_name,
      'slug', loc.slug,
      'timezone', loc.timezone,
      'currency', loc.currency,
      'locationStatus', loc.status,
      'businessType', loc.business_type,
      'createdAt', loc.created_at,
      'updatedAt', loc.updated_at,
      'ownerEmail', loc.owner_email,
      'ownerName', loc.owner_name
    ),
    'people', people,
    'billing', billing,
    'tenDlc', dlc,
    'storefront', brief,
    'setup', setup
  );
end;
$$;

create or replace function gf_platform_list_support_requests(
  p_status text,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  lim int;
  off int;
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();
  lim := least(greatest(coalesce(p_limit, 50), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);

  select count(*)::int into total
  from support_requests sr
  where p_status is null or p_status = '' or sr.status = p_status;

  select coalesce(jsonb_agg(to_jsonb(x) order by x."createdAt" desc), '[]'::jsonb)
  into items
  from (
    select
      sr.id,
      sr.org_id as "orgId",
      sr.location_id as "locationId",
      coalesce(l.name->>'en', l.slug) as "locationName",
      o.name as "organizationName",
      sr.category,
      sr.subject,
      sr.status,
      sr.priority,
      sr.assigned_operator_id as "assignedOperatorId",
      sr.created_at as "createdAt",
      sr.updated_at as "updatedAt",
      sr.resolved_at as "resolvedAt"
    from support_requests sr
    join locations l on l.id = sr.location_id
    join organizations o on o.id = sr.org_id
    where p_status is null or p_status = '' or sr.status = p_status
    order by sr.created_at desc
    limit lim offset off
  ) x;

  return jsonb_build_object('total', total, 'items', items);
end;
$$;

create or replace function gf_platform_support_request_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  req jsonb;
  notes jsonb;
begin
  perform gf_platform_assert_operator();

  select jsonb_build_object(
    'id', sr.id,
    'orgId', sr.org_id,
    'locationId', sr.location_id,
    'locationName', coalesce(l.name->>'en', l.slug),
    'organizationName', o.name,
    'submittedByUserId', sr.submitted_by_user_id,
    'submittedByMembershipId', sr.submitted_by_membership_id,
    'submitterEmail', u.email,
    'category', sr.category,
    'subject', sr.subject,
    'description', sr.description,
    'status', sr.status,
    'priority', sr.priority,
    'assignedOperatorId', sr.assigned_operator_id,
    'createdAt', sr.created_at,
    'updatedAt', sr.updated_at,
    'resolvedAt', sr.resolved_at
  )
  into req
  from support_requests sr
  join locations l on l.id = sr.location_id
  join organizations o on o.id = sr.org_id
  left join users u on u.id = sr.submitted_by_user_id
  where sr.id = p_id;

  if req is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id,
    'body', n.body,
    'authorOperatorId', n.author_operator_id,
    'createdAt', n.created_at
  ) order by n.created_at), '[]'::jsonb)
  into notes
  from support_request_notes n
  where n.request_id = p_id;

  return req || jsonb_build_object('notes', notes);
end;
$$;

create or replace function gf_platform_list_10dlc(
  p_status text,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  lim int;
  off int;
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();
  lim := least(greatest(coalesce(p_limit, 50), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);

  select count(*)::int into total
  from location_10dlc_registrations r
  where r.status is distinct from 'not_submitted'
    and (p_status is null or p_status = '' or r.status = p_status);

  select coalesce(jsonb_agg(to_jsonb(x) order by x."submittedAt" desc nulls last), '[]'::jsonb)
  into items
  from (
    select
      r.location_id as "locationId",
      l.org_id as "orgId",
      coalesce(l.name->>'en', l.slug) as "locationName",
      o.name as "organizationName",
      r.status,
      r.legal_business_name as "legalBusinessName",
      r.submitted_at as "submittedAt",
      r.submitted_by_membership_id as "submittedByMembershipId",
      r.reviewed_at as "reviewedAt"
    from location_10dlc_registrations r
    join locations l on l.id = r.location_id
    join organizations o on o.id = l.org_id
    where r.status is distinct from 'not_submitted'
      and (p_status is null or p_status = '' or r.status = p_status)
    order by r.submitted_at desc nulls last
    limit lim offset off
  ) x;

  return jsonb_build_object('total', total, 'items', items);
end;
$$;

create or replace function gf_platform_10dlc_detail(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  out jsonb;
begin
  perform gf_platform_assert_operator();

  select jsonb_build_object(
    'locationId', r.location_id,
    'orgId', l.org_id,
    'locationName', coalesce(l.name->>'en', l.slug),
    'organizationName', o.name,
    'status', r.status,
    'legalBusinessName', r.legal_business_name,
    'ein', r.ein,
    'businessStructure', r.business_structure,
    'registeredAddress', r.registered_address,
    'repName', r.rep_name,
    'repTitle', r.rep_title,
    'repEmail', r.rep_email,
    'repPhone', r.rep_phone,
    'optInMethod', r.opt_in_method,
    'sampleMessages', to_jsonb(r.sample_messages),
    'submittedAt', r.submitted_at,
    'submittedByMembershipId', r.submitted_by_membership_id,
    'submitterEmail', u.email,
    'reviewedAt', r.reviewed_at,
    'notes', r.notes
  )
  into out
  from location_10dlc_registrations r
  join locations l on l.id = r.location_id
  join organizations o on o.id = l.org_id
  left join memberships m on m.id = r.submitted_by_membership_id
  left join users u on u.id = m.user_id
  where r.location_id = p_location_id;

  return out;
end;
$$;

create or replace function gf_platform_list_storefront_requests(
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  lim int;
  off int;
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();
  lim := least(greatest(coalesce(p_limit, 50), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);

  select count(*)::int into total
  from storefront_briefs b
  where b.status in ('submitted', 'drafted', 'chosen', 'live')
     or b.launch_requested_at is not null
     or exists (
       select 1 from storefront_revisions rv
       where rv.brief_id = b.id and rv.status in ('submitted', 'in_progress')
     );

  select coalesce(jsonb_agg(to_jsonb(x) order by x."updatedAt" desc), '[]'::jsonb)
  into items
  from (
    select
      b.id as "briefId",
      b.location_id as "locationId",
      b.org_id as "orgId",
      coalesce(l.name->>'en', l.slug) as "locationName",
      o.name as "organizationName",
      b.status,
      b.submitted_at as "submittedAt",
      b.launch_requested_at as "launchRequestedAt",
      b.updated_at as "updatedAt",
      (select count(*)::int from storefront_revisions rv
        where rv.brief_id = b.id and rv.status in ('submitted', 'in_progress')) as "openRevisions"
    from storefront_briefs b
    join locations l on l.id = b.location_id
    join organizations o on o.id = b.org_id
    where b.status in ('submitted', 'drafted', 'chosen', 'live')
       or b.launch_requested_at is not null
       or exists (
         select 1 from storefront_revisions rv
         where rv.brief_id = b.id and rv.status in ('submitted', 'in_progress')
       )
    order by b.updated_at desc
    limit lim offset off
  ) x;

  return jsonb_build_object('total', total, 'items', items);
end;
$$;

create or replace function gf_platform_storefront_detail(p_brief_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  brief jsonb;
  revisions jsonb;
begin
  perform gf_platform_assert_operator();

  select jsonb_build_object(
    'briefId', b.id,
    'orgId', b.org_id,
    'locationId', b.location_id,
    'locationName', coalesce(l.name->>'en', l.slug),
    'organizationName', o.name,
    'status', b.status,
    'currentSiteUrl', b.current_site_url,
    'hasNoSite', b.has_no_site,
    'painPoints', b.pain_points,
    'painFreeText', b.pain_free_text,
    'audience', b.audience,
    'topQuestions', b.top_questions,
    'brandPrimary', b.brand_primary,
    'brandAccent', b.brand_accent,
    'voice', b.voice,
    'sections', b.sections,
    'usp', b.usp,
    'tone', b.tone,
    'storeName', b.store_name,
    'slogan', b.slogan,
    'submittedAt', b.submitted_at,
    'draftedAt', b.drafted_at,
    'liveAt', b.live_at,
    'launchRequestedAt', b.launch_requested_at,
    'publicUrl', b.public_url
  )
  into brief
  from storefront_briefs b
  join locations l on l.id = b.location_id
  join organizations o on o.id = b.org_id
  where b.id = p_brief_id;

  if brief is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rv.id,
    'text', rv.text,
    'status', rv.status,
    'response', rv.response,
    'createdAt', rv.created_at,
    'updatedAt', rv.updated_at
  ) order by rv.created_at desc), '[]'::jsonb)
  into revisions
  from storefront_revisions rv
  where rv.brief_id = p_brief_id;

  return brief || jsonb_build_object('revisions', revisions);
end;
$$;

create or replace function gf_platform_list_audit(
  p_location_id uuid,
  p_command text,
  p_actor_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit int,
  p_offset int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  lim int;
  off int;
  total int;
  items jsonb;
begin
  perform gf_platform_assert_operator();
  lim := least(greatest(coalesce(p_limit, 50), 1), 100);
  off := greatest(coalesce(p_offset, 0), 0);

  select count(*)::int into total
  from audit_log a
  where (p_location_id is null or a.location_id = p_location_id)
    and (p_command is null or p_command = '' or a.command = p_command)
    and (p_actor_id is null or a.actor_id = p_actor_id)
    and (p_from is null or a.at >= p_from)
    and (p_to is null or a.at <= p_to);

  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb)
  into items
  from (
    select
      a.id,
      a.org_id as "orgId",
      a.location_id as "locationId",
      coalesce(l.name->>'en', l.slug) as "locationName",
      a.actor_id as "actorId",
      a.actor_kind as "actorKind",
      a.command,
      a.entity_type as "entityType",
      a.entity_id as "entityId",
      a.at,
      -- Redact any leftover secret-shaped keys at the DB boundary.
      (
        case when a.before is null then null
        else (a.before
          - 'pinHash' - 'pin_hash' - 'tokenHash' - 'token_hash'
          - 'password' - 'secret' - 'answersEncrypted' - 'answers_encrypted')
        end
      ) as before,
      (
        case when a.after is null then null
        else (a.after
          - 'pinHash' - 'pin_hash' - 'tokenHash' - 'token_hash'
          - 'password' - 'secret' - 'answersEncrypted' - 'answers_encrypted')
        end
      ) as after
    from audit_log a
    left join locations l on l.id = a.location_id
    where (p_location_id is null or a.location_id = p_location_id)
      and (p_command is null or p_command = '' or a.command = p_command)
      and (p_actor_id is null or a.actor_id = p_actor_id)
      and (p_from is null or a.at >= p_from)
      and (p_to is null or a.at <= p_to)
    order by a.at desc
    limit lim offset off
  ) x;

  return jsonb_build_object('total', total, 'items', items);
end;
$$;

-- ── 7. Grants: app_user only. Never Data API / anon / authenticated. ────────

revoke all on function public.gf_platform_operator_role() from public, anon, authenticated;
revoke all on function public.gf_platform_assert_operator() from public, anon, authenticated;
revoke all on function public.gf_platform_dashboard_counts() from public, anon, authenticated;
revoke all on function public.gf_platform_search_stores(text, int, int) from public, anon, authenticated;
revoke all on function public.gf_platform_store_detail(uuid) from public, anon, authenticated;
revoke all on function public.gf_platform_list_support_requests(text, int, int) from public, anon, authenticated;
revoke all on function public.gf_platform_support_request_detail(uuid) from public, anon, authenticated;
revoke all on function public.gf_platform_list_10dlc(text, int, int) from public, anon, authenticated;
revoke all on function public.gf_platform_10dlc_detail(uuid) from public, anon, authenticated;
revoke all on function public.gf_platform_list_storefront_requests(int, int) from public, anon, authenticated;
revoke all on function public.gf_platform_storefront_detail(uuid) from public, anon, authenticated;
revoke all on function public.gf_platform_list_audit(uuid, text, uuid, timestamptz, timestamptz, int, int)
  from public, anon, authenticated;

grant execute on function public.gf_platform_operator_role() to app_user;
grant execute on function public.gf_platform_assert_operator() to app_user;
grant execute on function public.gf_platform_dashboard_counts() to app_user;
grant execute on function public.gf_platform_search_stores(text, int, int) to app_user;
grant execute on function public.gf_platform_store_detail(uuid) to app_user;
grant execute on function public.gf_platform_list_support_requests(text, int, int) to app_user;
grant execute on function public.gf_platform_support_request_detail(uuid) to app_user;
grant execute on function public.gf_platform_list_10dlc(text, int, int) to app_user;
grant execute on function public.gf_platform_10dlc_detail(uuid) to app_user;
grant execute on function public.gf_platform_list_storefront_requests(int, int) to app_user;
grant execute on function public.gf_platform_storefront_detail(uuid) to app_user;
grant execute on function public.gf_platform_list_audit(uuid, text, uuid, timestamptz, timestamptz, int, int)
  to app_user;
