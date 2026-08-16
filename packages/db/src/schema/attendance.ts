/**
 * 考勤打卡（Phase 1c，02-DATA-MODEL §4）
 *
 * 打卡是**流水**不是状态：只记「谁在几点打了什么卡」，
 * 「现在是不是在岗」由重放流水得出。理由和轮牌用事件溯源一样 ——
 * 状态字段会和流水打架，而打架时没人说得清哪个对。
 *
 * ⚠️ 打卡记录是劳资纠纷里的证据，所以：
 *   · 只能补录不能删除（改动留痕：edited_by / edit_reason）
 *   · 前台代打卡必须记下**代打的人是谁**（Desk-Only 模式天天发生）
 */

import {
  pgTable, uuid, text, timestamp, date, index,
} from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();

export const timePunches = pgTable('time_punches', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  businessDate: date('business_date').notNull(),
  kind: text('kind').notNull(),          // clock_in|clock_out|break_start|break_end
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  /** pin = 技师自己输 PIN；desk = 前台代打；app = 已登录的技师端 */
  method: text('method').notNull().default('pin'),
  /** ⭐ 前台代打卡时记下操作人 —— 「谁替谁打的卡」是纠纷里第一个被问的问题 */
  onBehalfBy: uuid('on_behalf_by'),
  note: text('note'),
  editedBy: uuid('edited_by'),
  editReason: text('edit_reason'),
  ip: text('ip'),
}, (t) => [
  index('time_punches_day_idx').on(t.locationId, t.businessDate, t.membershipId),
  index('time_punches_staff_idx').on(t.membershipId, t.at),
]);
