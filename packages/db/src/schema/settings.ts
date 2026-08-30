/**
 * 门店与系统设置扩展表（收银/预约规则/知情声明/10DLC/Webhooks）
 */

import {
  pgTable, uuid, text, boolean, integer, timestamp, numeric,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { locations } from './tenancy';
import { memberships } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const locationCheckoutSettings = pgTable('location_checkout_settings', {
  locationId: uuid('location_id').primaryKey().references(() => locations.id, { onDelete: 'cascade' }),
  salesTaxRatePercent: numeric('sales_tax_rate_percent', { precision: 6, scale: 4 }).notNull().default('8.8750'),
  taxCalculationMode: text('tax_calculation_mode').notNull().default('exclusive'),
  suggestedTipPercentages: integer('suggested_tip_percentages').array().notNull().default(sql`'{15, 18, 20, 25}'::int[]`),
  allowCustomTip: boolean('allow_custom_tip').notNull().default(true),
  defaultCashFloatCents: integer('default_cash_float_cents').notNull().default(20000),
  receiptFooterMessage: text('receipt_footer_message'),
  autoPrintReceipt: boolean('auto_print_receipt').notNull().default(true),
  autoSendSmsReceipt: boolean('auto_send_sms_receipt').notNull().default(true),
  checkoutTiming: text('checkout_timing').notNull().default('after_service_combined'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locationSchedulingRules = pgTable('location_scheduling_rules', {
  locationId: uuid('location_id').primaryKey().references(() => locations.id, { onDelete: 'cascade' }),
  slotIntervalMinutes: integer('slot_interval_minutes').notNull().default(30),
  cancelCutoffHours: integer('cancel_cutoff_hours').notNull().default(4),
  depositRequired: boolean('deposit_required').notNull().default(false),
  depositAmountCents: integer('deposit_amount_cents').notNull().default(2000),
  allowClientPickStaff: boolean('allow_client_pick_staff').notNull().default(true),
  requireCardOnFile: boolean('require_card_on_file').notNull().default(false),
  cancellationPolicyNotice: text('cancellation_policy_notice'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locationIntakeTemplates = pgTable('location_intake_templates', {
  locationId: uuid('location_id').primaryKey().references(() => locations.id, { onDelete: 'cascade' }),
  waiverTitle: text('waiver_title').notNull().default('顾客服务知情同意书与健康声明'),
  waiverContent: text('waiver_content'),
  requireSignature: boolean('require_signature').notNull().default(true),
  requireHealthAllergies: boolean('require_health_allergies').notNull().default(true),
  requirePressurePreference: boolean('require_pressure_preference').notNull().default(true),
  requireBodySorenessMap: boolean('require_body_soreness_map').notNull().default(true),
  autoCreateCrmProfile: boolean('auto_create_crm_profile').notNull().default(true),
  autoPromptTipPercentages: boolean('auto_prompt_tip_percentages').notNull().default(true),
  autoSyncToProfile: boolean('auto_sync_to_profile').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const location10DlcRegistrations = pgTable('location_10dlc_registrations', {
  locationId: uuid('location_id').primaryKey().references(() => locations.id, { onDelete: 'cascade' }),
  // Internal GenieFront review: not_submitted | pending_review | approved | rejected
  status: text('status').notNull().default('not_submitted'),
  legalBusinessName: text('legal_business_name'),
  ein: text('ein'),
  businessStructure: text('business_structure').notNull().default('llc'),
  registeredAddress: text('registered_address'),
  repName: text('rep_name'),
  repTitle: text('rep_title'),
  repEmail: text('rep_email'),
  repPhone: text('rep_phone'),
  optInMethod: text('opt_in_method'),
  sampleMessage1: text('sample_message_1'),
  sampleMessage2: text('sample_message_2'),
  sampleMessages: text('sample_messages').array().notNull().default(sql`'{}'::text[]`),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedByMembershipId: uuid('submitted_by_membership_id').references(() => memberships.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locationWebhooks = pgTable('location_webhooks', {
  id: id(),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  events: text('events').array().notNull().default(sql`'{booking.created, ticket.paid}'::text[]`),
  active: boolean('active').notNull().default(true),
  secret: text('secret'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
