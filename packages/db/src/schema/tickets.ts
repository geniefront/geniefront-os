/**
 * 服务单 / 收款 / 小费（02-DATA-MODEL §8–9）
 *
 * 决策 22：顾客付现金还是刷卡，往往要到结账那一刻才知道，
 * 所以「开单 → 加项 → 结账」这条链路不能跳。结账后两条出口：
 * 正常入账 或 作废（必选原因，记录保留但不计营业额）。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';
import { customers, services, appointments, resources } from './scheduling';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

/**
 * ⭐ 一组一起来的客人（02 §8.1）。
 *
 * 为什么不是「一张单多个客人」：提成、小费、轮牌全部按**人次**算，
 * 合成一张单之后就再也拆不回去了。所以每人各一张单，用 group 串起来，
 * 结账时可以合并收钱，也可以各付各的 —— 这两种在真店里天天切换，
 * 而且往往到掏钱那一刻才定（「我请客」是在结账台说的）。
 */
export const ticketGroups = pgTable('ticket_groups', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  /** 前台看得懂的名字：「Lisa 一行 4 位」 */
  label: text('label'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ticket_groups_day_idx').on(t.locationId, t.businessDate),
]);

export const tickets = pgTable('tickets', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  /** null = 单独来的客人。绝大多数单都是 null */
  groupId: uuid('group_id').references(() => ticketGroups.id),
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
  surchargeCents: integer('surcharge_cents').notNull().default(0),
  refundCents: integer('refund_cents').notNull().default(0),
  refundReason: text('refund_reason'),
  refundMethod: text('refund_method'),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  refundedBy: uuid('refunded_by').references(() => memberships.id),
}, (t) => [
  index('tickets_day_idx').on(t.locationId, t.businessDate, t.status),
  index('tickets_customer_idx').on(t.customerId),
  index('tickets_appointment_idx').on(t.appointmentId),
  index('tickets_group_idx').on(t.groupId),
  uniqueIndex('tickets_one_live_per_appointment_idx')
    .on(t.appointmentId)
    .where(sql`${t.appointmentId} is not null and ${t.status} <> 'voided'`),
]);

export const ticketItems = pgTable('ticket_items', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('service'), // service|addon|retail|fee
  serviceId: uuid('service_id').references(() => services.id),
  resourceId: uuid('resource_id').references(() => resources.id),
  nameSnapshot: text('name_snapshot').notNull(),
  qty: integer('qty').notNull().default(1),
  unitPriceCents: integer('unit_price_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull(),
  durationMin: integer('duration_min').notNull().default(0),
  seq: integer('seq').notNull().default(0),
  /**
   * ⭐ 技师点「开始 / 完成」的时刻（Phase 1c）。
   *
   * 不叫 status：一条 item 的状态就是这两个时间戳的函数
   * （都没有 = 等着做，有 started 没 finished = 在做，都有 = 做完）。
   * 多一个 status 列就多一处能和时间戳打架的地方。
   *
   * Desk-Only 的店由前台代点（宪法第 14 条），两条路走同一个命令。
   */
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  /** 落单要素快照：加钟改了力度、加了款式也在这（02 §3.1） */
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('ticket_items_ticket_idx').on(t.ticketId),
  index('ticket_items_service_idx').on(t.serviceId),
  index('ticket_items_resource_idx').on(t.resourceId),
]);

/** 双技师 / 接力：一条 item 可以关联多个技师，各记各的工时 */
export const ticketItemStaff = pgTable('ticket_item_staff', {
  id: id(),
  orgId: orgCol(),
  ticketItemId: uuid('ticket_item_id').notNull().references(() => ticketItems.id, { onDelete: 'cascade' }),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  role: text('role').notNull().default('primary'), // primary|assistant
  minutes: integer('minutes').notNull().default(0),
}, (t) => [
  index('ticket_item_staff_item_idx').on(t.ticketItemId),
]);

