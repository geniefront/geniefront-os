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

export const QueueDeviceCommand = defineCommand({
  name: 'device.queueCommand',
  input: z.object({
    deviceId: uuid,
    kind: z.enum(['wake', 'reset_home']),
  }),
  output: z.object({ commandId: uuid, deviceId: uuid, status: z.literal('pending') }),
  permission: 'settings.manage',
  ai: {
    description: '向已配对且未吊销的门店终端发送唤醒或回到首页命令。',
    confirm: 'always',
    exposed: false,
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
    /** Kiosk walk-in 主联系人；仅在门店开启自动建档时写入 CRM。 */
    walkInPhone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
    walkInEmail: z.string().email().max(200).optional(),
    requestedServiceId: uuid.nullable().optional(),
    requestedStaffId: uuid.nullable().optional(),
    requestedAddonIds: z.array(uuid).max(20).default([]),
    partySize: z.number().int().min(1).max(20).default(1),
    /** 有预约的客人来签到，也进这条队列 —— 前台只看一个地方 */
    appointmentId: uuid.nullable().optional(),
    source: z.enum(['kiosk', 'desk']).default('kiosk'),
  }),
  output: z.object({
    queueId: uuid,
    /** 所有到店来源统一生成/关联的预约主记录；queueId 只负责排队状态。 */
    appointmentId: uuid,
    ticketNumber: z.number().int(),
    /** 前面还有几位。客人最想知道的就是这个数 */
    aheadCount: z.number().int(),
    quotedWaitMin: z.number().int().nullable(),
    businessDate: z.string(),
  }),
  permission: 'queue.join',
  ai: {
    description: '把一位客人排进走单队列并给号。',
    confirm: 'always',
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

const formQuestions = z.array(z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['bool', 'text', 'choice', 'multi']),
  label: i18nText,
  options: z.array(z.object({ value: z.string().min(1).max(40), label: i18nText })).max(20).optional(),
  required: z.boolean().default(false),
  /** 隐藏题保留在模板版本中，方便店主以后重新启用；公开端不下发。 */
  hidden: z.boolean().default(false),
  sync: z.enum(['avoid_areas', 'health_flag']).optional(),
})).min(1).max(40).superRefine((questions, ctx) => {
  const ids = new Set<string>();
  questions.forEach((question, index) => {
    if (ids.has(question.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: '题目 id 不能重复' });
    }
    ids.add(question.id);
    if ((question.type === 'choice' || question.type === 'multi') && !question.options?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'options'], message: '选择题至少需要一个选项' });
    }
    if (question.sync === 'health_flag' && question.type !== 'bool') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'sync'], message: '健康禁忌标记只能来自是非题' });
    }
    if (question.sync === 'avoid_areas' && question.type !== 'multi') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'sync'], message: '避开部位只能来自多选题' });
    }
    const optionValues = new Set<string>();
    question.options?.forEach((option, optionIndex) => {
      if (optionValues.has(option.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'options', optionIndex, 'value'], message: '选项 value 不能重复' });
      }
      optionValues.add(option.value);
    });
  });
});

