/**
 * 订阅码：Stripe 之外的第二条计费权威（sql/0120，计划 2026-09-09）
 *
 * ## 为什么需要
 *
 * 在此之前付费状态只有一个写入者：Stripe。而店家用微信 / 支付宝 / 现金
 * 私下付款是真实存在的一类客户 —— 钱已经收了，服务却开不出来。
 *
 * 这里加的不是「绕过闸门的后门」，而是把「唯一权威」扩成
 * **「每个门店恰好有一个计费权威」**：`billing_accounts.billing_source`
 * 取 `stripe` 或 `license`，两者互斥、可切换、切换有留档。
 *
 * ## 两条纪律
 *
 * 1. **明文码不落库。** 只存 `codeHash`（sha256）与可见前缀。它是「捡到就能用」
 *    的凭证，和 magic link 同一个量级 —— 库里、日志里、审计里都不出现明文。
 * 2. **额度包不引入新的余额概念。** 额度包码兑换 = 往 `credit_ledger` 追加
 *    一条 `kind='topup', source='license'`。对账逻辑一行都不用改。
 *
 * ⚠️ 这两张表**不开放给 `app_user`**（RLS enable + force，且没有 policy）。
 * 一切读写走 sql/0120 里的 SECURITY DEFINER 窄口 —— 未定向的码在签发那一刻
 * 还不属于任何租户，没有可隔离的列。
 */

import {
  pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { users } from './identity';
import { platformOperators } from './platform';

/** 一张码一行。撤销与兑换都不删行 —— 那是历史事实 */
export const licenseCodes = pgTable('license_codes', {
  id: uuid('id').primaryKey().defaultRandom(),

  /**
   * subscription  订阅码：买 `durationDays` 天的 `plan`
   * quota_pack    额度包码：加 `amount` 个 `unit`
   * store_open    开店码：运营直接建店 + 挂上订阅
   */
  kind: text('kind').notNull(),

  /** sha256(规范化明文)。⚠️ 明文永不落库 */
  codeHash: text('code_hash').notNull(),
  /** `GF-3F7K`。只给运营检索用，不足以推出明文 */
  codePrefix: text('code_prefix').notNull(),

  plan: text('plan'),
  durationDays: integer('duration_days'),

  /** credit | voice_minute。**两种额度不能互换**（决策 8），码上写死哪一种 */
  unit: text('unit'),
  amount: integer('amount'),

  /** 面值：私下收了多少钱。只做对账留档，不参与任何计算（宪法第 4 条） */
  amountCents: integer('amount_cents'),
  /** 收款说明。必填 —— 没有出处的码事后查不清 */
  paymentNote: text('payment_note').notNull(),

  /** 定向签发。空 = 任意门店可兑换 */
  targetOrgId: uuid('target_org_id').references(() => organizations.id),
  targetLocationId: uuid('target_location_id').references(() => locations.id),

  /**
   * **码本身**的可兑换截止时刻。
   *
   * ⚠️ 和订阅有效期是两件事：一张 30 天的订阅码可以在 90 天内的任何时候
   * 被兑换，兑换那一刻才开始算那 30 天。
   */
  validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  maxRedemptions: integer('max_redemptions').notNull().default(1),
  redeemedCount: integer('redeemed_count').notNull().default(0),

  /** active | redeemed | revoked */
  status: text('status').notNull().default('active'),

  issuedByOperatorId: uuid('issued_by_operator_id').notNull()
    .references(() => platformOperators.id),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),

  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByOperatorId: uuid('revoked_by_operator_id').references(() => platformOperators.id),
  revokeReason: text('revoke_reason'),
}, (t) => [
  uniqueIndex('license_codes_hash_key').on(t.codeHash),
  index('license_codes_status_idx').on(t.status, t.issuedAt),
  index('license_codes_prefix_idx').on(t.codePrefix),
]);

/**
 * 兑换事实 —— **只追加**（同 `creditLedger` 的纪律，sql/0120 有触发器封 delete）。
 *
 * `effect` 里记的是生效前后的 `billingSource / plan / periodEnd`，
 * 用来回答「这家店为什么能用到这一天」—— 而这正是客户会打电话来问的问题。
 */
export const licenseRedemptions = pgTable('license_redemptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeId: uuid('code_id').notNull().references(() => licenseCodes.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /** 谁兑的。运营代兑时是运营那个 user id */
  redeemedByUserId: uuid('redeemed_by_user_id').references(() => users.id),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
  effect: jsonb('effect').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  // 同一张码在同一家店只能生效一次。跨店的次数由 maxRedemptions 管
  uniqueIndex('license_redemption_once').on(t.codeId, t.locationId),
  index('license_redemptions_location_idx').on(t.locationId, t.redeemedAt),
]);
