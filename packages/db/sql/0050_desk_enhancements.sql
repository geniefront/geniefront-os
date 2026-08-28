-- 0050_desk_enhancements.sql: 5 Core Workstations Backend Database Enhancements

-- 1. Appointments: Backfill audit tracking
alter table appointments add column if not exists is_backfill boolean not null default false;
alter table appointments add column if not exists backfill_reason text;
alter table appointments add column if not exists backfill_notes text;

-- 2. Tickets: Surcharge & refund tracking
alter table tickets add column if not exists surcharge_cents integer not null default 0;
alter table tickets add column if not exists refund_cents integer not null default 0;
alter table tickets add column if not exists refund_reason text;
alter table tickets add column if not exists refund_method text;
alter table tickets add column if not exists refunded_at timestamptz;
alter table tickets add column if not exists refunded_by uuid references memberships(id);

-- 3. Form submissions: Multi-version audit trail & appointment linking
alter table form_submissions add column if not exists version integer not null default 1;
alter table form_submissions add column if not exists is_latest boolean not null default true;
alter table form_submissions add column if not exists superseded_by uuid references form_submissions(id);
alter table form_submissions add column if not exists appointment_id uuid references appointments(id);

-- 4. Location reviews: AI sentiment, tags, technician & service attribution
alter table location_reviews add column if not exists ai_sentiment text;
alter table location_reviews add column if not exists ai_highlights jsonb not null default '[]'::jsonb;
alter table location_reviews add column if not exists technician_name text;
alter table location_reviews add column if not exists service_name text;
