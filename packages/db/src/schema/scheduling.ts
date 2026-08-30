/**
 * 顾客 / 项目 / 预约 / 轮牌 / 审计（02-DATA-MODEL §3、§5–7、§15）
 *
 * 约束强度分三层（01 §7.1）：
 *   资源 = 数据库硬约束，不可覆盖
 *   技师 = 应用层软告警，可带 reason 放行  ← 绝不在这里建排他约束
 *   门店 = 应用层软告警，可放行
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, date, index, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { skills } from './identity';
import { memberships } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

// ─────────────────────────────────────────────────────────── 顾客

export const customers = pgTable('customers', {
  id: id(),
  orgId: orgCol(),
  primaryLocationId: uuid('primary_location_id').references(() => locations.id),
  /** 展示用全名，不强拆 —— 越南姓在前、西语双姓、中文有拼音与汉字两版 */
  displayName: text('display_name').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  /** ⚠️ 查找键，不是唯一键。夫妻/母女共用一个号非常普遍（宪法第 16 条） */
  phoneE164: text('phone_e164'),
  email: text('email'),
  locale: text('locale'),
  gender: text('gender'),
  birthday: date('birthday'),
  notes: text('notes'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  vipLevel: integer('vip_level').notNull().default(0),
  marketingSmsOptIn: boolean('marketing_sms_opt_in').notNull().default(false),
  marketingEmailOptIn: boolean('marketing_email_opt_in').notNull().default(false),
  noShowCount: integer('no_show_count').notNull().default(0),
  lateCancelCount: integer('late_cancel_count').notNull().default(0),
  /** 只由人工操作触发（如安全事件）；系统绝不因爽约次数自动封禁（00 §1.9） */
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  blockedReason: text('blocked_reason'),
  source: text('source').notNull().default('walkin'),
  mergedIntoId: uuid('merged_into_id'),
  createdAt: createdAt(),
}, (t) => [
  index('customers_phone_idx').on(t.orgId, t.phoneE164),
]);

export const customerPreferences = pgTable('customer_preferences', {
  customerId: uuid('customer_id').primaryKey().references(() => customers.id, { onDelete: 'cascade' }),
  orgId: orgCol(),
  preferredStaffIds: uuid('preferred_staff_ids').array().notNull().default(sql`'{}'::uuid[]`),
  avoidStaffIds: uuid('avoid_staff_ids').array().notNull().default(sql`'{}'::uuid[]`),
  preferredGender: text('preferred_gender'),
  allergies: jsonb('allergies').notNull().default(sql`'{}'::jsonb`),
  freeNotes: text('free_notes'),
  /**
   * ⭐ sticky 落单要素的长期默认（02 §3.1）。
   * 老客最常说的是「跟上次一样」—— 这个字段就是把那句话产品化。
   * 如 {"pressure":4,"focus_areas":["neck","upper_back"],"avoid_areas":["lower_back"]}
   */
  profile: jsonb('profile').notNull().default(sql`'{}'::jsonb`),
});

// ─────────────────────────────────────────────────────────── 项目与资源

export const serviceCategories = pgTable('service_categories', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  name: jsonb('name').notNull(),
  sort: integer('sort').notNull().default(0),
});

export const services = pgTable('services', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  categoryId: uuid('category_id').references(() => serviceCategories.id),
  name: jsonb('name').notNull(),
  description: jsonb('description'),
  durationMin: integer('duration_min').notNull(),
  bufferBeforeMin: integer('buffer_before_min').notNull().default(0),
  bufferAfterMin: integer('buffer_after_min').notNull().default(0),
  /** 处理时间拆段：[{active_min:20},{wait_min:15},{active_min:10}]，wait 段技师可复用 */
  processingGap: jsonb('processing_gap'),
  basePriceCents: integer('base_price_cents').notNull(),
  /** Internal fulfillment cost used for gross-margin reporting. Null = not configured. */
  costCents: integer('cost_cents'),
  taxable: boolean('taxable').notNull().default(false), // 服务多数州不收税，零售收
  staffCount: integer('staff_count').notNull().default(1), // 2 = 双技师项目
  turnValueBp: integer('turn_value_bp'), // null = 按轮牌策略算
  onlineBookable: boolean('online_bookable').notNull().default(false),
  /**
   * ⭐ 加项（sql/0035）。true = 只能加在别的项目上，不能单独预约。
   *
   * 加项在这个数据模型里就是普通的 services 行（`appointment_items.addon_ids`
   * 引用它们），所以在此之前**没有任何一处能分辨**「热石 $15」是加项
   * 还是一个完整项目 —— 电话 AI 会把它当成一次 $15 的服务报给客人。
   * 拍价目表提取时模型本来就判断得出（blueprint_items.kind = 'addon'），
   * 只是一直没地方存。
   */
  isAddon: boolean('is_addon').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
}, (t) => [
  index('services_location_idx').on(t.locationId, t.active),
]);

