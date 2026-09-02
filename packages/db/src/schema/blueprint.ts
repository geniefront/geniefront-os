/**
 * 开店草案（Shop Blueprint）—— AI 拍照开店的中间产物（05-AI-INTEGRATION §4.2）
 *
 * ⭐ 这三张表存在的唯一理由：**AI 永远不直接写业务表**。
 *
 * 价目表照片提取出来的东西先落在这里，带 confidence、带 source、带 bbox，
 * 由老板逐项看过、改过、勾过，才通过命令总线变成真正的 `services`。
 * 所以「提取错了」在这一层就被拦住，不会污染开单时的项目库；
 * 而且提取过程本身是可回放、可审计、可整体丢弃的。
 *
 * 为什么不直接建店再让老板改：
 *   38 个项目里错 3 个，老板在项目列表里根本认不出是哪 3 个 ——
 *   他没有对照物。左边原图、右边表格、错的标黄，才是他能核对的形态。
 */

import {
  pgTable, uuid, text, jsonb, integer, boolean, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { services } from './scheduling';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * 一次开店尝试。
 *
 * status：
 *   draft      —— 还在提取/复核
 *   applied    —— 已经落地成 services（不可再改，留档）
 *   discarded  —— 老板放弃了这一次（留档，不删除）
 *
 * 一家店可以有多份草案（先拍手部价目表，再拍足部的），互不干扰。
 */
export const shopBlueprints = pgTable('shop_blueprints', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  status: text('status').notNull().default('draft'),
  /** 老板给这次拍照起的名字，不填就用「价目表 · 8月16日」 */
  label: text('label'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  /** 提取跑完的时刻。null = 还没提取过（只上传了照片） */
  extractedAt: timestamp('extracted_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  /**
   * 后台提取任务的状态（sql/0094）：idle | running | done | failed。
   * 提取改成异步之后，路由立刻返回 202，确认页轮询这一列。
   */
  extractionStatus: text('extraction_status').notNull().default('idle'),
  /** failed 时的原因（timeout / all_images_failed / 模型返回的 error 串）。 */
  extractionError: text('extraction_error'),
  /**
   * 置 running 的时刻。滚动部署会打断游离的后台任务，读取侧据此把
   * 「running 且早于阈值」判成 failed/timeout（sql/0094 文件头）。
   */
  extractionStartedAt: timestamp('extraction_started_at', { withTimezone: true }),
  /**
   * AI 主动列出的「它不知道的」（05 §4.2 unresolved）。
   * 这些会变成确认页底部的追问，而不是让模型瞎猜一个值填进去。
   */
  unresolved: jsonb('unresolved').notNull().default(sql`'[]'::jsonb`),
  /** 官网/商家平台提取出的门店资料提议，确认前不写正式门店。 */
  locationProposal: jsonb('location_proposal').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('shop_blueprints_loc_idx').on(t.locationId, t.status, t.createdAt),
]);

/**
 * 草案的输入源。一次可以传 3–6 张（一家店的价目表通常分几块牌子）。
 *
 * `storagePath` 指向 Supabase Storage 的私有桶，**可以为空** ——
 * 上传失败不该挡住提取（宪法第 14 条的同一条精神：增强项永不成为阻断点）。
 * 为空时确认页就没有左边那张原图可点，其余照常。
 */
export const blueprintSources = pgTable('blueprint_sources', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  blueprintId: uuid('blueprint_id').notNull()
    .references(() => shopBlueprints.id, { onDelete: 'cascade' }),
  /** price_list_image | website | yelp —— 目前只实现第一种，后两种是 05 §4.1 的其他入口 */
  kind: text('kind').notNull().default('price_list_image'),
  /** 第几张。bbox 要靠它回溯到具体哪张照片 */
  seq: integer('seq').notNull(),
  /** Supabase Storage 的对象路径，如 `{locationId}/{blueprintId}/0.jpg` */
  storagePath: text('storage_path'),
  sourceUrl: text('source_url'),
  rawSnapshot: jsonb('raw_snapshot'),
  /** 原始像素尺寸。bbox 是像素坐标，没有它就没法在缩放后的 <img> 上定位 */
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('blueprint_sources_seq_key').on(t.blueprintId, t.seq),
]);

/**
 * 提取出来的一条候选项目。
 *
 * ⚠️ 三个字段是这张表的全部价值，缺一个确认页就没法用（05 §4.2）：
 *   confidenceBp —— 低于阈值标黄，老板知道该重点看哪几行
 *   sourceSeq + bbox —— 点一下能跳回原图那一行，老板才有对照物
 *   kind —— 「Add-on」「Kids under 10」这类修饰行不是独立项目，
 *            让模型自己分类，比我们事后用正则猜靠谱得多（05 §5.3）
 *
 * 金额整数分、置信度 basis point（宪法第 4 条）—— 置信度也走 bp 不是洁癖：
 * 0.85 存成 float 再比较阈值，跨语言序列化会在边界上抖。
 */
export const blueprintItems = pgTable('blueprint_items', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  blueprintId: uuid('blueprint_id').notNull()
    .references(() => shopBlueprints.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  /** service | addon | note | price_modifier（05 §5.3 的反面清单） */
  kind: text('kind').notNull().default('service'),
  /** i18n。模型只认得出价目表上那一种语言，其余是自动补的（05 §4.4） */
  name: jsonb('name').notNull(),
  /**
   * 哪几个语言格是**机器补的**，如 `["zh-Hans","ko"]`（sql/0028）。
   *
   * 单独一列而不是塞进 `name` 里：`name` 被 `pickText` 当成纯粹的
   * 「语言 → 文本」表读，混一个 `_auto` 键进去，任何一处忘了过滤
   * 就会把它当成一种语言显示给客人。
   */
  nameAuto: jsonb('name_auto').notNull().default(sql`'[]'::jsonb`),
  /** 价目表上的分类标题，如 "Manicure" / "足疗"。不强制，很多小店没有分类 */
  category: text('category'),
  durationMin: integer('duration_min'),
  priceCents: integer('price_cents'),
  /** "$25 & up" / "from $40" —— 开放价（05 §5.3） */
  priceIsFrom: boolean('price_is_from').notNull().default(false),
  /**
   * 一个项目多个价格（按长度/等级/时长）时的变体，
   * `[{ label, priceCents, durationMin }]`。
   * 硬塞进一个 price 会丢信息，落地时拆成多个 service。
   */
  variants: jsonb('variants').notNull().default(sql`'[]'::jsonb`),
  /** 10000 = 完全确定。低于 8500 在确认页标黄（05 §4.2 的建议阈值） */
  confidenceBp: integer('confidence_bp').notNull().default(10000),
  /** 来自哪张照片。对应 blueprint_sources.seq */
  sourceSeq: integer('source_seq'),
  /** [x1,y1,x2,y2] 像素坐标，与原图 1:1（Opus 5 视觉坐标不需要换算，05 §5.1） */
  bbox: jsonb('bbox'),
  /** pending | accepted | rejected —— 老板逐项勾选的结果 */
  decision: text('decision').notNull().default('pending'),
  /** 老板改过的痕迹：改过就不再是纯 AI 产物，落地时 source 标记不同 */
  editedAt: timestamp('edited_at', { withTimezone: true }),
  /** 落地之后指向真正建出来的项目，可回滚可追溯 */
  appliedServiceId: uuid('applied_service_id').references(() => services.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('blueprint_items_seq_key').on(t.blueprintId, t.seq),
  index('blueprint_items_review_idx').on(t.blueprintId, t.decision, t.confidenceBp),
]);
