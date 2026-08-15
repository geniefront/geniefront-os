/**
 * 服务单 / 收款 / 小费（02-DATA-MODEL §8–9）
 *
 * 决策 22：顾客付现金还是刷卡，往往要到结账那一刻才知道，
 * 所以「开单 → 加项 → 结账」这条链路不能跳。结账后两条出口：
 * 正常入账 或 作废（必选原因，记录保留但不计营业额）。
 */

import {
  pgTable, uuid, text, jsonb, integer, timestamp, date, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';
import { customers, services, appointments } from './scheduling';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

export const tickets = pgTable('tickets', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  customerId: uuid('customer_id').references(() => customers.id),
  walkInName: text('walk_in_name'),
  appointmentId: uuid('appointment_id').references(() => appointments.id),
  status: text('status').notNull().default('open'), // open|in_service|ready_to_pay|closed|voided
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  openedBy: uuid('opened_by'),
  closedBy: uuid('closed_by'),
  subtotalCents: integer('subtotal_cents').notNull().default(0),
  discountCents: integer('discount_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  /** ⚠️ tip 与 service_charge 法律上是两回事，永不混用（00 §3.2） */
  tipCents: integer('tip_cents').notNull().default(0),
  serviceChargeCents: integer('service_charge_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull().default(0),
  tipPolicyVersion: integer('tip_policy_version'),
  voidReason: text('void_reason'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: uuid('voided_by'),
  voidNote: text('void_note'),
}, (t) => [
  index('tickets_day_idx').on(t.locationId, t.businessDate, t.status),
]);

export const ticketItems = pgTable('ticket_items', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('service'), // service|addon|retail|fee
  serviceId: uuid('service_id').references(() => services.id),
  nameSnapshot: text('name_snapshot').notNull(),
  qty: integer('qty').notNull().default(1),
  unitPriceCents: integer('unit_price_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull(),
  durationMin: integer('duration_min').notNull().default(0),
  seq: integer('seq').notNull().default(0),
  /** 落单要素快照：加钟改了力度、加了款式也在这（02 §3.1） */
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
}, (t) => [index('ticket_items_ticket_idx').on(t.ticketId)]);

/** 双技师 / 接力：一条 item 可以关联多个技师，各记各的工时 */
export const ticketItemStaff = pgTable('ticket_item_staff', {
  id: id(),
  orgId: orgCol(),
  ticketItemId: uuid('ticket_item_id').notNull().references(() => ticketItems.id, { onDelete: 'cascade' }),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  role: text('role').notNull().default('primary'), // primary|assistant
  minutes: integer('minutes').notNull().default(0),
});

export const payments = pgTable('payments', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  /** 决策 19：只区分现金与刷卡，Zelle 按现金记 */
  method: text('method').notNull(),   // cash|card|external
  amountCents: integer('amount_cents').notNull(),
  tipCents: integer('tip_cents').notNull().default(0),
  processorRef: text('processor_ref'),
  terminalRef: text('terminal_ref'),
  takenBy: uuid('taken_by'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const tipAllocations = pgTable('tip_allocations', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  amountCents: integer('amount_cents').notNull(),
  /** 可读的计算依据 —— 技师质疑时直接展示（01 §9） */
  basis: jsonb('basis').notNull(),
  /** 现金当天发，刷卡进工资，两者分开统计 */
  source: text('source').notNull(),   // cash|card
  policyVersion: integer('policy_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('tip_allocations_staff_idx').on(t.locationId, t.membershipId, t.createdAt)]);

/** 小费策略：版本化。改规则不影响历史单据 —— 结账时把版本快照进 ticket */
export const tipPolicies = pgTable('tip_policies', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  version: integer('version').notNull().default(1),
  config: jsonb('config').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
});
