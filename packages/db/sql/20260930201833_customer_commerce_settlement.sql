-- Stripe balance facts stay in their own currency; converted net is never added to original service money.
alter table commerce_payments add column charge_id text, add column settlement_currency text,
 add column settlement_gross_cents integer, add column available_on timestamptz;
alter table commerce_refunds add column balance_transaction_id text,add column settlement_currency text,
 add column settlement_gross_cents integer,add column fee_cents integer,add column net_cents integer,add column available_on timestamptz;
alter table commerce_tasks drop constraint commerce_tasks_kind_check;
alter table commerce_tasks add constraint commerce_tasks_kind_check check(kind in ('checkout','refund','reconcile','expire_checkout','notification','subscription_update'));
