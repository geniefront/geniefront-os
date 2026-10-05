/**
 * 礼品卡与客人预付资产的统一账本（02-DATA-MODEL、sql/0043，批 5）
 *
 * ⭐ **一张账本装四种东西。** 这一批只做礼品卡，但积分 / 次卡套餐 /
 * 优惠券和它共用同一套记账：客人预付了钱或权益，之后一点一点核销。
 * 四条线各建一张账本的话，「这个客人手里一共有多少」要 union 四张表，
 * 而日结要把四张表分别对一遍 —— 而它们的对账规则一模一样。
 *
 * ⭐ **面值 ≠ 售价。** 买 $100 的卡付 $80 是这行最常见的促销：
 * 卖出那一刻负债 +$100 营收 +$0；核销 $30 时负债 −$30 营收 +$30。
 * 把面值当营收记的话，卖了一万块卡的店会以为自己赚了一万，
 * 而那一万里有一部分是明年才要付出的服务。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, index, uniqueIndex, bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { customers } from './scheduling';
import { memberships } from './identity';
import { tickets } from './tickets';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

export const giftCardTemplates = pgTable('gift_card_templates', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  name: jsonb('name').notNull(),
  /** 卡里有多少钱 */
  faceValueCents: integer('face_value_cents').notNull(),
  /** 客人付多少钱。可以等于面值（不打折） */
  salePriceCents: integer('sale_price_cents').notNull(),
  /**
   * 多少天后过期。null = 永不过期。
   *
   * ⚠️ 美国多数州禁止礼品卡在 5 年内过期，有的州完全禁止。
   * 我们不替店家判法律，但**默认 null 是唯一安全的默认值**。
   */
  validDays: integer('valid_days'),
  /** `location`（只能在售出店用，默认）/ `org`（同 org 任意店） */
  scope: text('scope').notNull().default('location'),
  onlineSale: boolean('online_sale').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const giftCards = pgTable('gift_cards', {
  id: id(),
  orgId: orgCol(),
  /** ⚠️ **售出**门店，不是「只能在这里用」。能在哪用看 `scope` */
  locationId: locCol(),
  templateId: uuid('template_id').references(() => giftCardTemplates.id),
  /**
   * 卡号。⚠️ **不可自增、不可按时间生成。**
   *
   * 能猜的卡号等于把店里的钱放在门口 —— 拿到一张卡的人试相邻几个号
   * 就能刷别人的余额。应用生成 22 位 base32，数据库只保证唯一。
   */
  code: text('code').notNull(),
  faceValueCents: integer('face_value_cents').notNull(),
  salePriceCents: integer('sale_price_cents').notNull(),
  /**
   * ⚠️ **余额是账本推出来的缓存，不是事实源。**
   * 事实源是 `customer_credit_ledger` 的求和；这一列只为了前台刷卡时
   * 不用每次扫全表。对不上时以账本为准（同 `billing_accounts`）。
   */
  balanceCents: integer('balance_cents').notNull(),
  purchaseOrderId: uuid('purchase_order_id').unique(),
  purchaseSnapshot: jsonb('purchase_snapshot'),
  reservedCents: integer('reserved_cents').notNull().default(0),
  commerceFrozen: boolean('commerce_frozen').notNull().default(false),
  credentialDisabled: boolean('credential_disabled').notNull().default(false),
  credentialVersion: integer('credential_version').notNull().default(1),
  scope: text('scope').notNull().default('location'),
  purchaserCustomerId: uuid('purchaser_customer_id').references(() => customers.id),
  holderCustomerId: uuid('holder_customer_id').references(() => customers.id),
  recipientName: text('recipient_name'),
  recipientNote: text('recipient_note'),
  /** front_desk | online | bulk | auto（生日/节日自动赠送） */
  source: text('source').notNull().default('front_desk'),
  /** active | depleted | expired | void */
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  soldTicketId: uuid('sold_ticket_id').references(() => tickets.id),
  issuedBy: uuid('issued_by').references(() => memberships.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('gift_cards_code_uidx').on(t.code),
  index('gift_cards_org_active_idx').on(t.orgId, t.status),
]);

/**
 * ⭐ 客人预付资产的统一账本。**只追加，永不 UPDATE、永不 DELETE**
 * （宪法第 9 条；数据库有触发器兜底）。
 */
export const customerCreditLedger = pgTable('customer_credit_ledger', {
  id: id(),
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  orgId: orgCol(),
  /**
   * ⭐ **发生这笔账的门店**，不一定等于卡的售出门店。
   *
   * org 范围的卡在 A 店卖、B 店核销：售出行的 location 是 A，
   * 核销行的是 B。两家店的日结各取各的行，负债从 A 挪到 B 的收入 ——
   * 这一列现在不记，以后补不出来。
   */
  locationId: locCol(),
  /** gift_card | package | points | coupon | store_credit */
  kind: text('kind').notNull().default('gift_card'),
  /** 指向具体那张卡 / 那份套餐 */
  subjectId: uuid('subject_id').notNull(),
  customerId: uuid('customer_id').references(() => customers.id),
  /** issue | redeem | refund | adjust | expire */
  entry: text('entry').notNull(),
  /** ⚠️ 有符号：issue 为正，redeem 为负。求和 = 当前余额 */
  amountCents: integer('amount_cents').notNull(),
  unit: text('unit').generatedAlwaysAs(sql`case when kind = 'points' then 'points'
    when kind = 'package' and entry = 'issue' then 'cents'
    when kind = 'package' and entry in ('redeem','refund') then 'sessions'
    when kind = 'package' then 'unknown' else 'cents' end`),
  balanceAfterCents: integer('balance_after_cents').notNull(),
  ticketId: uuid('ticket_id').references(() => tickets.id),
  /** 冲销指向被冲的那一行 */
  reversalOfId: uuid('reversal_of_id'),
  reason: text('reason'),
  actorMembershipId: uuid('actor_membership_id').references(() => memberships.id),
  /** 幂等键。前台手抖点两次不能扣两次 */
  idemKey: text('idem_key'),
  meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (t) => [
  index('ccl_subject_idx').on(t.kind, t.subjectId, t.seq),
  index('ccl_location_day_idx').on(t.locationId, t.createdAt),
]);
