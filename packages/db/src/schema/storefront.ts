/**
 * 建站工单（sql/0045，批 8，docs/17）
 *
 * 我们**不做网站编辑器**（docs/01 §13）。定制官网走工单：
 * 店主填一张结构化需求单 → AI 出三版 → 老板选一版 → 人工精修 → 上线。
 *
 * ⭐ 工单的真正价值不是「省了编辑器」，是**它本身就是一张结构化的 prompt**。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);
const jsonArr = (name: string) => jsonb(name).notNull().default(sql`'[]'::jsonb`);

export const storefrontBriefs = pgTable('storefront_briefs', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  /** draft → submitted → drafted → chosen → live（withdrawn 回到 draft） */
  status: text('status').notNull().default('draft'),

  currentSiteUrl: text('current_site_url'),
  hasNoSite: boolean('has_no_site').notNull().default(false),
  painPoints: jsonArr('pain_points'),
  /** ⚠️ 问的是「**要避开什么**」不是「要什么」—— 后者人人都答「高级大气」 */
  painFreeText: text('pain_free_text'),

  /**
   * ⭐ 客群。竞品问了痛点、调性、卖点，**唯独没问这个** ——
   * 而它直接决定首屏说什么。
   */
  audience: jsonArr('audience'),
  /**
   * ⭐ 客人最常问的三件事：停车、现金/小费、说不说中文。
   * 这一节可以从 AI 通话记录里挖出来预填，不必问老板。
   */
  topQuestions: jsonArr('top_questions'),

  brandPrimary: text('brand_primary'),
  brandAccent: text('brand_accent'),
  /** warm | luxury | modern | traditional */
  voice: text('voice'),
  referenceSites: jsonArr('reference_sites'),

  sections: jsonArr('sections'),
  usp: text('usp'),
  tone: text('tone'),

  /** Supabase Storage 私有桶的 key，**不是 URL** */
  logoKey: text('logo_key'),
  heroKey: text('hero_key'),
  galleryKeys: jsonArr('gallery_keys'),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  draftedAt: timestamp('drafted_at', { withTimezone: true }),
  liveAt: timestamp('live_at', { withTimezone: true }),
  publicUrl: text('public_url'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('storefront_briefs_loc_uidx').on(t.locationId),
]);

export const storefrontDrafts = pgTable('storefront_drafts', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  briefId: uuid('brief_id').notNull()
    .references(() => storefrontBriefs.id, { onDelete: 'cascade' }),
  variant: integer('variant').notNull(),
  content: jsonb('content').notNull(),
  previewKey: text('preview_key'),
  chosenAt: timestamp('chosen_at', { withTimezone: true }),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costMillicents: integer('cost_millicents'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('storefront_drafts_variant_uidx').on(t.briefId, t.variant),
]);
