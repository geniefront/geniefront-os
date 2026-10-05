-- A flexible Billing portal can set cancel_at to the item's end while cancel_at_period_end remains false.
-- Preserve both retrieved facts. Unknown older state stays NULL until reconciliation; no inferred backfill.
alter table customer_paid_memberships add column scheduled_cancel_at timestamptz,
 add column provider_cancel_at_period_end boolean,
 add constraint customer_membership_cancel_fact_binding check(
  (scheduled_cancel_at is null and provider_cancel_at_period_end is null) or stripe_subscription_id is not null);
