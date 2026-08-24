/**
 * 薪酬 / 收入 / 打烊日结 / 现金小费发放（Phase 1b）
 *
 * 这几张表回答的是老板每天关门前的三个问题：
 *   今天挣了多少？抽屉里的钱对不对？每个人该拿多少、发了没有？
 *
 * 设计上有一条贯穿的原则：**钱的结果在发生那一刻就落库，不靠事后重算**。
 * 提成规则、小费策略都会被改，改完再回头重算历史，技师当天看到的数字
 * 和月底工资单就会对不上 —— 那是最伤信任的一种 bug。
 * 所以 earnings 在结账那一刻写死，改规则只影响之后的单。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';
import { tickets } from './tickets';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ─────────────────────────────────────────────────────────────── 薪酬方案

/**
 * 薪酬方案。版本化，和 tip_policies 同一个道理：
 * 改规则不影响已经算过的单，结账时把版本号快照进 earnings。
 *
 * membership_id 为 null = 门店默认方案（新人进来自动套用）。
 */
export const compensationPlans = pgTable('compensation_plans', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  membershipId: uuid('membership_id').references(() => memberships.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  /** @gf/payroll 的 CompensationPlan：kind / rate_bp / category_rate_bp / hourly / base */
  config: jsonb('config').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  index('comp_plans_lookup_idx').on(t.locationId, t.membershipId, t.version),
]);

/**
 * 收入流水 —— 技师当日收入看板与工资单的唯一数据源。
 *
 * 每一行都指向它的来源（哪张单、哪条规则），技师质疑时能一路查到底。
 * 作废单据时同 ticket_id 的行一并删除，否则当日收入会虚高。
 */
export const earnings = pgTable('earnings', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  businessDate: date('business_date').notNull(),
  /** commission | tip_cash | tip_card | hourly | adjustment */
  kind: text('kind').notNull(),
  amountCents: integer('amount_cents').notNull(),
  /** 提成基数（认到的营业额）。tip 行为 0 */
  baseCents: integer('base_cents').notNull().default(0),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  /** 可读依据，和小费的 basis 一样是给技师看的 */
  basis: jsonb('basis').notNull().default(sql`'{}'::jsonb`),
  planVersion: integer('plan_version'),
  /** 作废时冲销而不是删除，与 tip_allocations 同一条纪律（宪法第 9 条） */
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedBy: uuid('reversed_by'),
  createdAt: createdAt(),
}, (t) => [
  index('earnings_day_idx').on(t.locationId, t.businessDate, t.membershipId),
  index('earnings_ticket_idx').on(t.ticketId),
]);

// ─────────────────────────────────────────────────────────────── 打烊日结

/**
 * 一天一条。正常路径：open → counted → closed。
 *
 * 决策 19 说不逼老板记零钱流水，所以这张表里除了「点了多少」之外
 * **所有字段都可以留空**：只想知道抽屉里对不对的店，填一个数就能收工。
 *
 * ⭐ 另外三个是**断档终态**（2026-08-20 补）。它们回答的是同一个问题：
 * 「那天系统里什么都没有，是店没开，还是没人记？」
 *
 * 没有这三个状态的话，这三种情况在库里长得一模一样，而它们的含义天差地别：
 *
 *   no_business  —— 那天没营业。报表里是**真实的 0**，进平均值不失真。
 *   paper_only   —— 那天开着门，用纸记的，不补了。报表里是**空白**，
 *                   合计不含它。这不是错误，是一条诚实的记录。
 *   summary_only —— 那天用纸记的，补了个总数进来（backfill* 那几列）。
 *                   营业额对得上，**但提成和小费分配算不出来** ——
 *                   系统不知道哪一单是谁做的，别假装知道。
 *
 * 三个都是**终态**：标完就不再进「没记完的日子」提醒。给「不补」一条
 * 体面的出路，比让横幅一直挂着重要 —— 挂久了前台学会的是无视所有横幅。
 */
