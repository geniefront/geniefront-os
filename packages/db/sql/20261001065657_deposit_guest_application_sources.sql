-- Guest-specific application/restoration follows the original cash source. Unknown history remains NULL.
alter table commerce_deposit_ledger add column guest_allocation jsonb,
 add constraint deposit_ledger_guest_amount check(gf_valid_deposit_refund_allocation(guest_allocation,abs(amount_cents)));