/** 项目履约所需技能；为空表示不设技能硬门槛。 */
export const serviceSkillRequirements = pgTable('service_skill_requirements', {
  orgId: orgCol(),
  locationId: locCol(),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  minimumProficiency: integer('minimum_proficiency').notNull().default(1),
}, (t) => [
  primaryKey({ columns: [t.serviceId, t.skillId] }),
  index('service_skill_requirements_location_idx').on(t.locationId, t.serviceId),
  index('service_skill_requirements_skill_idx').on(t.skillId),
]);

export const resourceTypes = pgTable('resource_types', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  key: text('key').notNull(), // room|pedi_chair|bed|couples_room
  name: jsonb('name').notNull(),
});

export const resources = pgTable('resources', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  resourceTypeId: uuid('resource_type_id').notNull().references(() => resourceTypes.id),
  name: text('name').notNull(),
  status: text('status').notNull().default('available'),
  /**
   * ⭐ 同时能容纳几个服务。
   *
   * 一间房不等于一张床：足疗房里排 6 张躺椅、双人房两张床两个技师、
   * 美甲区一个「区域」当资源用 —— 这些在真店里比「一房一客」更常见。
   * capacity = 1 时行为与从前完全一致（互斥）。
   *
   * 硬约束仍在数据库（宪法第 15 条），只是从排他约束换成了
   * 计数触发器 —— 排他约束表达不了「最多 N 个」。见 sql/0008。
   */
  capacity: integer('capacity').notNull().default(1),
  /**
   * 同一时刻这间房里允许几个**不同技师**。
   * null = 不限（等于 capacity）。双人房常见 2，单人房设 1 可以挡住
   * 「两个技师被排进同一间房」这种排班事故。
   */
  maxStaff: integer('max_staff'),
}, (t) => [
  index('resources_location_idx').on(t.locationId, t.status),
]);

/**
 * ⭐ 落单要素目录（02 §3.1）。按 business_type 出预设，店主可增删改。
 * 不为每个业态硬编码列 —— 那样每加一个业态都要改表。
 */
export const serviceOptionDefs = pgTable('service_option_defs', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  key: text('key').notNull(),        // pressure|focus_areas|shape|color_ref|glue_sensitivity…
  label: jsonb('label').notNull(),
  hint: jsonb('hint'),
  input: text('input').notNull(),    // single|multi|scale|bodymap|color|text|photo
  options: jsonb('options').notNull().default(sql`'[]'::jsonb`),
  applies_to: jsonb('applies_to').notNull().default(sql`'{}'::jsonb`),
  /** 记住上次选择，下次开单自动带出。力度、甲型、色号、卷翘度都必须 sticky */
  sticky: boolean('sticky').notNull().default(true),
  /** 是否显示在技师端「下一位客人」卡片上。健康问卷明细不显示，走权限 */
  toStaff: boolean('to_staff').notNull().default(true),
  required: boolean('required').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
}, (t) => [
  index('service_option_defs_location_idx').on(t.locationId, t.active),
]);

// ─────────────────────────────────────────────────────────── 预约

export const appointments = pgTable('appointments', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  customerId: uuid('customer_id').references(() => customers.id),
  walkInName: text('walk_in_name'), // 匿名 walk-in，事后可合并
  businessDate: date('business_date').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('booked'),
  source: text('source').notNull().default('desk'),
  bookingChannelRef: text('booking_channel_ref'),
  partySize: integer('party_size').notNull().default(1),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  cancelNote: text('cancel_note'),
  idempotencyKey: text('idempotency_key'),
  /**
   * 公开预约（官网）专用的两列，其它来源一律为空（sql/0033、docs/13）。
   *
   * `confirmationCode`   客人念得出来的短码，前台也能按它搜。明文存
   * `manageTokenDigest`  ⭐ 自助取消的**唯一凭证**，只存 SHA-256 摘要。
   *                      明文只在建单响应和确认信里出现过一次 ——
   *                      和设备令牌、技师会话令牌同一个套路。
   *                      预约 id 会出现在 URL、浏览器历史、转发的邮件里，
   *                      只靠 id 就能取消等于谁都能取消别人的预约。
   */
  confirmationCode: text('confirmation_code'),
  manageTokenDigest: text('manage_token_digest'),
  /**
   * 客人自己在网上改过几次期（sql/0040，批 2）。
   *
   * 到达 `settings.online_booking.self_reschedule_max` 之后只能打电话。
   * 无限次自助改期等于把日程表交给客人随便拖，而每一次拖动都可能
   * 把别人挤掉一格。**前台代改不计数** —— 那是店里自己的决定。
   */
  selfRescheduleCount: integer('self_reschedule_count').notNull().default(0),
  isBackfill: boolean('is_backfill').notNull().default(false),
  backfillReason: text('backfill_reason'),
  backfillNotes: text('backfill_notes'),
  createdAt: createdAt(),
}, (t) => [
  index('appointments_day_idx').on(t.orgId, t.locationId, t.businessDate, t.status),
  index('appointments_customer_idx').on(t.customerId),
]);

