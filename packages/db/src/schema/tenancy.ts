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
  /**
   * 门店官网调公开预约 API 用的标识（docs/13 §3）。
   *
   * ⚠️ **不是密钥** —— 它明文躺在官网的 JS 里，谁都看得到。安全不建立在它上面。
   * 形如 `pk_` + 24 位 hex，由 sql/0033 的触发器保证熵：短到能枚举时，
   * 有人可以扫出「哪些 key 是活的」批量骚扰所有门店，而不必先找到每家店的官网。
   */
  publicKey: text('public_key').notNull(),
  /**
   * 外部平台 id。开店向导用店名 + 邮编在 Yelp 搜到店时一并存下，
   * 之后抓评价、拉营业时间都靠它，不用每次再搜一遍（搜索是有配额的）。
   */
  yelpBusinessId: text('yelp_business_id'),
  googlePlaceId: text('google_place_id'),
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

/**
 * 一次自助开户（sql/0030）。
 *
 * ⭐ `checkoutSessionId` 唯一 —— 这是整条链路的幂等依据。Stripe 的 webhook
 * 是「至少一次」投递，重投必须返回**已经建好的那一家**：建出两家店的话，
 * 老板会看到两个空店铺而只有一个能用，他分不出是哪个。
 *
 * ⭐ `ownerEmail` 是这条链路上唯一的身份边界：收到激活邮件的人就是老板。
 * 比对在数据库函数里做（gf_signup_intent_for_user），比的是 auth.users 那一行。
 */
export const signupIntents = pgTable('signup_intents', {
  id: id(),
  checkoutSessionId: text('checkout_session_id').notNull().unique(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /** 全小写存。比对时不区分大小写 */
  ownerEmail: text('owner_email').notNull(),
  plan: text('plan').notNull(),
  /** 官网传来的 metadata 原样留档，含我们回退掉的字段（时区/业态/语言认不出时） */
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  provisionedAt: timestamp('provisioned_at', { withTimezone: true }).notNull().defaultNow(),
  /** 激活信只发一封。为空 = 从来没发出去过（客服可以人工补发） */
  activationEmailSentAt: timestamp('activation_email_sent_at', { withTimezone: true }),
  /** 一次性：认领过就不能再认领 */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedUserId: uuid('claimed_user_id'),
});

export const locationSubscriptions = pgTable('location_subscriptions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  plan: text('plan').notNull(),   // essential|growth（docs/11 §2 为准）
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

/**
 * 门店官网的域名白名单（sql/0033、docs/13 §3）。
 *
 * ⚠️ **这不是鉴权。** 它挡的是「别人的网站嵌一个我们的预约表单」，挡不住 curl。
 * 真正挡机器人的是 Turnstile + 限频 + 蜜罐。它的价值在于把一个
 * 公开 key 的使用面收回到老板自己的站点上。
 */
export const locationAllowedOrigins = pgTable('location_allowed_origins', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /** 规范形式：小写、含协议、不带路径、不带尾斜杠。如 https://lotusnails.com */
  origin: text('origin').notNull(),
  label: text('label'),
  createdAt: createdAt(),
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