export const dayCloses = pgTable('day_closes', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  /** open|counted|closed ｜ no_business|paper_only|summary_only */
  status: text('status').notNull().default('open'),

  /** 早上抽屉里的备用金 */
  openingFloatCents: integer('opening_float_cents').notNull().default(0),
  /** 留给明天的备用金 */
  closingFloatCents: integer('closing_float_cents').notNull().default(0),

  /** 点钞：面额 → 张数。{"10000":3,"2000":7,...} */
  countBreakdown: jsonb('count_breakdown').notNull().default(sql`'{}'::jsonb`),
  countedCashCents: integer('counted_cash_cents'),
  /** 系统算出的应有现金（含备用金与现金进出） */
  expectedCashCents: integer('expected_cash_cents'),
  cashVarianceCents: integer('cash_variance_cents'),
  cashVarianceReason: text('cash_variance_reason'),

  /** 刷卡机打出来的 batch total（含小费） */
  cardTerminalCents: integer('card_terminal_cents'),
  cardExpectedCents: integer('card_expected_cents'),
  cardVarianceCents: integer('card_variance_cents'),
  cardVarianceReason: text('card_variance_reason'),

  /** 当日营业额快照，封账时写死，报表跑历史不用重算 */
  grossCents: integer('gross_cents'),
  discountCents: integer('discount_cents'),
  netCents: integer('net_cents'),
  taxCents: integer('tax_cents'),
  tipCashCents: integer('tip_cash_cents'),
  tipCardCents: integer('tip_card_cents'),

  /**
   * ⭐ 补录进来的总数（status = 'summary_only' 时才有值）。
   *
   * 故意跟上面那组 gross/net/tax 快照**分开存**，不共用列：
   * 那一组是封账时从真实工单算出来的，这一组是人照着纸本子敲的。
   * 混在一列里，第二年查账的人就再也分不清哪个数背后有单据。
   */
  backfillGrossCents: integer('backfill_gross_cents'),
  backfillCashCents: integer('backfill_cash_cents'),
  backfillCardCents: integer('backfill_card_cents'),
  backfillTipCashCents: integer('backfill_tip_cash_cents'),
  backfillTipCardCents: integer('backfill_tip_card_cents'),
  /** 断档终态的说明：「Lily 请假，我用本子记的」「下雪关门」 */
  gapNote: text('gap_note'),
  markedBy: uuid('marked_by'),
  markedAt: timestamp('marked_at', { withTimezone: true }),

  note: text('note'),
  countedBy: uuid('counted_by'),
  countedAt: timestamp('counted_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('day_closes_unique').on(t.locationId, t.businessDate),
]);

/**
 * 现金进出。**全部可选**（决策 19：不逼老板记琐碎流水），
 * 但填了就一定进期望现金的计算 —— 填了却不算，比不填更容易对不上。
 *
 * amount 正 = 进抽屉，负 = 出抽屉。
 */
export const cashMovements = pgTable('cash_movements', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  /** opening_float|cash_drop|supply_purchase|tip_payout|payout_owner|other */
  kind: text('kind').notNull(),
  amountCents: integer('amount_cents').notNull(),
  note: text('note'),
  /** tip_payout 类型由发放流程自动产生，指回那条发放记录 */
  tipPayoutId: uuid('tip_payout_id'),
  actorId: uuid('actor_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('cash_movements_day_idx').on(t.locationId, t.businessDate, t.at),
]);

/**
 * ⭐ 现金小费发放。老板逐人数钞票、确认入账。
 *
 * owed = 今日现金小费 + 昨日结转；paid = 实际数出去的钞票；
 * carry_out = 发不出的零头，明天一起给。
 * 老板手里没有硬币，欠 $37.60 就是给 $37 记着六毛 —— 以前记在本子上。
 */
export const tipPayouts = pgTable('tip_payouts', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  owedCents: integer('owed_cents').notNull(),
  paidCents: integer('paid_cents').notNull(),
  carryInCents: integer('carry_in_cents').notNull().default(0),
  carryOutCents: integer('carry_out_cents').notNull().default(0),
  /** 数了哪些面额，事后有人质疑时能还原当时的动作 */
  bills: jsonb('bills').notNull().default(sql`'{}'::jsonb`),
  /** 技师当面确认收到 —— Desk-Only 模式下由前台代点，Phase 1c 技师端自签 */
  acknowledged: boolean('acknowledged').notNull().default(false),
  note: text('note'),
  paidBy: uuid('paid_by'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('tip_payouts_unique').on(t.locationId, t.businessDate, t.membershipId),
  index('tip_payouts_staff_idx').on(t.locationId, t.membershipId, t.businessDate),
]);