export const appointmentItems = pgTable('appointment_items', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  addonIds: uuid('addon_ids').array().notNull().default(sql`'{}'::uuid[]`),
  membershipId: uuid('membership_id').references(() => memberships.id),
  isRequest: boolean('is_request').notNull().default(false), // 点钟单
  resourceId: uuid('resource_id').references(() => resources.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  priceCentsSnapshot: integer('price_cents_snapshot').notNull(),
  durationMin: integer('duration_min').notNull(),
  seq: integer('seq').notNull().default(0),
  status: text('status').notNull().default('booked'),
  /** ⭐ 软约束放行时必填，写进审计（决策 12：可解释的流水，杜绝技师猜忌） */
  overbooked: boolean('overbooked').notNull().default(false),
  overbookReason: text('overbook_reason'),
  overbookNote: text('overbook_note'),
  /** ⭐ 本次落单要素：力度/部位/甲型/色号…（02 §3.1） */
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('appointment_items_staff_idx').on(t.locationId, t.membershipId, t.startsAt),
  index('appointment_items_resource_idx').on(t.locationId, t.resourceId, t.startsAt),
  index('appointment_items_appointment_idx').on(t.appointmentId),
]);

/** 处理时间拆段。资源排他约束只建在 active 段上，否则泡脚/等干场景排不进去。 */
export const appointmentItemBlocks = pgTable('appointment_item_blocks', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  itemId: uuid('item_id').notNull().references(() => appointmentItems.id, { onDelete: 'cascade' }),
  resourceId: uuid('resource_id').references(() => resources.id),
  kind: text('kind').notNull(), // active|wait
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
});

// ─────────────────────────────────────────────────────────── 轮牌

export const rotationPolicies = pgTable('rotation_policies', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  version: integer('version').notNull().default(1),
  config: jsonb('config').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ⭐ 按营业日存，不是按角色存。
 * 「今天人手不够老板下场、明天又不下」是天天变的（01 §5.1）。
 */
export const rotationParticipants = pgTable('rotation_participants', {
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  inRotation: boolean('in_rotation').notNull().default(true),
  note: text('note'),
}, (t) => [
  primaryKey({ columns: [t.locationId, t.businessDate, t.membershipId] }),
]);

/**
 * 事件溯源：当前顺序由事件重放得出，永远可解释。
 * 技师质疑时前台能一条条给他看 —— 这是竞品全都做不到的地方。
 */
export const rotationEvents = pgTable('rotation_events', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  membershipId: uuid('membership_id').notNull().references(() => memberships.id),
  delta: integer('delta_bp').notNull(), // basis point：5000 = 半轮
  reason: text('reason').notNull(),
  ticketId: uuid('ticket_id'),
  appointmentItemId: uuid('appointment_item_id'),
  actorId: uuid('actor_id'),
  note: text('note'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('rotation_events_day_idx').on(t.locationId, t.businessDate, t.at),
]);

// ─────────────────────────────────────────────────────────── 审计

/**
 * append-only。强制方式在迁移里：REVOKE + BEFORE trigger（02 §15）。
 *
 * ⚠️ 宪法第 17 条：ticket / payment 的金额字段不写入 before/after。
 * 动作本身照常留痕（谁、几点、什么原因），只是不留金额快照。
 */
export const auditLog = pgTable('audit_log', {
  id: id(),
  orgId: uuid('org_id').notNull(),
  locationId: uuid('location_id'),
  actorId: uuid('actor_id'),
  actorKind: text('actor_kind').notNull().default('user'), // user|ai|system|api|platform
  command: text('command').notNull(),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  undoOfId: uuid('undo_of_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('audit_log_entity_idx').on(t.orgId, t.entityType, t.entityId, t.at),
  index('audit_log_actor_idx').on(t.locationId, t.actorId, t.at),
]);

/** 幂等键去重。网络差的门店必须能安全重试。 */
export const commandIdempotency = pgTable('command_idempotency', {
  key: text('key').notNull(),
  locationId: uuid('location_id').notNull(),
  command: text('command').notNull(),
  resultJson: jsonb('result_json').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.locationId, t.key] }),
]);

/**
 * 自助管理页「手机后四位」的失败计数（sql/0040，批 2）。
 *
 * ⭐ **按预约维度锁，不按 IP。** 按 IP 锁会让同一个 WiFi 下的第二位客人
 * 被前一位连累（一家店的客人常常连的是同一个 WiFi）；而攻击者要猜的是
 * 「某一条特定预约」的后四位，按预约锁正好卡住他 —— 一万种可能里
 * 连猜三次就锁 15 分钟，穷举要几十年。
 */
export const bookingManageAttempts = pgTable('booking_manage_attempts', {
  appointmentId: uuid('appointment_id').primaryKey()
    .references(() => appointments.id, { onDelete: 'cascade' }),
  orgId: orgCol(),
  locationId: locCol(),
  failedCount: integer('failed_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
