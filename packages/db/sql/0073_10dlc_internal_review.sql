-- ════════════════════════════════════════════════════════════════════════════
--  0073 · 10DLC application is an internal GenieFront review, not a carrier filing
--
--  Customer submit writes location_10dlc_registrations with pending_review.
--  That row is later reviewed by platform operators; TCR/carrier filing is
--  not performed here. Store the submitting membership so a future operator
--  queue can see who sent the application.
--
--  Must be applied in production. Do not rewrite earlier numbered files.
-- ════════════════════════════════════════════════════════════════════════════

alter table location_10dlc_registrations
  add column if not exists submitted_by_membership_id uuid references memberships(id);

comment on column location_10dlc_registrations.status is
  'Internal GenieFront workflow: not_submitted | pending_review | approved | rejected. pending_review means received for internal review, not submitted to TCR/carriers.';

comment on column location_10dlc_registrations.submitted_by_membership_id is
  'Desk membership that submitted the application for internal GenieFront review.';

comment on column location_10dlc_registrations.submitted_at is
  'When the customer application was received by GenieFront. Not a carrier/TCR filing timestamp.';
