/**
 * Kiosk 门口端：走单队列 + 健康表 / 同意书（02-DATA-MODEL §5–6，Phase 2）
 *
 * ⚠️ **宪法第 14 条**：Kiosk 是**可选增强**，绝不是强依赖。
 * 这几张表里的每一件事，前台在自己那台电脑上都能代做 ——
 * 客人自己签到、自己签免责书是省事，不是前提。没有 iPad 的店照常跑。
 *
 * 健康表这一块的设计原则和别处不同：**它是出事时的唯一证据**（00 §2）。
 * 所以：版本化模板、签名、时间戳、IP、UA、语言全部留档，
 * 答案应用层加密，**连读取都要留痕**。
 */

import {
  pgTable, uuid, text, jsonb, integer, boolean, timestamp, date, customType,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { memberships } from './identity';
import { customers, services, appointments } from './scheduling';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// ─────────────────────────────────────────────────────────────── 走单队列

/**
 * 走单队列（walk-in queue）。
 *
 * 「取号」在客人那一侧是一个号码，在店里那一侧是一条等位记录。
 * 两者是同一行 —— 分开存的话，叫到号了而队列里还留着，
 * 或者反过来，前台看到的人数和门口大屏上的对不上。
 *
 * ⚠️ **不做叫号短信**（宪法第 13 条）。门店数 ≥ 10 且 10DLC 批准之前，
 * 叫号只有两条路：门口大屏 + 前台口头喊。这一点不因为有了 Kiosk 而改变。
 */
export const walkinQueue = pgTable('walkin_queue', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  businessDate: date('business_date').notNull(),
  /**
   * 当天的排队号。**按营业日从 1 开始重新数** ——
   * 客人手上那张纸/屏幕上写着 "A7"，和昨天的 A7 不冲突。
   */
  ticketNumber: integer('ticket_number').notNull(),
  customerId: uuid('customer_id').references(() => customers.id),
  /** 匿名 walk-in：只留个名字，事后可合并（决策 21） */
  walkInName: text('walk_in_name'),
  /** 客人在 Kiosk 上自己选的项目。可以为空 —— 「先排上，进去再说」也是常态 */
  requestedServiceId: uuid('requested_service_id').references(() => services.id),
  requestedStaffId: uuid('requested_staff_id').references(() => memberships.id),
  partySize: integer('party_size').notNull().default(1),
  /** 有预约的客人来签到，也进这条队列 —— 前台只需要看一个地方 */
  appointmentId: uuid('appointment_id').references(() => appointments.id),
  /**
   * 估的等待分钟数。**只是给客人一个心理预期**，不参与任何排期计算。
   * 存下来是为了事后回头看「我们估得准不准」。
   */
  quotedWaitMin: integer('quoted_wait_min'),
  /** waiting | called | seated | left */
  status: text('status').notNull().default('waiting'),
  /** kiosk | desk —— 谁把他排进来的。Desk-Only 的店这一列全是 desk */
  source: text('source').notNull().default('kiosk'),
  /** ⚠️ 不能用上面那个 createdAt() helper —— 它把列名写死成 created_at 了 */
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  calledAt: timestamp('called_at', { withTimezone: true }),
  seatedAt: timestamp('seated_at', { withTimezone: true }),
  leftAt: timestamp('left_at', { withTimezone: true }),
  /** 走了的原因。等太久走的和「说了一声先去吃饭」是两回事 */
  leftReason: text('left_reason'),
}, (t) => [
  uniqueIndex('walkin_queue_number_key').on(t.locationId, t.businessDate, t.ticketNumber),
  index('walkin_queue_board_idx').on(t.locationId, t.businessDate, t.status, t.joinedAt),
]);

// ─────────────────────────────────────────────────────── 健康表 / 同意书

/**
 * 表单模板。**版本化**，而且发布之后不可改。
 *
 * 为什么不可改：`form_submissions` 存的是「客人签的是第几版」。
 * 模板能就地改的话，出事时我们拿不出「他当时签的到底是什么」——
 * 而那正是这张表存在的全部意义（00 §2）。要改就发新版本。
 */
