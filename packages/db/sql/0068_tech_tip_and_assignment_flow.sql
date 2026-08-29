-- 0068: skill-aware service fulfillment and direct-cash-tip query indexes.

create table if not exists service_skill_requirements (
  org_id uuid not null references organizations(id),
  location_id uuid not null references locations(id),
  service_id uuid not null references services(id) on delete cascade,
  skill_id uuid not null references skills(id) on delete cascade,
  minimum_proficiency integer not null default 1 check (minimum_proficiency between 1 and 5),
  primary key (service_id, skill_id)
);

create index if not exists service_skill_requirements_location_idx
  on service_skill_requirements(location_id, service_id);
create index if not exists service_skill_requirements_skill_idx
  on service_skill_requirements(skill_id);

alter table service_skill_requirements enable row level security;
alter table service_skill_requirements force row level security;
drop policy if exists tenant_isolation on service_skill_requirements;
create policy tenant_isolation on service_skill_requirements
  using (org_id = app_org_id() and location_id = app_location_id())
  with check (org_id = app_org_id() and location_id = app_location_id());

-- Direct-cash records live in the immutable earnings ledger and are found by
-- ticket + technician; this partial index keeps self-edit/reversal bounded.
create index if not exists earnings_direct_cash_ticket_idx
  on earnings(ticket_id, membership_id, created_at)
  where kind = 'tip_cash' and reversed_at is null
    and basis->>'method' = 'direct_cash';
