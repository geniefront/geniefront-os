-- Pin name resolution for financial guards and valuation helpers.
-- Invoker privileges, RLS, function bodies and all existing financial facts remain unchanged.
alter function commerce_internal.membership_range_value(amount integer, quantity integer, units int4multirange) set search_path = pg_catalog, public, pg_temp;
alter function public.gf_ccl_append_only() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_commerce_payout_batch_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_commerce_payout_context_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_commerce_payout_transaction_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_deposit_appointment_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_deposit_hold_contract_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_deposit_ledger_append_only() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_deposit_retention_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_guest_cancellation_append_only() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_guest_refund_context_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_membership_purchase_refund_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_membership_service_refund_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_membership_stop_fact_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_membership_termination_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_membership_termination_link_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_paid_membership_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_refund_decline_immutable() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_refund_guest_contract_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_ticket_refund_sources_complete() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_ticket_source_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_ticket_source_receipt_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_ticket_source_refund_guard() set search_path = pg_catalog, public, pg_temp;
alter function public.gf_valid_deposit_refund_allocation(shares jsonb, amount integer) set search_path = pg_catalog, public, pg_temp;
