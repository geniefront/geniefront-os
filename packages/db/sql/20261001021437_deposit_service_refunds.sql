alter table ticket_refunds add column deposit_cents integer not null default 0 check(deposit_cents>=0);
alter table ticket_refunds drop constraint ticket_refunds_channels_match;
alter table ticket_refunds add constraint ticket_refunds_channels_match check(
 cash_cents+card_cents+gift_card_cents+customer_credit_cents+deposit_cents=amount_cents);
create unique index if not exists ticket_refunds_identity_scope on ticket_refunds(id,org_id,location_id);
alter table commerce_deposit_ledger add column ticket_refund_id uuid;
alter table commerce_deposit_ledger add constraint deposit_ledger_service_refund_scope foreign key(ticket_refund_id,org_id,location_id)
 references ticket_refunds(id,org_id,location_id);
