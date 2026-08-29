/**
 * 建站工单（批 8，docs/17）。
 *
 * ⚠️ **生成那一步不走命令总线** —— 模型调用要几十秒，塞进事务会
 * 占住一个连接和一个快照那么久（同 blueprint/extract 躲开的坑）。
 * 那一步是 `POST /v1/storefront/:id/generate`，只做编排，落库仍是命令。
 */

import { z } from 'zod';
import { defineCommand } from '../command.js';

const uuid = z.string().uuid();

/** 可点即加的痛点 chip（docs/17 §4，照抄竞品那八个） */
export const PAIN_POINTS = [
  'poor_mobile', 'no_booking_entry', 'slow', 'dated_photos',
  'unclear_pricing', 'not_in_search', 'template_feel', 'weak_brand',
] as const;

/** ⭐ 客群 —— 竞品没问这一节 */
export const AUDIENCES = [
  'local_workers', 'tourists', 'seniors', 'insurance', 'chinese_community', 'members',
] as const;

/** 四种调性，每一种在界面上都要写清会长什么样 */
export const VOICES = ['warm', 'luxury', 'modern', 'traditional'] as const;

export const SECTIONS = [
  'hero', 'about', 'gallery', 'services', 'reviews', 'giftcards', 'faq', 'contact',
] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const SaveStorefrontBrief = defineCommand({
  name: 'storefront.saveDraft',
  input: z.object({
    currentSiteUrl: z.string().max(500).nullable().optional(),
    hasNoSite: z.boolean().optional(),
    painPoints: z.array(z.string().max(100)).max(20).optional(),
    /** ⚠️ 问「要避开什么」不是「要什么」—— 后者人人都答「高级大气」 */
    painFreeText: z.string().max(2000).nullable().optional(),
    audience: z.array(z.string().max(100)).max(20).optional(),
    /** 客人最常问的三件事。可以从 AI 通话记录里挖出来预填 */
    topQuestions: z.array(z.string().max(200)).max(5).optional(),
    brandPrimary: z.string().max(50).nullable().optional(),
    brandAccent: z.string().max(50).nullable().optional(),
    voice: z.string().max(100).nullable().optional(),
    referenceSites: z.array(z.string().max(300)).max(5).optional(),
    sections: z.array(z.string().max(100)).max(20).optional(),
    usp: z.string().max(2000).nullable().optional(),
    tone: z.string().max(1000).nullable().optional(),
    logoKey: z.string().max(300).nullable().optional(),
    heroKey: z.string().max(300).nullable().optional(),
    galleryKeys: z.array(z.string().max(300)).max(12).optional(),
    storeName: z.string().max(200).nullable().optional(),
    slogan: z.string().max(500).nullable().optional(),
    photoSourceUrl: z.string().max(1000).nullable().optional(),
  }),
  output: z.object({ briefId: z.string(), status: z.string() }),
  permission: 'settings.manage',
  ai: { description: '保存建站需求单的草稿。不提交就不会进我们的队列。', confirm: 'never' },
  reversible: true,
  idempotency: 'optional',
});

export const SubmitStorefrontBrief = defineCommand({
  name: 'storefront.submit',
  input: z.object({}),
  output: z.object({ briefId: uuid, status: z.string(), submittedAt: z.string() }),
  permission: 'billing.manage',
  ai: { description: '把建站需求单提交给团队。提交后进入排期。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const WithdrawStorefrontBrief = defineCommand({
  name: 'storefront.withdraw',
  input: z.object({}),
  output: z.object({ briefId: uuid, status: z.string() }),
  permission: 'billing.manage',
  ai: { description: '撤回已提交的建站需求单，回到草稿状态继续改。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const ChooseStorefrontDraft = defineCommand({
  name: 'storefront.chooseDraft',
  input: z.object({ draftId: uuid }),
  output: z.object({ briefId: uuid, draftId: uuid, status: z.string() }),
  permission: 'billing.manage',
  ai: { description: '从 AI 生成的三版里选一版。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const AddStorefrontRevision = defineCommand({
  name: 'storefront.addRevision',
  input: z.object({ text: z.string().trim().min(1).max(4000) }),
  output: z.object({ revisionId: uuid, status: z.literal('submitted'), createdAt: z.string() }),
  permission: 'billing.manage',
  ai: { description: '向微店交付团队提交一条修改意见。', confirm: 'always' },
  reversible: false,
  idempotency: 'optional',
});

export const RequestStorefrontLaunch = defineCommand({
  name: 'storefront.requestLaunch',
  input: z.object({}),
  output: z.object({ briefId: uuid, status: z.string(), launchRequestedAt: z.string() }),
  permission: 'billing.manage',
  ai: { description: '确认当前选定的微店版本并申请正式上线。', confirm: 'always' },
  reversible: false,
  idempotency: 'optional',
});

export const STOREFRONT_COMMANDS = [
  SaveStorefrontBrief, SubmitStorefrontBrief, WithdrawStorefrontBrief, ChooseStorefrontDraft,
  AddStorefrontRevision, RequestStorefrontLaunch,
] as const;
