/**
 * 折扣明细 + 通知模板（sql/0044，批 7）
 *
 * 两块互不相干，放一个文件是因为它们都是「解锁性的地基」：
 * 前者解锁「退款+折扣漏损率」这个指标，后者解锁技师侧那四条通知。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';
import { tickets, ticketItems } from './tickets';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

export const discountReasons = pgTable('discount_reasons', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  label: jsonb('label').notNull(),
  /**
   * ⭐ 超过这个金额要授权。null = 不限。
   *
   * 前台自己能批多少是个真实的管理问题：不设限的话一个新前台可以整天
   * 给人打五折；设死了她每次都要去找老板。所以由老板按原因分别设。
   */
  maxSelfApproveCents: integer('max_self_approve_cents'),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
});

/**
 * 每一笔折扣的明细。
 *
 * ⭐ 华人店的折扣是**前台口头给的、现场给的** —— 老熟客说一句
 * 「今天给我便宜十块」，前台就按了。月底老板看到 `day_closes.discount_cents`
 * 一个总数，但不知道那是二十个十块还是两个一百块，也不知道是谁批的。
 */
export const ticketDiscounts = pgTable('ticket_discounts', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  /** 挂在哪一项上。null = 整单折扣 */
  ticketItemId: uuid('ticket_item_id').references(() => ticketItems.id, { onDelete: 'cascade' }),
  reasonId: uuid('reason_id').references(() => discountReasons.id),
  reasonText: text('reason_text'),
  /** amount | percent */
  kind: text('kind').notNull(),
  /**
   * ⚠️ 无论 kind 是什么，这一列都是**折算之后的实际金额**。
   * 报表和日结只读它，不需要每次再算一遍百分比。
   */
  amountCents: integer('amount_cents').notNull(),
  /** 只是留痕，说明当初是按几折给的 */
  percentBp: integer('percent_bp'),
  /** ⚠️ 不可空 —— 「不知道是谁批的」正是这张表要消灭的东西 */
  grantedBy: uuid('granted_by').notNull().references(() => memberships.id),
  /** 超额时是谁批的。null = 在自助额度内 */
  approvedBy: uuid('approved_by').references(() => memberships.id),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedBy: uuid('reversed_by').references(() => memberships.id),
  createdAt: createdAt(),
}, (t) => [
  index('ticket_discounts_ticket_idx').on(t.ticketId),
]);

/**
 * 通知模板。
 *
 * ⭐ **版本化。** 改了模板之后，已经入队但还没发出去的消息必须用
 * **旧版本**渲染 —— 不然一条昨天生成的确认信会带上今天改的措辞，
 * 而 outbox 那一行本来就该是「那封信本身」（见 email/render.ts 文件头）。
 */
export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  /** 见 `NOTIFICATION_EVENTS`（packages/contracts） */
  eventKey: text('event_key').notNull(),
  channel: text('channel').notNull(),
  locale: text('locale').notNull().default('en'),
  version: integer('version').notNull().default(1),
  subject: text('subject'),
  body: text('body').notNull(),
  active: boolean('active').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => memberships.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('notif_tpl_uidx').on(t.locationId, t.eventKey, t.channel, t.locale, t.version),
]);

export const notificationRules = pgTable('notification_rules', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  eventKey: text('event_key').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** 延迟多少分钟。**负数 = 事件之前**（提醒类用，如 -1440 = 提前一天） */
  offsetMin: integer('offset_min').notNull().default(0),
  /** 走哪些渠道。空数组 = 这条规则关着 */
  channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
  updatedBy: uuid('updated_by').references(() => memberships.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('notif_rule_uidx').on(t.locationId, t.eventKey),
]);