export const payments = pgTable('payments', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  /** 决策 19：只区分现金与刷卡，Zelle 按现金记 */
  method: text('method').notNull(),   // cash|card|external
  /** ⚠️ 含小费的收款总额（刷卡机小票上的那个数）。服务净额 = amount − tip */
  amountCents: integer('amount_cents').notNull(),
  tipCents: integer('tip_cents').notNull().default(0),
  /**
   * ⭐ 客人递过来多少现金。刷卡时为 null。
   * 记它是为了日结对得上：不记的话，「不用找了」的那几块钱会凭空出现在抽屉里。
   */
  tenderedCents: integer('tendered_cents'),
  /** 实际找出去多少 */
  changeCents: integer('change_cents').notNull().default(0),
  /** ⭐ 客人说「不用找了」—— 找零转成小费。true 时 change 必为 0 */
  keepChange: boolean('keep_change').notNull().default(false),
  /**
   * ⭐ 一笔钱付了一组单时，同一次收款在每张单上各留一行，共用这个 id。
   * 保留 ticket_id 而不是让 payment 指向 group：这样报表、提成、日结
   * 全都不用改口径，「谁付的」只是多一层引用。
   */
  groupPaymentId: uuid('group_payment_id'),
  /** 组单里实际掏钱的那张单（= 掏钱那个人）。前台事后想问「谁付的」看这个 */
  payerTicketId: uuid('payer_ticket_id'),
  processorRef: text('processor_ref'),
  terminalRef: text('terminal_ref'),
  takenBy: uuid('taken_by'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('payments_day_idx').on(t.locationId, t.at),
  index('payments_group_idx').on(t.groupPaymentId),
]);

/**
 * 退款逐笔账本。tickets.refund_cents 只是累计快照；渠道、构成和操作者以这里为准。
 * 迁移层对本表启用 FORCE RLS，并用 REVOKE + trigger 强制只追加。
 */
export const ticketRefunds = pgTable('ticket_refunds', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id),
  businessDate: date('business_date').notNull(),
  amountCents: integer('amount_cents').notNull(),
  serviceCents: integer('service_cents').notNull().default(0),
  taxCents: integer('tax_cents').notNull().default(0),
  feeCents: integer('fee_cents').notNull().default(0),
  tipCents: integer('tip_cents').notNull().default(0),
  cashCents: integer('cash_cents').notNull().default(0),
  cardCents: integer('card_cents').notNull().default(0),
  giftCardCents: integer('gift_card_cents').notNull().default(0),
  customerCreditCents: integer('customer_credit_cents').notNull().default(0),
  method: text('method').notNull(),
  reason: text('reason').notNull(),
  notes: text('notes'),
  refundedBy: uuid('refunded_by').references(() => memberships.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ticket_refunds_ticket_idx').on(t.ticketId),
  index('ticket_refunds_tenant_idx').on(t.orgId, t.locationId),
  index('ticket_refunds_actor_idx').on(t.refundedBy),
  index('ticket_refunds_day_idx').on(t.locationId, t.businessDate, t.createdAt),
]);

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
  /**
   * ⭐ 作废单据时**冲销而不是删除**（宪法第 9 条）。
   *
   * 原来的实现是 `delete from tip_allocations` —— 两个问题：
   * 财务记录不该消失，而且 0005 已经对 app_user 撤销了这张表的 DELETE 权限，
   * 于是「作废一张已经分过小费的单」在生产上会直接报权限错。
   * （作废通常发生在结账前，那时还没有分配行，所以一直没被撞见。）
   */
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedBy: uuid('reversed_by'),
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

/** Per-visit notes. Visibility is enforced by API scope in addition to tenant RLS. */
export const ticketServiceNotes = pgTable('ticket_service_notes', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketItemId: uuid('ticket_item_id').notNull().references(() => ticketItems.id),
  authorMembershipId: uuid('author_membership_id').notNull().references(() => memberships.id),
  visibility: text('visibility').notNull().default('management'),
  content: text('content').notNull(),
  containsSensitiveData: boolean('contains_sensitive_data').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ticket_service_notes_ticket_item_id_author_membership_id_key')
    .on(t.ticketItemId, t.authorMembershipId),
  index('ticket_service_notes_item_idx').on(t.ticketItemId),
  index('ticket_service_notes_author_idx').on(t.authorMembershipId, t.createdAt),
]);

/** Transactional room occupancy and cleaning lifecycle for a service item. */
export const resourceOccupancies = pgTable('resource_occupancies', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  resourceId: uuid('resource_id').notNull().references(() => resources.id),
  ticketItemId: uuid('ticket_item_id').notNull().references(() => ticketItems.id),
  status: text('status').notNull(),
  occupiedAt: timestamp('occupied_at', { withTimezone: true }).notNull().defaultNow(),
  cleaningStartedAt: timestamp('cleaning_started_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  updatedBy: uuid('updated_by').references(() => memberships.id),
}, (t) => [
  uniqueIndex('resource_occupancies_ticket_item_id_resource_id_key')
    .on(t.ticketItemId, t.resourceId),
  index('resource_occupancies_active_idx').on(t.resourceId, t.status)
    .where(sql`${t.status} <> 'released'`),
]);
