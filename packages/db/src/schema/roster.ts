/**
 * 排班：周模板 + 具体班次（Phase 1b）
 *
 * ⚠️ 班次存**营业日 + 墙上分钟**，不是 timestamptz —— 理由写在
 * packages/scheduling/src/roster.ts 的文件头：班表是计划的墙上时间，
 * 烤成时刻会在 DST 那两天集体偏移一小时。
 * 需要真实时刻（算工时、算保底工资）时用 shiftRealMinutes() 现算。
 */

import {
  pgTable, uuid, text, integer, timestamp, date, boolean, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

/** 周模板：一周七天的常规班。前台按「铺开一周」把它变成具体班次 */
export const shiftTemplates = pgTable('shift_templates', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  /** 0 = 周日 */
  weekday: integer('weekday').notNull(),
  startMin: integer('start_min').notNull(),
  /** 允许 > 1440 表示跨夜（足疗店 18:00–次日 02:00 = 1080 → 1560） */
  endMin: integer('end_min').notNull(),
  breakMin: integer('break_min').notNull().default(0),
  active: boolean('active').notNull().default(true),
}, (t) => [
  index('shift_templates_lookup_idx').on(t.locationId, t.weekday, t.active),
]);

/**
 * 具体班次。
 *
 * status: planned（草稿，只有前台看得到）→ published（技师可见）
 *       | off（请假/休息，保留一行是为了让「今天为什么没人」有出处）
 *
 * 一人一天一条：真店里没有「上午上班下午再来一趟」的排法，
 * 中间的空档是用 break_min 表达的。
 */
export const shifts = pgTable('shifts', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  businessDate: date('business_date').notNull(),
  startMin: integer('start_min').notNull(),
  endMin: integer('end_min').notNull(),
  breakMin: integer('break_min').notNull().default(0),
  status: text('status').notNull().default('planned'), // planned|published|off
  /** off 时的原因：sick|vacation|personal|store_closed|other */
  offReason: text('off_reason'),
  note: text('note'),
  /** 是否由模板一键铺出来的 —— 手工改过的班不会被下一次铺开冲掉 */
  fromTemplate: boolean('from_template').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedBy: uuid('updated_by'),
}, (t) => [
  uniqueIndex('shifts_unique').on(t.locationId, t.businessDate, t.membershipId),
  index('shifts_day_idx').on(t.locationId, t.businessDate, t.status),
]);
