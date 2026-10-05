-- Disputes and refunds created outside GenieFront must never leave spendable unfunded assets.
alter table gift_cards add column commerce_frozen boolean not null default false;
alter table customer_packages add column commerce_frozen boolean not null default false;
create table commerce_review_items (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references organizations(id),
 location_id uuid not null references locations(id),
 payment_id uuid not null,
 stripe_account_id text not null,
 livemode boolean not null,
 kind text not null check(kind in ('dispute','external_refund')),
 external_id text not null,
 amount_cents integer not null check(amount_cents > 0),
 currency text not null check(currency ~ '^[a-z]{3}$'),
 status text not null check(status in ('open','won','lost','review','resolved')),
 provider_status text not null,
 event_created bigint not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(payment_id,org_id,location_id) references commerce_payments(id,org_id,location_id),
 unique(stripe_account_id,livemode,kind,external_id)
);
create index commerce_review_open on commerce_review_items(location_id,status);
alter table commerce_review_items enable row level security;
alter table commerce_review_items force row level security;
create policy tenant_isolation on commerce_review_items for all to app_user
 using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on commerce_review_items from public,anon,authenticated;
grant select,insert,update on commerce_review_items to app_user;
