/**
 * Kiosk 门口端的命令（Phase 2）
 *
 * ⚠️ **宪法第 14 条贯穿这一组**：这里每一条命令，前台在自己那台电脑上
 * 都能代做。Kiosk 只是让客人自己动手，不是让流程依赖那台 iPad。
 * 所以每条命令都同时接受两种来源（`kiosk` / `desk`），且代做要留痕。
 */

import { z } from 'zod';
import { defineCommand, uuid, i18nText, localeSchema } from '../command.js';

// ─────────────────────────────────────────────────────────── 设备配对

/**
 * 签发一个设备令牌。
 *
 * ⚠️ **明文只在返回里给这一次**，之后库里只有摘要。
 * 前台要把它当密码看：配好那台 iPad 就别再截图留着。
 */
export const IssueDeviceToken = defineCommand({
  name: 'device.issueToken',
  input: z.object({
    /** 「门口 iPad」「二楼那台」—— 吊销的时候要认得出是哪一台 */
    label: z.string().min(1).max(60),
  }),
  output: z.object({
    deviceId: uuid,
    /** 明文令牌。**只有这一次**能拿到 */
    token: z.string(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '给一台门口 iPad 签发设备令牌。明文只返回一次。',
    confirm: 'always',
    // 不给副驾：它没有理由替人配设备，而配错一台就是把门开着
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

export const RevokeDeviceToken = defineCommand({
  name: 'device.revokeToken',
  input: z.object({ deviceId: uuid }),
  output: z.object({ deviceId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '吊销一台设备的令牌。iPad 丢了、或者不用了就吊销。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────── 走单队列

export const queueLeftReason = z.enum([
  'waited_too_long',   // 等太久走了 —— 这条要能统计，它直接对应流失
  'told_us',           // 说了一声先去别处
  'seated_elsewhere',  // 前台安排到别的方式了
  'no_response',       // 叫了没人应
  'other',
]);

/**
 * 排队取号。
 *
 * Kiosk 和前台都能调。号码按**营业日**从 1 重新数 ——
 * 客人手上那张写着 "7 号" 的纸，和昨天的 7 号不冲突。
 */
export const JoinQueue = defineCommand({
  name: 'queue.join',
  input: z.object({
    customerId: uuid.nullable().optional(),
    /** 匿名 walk-in：只留个名字，事后可合并（决策 21） */
    walkInName: z.string().max(120).optional(),
    requestedServiceId: uuid.nullable().optional(),
    requestedStaffId: uuid.nullable().optional(),
    partySize: z.number().int().min(1).max(20).default(1),
    /** 有预约的客人来签到，也进这条队列 —— 前台只看一个地方 */
    appointmentId: uuid.nullable().optional(),
    source: z.enum(['kiosk', 'desk']).default('kiosk'),
  }),
  output: z.object({
    queueId: uuid,
    ticketNumber: z.number().int(),
    /** 前面还有几位。客人最想知道的就是这个数 */
    aheadCount: z.number().int(),
    quotedWaitMin: z.number().int().nullable(),
    businessDate: z.string(),
  }),
  permission: 'queue.join',
  ai: {
    description: '把一位客人排进走单队列并给号。',
    confirm: 'never',
  },
  reversible: true,
  // Kiosk 那台 iPad 的网络常常是店里最差的一条。重试不能变成两个号
  idempotency: 'required',
});

/** 叫号 / 入座 / 离开。全部是前台的动作 —— 客人自己不能把自己叫号 */
export const UpdateQueueEntry = defineCommand({
  name: 'queue.update',
  input: z.object({
    queueId: uuid,
    status: z.enum(['called', 'seated', 'waiting', 'left']),
    /** status = left 时**必填**：等太久走的和「说了一声」是两回事 */
    leftReason: queueLeftReason.optional(),
  }),
  output: z.object({ queueId: uuid, status: z.string() }),
  permission: 'queue.manage',
  ai: {
    description: '叫号、安排入座、或标记客人离开。标记离开必须给原因。',
    confirm: 'destructive',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────── 健康表 / 同意书

export const SaveFormTemplate = defineCommand({
  name: 'catalog.saveFormTemplate',
  input: z.object({
    /** intake | consent | patch_test …… 同一个 key 只有一个在用的版本 */
    key: z.string().min(1).max(40).regex(/^[a-z][a-z_]*$/, '只能用小写字母和下划线'),
    title: i18nText,
    /**
     * 题目。每一题的 label 也是多语言的 —— 客人看不懂的免责书
     * 在法律上等于没签（宪法第 7 条在这里不是体验问题，是效力问题）。
     */
    questions: z.array(z.object({
      id: z.string().min(1).max(40),
      type: z.enum(['bool', 'text', 'choice', 'multi']),
      label: i18nText,
      options: z.array(z.object({ value: z.string().max(40), label: i18nText })).max(20).optional(),
      required: z.boolean().default(false),
    })).min(1).max(40),
    requiresSignature: z.boolean().default(true),
    /** 有效期。到期重签 —— 「三年前签过一次」在法律上站不住 */
    validDays: z.number().int().min(1).max(3650).nullable().default(365),
    /** 哪些项目要它。空 = 全店 */
    serviceIds: z.array(uuid).max(200).default([]),
  }),
  output: z.object({ templateId: uuid, version: z.number().int() }),
  permission: 'settings.manage',
  ai: {
    description:
      '新建或更新一份健康表 / 免责书模板。' +
      '**改内容会发一个新版本**，老的签名仍然指向他当时签的那一版。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 交一份填好的表。
 *
 * ⚠️ 答案在服务端**加密之后**才落库（02 §5）。这条命令的 `auditRedact`
 * 把 answers 整个抹掉 —— 审计里留「谁在什么时候签了哪一版」，
 * 不留他填了什么。健康数据不该在 audit_log 里再存一份明文。
 */
export const SubmitForm = defineCommand({
  name: 'form.submit',
  input: z.object({
    templateId: uuid,
    customerId: uuid.nullable().optional(),
    /** 题目 id → 答案 */
    answers: z.record(z.string(), z.unknown()),
    /** 签名图片的 data URL（PNG）。模板要求签字时必填 */
    signatureDataUrl: z.string().max(400_000).optional(),
    signerName: z.string().min(1).max(120),
    signerRelation: z.enum(['self', 'guardian']).default('self'),
    /** 他看的是哪种语言的版本。「我看不懂英文」是最常见的抗辩 */
    locale: localeSchema.default('en'),
    source: z.enum(['kiosk', 'desk']).default('kiosk'),
  }),
  output: z.object({
    submissionId: uuid,
    expiresOn: z.string().nullable(),
  }),
  permission: 'form.submit',
  ai: {
    description: '提交一份填好的健康表 / 免责书。',
    confirm: 'never',
    // 副驾永远不该替客人签免责书
    exposed: false,
  },
  reversible: false,
  idempotency: 'required',
  // 宪法第 17 条的同一条精神：动作留痕，内容不留
  auditRedact: ['answers', 'signatureDataUrl'],
});

export const KIOSK_COMMANDS = [
  IssueDeviceToken, RevokeDeviceToken,
  JoinQueue, UpdateQueueEntry,
  SaveFormTemplate, SubmitForm,
] as const;
