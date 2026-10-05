import { pgTable,uuid,text,jsonb,boolean,integer,timestamp,bigserial,bigint,customType,uniqueIndex,index,date } from 'drizzle-orm/pg-core';
import { organizations,locations } from './tenancy';
import { customers } from './scheduling';
import { memberships } from './identity';
import { tickets } from './tickets';
import { customerPackages } from './marketing';
import { appointments } from './scheduling';
const identity = () => ({ id:uuid('id').primaryKey().defaultRandom(), orgId:uuid('org_id').notNull().references(()=>organizations.id),
  locationId:uuid('location_id').notNull().references(()=>locations.id), createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow() });
const when = (name:string) => timestamp(name,{withTimezone:true});
const unitRange=customType<{data:string;driverData:string}>({dataType:()=> 'int4multirange'});
const encryptedToken=customType<{data:Buffer;driverData:Buffer}>({dataType:()=> 'bytea'});
export const commercePayouts=pgTable('commerce_payouts',{
 ...identity(),accountId:uuid('account_id').notNull().references(()=>commerceAccounts.id),stripeAccountId:text('stripe_account_id').notNull(),livemode:boolean('livemode').notNull(),stripePayoutId:text('stripe_payout_id').notNull(),
 amountCents:integer('amount_cents').notNull(),currency:text('currency').notNull(),automatic:boolean('automatic').notNull(),destinationType:text('destination_type').notNull(),providerCreatedAt:when('provider_created_at').notNull(),businessDate:date('business_date').notNull(),
},t=>[uniqueIndex('commerce_payouts_stripe_account_id_livemode_stripe_payout_id_key').on(t.stripeAccountId,t.livemode,t.stripePayoutId)]);
export const commercePayoutObservations=pgTable('commerce_payout_observations',{
 ...identity(),payoutId:uuid('payout_id').notNull().references(()=>commercePayouts.id),status:text('status').notNull(),reconciliationStatus:text('reconciliation_status').notNull(),arrivalAt:when('arrival_at').notNull(),failureCode:text('failure_code'),
 balanceTransactionId:text('balance_transaction_id'),failureBalanceTransactionId:text('failure_balance_transaction_id'),observedAt:when('observed_at').notNull(),factsHash:text('facts_hash').notNull(),sourceCount:integer('source_count'),sourceNetCents:integer('source_net_cents'),
},t=>[uniqueIndex('commerce_payout_observations_payout_id_facts_hash_key').on(t.payoutId,t.factsHash)]);
export const commercePayoutTransactions=pgTable('commerce_payout_transactions',{
 ...identity(),payoutId:uuid('payout_id').notNull().references(()=>commercePayouts.id),role:text('role').notNull(),balanceTransactionId:text('balance_transaction_id').notNull(),sourceId:text('source_id'),currency:text('currency').notNull(),
 grossCents:integer('gross_cents').notNull(),feeCents:integer('fee_cents').notNull(),netCents:integer('net_cents').notNull(),type:text('type').notNull(),providerCreatedAt:when('provider_created_at').notNull(),availableOn:when('available_on').notNull(),
},t=>[uniqueIndex('commerce_payout_transactions_payout_id_balance_transaction_id_key').on(t.payoutId,t.balanceTransactionId)]);
export const customerMembershipPlans=pgTable('customer_membership_plans',{
 ...identity(),active:boolean('active').notNull().default(true),onlineSale:boolean('online_sale').notNull().default(false),
});
export const customerMembershipPlanVersions=pgTable('customer_membership_plan_versions',{
 ...identity(),planId:uuid('plan_id').notNull().references(()=>customerMembershipPlans.id),version:integer('version').notNull(),terms:jsonb('terms').notNull(),
 currency:text('currency').notNull(),createdBy:uuid('created_by').notNull().references(()=>memberships.id),
},t=>[uniqueIndex('customer_membership_plan_versions_plan_id_version_key').on(t.planId,t.version)]);
export const customerPaidMemberships=pgTable('customer_paid_memberships',{
 ...identity(),customerId:uuid('customer_id').notNull().references(()=>customers.id),planVersionId:uuid('plan_version_id').notNull().references(()=>customerMembershipPlanVersions.id),
 accountId:uuid('account_id').notNull().references(()=>commerceAccounts.id),originalOrderId:uuid('original_order_id').notNull().unique().references(()=>commerceOrders.id),
 snapshot:jsonb('snapshot').notNull(),consent:jsonb('consent').notNull(),livemode:boolean('livemode').notNull(),stripeCustomerId:text('stripe_customer_id'),
 stripeSubscriptionId:text('stripe_subscription_id'),stripePriceId:text('stripe_price_id'),providerStatus:text('provider_status').notNull().default('pending'),
 cancelAtPeriodEnd:boolean('cancel_at_period_end').notNull().default(false),currentPeriodEnd:when('current_period_end'),providerObservedAt:when('provider_observed_at'),
 scheduledCancelAt:when('scheduled_cancel_at'),providerCancelAtPeriodEnd:boolean('provider_cancel_at_period_end'),
 endedAt:when('ended_at'),terminatedAt:when('terminated_at'),commerceFrozen:boolean('commerce_frozen').notNull().default(false),
 terminationId:uuid('termination_id'),currentPriceId:text('current_price_id'),
 manageTokenHash:text('manage_token_hash').notNull().unique(),manageTokenWrapped:encryptedToken('manage_token_wrapped').notNull(),
 manageTokenExpiresAt:when('manage_token_expires_at').notNull(),manageTokenRevokedAt:when('manage_token_revoked_at'),updatedAt:when('updated_at').notNull().defaultNow(),
});
export const customerMembershipPlanChanges=pgTable('customer_membership_plan_changes',{
 ...identity(),membershipId:uuid('membership_id').notNull().references(()=>customerPaidMemberships.id),planVersionId:uuid('plan_version_id').notNull().references(()=>customerMembershipPlanVersions.id),snapshot:jsonb('snapshot').notNull(),consent:jsonb('consent').notNull(),effectiveAt:when('effective_at').notNull(),previousPriceId:text('previous_price_id').notNull(),status:text('status').notNull().default('pending'),stripePriceId:text('stripe_price_id'),stripeScheduleId:text('stripe_schedule_id'),scheduledAt:when('scheduled_at'),appliedAt:when('applied_at'),updatedAt:when('updated_at').notNull().defaultNow(),
});
export const customerMembershipInvoices=pgTable('customer_membership_invoices',{
 planVersionId:uuid('plan_version_id').notNull().references(()=>customerMembershipPlanVersions.id),snapshot:jsonb('snapshot').notNull(),stripePriceId:text('stripe_price_id').notNull(),
 ...identity(),membershipId:uuid('membership_id').notNull().references(()=>customerPaidMemberships.id),accountId:uuid('account_id').notNull().references(()=>commerceAccounts.id),
 livemode:boolean('livemode').notNull(),stripeInvoiceId:text('stripe_invoice_id').notNull(),orderId:uuid('order_id').notNull().unique().references(()=>commerceOrders.id),
 paymentId:uuid('payment_id').notNull().unique().references(()=>commercePayments.id),periodStart:when('period_start').notNull(),periodEnd:when('period_end').notNull(),paidAt:when('paid_at').notNull(),
},t=>[uniqueIndex('customer_membership_invoices_account_invoice').on(t.accountId,t.livemode,t.stripeInvoiceId),uniqueIndex('customer_membership_invoices_period').on(t.membershipId,t.periodStart,t.periodEnd)]);
export const customerMembershipCycles=pgTable('customer_membership_cycles',{
 ...identity(),membershipId:uuid('membership_id').notNull().references(()=>customerPaidMemberships.id),invoiceId:uuid('invoice_id').notNull().references(()=>customerMembershipInvoices.id),
 cycleIndex:integer('cycle_index').notNull(),startsAt:when('starts_at').notNull(),endsAt:when('ends_at').notNull(),quantity:integer('quantity').notNull(),valueCents:integer('value_cents').notNull(),
 status:text('status').notNull().default('planned'),availableUnits:unitRange('available_units').notNull().default('{}'),issuedAt:when('issued_at'),
},t=>[uniqueIndex('customer_membership_cycles_invoice_id_cycle_index_key').on(t.invoiceId,t.cycleIndex)]);
export const customerMembershipLedger=pgTable('customer_membership_ledger',{
 ...identity(),cycleId:uuid('cycle_id').notNull().references(()=>customerMembershipCycles.id),entry:text('entry').notNull(),quantity:integer('quantity').notNull(),
 valueCents:integer('value_cents').notNull(),unitRanges:unitRange('unit_ranges').notNull().default('{}'),ticketId:uuid('ticket_id').references(()=>tickets.id),reference:text('reference').notNull(),
 ticketItemId:uuid('ticket_item_id'),redemptionId:uuid('redemption_id'),ticketRefundId:uuid('ticket_refund_id'),coveredCents:integer('covered_cents').notNull().default(0),
 businessDate:date('business_date'),meta:jsonb('meta').notNull().default({}),
 terminationId:uuid('termination_id'),currentPriceId:text('current_price_id'),
},t=>[uniqueIndex('customer_membership_ledger_cycle_id_reference_key').on(t.cycleId,t.reference)]);
export const customerMembershipServiceRefunds=pgTable('customer_membership_service_refunds',{
 ...identity(),redemptionId:uuid('redemption_id').notNull().references(()=>customerMembershipLedger.id),ticketRefundId:uuid('ticket_refund_id').notNull(),coveredCents:integer('covered_cents').notNull(),
},t=>[uniqueIndex('customer_membership_service_refunds_redemption_id_ticket_refund_id_key').on(t.redemptionId,t.ticketRefundId)]);
export const ticketPriceAdjustments=pgTable('ticket_price_adjustments',{
 ...identity(),ticketId:uuid('ticket_id').notNull().references(()=>tickets.id),ticketItemId:uuid('ticket_item_id').notNull().unique(),kind:text('kind').notNull(),
 originalCents:integer('original_cents').notNull(),discountCents:integer('discount_cents').notNull(),customerMembershipId:uuid('customer_membership_id').references(()=>customerPaidMemberships.id),
 cycleId:uuid('cycle_id').references(()=>customerMembershipCycles.id),planVersionId:uuid('plan_version_id').references(()=>customerMembershipPlanVersions.id),
 businessDate:date('business_date').notNull(),actorMembershipId:uuid('actor_membership_id').references(()=>memberships.id),ruleSnapshot:jsonb('rule_snapshot').notNull(),
},t=>[index('ticket_price_adjustments_ticket').on(t.ticketId,t.kind)]);
export const customerMembershipTerminations=pgTable('customer_membership_terminations',{
 ...identity(),membershipId:uuid('membership_id').notNull().unique().references(()=>customerPaidMemberships.id),unusedBenefits:text('unused_benefits').notNull(),
 reason:text('reason').notNull(),requestedBy:uuid('requested_by').notNull().references(()=>memberships.id),businessDate:date('business_date').notNull(),
 reviewSnapshot:jsonb('review_snapshot').notNull(),status:text('status').notNull().default('pending'),providerCanceledAt:when('provider_canceled_at'),updatedAt:when('updated_at').notNull().defaultNow(),
});
export const customerMembershipTerminationCycles=pgTable('customer_membership_termination_cycles',{
 ...identity(),terminationId:uuid('termination_id').notNull().references(()=>customerMembershipTerminations.id),cycleId:uuid('cycle_id').notNull().unique().references(()=>customerMembershipCycles.id),
 stopBenefits:boolean('stop_benefits').notNull(),reviewedState:jsonb('reviewed_state').notNull(),
});
export const customerMembershipRefundRequests=pgTable('customer_membership_refund_requests',{
 ...identity(),membershipId:uuid('membership_id').notNull().references(()=>customerPaidMemberships.id),terminationId:uuid('termination_id').notNull().references(()=>customerMembershipTerminations.id),
 reason:text('reason').notNull(),reviewSnapshot:jsonb('review_snapshot').notNull(),requestedBy:uuid('requested_by').notNull().references(()=>memberships.id),businessDate:date('business_date').notNull(),
});
export const commerceAccounts = pgTable('commerce_accounts',{
  id:uuid('id').primaryKey().defaultRandom(), orgId:uuid('org_id').notNull().references(()=>organizations.id),
  locationId:uuid('location_id').notNull().references(()=>locations.id), stripeAccountId:text('stripe_account_id').notNull(), livemode:boolean('livemode').notNull(),
  apiVersion:text('api_version').notNull().default('v1'),payoutScanCursor:text('payout_scan_cursor'),
  chargesEnabled:boolean('charges_enabled').notNull().default(false), payoutsEnabled:boolean('payouts_enabled').notNull().default(false),
  detailsSubmitted:boolean('details_submitted').notNull().default(false), disconnected:boolean('disconnected').notNull().default(false),
  capabilities:jsonb('capabilities').notNull().default({}),requirements:jsonb('requirements').notNull().default({}),refreshedAt:when('refreshed_at').notNull().defaultNow(),
},t=>[uniqueIndex('commerce_accounts_location_id_livemode_key').on(t.locationId,t.livemode),index('commerce_account_external').on(t.stripeAccountId,t.livemode)]);
export const commerceAppointmentHolds=pgTable('commerce_appointment_holds',{
 ...identity(),appointmentId:uuid('appointment_id').notNull().unique().references(()=>appointments.id),orderId:uuid('order_id').unique().references(()=>commerceOrders.id),
 status:text('status').notNull().default('pending'),amountCents:integer('amount_cents').notNull(),serviceTotalCents:integer('service_total_cents').notNull(),
 currency:text('currency').notNull(),expiresAt:when('expires_at').notNull(),policySnapshot:jsonb('policy_snapshot').notNull(),
 businessKey:text('business_key').notNull(),requestHash:text('request_hash').notNull(),updatedAt:when('updated_at').notNull().defaultNow(),
 reservedCents:integer('reserved_cents').notNull().default(0),commerceFrozen:boolean('commerce_frozen').notNull().default(false),
 hasConfirmedBooking:boolean('has_confirmed_booking').notNull().default(false),
 waivedAt:when('waived_at'),waivedBy:uuid('waived_by').references(()=>memberships.id),waiverReason:text('waiver_reason'),
},t=>[uniqueIndex('commerce_appointment_holds_location_business_key').on(t.locationId,t.businessKey)]);
export const commerceOrders = pgTable('commerce_orders',{
  ...identity(),customerId:uuid('customer_id').references(()=>customers.id),accountId:uuid('account_id').references(()=>commerceAccounts.id),
  kind:text('kind').notNull(),channel:text('channel').notNull(),status:text('status').notNull().default('pending'),amountCents:integer('amount_cents').notNull(),
  currency:text('currency').notNull(),snapshot:jsonb('snapshot').notNull(),assetId:uuid('asset_id'),idemKey:text('idem_key').notNull(),requestHash:text('request_hash').notNull(),
  updatedAt:when('updated_at').notNull().defaultNow(),
},t=>[uniqueIndex('commerce_orders_location_id_idem_key_key').on(t.locationId,t.idemKey),index('commerce_order_customer').on(t.locationId,t.customerId,t.createdAt)]);
export const commercePayments = pgTable('commerce_payments',{
  ...identity(),orderId:uuid('order_id').notNull().references(()=>commerceOrders.id),provider:text('provider').notNull(),method:text('method').notNull(),
  status:text('status').notNull().default('pending'),amountCents:integer('amount_cents').notNull(),currency:text('currency').notNull(),stripeAccountId:text('stripe_account_id'),
  livemode:boolean('livemode').notNull().default(false),checkoutSessionId:text('checkout_session_id'),checkoutUrl:text('checkout_url'),checkoutExpiresAt:when('checkout_expires_at'),
  paymentIntentId:text('payment_intent_id'),externalReference:text('external_reference'),recordedBy:uuid('recorded_by').references(()=>memberships.id),paidAt:when('paid_at'),
  feeCents:integer('fee_cents'),netCents:integer('net_cents'),balanceTransactionId:text('balance_transaction_id'),chargeId:text('charge_id'),settlementCurrency:text('settlement_currency'),settlementGrossCents:integer('settlement_gross_cents'),availableOn:when('available_on'),
});
export const commerceDepositRequotes=pgTable('commerce_deposit_requotes',{
 ...identity(),holdId:uuid('hold_id').notNull().references(()=>commerceAppointmentHolds.id),revision:integer('revision').notNull(),
 serviceTotalCents:integer('service_total_cents').notNull(),requiredCents:integer('required_cents').notNull(),availableCents:integer('available_cents').notNull(),
 requestCents:integer('request_cents').notNull(),excessCents:integer('excess_cents').notNull(),currency:text('currency').notNull(),policyVersion:text('policy_version').notNull(),
 quoteHash:text('quote_hash').notNull(),snapshot:jsonb('snapshot').notNull(),consent:jsonb('consent').notNull(),createdBy:uuid('created_by').references(()=>memberships.id),
},t=>[uniqueIndex('commerce_deposit_requotes_hold_revision').on(t.holdId,t.revision)]);
export const commerceDepositRequests=pgTable('commerce_deposit_requests',{
 orderId:uuid('order_id').primaryKey().references(()=>commerceOrders.id),orgId:uuid('org_id').notNull().references(()=>organizations.id),
 locationId:uuid('location_id').notNull().references(()=>locations.id),holdId:uuid('hold_id').notNull().references(()=>commerceAppointmentHolds.id),
 quoteId:uuid('quote_id').references(()=>commerceDepositRequotes.id),purpose:text('purpose').notNull(),state:text('state').notNull().default('open'),
 expiresAt:when('expires_at').notNull(),createdAt:when('created_at').notNull().defaultNow(),
});
export const commerceRefunds = pgTable('commerce_refunds',{
  ...identity(),paymentId:uuid('payment_id').notNull().references(()=>commercePayments.id),amountCents:integer('amount_cents').notNull(),assetQuantity:integer('asset_quantity').notNull().default(0),
  status:text('status').notNull().default('pending'),stripeRefundId:text('stripe_refund_id'),externalReference:text('external_reference'),reason:text('reason').notNull(),balanceTransactionId:text('balance_transaction_id'),settlementCurrency:text('settlement_currency'),settlementGrossCents:integer('settlement_gross_cents'),feeCents:integer('fee_cents'),netCents:integer('net_cents'),availableOn:when('available_on'),
  reservedUnitRanges:unitRange('reserved_unit_ranges'),recordedBy:uuid('recorded_by').references(()=>memberships.id),completedAt:when('completed_at'),
  membershipRefundRequestId:uuid('membership_refund_request_id').references(()=>customerMembershipRefundRequests.id),
  depositGuestAllocation:jsonb('deposit_guest_allocation'),guestCancellationId:uuid('guest_cancellation_id').references(()=>appointmentGuestCancellations.id),
  retentionReleaseId:uuid('retention_release_id').references(()=>commerceDepositRetentionReleases.id),
  declinedAt:when('declined_at'),declinedBy:uuid('declined_by').references(()=>memberships.id),declineReason:text('decline_reason'),retentionId:uuid('retention_id').references(()=>commerceDepositRetentions.id),
  reviewRequired:boolean('review_required').notNull().default(false),approvedBy:uuid('approved_by').references(()=>memberships.id),approvedAt:when('approved_at'),approvalReason:text('approval_reason'),
},t=>[index('commerce_refund_payment').on(t.paymentId,t.status)]);
export const commerceDepositLedger=pgTable('commerce_deposit_ledger',{
  ...identity(),holdId:uuid('hold_id').notNull().references(()=>commerceAppointmentHolds.id),paymentId:uuid('payment_id').notNull().references(()=>commercePayments.id),
  ticketId:uuid('ticket_id').references(()=>tickets.id),refundId:uuid('refund_id').references(()=>commerceRefunds.id),ticketRefundId:uuid('ticket_refund_id'),
  entry:text('entry').notNull(),amountCents:integer('amount_cents').notNull(),reference:text('reference').notNull(),
  guestAllocation:jsonb('guest_allocation'),
},t=>[uniqueIndex('commerce_deposit_ledger_hold_reference').on(t.holdId,t.reference)]);
export const commerceDepositRetentions=pgTable('commerce_deposit_retentions',{
 ...identity(),holdId:uuid('hold_id').notNull().references(()=>commerceAppointmentHolds.id),paymentId:uuid('payment_id').notNull().references(()=>commercePayments.id),
 amountCents:integer('amount_cents').notNull(),guestAllocation:jsonb('guest_allocation').notNull(),policyVersion:text('policy_version').notNull(),
 reason:text('reason').notNull(),recordedBy:uuid('recorded_by').notNull().references(()=>memberships.id),
},t=>[index('commerce_deposit_retentions_hold').on(t.holdId,t.createdAt)]);
export const commerceDepositRetentionReleases=pgTable('commerce_deposit_retention_releases',{
 ...identity(),retentionId:uuid('retention_id').notNull().references(()=>commerceDepositRetentions.id),holdId:uuid('hold_id').notNull().references(()=>commerceAppointmentHolds.id),paymentId:uuid('payment_id').notNull().references(()=>commercePayments.id),
 amountCents:integer('amount_cents').notNull(),guestAllocation:jsonb('guest_allocation').notNull(),reason:text('reason').notNull(),recordedBy:uuid('recorded_by').notNull().references(()=>memberships.id),
},t=>[index('commerce_deposit_retention_releases_retention').on(t.retentionId,t.createdAt),index('commerce_deposit_retention_releases_hold').on(t.holdId,t.createdAt)]);
export const appointmentGuestCancellations=pgTable('appointment_guest_cancellations',{
  ...identity(),appointmentId:uuid('appointment_id').notNull().references(()=>appointments.id),guestIndex:integer('guest_index').notNull(),
  originalPartySize:integer('original_party_size').notNull(),reason:text('reason').notNull(),createdBy:uuid('created_by').references(()=>memberships.id),
  actorSource:text('actor_source').notNull().default('staff'),originalStartsAt:when('original_starts_at'),
},t=>[uniqueIndex('appointment_guest_cancellations_appointment_guest').on(t.appointmentId,t.guestIndex)]);
export const commerceEvents = pgTable('commerce_events',{
  ...identity(),stripeAccountId:text('stripe_account_id').notNull(),livemode:boolean('livemode').notNull(),eventId:text('event_id').notNull(),eventType:text('event_type').notNull(),objectId:text('object_id').notNull(),
},t=>[uniqueIndex('commerce_events_stripe_account_id_livemode_event_id_key').on(t.stripeAccountId,t.livemode,t.eventId)]);
export const commerceTasks = pgTable('commerce_tasks',{
  ...identity(),kind:text('kind').notNull(),subjectId:uuid('subject_id').notNull(),status:text('status').notNull().default('pending'),attempts:integer('attempts').notNull().default(0),
  leaseId:uuid('lease_id'),lockedUntil:when('locked_until'),retryAt:when('retry_at').notNull().defaultNow(),lastError:text('last_error'),
},t=>[uniqueIndex('commerce_tasks_kind_subject_id_key').on(t.kind,t.subjectId),index('commerce_task_due').on(t.status,t.retryAt,t.lockedUntil)]);
export const commerceAccessTokens = pgTable('commerce_access_tokens',{
  ...identity(),orderId:uuid('order_id').notNull().references(()=>commerceOrders.id),tokenHash:text('token_hash').notNull(),expiresAt:when('expires_at').notNull(),revokedAt:when('revoked_at'),
},t=>[uniqueIndex('commerce_access_tokens_token_hash_key').on(t.tokenHash)]);
export const commerceReviewItems=pgTable('commerce_review_items',{
  ...identity(),paymentId:uuid('payment_id').notNull().references(()=>commercePayments.id),stripeAccountId:text('stripe_account_id').notNull(),
  livemode:boolean('livemode').notNull(),kind:text('kind').notNull(),externalId:text('external_id').notNull(),amountCents:integer('amount_cents').notNull(),
  currency:text('currency').notNull(),status:text('status').notNull(),providerStatus:text('provider_status').notNull(),
  eventCreated:bigint('event_created',{mode:'number'}).notNull(),updatedAt:when('updated_at').notNull().defaultNow(),
},t=>[uniqueIndex('commerce_review_items_stripe_account_id_livemode_kind_external_id_key').on(t.stripeAccountId,t.livemode,t.kind,t.externalId),
  index('commerce_review_open').on(t.locationId,t.status)]);
export const customerPackageLedger = pgTable('customer_package_ledger',{
  ...identity(),seq:bigserial('seq',{mode:'number'}).notNull(),packageId:uuid('package_id').notNull().references(()=>customerPackages.id),entry:text('entry').notNull(),
  quantity:integer('quantity').notNull(),valueCents:integer('value_cents').notNull().default(0),unitRanges:unitRange('unit_ranges'),ticketId:uuid('ticket_id').references(()=>tickets.id),reversalOfId:uuid('reversal_of_id'),reference:text('reference').notNull(),
},t=>[uniqueIndex('customer_package_ledger_package_id_reference_key').on(t.packageId,t.reference),index('customer_package_ledger_subject').on(t.packageId,t.seq)]);
