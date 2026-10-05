-- Append-only reversal of an explicit retention, atomically reserved for its original payment refund.
create table commerce_deposit_retention_releases(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 retention_id uuid not null references commerce_deposit_retentions(id),hold_id uuid not null references commerce_appointment_holds(id),
 payment_id uuid not null references commerce_payments(id),amount_cents integer not null check(amount_cents>0),guest_allocation jsonb not null,
 reason text not null check(length(btrim(reason)) between 2 and 500),recorded_by uuid not null references memberships(id),created_at timestamptz not null default now(),
 check(gf_valid_deposit_refund_allocation(guest_allocation,amount_cents))
);
alter table commerce_deposit_retention_releases enable row level security;
alter table commerce_deposit_retention_releases force row level security;
create policy tenant_isolation on commerce_deposit_retention_releases to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on commerce_deposit_retention_releases from public,anon,authenticated,app_user;
grant select,insert on commerce_deposit_retention_releases to app_user;
create index commerce_deposit_retention_releases_retention on commerce_deposit_retention_releases(retention_id,created_at);
create index commerce_deposit_retention_releases_hold on commerce_deposit_retention_releases(hold_id,created_at);
alter table commerce_refunds add column retention_release_id uuid unique references commerce_deposit_retention_releases(id);
alter table commerce_deposit_ledger drop constraint commerce_deposit_ledger_entry_check;
alter table commerce_deposit_ledger add constraint commerce_deposit_ledger_entry_check check(entry in('collected','applied','restored','refund','retained','retention_released'));
alter table commerce_deposit_ledger drop constraint commerce_deposit_ledger_check;
alter table commerce_deposit_ledger add constraint commerce_deposit_ledger_check check(
 (entry in('collected','restored','retention_released') and amount_cents>0) or (entry in('applied','refund','retained') and amount_cents<0));

create function gf_retention_release_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare original commerce_deposit_retentions;share jsonb;prior integer;maximum integer;
begin
 if tg_op<>'INSERT' then
  if current_user='app_user' then raise exception using errcode='23001',message='retention releases are append-only';end if;
  return old;
 end if;
 perform id from commerce_appointment_holds where id=new.hold_id for update;
 select * into original from commerce_deposit_retentions where id=new.retention_id;
 if original.id is null or row(original.org_id,original.location_id,original.hold_id,original.payment_id) is distinct from row(new.org_id,new.location_id,new.hold_id,new.payment_id)
  or not exists(select 1 from commerce_appointment_holds h join commerce_payments p on p.id=new.payment_id and p.order_id=h.order_id
   where h.id=new.hold_id and not h.commerce_frozen and h.waived_at is null and p.status='paid') then
  raise exception using errcode='23001',message='retention release requires original paid and unfrozen deposit';
 end if;
 select coalesce(sum(amount_cents),0)::integer into prior from commerce_deposit_retention_releases where retention_id=original.id;
 if new.amount_cents>original.amount_cents-prior then raise exception using errcode='23001',message='retention release exceeds original amount';end if;
 for share in select * from jsonb_array_elements(new.guest_allocation) loop
  select (g->>'amountCents')::integer into maximum from jsonb_array_elements(original.guest_allocation)g where g->>'guestIndex'=share->>'guestIndex';
  select coalesce(sum((g->>'amountCents')::integer),0)::integer into prior from commerce_deposit_retention_releases r,
   jsonb_array_elements(r.guest_allocation)g where r.retention_id=original.id and g->>'guestIndex'=share->>'guestIndex';
  if maximum is null or (share->>'amountCents')::integer>maximum-prior then raise exception using errcode='23001',message='retention release exceeds original guest share';end if;
 end loop;
 return new;
end $$;
create trigger retention_release_guard before insert or update or delete on commerce_deposit_retention_releases for each row execute function gf_retention_release_guard();

create function gf_retention_release_links() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare release commerce_deposit_retention_releases;
begin
 if tg_table_name='commerce_deposit_ledger' then
  if new.entry<>'retention_released' then return new;end if;
  select * into release from commerce_deposit_retention_releases where 'release:'||id::text=new.reference;
  if release.id is null or row(new.org_id,new.location_id,new.hold_id,new.payment_id,new.amount_cents,new.guest_allocation)
   is distinct from row(release.org_id,release.location_id,release.hold_id,release.payment_id,release.amount_cents,release.guest_allocation) then
   raise exception using errcode='23001',message='released deposit ledger requires matching decision';
  end if;
 else
  if tg_op='UPDATE' and new.retention_release_id is distinct from old.retention_release_id then
   raise exception using errcode='23001',message='retention refund source is immutable';
  end if;
  if new.retention_release_id is null then return new;end if;
  select * into release from commerce_deposit_retention_releases where id=new.retention_release_id;
  if release.id is null or row(new.org_id,new.location_id,new.payment_id,new.amount_cents,new.deposit_guest_allocation,new.recorded_by)
   is distinct from row(release.org_id,release.location_id,release.payment_id,release.amount_cents,release.guest_allocation,release.recorded_by)
   or new.review_required or new.guest_cancellation_id is not null or new.status not in('pending','succeeded','failed') then
   raise exception using errcode='23001',message='retention refund requires matching release';
  end if;
 end if;
 return new;
end $$;
create trigger retention_release_ledger_link before insert on commerce_deposit_ledger for each row execute function gf_retention_release_links();
create trigger retention_release_refund_link before insert or update on commerce_refunds for each row execute function gf_retention_release_links();
create function gf_retention_release_complete() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if not exists(select 1 from commerce_refunds where retention_release_id=new.id)
  or not exists(select 1 from commerce_deposit_ledger where hold_id=new.hold_id and entry='retention_released' and reference='release:'||new.id::text) then
  raise exception using errcode='23001',message='retention release requires atomic ledger and refund reservation';
 end if;
 return new;
end $$;
create constraint trigger retention_release_complete after insert on commerce_deposit_retention_releases deferrable initially deferred for each row execute function gf_retention_release_complete();
revoke all on function gf_retention_release_guard(),gf_retention_release_links(),gf_retention_release_complete() from public,anon,authenticated;
grant execute on function gf_retention_release_guard(),gf_retention_release_links(),gf_retention_release_complete() to app_user;
