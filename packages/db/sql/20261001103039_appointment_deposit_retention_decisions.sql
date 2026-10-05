-- Retention is an explicit decision against a purchased policy, never a payment or a refund.
-- Unknown historical cancellation time remains unknown; never infer it from a later reschedule.
alter table appointment_guest_cancellations add column original_starts_at timestamptz;
alter table commerce_deposit_ledger drop constraint commerce_deposit_ledger_entry_check;
alter table commerce_deposit_ledger add constraint commerce_deposit_ledger_entry_check check(entry in('collected','applied','restored','refund','retained'));
alter table commerce_deposit_ledger drop constraint commerce_deposit_ledger_check;
alter table commerce_deposit_ledger add constraint commerce_deposit_ledger_check check(
 (entry in('collected','restored') and amount_cents>0) or (entry in('applied','refund','retained') and amount_cents<0));
alter table commerce_appointment_holds drop constraint commerce_appointment_holds_status_check;
alter table commerce_appointment_holds add constraint commerce_appointment_holds_status_check
 check(status in('pending','paid','waived','expired','cancelled','refund_pending','refunded','review','retained'));
alter table appointments drop constraint appointments_deposit_status_check;
alter table appointments add constraint appointments_deposit_status_check
 check(deposit_status in('none','pending','paid','waived','expired','cancelled','refund_pending','refunded','review','retained'));
create table commerce_deposit_retentions(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references organizations(id),location_id uuid not null references locations(id),
 hold_id uuid not null references commerce_appointment_holds(id),payment_id uuid not null references commerce_payments(id),
 amount_cents integer not null check(amount_cents>0),guest_allocation jsonb not null,
 policy_version text not null,reason text not null check(length(btrim(reason)) between 2 and 500),
 recorded_by uuid not null references memberships(id),created_at timestamptz not null default now(),
 check(gf_valid_deposit_refund_allocation(guest_allocation,amount_cents))
);
alter table commerce_deposit_retentions enable row level security;
alter table commerce_deposit_retentions force row level security;
create policy tenant_isolation on commerce_deposit_retentions to app_user using(org_id=app_org_id() and location_id=app_location_id())
 with check(org_id=app_org_id() and location_id=app_location_id());
revoke all on commerce_deposit_retentions from public,anon,authenticated,app_user;
grant select,insert on commerce_deposit_retentions to app_user;
create index commerce_deposit_retentions_hold on commerce_deposit_retentions(hold_id,created_at);
create function gf_deposit_retention_guard() returns trigger language plpgsql as $$
begin
 if tg_op<>'INSERT' then
   if current_user='app_user' then raise exception using errcode='23001',message='deposit retention decisions are append-only'; end if;
   return old;
 end if;
 if not exists(select 1 from commerce_appointment_holds h join commerce_payments p on p.order_id=h.order_id
   where h.id=new.hold_id and h.org_id=new.org_id and h.location_id=new.location_id and p.id=new.payment_id
     and p.status='paid' and h.waived_at is null and not h.commerce_frozen
     and h.policy_snapshot->>'version'=new.policy_version and h.policy_snapshot->>'retainAfterCutoff'='true'
     and h.policy_snapshot->'consent'->>'accepted'='true') then
   raise exception using errcode='23001',message='retention requires the original paid deposit policy and consent';
 end if;
 return new;
end $$;
create trigger deposit_retention_guard before insert or update or delete on commerce_deposit_retentions
 for each row execute function gf_deposit_retention_guard();
alter table commerce_refunds drop constraint commerce_refunds_status_check;
alter table commerce_refunds add constraint commerce_refunds_status_check check(status in('pending','succeeded','failed','review','declined'));
alter table commerce_refunds add column declined_at timestamptz,add column declined_by uuid references memberships(id),
 add column decline_reason text,add column retention_id uuid references commerce_deposit_retentions(id),
 add constraint guest_refund_decline_fields check(
 (declined_at is null and declined_by is null and decline_reason is null and retention_id is null and status<>'declined')
 or (status='declined' and declined_at is not null and declined_by is not null and length(btrim(decline_reason)) between 2 and 500
   and decline_reason is not null and retention_id is not null and review_required and guest_cancellation_id is not null
   and approved_at is null and stripe_refund_id is null));
create function gf_refund_decline_immutable() returns trigger language plpgsql as $$
begin
 if old.declined_at is not null and row(new.status,new.declined_at,new.declined_by,new.decline_reason,new.retention_id)
    is distinct from row(old.status,old.declined_at,old.declined_by,old.decline_reason,old.retention_id) then
   raise exception using errcode='23001',message='refund decline decision is immutable';
 end if;
 return new;
end $$;
create trigger refund_decline_immutable before update on commerce_refunds for each row execute function gf_refund_decline_immutable();
insert into role_permissions(role_id,permission) select id,'commerce.retainDeposit' from roles where key in('owner','manager') on conflict do nothing;
alter table email_outbox drop constraint email_outbox_kind;
alter table email_outbox add constraint email_outbox_kind check(kind in(
 'appointment_confirm','appointment_changed','appointment_reminder','appointment_deposit_pending','appointment_deposit_retained',
 'receipt','platform_notice','form_invite','trial_ending','payment_failed','subscription_canceled','license_expiring'));
