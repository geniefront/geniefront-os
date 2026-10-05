/**
 * 营销体系数据模型（次卡套餐 / 优惠券 / 预付资产）
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, index, uniqueIndex,customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const unitRange=customType<{data:string;driverData:string}>({dataType:()=> 'int4multirange'});
import { organizations, locations } from './tenancy';
import { customers } from './scheduling';
import { tickets } from './tickets';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

export const packageTemplates = pgTable('package_templates', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  name: jsonb('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  sessions: integer('sessions').notNull().default(1),
  serviceIds: uuid('service_ids').array().notNull().default(sql`'{}'::uuid[]`),
  validDays: integer('valid_days'),
  scope: text('scope').notNull().default('location'),
  onlineSale: boolean('online_sale').notNull().default(false),
  coverageMode: text('coverage_mode'),
  commissionBasis: text('commission_basis'),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('package_tpl_org_idx').on(t.orgId, t.locationId),
]);

export const customerPackages = pgTable('customer_packages', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  templateId: uuid('template_id').references(() => packageTemplates.id),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  remainingSessions: integer('remaining_sessions').notNull(),
  purchaseOrderId: uuid('purchase_order_id').unique(),
  purchaseSnapshot: jsonb('purchase_snapshot'),
  reservedSessions: integer('reserved_sessions').notNull().default(0),
  refundFrozen: boolean('refund_frozen').notNull().default(false),
  commerceFrozen: boolean('commerce_frozen').notNull().default(false),
  availableUnits:unitRange('available_units').notNull().default(sql`'{}'::int4multirange`),
  totalSessions: integer('total_sessions').notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  soldTicketId: uuid('sold_ticket_id').references(() => tickets.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('cust_pkg_customer_idx').on(t.customerId, t.status),
  index('cust_pkg_org_idx').on(t.orgId, t.locationId),
]);

export const couponTemplates = pgTable('coupon_templates', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  code: text('code').notNull(),
  name: jsonb('name').notNull(),
  kind: text('kind').notNull(), // amount | percent
  discountCents: integer('discount_cents').notNull().default(0),
  percentBp: integer('percent_bp').notNull().default(0),
  minSpendCents: integer('min_spend_cents').notNull().default(0),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('coupon_tpl_code_uidx').on(t.locationId, t.code),
  index('coupon_tpl_org_idx').on(t.orgId, t.locationId, t.active),
]);
