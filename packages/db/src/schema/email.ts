/**
 * 邮件发件箱（sql/0029）。
 *
 * 三种邮件：预约确认、收据、平台通知。都是「一家店一天几封、
 * 晚一秒没人在意、由某个刚发生的动作触发」—— **一张表就够，不引队列**。
 *
 * ⭐ 写在业务事务里，发在事务外。在事务里发的话，事务回滚了但邮件
 * 已经飞出去了：客人收到「您的预约已确认」，而库里根本没有这条预约。
 * 邮件和扣款一样收不回来。
 */

import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';
import {giftCards} from './giftcard';
import {commerceOrders} from './commerce';

export const emailOutbox = pgTable('email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').references(() => locations.id),
  /** appointment_confirm | appointment_changed | receipt | platform_notice */
  kind: text('kind').notNull(),
  toEmail: text('to_email').notNull(),
  subject: text('subject').notNull(),
  /** ⭐ 写入时就渲染好。发的时候数据可能已经变了，那样发出去的内容和当时的事实对不上 */
  bodyHtml: text('body_html').notNull(),
  bodyText: text('body_text').notNull(),
  /** 幂等键：同一件事只发一封。重复的确认信会让客人以为自己订了两次 */
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  commerceOrderId:uuid('commerce_order_id').references(()=>commerceOrders.id),
  commerceGiftCardId:uuid('commerce_gift_card_id').references(()=>giftCards.id),
  commerceCredentialVersion:integer('commerce_credential_version'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  providerId: text('provider_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('email_outbox_dedupe').on(t.entityType, t.entityId, t.kind),
  index('email_outbox_pending').on(t.locationId, t.createdAt),
]);
