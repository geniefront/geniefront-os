alter table customer_membership_plan_changes add column withdrawal_requested_at timestamptz,add column withdrawn_at timestamptz,add column canceled_at timestamptz;
alter table customer_membership_plan_changes drop constraint customer_membership_plan_changes_status_check;
alter table customer_membership_plan_changes add constraint customer_membership_plan_changes_status_check check(status in('pending','scheduled','applied','withdrawn','canceled'));
do $$ declare key_name text;begin
 select conname into key_name from pg_constraint where conrelid='customer_membership_plan_changes'::regclass and contype='u';
 if key_name is not null then execute format('alter table customer_membership_plan_changes drop constraint %I',key_name);end if;
end $$;
create unique index customer_membership_live_change_boundary on customer_membership_plan_changes(membership_id,effective_at) where status<>'withdrawn';
alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in('checkout','refund','expire_checkout','notification','subscription_update','reconcile','expire_deposit','membership_grant','payout_scan','payout_reconcile','membership_change','membership_change_withdraw'));
create or replace function gf_membership_change_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if tg_op='INSERT' then
  if new.status<>'pending' or new.withdrawal_requested_at is not null or new.withdrawn_at is not null or new.canceled_at is not null or new.stripe_price_id is not null or new.stripe_schedule_id is not null or not exists(
   select 1 from customer_paid_memberships m join customer_membership_plan_versions v on v.id=new.plan_version_id where m.id=new.membership_id
    and m.org_id=new.org_id and m.location_id=new.location_id and v.org_id=new.org_id and v.location_id=new.location_id
    and m.provider_status='active' and not m.commerce_frozen and m.terminated_at is null and not m.cancel_at_period_end
    and m.current_period_end=new.effective_at and coalesce(m.current_price_id,m.stripe_price_id)=new.previous_price_id
    and new.snapshot->'terms'=v.terms and new.snapshot->>'currency'=v.currency and v.currency=m.snapshot->>'currency'
    and new.snapshot->>'timezone'=m.snapshot->>'timezone' and new.consent->>'accepted'='true'
    and new.consent->>'versionId'=v.id::text and new.consent->>'amountCents'=v.terms->>'amountCents'
    and new.consent->>'cadence'=v.terms->>'cadence' and (new.consent->>'effectiveAt')::timestamptz=new.effective_at) then
   raise exception using errcode='23001',message='membership change requires confirmed scoped future terms';
  end if;
 else
  if row(new.org_id,new.location_id,new.membership_id,new.plan_version_id,new.snapshot,new.consent,new.effective_at,new.previous_price_id,new.created_at)
   is distinct from row(old.org_id,old.location_id,old.membership_id,old.plan_version_id,old.snapshot,old.consent,old.effective_at,old.previous_price_id,old.created_at)
   or (old.stripe_price_id is not null and new.stripe_price_id is distinct from old.stripe_price_id)
   or (old.stripe_schedule_id is not null and new.stripe_schedule_id is distinct from old.stripe_schedule_id)
   or (old.status in('applied','withdrawn','canceled') and new.status<>old.status) or (old.status='scheduled' and new.status='pending') then
   raise exception using errcode='23001',message='membership change consent and provider bindings are immutable';
  end if;
 end if;
 if (old.withdrawal_requested_at is not null and new.withdrawal_requested_at is distinct from old.withdrawal_requested_at)
   or (old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at)
   or (old.canceled_at is not null and new.canceled_at is distinct from old.canceled_at)
   or (new.status='canceled' and (new.canceled_at is null or not exists(select 1 from customer_paid_memberships m where m.id=new.membership_id and m.provider_status in('canceled','incomplete_expired'))))
   or (new.canceled_at is not null and new.status<>'canceled')
   or (new.status='withdrawn' and (new.withdrawal_requested_at is null or new.withdrawn_at is null))
   or (new.withdrawn_at is not null and new.status<>'withdrawn') then
  raise exception using errcode='23001',message='membership withdrawal receipt is immutable';
 end if;
 if new.status in('scheduled','applied') and (new.stripe_price_id is null or new.stripe_schedule_id is null or new.scheduled_at is null) then
  raise exception using errcode='23001',message='membership change schedule must be verified';
 end if;
 return new;
end $$;