export const SaveFormTemplate = defineCommand({
  name: 'catalog.saveFormTemplate',
  input: z.object({
    /** intake | consent | patch_test …… 同一个 key 只有一个在用的版本 */
    key: z.string().min(1).max(40).regex(/^[a-z][a-z_]*$/, '只能用小写字母和下划线'),
    title: i18nText,
    /**
     * 题目。每一题的 label 也是多语言的 —— 客人看不懂的免责书
     * 在法律上等于没签（宪法第 7 条在这里不是体验问题，是效力问题）。
     * `sync` 的题型兼容性与题目 / 选项 id 唯一性也在 schema 中强制校验，
     * 避免提交答案时一个 key 对应两个含义。
     */
    questions: formQuestions,
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
    /**
     * 关联预约。公开链接提交时由服务端从 form_share_links 注入，
     * 不信任顾客端请求体中的值。
     */
    appointmentId: uuid.nullable().optional(),
    /** Kiosk walk-in 表单关联到刚取的队列号；由已验设备令牌的路由注入。 */
    queueId: uuid.nullable().optional(),
    /** 题目 id → 答案 */
    answers: z.record(z.string(), z.unknown()),
    /** 签名图片的 data URL（PNG）。模板要求签字时必填 */
    signatureDataUrl: z.string().max(400_000).optional(),
    signerName: z.string().min(1).max(120),
    signerRelation: z.enum(['self', 'guardian']).default('self'),
    /** 他看的是哪种语言的版本。「我看不懂英文」是最常见的抗辩 */
    locale: localeSchema.default('en'),
    /** `link` = 客人扫码 / 点邮件里的链接，在自己手机上填的（`docs/15`） */
    source: z.enum(['kiosk', 'desk', 'link']).default('kiosk'),
    /**
     * 从哪条填表链接签进来的。
     *
     * ⚠️ **由路由拼，不由客户端说了算**（`public/formRoutes.ts`）——
     * 和 `customerId` 同一条道理：让请求体决定的话，一条链接就能把
     * 自己的签名挂到别的链接名下。
     */
    shareLinkId: uuid.nullable().optional(),
    /**
     * 前台代客重填（AUD-04）。
     *
     * 置 true 时：新记录的 `version` = 上一版 + 1，上一版被标成
     * `is_latest = false` 且 `superseded_by` 指向新记录。
     *
     * ⚠️ 这一段逻辑原来长在 `POST /v1/desk/forms/re-submit` 里，
     * 用的是一组裸 SQL —— 于是**一份签过字的健康表可以被改写，
     * 而 audit_log 里一条记录都没有**。健康表恰恰是「谁在什么时候
     * 代客改了什么」必须查得到的那一类数据。
     *
     * 合并进 `form.submit` 而不是新开一条命令：`form_submissions`
     * 的写入方只能有一个，两个写入方迟早会在加密、模板版本、
     * 有效期这三件事上漂开。
     */
    supersedePrevious: z.boolean().default(false),
  }),
  output: z.object({
    submissionId: uuid,
    expiresOn: z.string().nullable(),
    /** 这一份是第几版。首次提交是 1。 */
    version: z.number().int().min(1),
    /** 被这一份顶掉的上一版（没有就是 null）。 */
    supersededId: uuid.nullable(),
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

// ───────────────────────────────────────────────── 把表发给客人（`docs/15`）

/**
 * 生成一条**一次性的填表链接**。
 *
 * ## 为什么要有这条路
 *
 * 门口那台 iPad 只解决「已经站在店里的人」。而健康表最该在**到店之前**填完：
 * 客人站在柜台前用一台公用 iPad 回答「有没有血栓史」，后面还排着队 ——
 * 那种情况下他会一路点「否」，而这张表的全部意义就在他答的是不是真话。
 *
 * ## ⚠️ 只走二维码和邮件，**不发短信**
 *
 * 短信里的网页链接在美国运营商眼里是高风险流量（`09` §5）：平台号 + 陌生短链
 * 是钓鱼短信最常见的形状，掐的是整条 10DLC 通道 —— 一旦被掐，
 * 受影响的是所有店的预约确认短信，不只是这一条。
 * 所以到店前的分享只有两条：**当面扫码**、**发邮件**。
 *
 * ## 令牌
 *
 * 明文 `fs_…` **只在这次返回里出现**，库里只存 SHA-256 摘要 ——
 * 和设备令牌（0016）、自助取消令牌（0033）同一个套路。
 * 链接过期或用过之后立刻失效，捡到旧链接的人什么也拿不到。
 */
export const ShareForm = defineCommand({
  name: 'form.share',
  input: z.object({
    /** 要他签哪几份。空 = 按门店当前业态选择一份已发布表 */
    templateIds: z.array(uuid).max(10).default([]),
    /** 认得出是谁签的。没有客户档案也能发（他到店再合并，决策 21） */
    customerId: uuid.nullable().optional(),
    appointmentId: uuid.nullable().optional(),
    /**
     * `qr` = 前台屏上出个码给客人当面扫；`email` = 发到他邮箱。
     * ⚠️ **没有 sms** —— 理由见上面
     */
    channel: z.enum(['qr', 'email']).default('qr'),
    /** channel = email 时必填 */
    email: z.string().email().max(200).optional(),
    /** 链接活多久。默认 72 小时 —— 够他晚上想起来再填，又不会留一年 */
    expiresInHours: z.number().int().min(1).max(720).default(72),
    /** 客人看到的语言。发邮件时也用它 */
    locale: localeSchema.default('en'),
  }),
  output: z.object({
    shareId: uuid,
    /** 明文令牌。**只有这一次**能拿到 */
    token: z.string(),
    url: z.string(),
    /** 内联 SVG 二维码（服务端生成，不引外部图床）*/
    qrSvg: z.string(),
    expiresAt: z.string(),
    /** channel = email 时，邮件是否已入队 */
    emailQueued: z.boolean(),
  }),
  permission: 'form.submit',
  ai: {
    description: '为到店或预约客人生成健康免责表填写链接及二维码（支持 qr 扫码或 email 邮件发送）。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
  // 邮箱是个人信息，审计里留「发过一条」就够了
  auditRedact: ['email'],
});

/** 发错人了、或者客人说链接被同事看到了 —— 立刻失效。 */
export const RevokeFormShare = defineCommand({
  name: 'form.revokeShare',
  input: z.object({ shareId: uuid }),
  output: z.object({ shareId: uuid }),
  permission: 'form.submit',
  ai: {
    description: '让一条填表链接立刻失效。',
    confirm: 'destructive',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

export const KIOSK_COMMANDS = [
  IssueDeviceToken, RevokeDeviceToken, QueueDeviceCommand,
  JoinQueue, UpdateQueueEntry,
  SaveFormTemplate, SubmitForm, ShareForm, RevokeFormShare,
] as const;