export const formTemplates = pgTable('form_templates', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  /** intake | consent | covid | patch_test …… 一家店同一个 key 只有一个在用的版本 */
  key: text('key').notNull(),
  version: integer('version').notNull().default(1),
  /** i18n。客人看到的是自己的语言（宪法第 7 条） */
  title: jsonb('title').notNull(),
  /**
   * 题目定义。每一题的 label 也是 i18n：
   * `[{ id, type: 'bool'|'text'|'choice'|'multi', label: {...}, options?, required }]`
   */
  schema: jsonb('schema').notNull(),
  /** 免责书要签字，普通问卷不用 */
  requiresSignature: boolean('requires_signature').notNull().default(true),
  /**
   * 有效期。到期要重签 —— 「三年前签过一次」在法律上站不住。
   * null = 永久有效（少见，通常只有一次性告知书）。
   */
  validDays: integer('valid_days'),
  /** 哪些项目需要它。空 = 全店所有项目都要 */
  serviceIds: jsonb('service_ids').notNull().default(sql`'[]'::jsonb`),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('form_templates_version_key').on(t.locationId, t.key, t.version),
]);

/**
 * 一次填写。**这是出事时唯一的证据**，所以留档留得比别处狠。
 *
 * ⭐ `answersEncrypted` 是应用层加密的密文（AES-256-GCM，密钥在环境变量）。
 * 数据库被拖走也拿不到健康数据 —— RLS 挡的是应用里的越权，
 * 挡不住直接把整个库复制走的人。这两件事要分开防。
 *
 * ⚠️ 不删除，只作废（宪法第 9 条）。客人要求删除时走匿名化，
 * 保留「签过、什么时候签的、签的第几版」，抹掉答案本身。
 */
export const formSubmissions = pgTable('form_submissions', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  customerId: uuid('customer_id').references(() => customers.id),
  templateId: uuid('template_id').notNull().references(() => formTemplates.id),
  /** 签的是第几版。模板发新版之后，这一列还指着他当时签的那一版 */
  templateVersion: integer('template_version').notNull(),

  answersEncrypted: bytea('answers_encrypted'),
  /** 加密方案标识（如 `aes-256-gcm.v1`）。将来换算法时靠它区分 */
  encAlg: text('enc_alg'),

  /** 签名图片在 Supabase Storage 的路径。私有桶，只有有权限的人拿得到签名 URL */
  signatureUrl: text('signature_url'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signerName: text('signer_name'),
  /** self | guardian —— 未成年人由监护人签（00 §2） */
  signerRelation: text('signer_relation').notNull().default('self'),

  /** 出事时要能复原「他在什么环境下签的」 */
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** 他当时看的是哪种语言的版本。「我看不懂英文」是最常见的抗辩 */
  locale: text('locale').notNull().default('en'),
  /** kiosk | desk —— 前台代签也合法，但要标出来（宪法第 14 条） */
  source: text('source').notNull().default('kiosk'),
  /** 前台代签时记下是谁代的 */
  onBehalfBy: uuid('on_behalf_by').references(() => memberships.id),

  expiresOn: date('expires_on'),
  /** 客人要求删除时抹掉答案，但保留「签过」这个事实 */
  anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('form_submissions_customer_idx').on(t.locationId, t.customerId, t.createdAt),
  index('form_submissions_expiry_idx').on(t.locationId, t.expiresOn),
]);

/**
 * 读取留痕（02 §5：读也要审计）。
 *
 * 健康数据和别的数据不一样：**看一眼本身就是一件需要留痕的事**。
 * 普通的 audit_log 只记写操作；这张表记的是「谁在什么时候、因为什么，
 * 看了谁的健康表」。出了纠纷这是能自证清白的东西。
 */
export const formAccessLog = pgTable('form_access_log', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  submissionId: uuid('submission_id').notNull()
    .references(() => formSubmissions.id, { onDelete: 'cascade' }),
  membershipId: uuid('membership_id').references(() => memberships.id),
  /** 为什么看：service_prep | incident_review | customer_request | export */
  reason: text('reason').notNull(),
  ip: text('ip'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('form_access_log_submission_idx').on(t.submissionId, t.at),
]);
