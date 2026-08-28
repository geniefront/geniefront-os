/** Provider-sourced operational facts. SQL 0059 owns constraints, RLS and immutability. */
import {
  pgTable, uuid, text, integer, boolean, jsonb, timestamp, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();
const org = () => uuid('org_id').notNull().references(() => organizations.id);
const location = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const providerConnections = pgTable('provider_connections', {
  id: id(), orgId: org(), locationId: location(), provider: text('provider').notNull(),
  capability: text('capability').notNull(), status: text('status').notNull().default('not_configured'),
  credentialsRef: text('credentials_ref'), syncCursor: text('sync_cursor'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'), createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('provider_connections_location_id_provider_capability_key')
  .on(t.locationId, t.provider, t.capability)]);

export const merchantBalanceSnapshots = pgTable('merchant_balance_snapshots', {
  id: id(), orgId: org(), locationId: location(),
  providerConnectionId: uuid('provider_connection_id').notNull().references(() => providerConnections.id),
  availableCents: integer('available_cents').notNull(), pendingCents: integer('pending_cents').notNull(),
  processingFeeCents: integer('processing_fee_cents').notNull().default(0),
  bankName: text('bank_name'), bankLast4: text('bank_last4'), bankStatus: text('bank_status'),
  payoutSchedule: text('payout_schedule'), nextPayoutAt: timestamp('next_payout_at', { withTimezone: true }),
  providerAsOf: timestamp('provider_as_of', { withTimezone: true }).notNull(), createdAt: createdAt(),
}, (t) => [index('merchant_balance_latest_idx').on(t.locationId, t.providerAsOf)]);

export const payoutBatches = pgTable('payout_batches', {
  id: id(), orgId: org(), locationId: location(),
  providerConnectionId: uuid('provider_connection_id').notNull().references(() => providerConnections.id),
  providerPayoutId: text('provider_payout_id').notNull(), amountCents: integer('amount_cents').notNull(),
  feeCents: integer('fee_cents').notNull().default(0), netCents: integer('net_cents').notNull(),
  transactionCount: integer('transaction_count').notNull().default(0), bankLast4: text('bank_last4'),
  status: text('status').notNull(), arrivalDate: date('arrival_date'),
  providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(), createdAt: createdAt(),
}, (t) => [
  uniqueIndex('payout_batches_provider_connection_id_provider_payout_id_key')
    .on(t.providerConnectionId, t.providerPayoutId),
  index('payout_batches_recent_idx').on(t.locationId, t.providerCreatedAt),
]);

export const providerWebhookEvents = pgTable('provider_webhook_events', {
  id: id(), orgId: org(), locationId: location(),
  providerConnectionId: uuid('provider_connection_id').notNull().references(() => providerConnections.id),
  providerEventId: text('provider_event_id').notNull(), eventType: text('event_type').notNull(),
  payloadSha256: text('payload_sha256').notNull(), payload: jsonb('payload').notNull(),
  signatureVerified: boolean('signature_verified').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  processingStatus: text('processing_status').notNull().default('pending'), errorCode: text('error_code'),
  replayCount: integer('replay_count').notNull().default(0),
}, (t) => [uniqueIndex('provider_webhook_events_provider_connection_id_provider_event_id_key')
  .on(t.providerConnectionId, t.providerEventId)]);

export const payrollBatches = pgTable('payroll_batches', {
  id: id(), orgId: org(), locationId: location(), periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(), status: text('status').notNull().default('draft'),
  providerConnectionId: uuid('provider_connection_id').references(() => providerConnections.id),
  providerBatchId: text('provider_batch_id'), approvedBy: uuid('approved_by').references(() => memberships.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }), paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('payroll_batches_location_id_period_start_period_end_key')
  .on(t.locationId, t.periodStart, t.periodEnd)]);

export const payrollBatchItems = pgTable('payroll_batch_items', {
  id: id(), orgId: org(), locationId: location(),
  payrollBatchId: uuid('payroll_batch_id').notNull().references(() => payrollBatches.id),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  baseSalaryCents: integer('base_salary_cents').notNull().default(0),
  serviceSalesCents: integer('service_sales_cents').notNull().default(0),
  serviceCommissionCents: integer('service_commission_cents').notNull().default(0),
  retailSalesCents: integer('retail_sales_cents').notNull().default(0),
  retailCommissionCents: integer('retail_commission_cents').notNull().default(0),
  cardTipsCents: integer('card_tips_cents').notNull().default(0),
  bonusCents: integer('bonus_cents').notNull().default(0),
  deductionsCents: integer('deductions_cents').notNull().default(0), netPayCents: integer('net_pay_cents').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('payroll_batch_items_payroll_batch_id_membership_id_key').on(t.payrollBatchId, t.membershipId),
  index('payroll_batch_items_member_idx').on(t.locationId, t.membershipId, t.payrollBatchId),
]);

export const aiBusinessSummaries = pgTable('ai_business_summaries', {
  id: id(), orgId: org(), locationId: location(), periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(), generator: text('generator').notNull(),
  generatorVersion: text('generator_version').notNull(), inputFactsSha256: text('input_facts_sha256').notNull(),
  inputRecordCount: integer('input_record_count').notNull(), content: jsonb('content').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ai_business_summaries_recent_idx').on(t.locationId, t.generatedAt)]);
