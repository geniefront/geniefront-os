/**
 * 组织 / 门店 / 订阅（02-DATA-MODEL §1）
 *
 * 计费单位 = 门店。organizations 只是「同一个老板的店的分组」，
 * 单店老板在 UI 里完全看不到这个概念。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, time, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  ownerUserId: uuid('owner_user_id').notNull(),
  billingCustomerId: text('billing_customer_id'), // stripe cus_xxx
  /** 同一 org 内跨店共享什么。默认共享顾客，礼品卡/套餐默认不共享（财务归属会吵架）。 */
  sharing: jsonb('sharing').notNull().default(
    sql`'{"customers":true,"gift_cards":false,"packages":false,"staff":true}'::jsonb`,
  ),
  defaultLocale: text('default_locale').notNull().default('en'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locations = pgTable('locations', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: jsonb('name').notNull(),          // i18n
  slug: text('slug').notNull(),
  timezone: text('timezone').notNull(),   // IANA，如 America/New_York
  currency: text('currency').notNull().default('USD'),
  address: jsonb('address'),
  phone: text('phone'),
  businessHours: jsonb('business_hours').notNull().default(sql`'{}'::jsonb`),
  holidayCalendar: jsonb('holiday_calendar').notNull().default(sql`'[]'::jsonb`),
  /**
   * 营业日边界。足疗店开到凌晨 2:00，那一单要算「昨天」的营业日，
   * 否则日结和小费发放会被切成两天（00 §1.5.1 场景 6）。
   */
  businessDayCutoff: time('business_day_cutoff').notNull().default('03:00'),
  businessType: text('business_type').notNull(), // nail|massage|foot_spa|hair|lash|mixed
  publicKey: text('public_key').notNull(),
  /**
   * settings.capacity（01 §7.1）：
   *   { slot_minutes: 15, max_concurrent_per_slot: null, overbook: "warn" }
   *   max_concurrent_per_slot = null → 自动取该时段在岗且 is_bookable 的员工数
   */
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('trial'), // trial|active|past_due|suspended|closed
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('locations_org_idx').on(t.orgId),
]);

export const locationSubscriptions = pgTable('location_subscriptions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  plan: text('plan').notNull(),   // starter|pro
  status: text('status').notNull(),
  stripeSubscriptionItemId: text('stripe_subscription_item_id'),
  /** AI 电话是独立加购包，不含在 plan 里（04 §4.1：两种 AI 成本差 10–16 倍） */
  aiPhonePackEnabled: boolean('ai_phone_pack_enabled').notNull().default(false),
  trialEndsOn: timestamp('trial_ends_on', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAt: timestamp('cancel_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const locationFeatures = pgTable('location_features', {
  locationId: uuid('location_id').notNull().references(() => locations.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  key: text('key').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
});

/**
 * 用量计费。第一天就埋（04 §4）。
 * kind 分四种，ai_assist 与 ai_call_min 必须分开 —— 合成一个「额度」必被套利。
 */
export const usageEvents = pgTable('usage_events', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  kind: text('kind').notNull(), // email|sms|ai_assist|ai_call_min
  qty: integer('qty').notNull(),
  costCents: integer('cost_cents').notNull().default(0),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('usage_events_billing_idx').on(t.locationId, t.kind, t.at),
]);
