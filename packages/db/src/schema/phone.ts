/**
 * AI 电话接单（09-TELNYX §4，决策 6）
 *
 * ⭐ **最重要的一条设计**：AI 电话**不建预约**，它只往一个复核队列里放草案。
 *
 * 一开始的想法是让 AI 直接建 `appointments(status='pending_review')`。
 * 那样做有一个不明显但要命的后果：**AI 建的东西会占住日程表上的位置**。
 * 一通没听清的电话就能把周六下午卡掉一格，而前台要到复核时才发现。
 * 更糟的是 webhook 一旦被人伪造（或者 Telnyx 那边重放），
 * 攻击面直接落在真实的排期数据上。
 *
 * 所以改成：AI 只能往 `call_drafts` 里写，**这张表和排期完全不相干**。
 * 前台点「确认」时，走的是**前台自己身份下**的 `appointment.create` ——
 * 容量检查、软约束放行、审计，全部按前台手工建单那条路走一遍。
 *
 * 这样一来，就算验签整个被绕过，攻击者能做到的最坏情况也只是
 * 「往某家店的待办列表里塞垃圾」，而不是改动任何真实预约。
 */

import {
  pgTable, uuid, text, jsonb, integer, boolean, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';
import { customers, services, appointments } from './scheduling';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * 号码 → 门店。
 *
 * webhook 打进来只带「谁打的」和「打给谁」，没有租户上下文 ——
 * **被叫号码是我们唯一能用来定位门店的东西**，所以它必须是一张真表，
 * 而不是塞在 `locations.phone` 里凑合：一家店会有主线、AI 线、
 * 以后还有短信线，混成一个字段之后就再也分不清哪条是哪条了。
 *
 * `e164` 全局唯一：同一个号码不可能同时属于两家店，
 * 而这个约束漏掉的后果是 webhook 随机落到其中一家 —— 无从复现的串店。
 */
export const phoneLines = pgTable('phone_lines', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  e164: text('e164').notNull(),
  /** telnyx —— twilio 是历史回退路径，已否决（09） */
  provider: text('provider').notNull().default('telnyx'),
  /**
   * ai_voice | main | sms | transfer_target
   *
   * 分两类，这个区分决定了约束和 RLS 策略（sql/0025）：
   *   · **会被反查的**（`ai_voice` / `sms`）—— webhook 拿着被叫号码来问
   *     「这是谁家的」。这类必须全局唯一，否则会串店。
   *   · **不反查的**（`main` 店家对外公布的号 / `transfer_target` 人工客服号）——
   *     店家自己的号，我们只记录。**不能要求全局唯一**：人工客服号常常
   *     是老板的手机，而一个老板开两三家店在这行很普遍。
   */
  purpose: text('purpose').notNull().default('ai_voice'),
  /** Telnyx 那边的 assistant id。一家店一个，可以配不同开场白 */
  assistantId: text('assistant_id'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  // ⚠️ e164 的唯一性是**部分索引**，只覆盖会被反查的 purpose，
  // 和「一店一用途只留一条」一起写在 sql/0025 里（drizzle 这里表达不了 where）。
  index('phone_lines_loc_idx').on(t.locationId, t.purpose),
]);

/**
 * 一通电话。
 *
 * 存在的理由有两个，都不是「记录通话」：
 *   1. **计费**：`ai_call_min` 要按分钟记（决策 8，与 `ai_assist` 分开卖）
 *   2. **幂等**：Telnyx 的 webhook 会重投，同一通电话的挂机事件可能来两次，
 *      不去重就会把分钟数记两遍 —— 直接变成给客户多收钱
 */
export const phoneCalls = pgTable('phone_calls', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  /** Telnyx 的 call_session_id，一通电话从头到尾不变（call_control_id 会变） */
  providerCallId: text('provider_call_id').notNull(),
  fromE164: text('from_e164'),
  toE164: text('to_e164'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  /** 秒。计费按分钟向上取整，但存秒 —— 存分钟就再也算不回去了 */
  durationSeconds: integer('duration_seconds'),
  /** completed | no_answer | transferred_to_human | failed */
  outcome: text('outcome'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('phone_calls_provider_key').on(t.providerCallId),
  index('phone_calls_loc_idx').on(t.locationId, t.createdAt),
]);

/**
 * 来电三要素的草案 —— 前台的「待复核」队列。
 *
 * 每个「听到的」字段都同时存**原话**和**匹配到的 id**：
 *
 *   `serviceNameHeard` = "gel manicure"     `serviceId` = 匹配到的项目
 *   `staffNameHeard`   = "Amy"              `staffMembershipId` = 匹配到的人
 *
 * 只存 id 的话，匹配错了前台根本看不出来 —— 屏幕上写着「Gel Manicure」，
 * 而客人说的其实是 "gel removal"。两个都留着，前台一眼就能对上。
 * 匹配不到时 id 为空、原话还在，这比丢掉信息强得多。
 */
export const callDrafts = pgTable('call_drafts', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  callId: uuid('call_id').references(() => phoneCalls.id, { onDelete: 'set null' }),
  /** 来电号码。决策 21：手机号只是查找键，不是身份 */
  fromE164: text('from_e164'),

  // ── 三要素：项目 ────────────────────────────────────────────────────────
  serviceNameHeard: text('service_name_heard'),
  serviceId: uuid('service_id').references(() => services.id),

  // ── 三要素：技师偏好 ────────────────────────────────────────────────────
  staffNameHeard: text('staff_name_heard'),
  staffMembershipId: uuid('staff_membership_id').references(() => memberships.id),

  // ── 三要素：时间 ────────────────────────────────────────────────────────
  /** 客人原话，如「明天下午四点左右」。解析错时这是唯一的线索 */
  timeHeard: text('time_heard'),
  /**
   * AI 最终选定的空档。**必须是 find_slots 返回过的**（09 §8）——
   * 让模型自己算时间，它会算出一个店里没人在班的时刻，
   * 而客人在电话里已经听到了肯定的答复。
   */
  slotStartsAt: timestamp('slot_starts_at', { withTimezone: true }),
  durationMin: integer('duration_min'),

  // ── 客人 ────────────────────────────────────────────────────────────────
  customerId: uuid('customer_id').references(() => customers.id),
  /**
   * 同号多客户时的候选列表（决策 21：夫妻/母女共号很普遍，不许自动挑一个）。
   * `[{ customerId, displayName, lastVisitOn }]`
   */
  customerCandidates: jsonb('customer_candidates').notNull().default(sql`'[]'::jsonb`),
  callerNameHeard: text('caller_name_heard'),

  /** AI 自己报的把握程度，basis point（宪法第 4 条） */
  confidenceBp: integer('confidence_bp').notNull().default(10000),
  /** 让前台能读懂 AI 为什么这么填的那几句话。**不存整段录音转录** */
  notes: text('notes'),

  /** pending | confirmed | dismissed */
  status: text('status').notNull().default('pending'),
  /** 确认之后指向真正建出来的预约 */
  appointmentId: uuid('appointment_id').references(() => appointments.id),
  reviewedBy: uuid('reviewed_by').references(() => memberships.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  /** 忽略时必选原因 —— 「AI 到底准不准」只能靠这个统计（05 §9） */
  dismissReason: text('dismiss_reason'),
  createdAt: createdAt(),
}, (t) => [
  index('call_drafts_queue_idx').on(t.locationId, t.status, t.createdAt),
]);
