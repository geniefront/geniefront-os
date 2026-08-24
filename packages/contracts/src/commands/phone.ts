/**
 * AI 电话接单的命令（09-TELNYX §4，决策 6）
 *
 * 这一组命令的权限设计是整件事的要害，值得先说清楚：
 *
 *   AI 电话拿到的权限只有 `call.draft` 一个 —— **它建不出预约**。
 *   前台在复核队列点「确认」时，走的是前台**自己身份下**的
 *   `appointment.create`，容量检查、软约束放行、审计一样不少。
 *
 * 也就是说：就算验签被绕过，攻击者能做到的最坏情况是往某家店的待办列表里
 * 塞垃圾，而不是动任何真实预约、不占日程表上任何一格。
 *
 * 这不是过度设计。webhook 是**没有 Bearer token** 的入口，
 * 唯一的身份证明是一个签名 —— 给这样一个入口配 `appointment.write`，
 * 等于把排期表的写权限挂在一个环境变量上。
 */

import { z } from 'zod';
import { defineCommand, uuid, phoneE164 } from '../command.js';

/** 忽略草案时的原因。这是「AI 到底准不准」唯一诚实的度量（05 §9） */
export const draftDismissReason = z.enum([
  'wrong_service',      // 项目听错了
  'wrong_time',         // 时间听错了
  'wrong_staff',        // 技师听错了
  'not_a_booking',      // 客人只是问价格 / 问营业时间
  'duplicate',          // 客人已经用别的方式约过了
  'customer_cancelled', // 挂电话前又说不用了
  'spam',
  'other',
]);

/**
 * AI 把听到的三要素放进复核队列。
 *
 * **幂等 required**：通话中断重连、Telnyx 重投 webhook，
 * 同一通电话可能调两次。不去重前台会看到两条一模一样的待办，
 * 而她分不清是客人打了两次还是系统重了。
 */
export const DraftFromCall = defineCommand({
  name: 'call.draftAppointment',
  input: z.object({
    /** Telnyx 的 call_session_id。用来把草案和通话计费对上 */
    providerCallId: z.string().max(120).optional(),
    fromE164: phoneE164.optional(),

    // ── 三要素。每一项都同时收「听到的原话」和「匹配到的 id」 ──────────────
    serviceNameHeard: z.string().max(200).optional(),
    serviceId: uuid.nullable().optional(),
    staffNameHeard: z.string().max(120).optional(),
    staffMembershipId: uuid.nullable().optional(),
    timeHeard: z.string().max(200).optional(),

    /**
     * AI 选定的空档。
     *
     * ⚠️ **必须是 find_slots 返回过的时刻**（09 §8）。
     * 服务端会拿排期引擎再验一遍 —— 不验的话，模型「算」出来的
     * 一个店里没人在班的时间会一路走到前台屏幕上，
     * 而客人在电话里早已听到了肯定的答复。
     */
    slotStartsAt: z.string().datetime({ offset: true }).nullable().optional(),
    durationMin: z.number().int().min(5).max(600).nullable().optional(),

    customerId: uuid.nullable().optional(),
    callerNameHeard: z.string().max(120).optional(),

    /** AI 自报的把握程度，basis point */
    confidenceBp: z.number().int().min(0).max(10000).default(10000),
    /** 给前台看的一两句话。**不要塞整段转录** —— 那是个人信息，也没人会读 */
    notes: z.string().max(1000).optional(),
  }),
  output: z.object({ draftId: uuid, queuedAt: z.string() }),
  permission: 'call.draft',
  ai: {
    description:
      '把电话里听到的预约意向放进前台复核队列。' +
      '时间必须先用 find_slots 查到真实空档再填，不许自己推算。',
    confirm: 'never',
    // 前台副驾用不着这条：它面前坐着的是人，直接建单就行
    exposed: false,
  },
  reversible: true,
  idempotency: 'required',
});

/**
 * 前台复核。
 *
 * `confirm` 不在这里建预约 —— 建预约是**另一条命令**（`appointment.create`），
 * 由前端在确认时以前台自己的身份发起。这里只负责把草案标记成已处理、
 * 并记下它变成了哪一条预约。
 *
 * 拆成两步是有意的：合成一步的话，`call.reviewDraft` 就需要
 * `appointment.write` 权限，而它的调用方是复核界面 —— 权限边界会糊掉，
 * 更重要的是容量冲突（周六下午满了）就得在这条命令里重新处理一遍，
 * 那等于把 `appointment.create` 的逻辑抄第二份（宪法第 2 条）。
 */
export const ReviewCallDraft = defineCommand({
  name: 'call.reviewDraft',
  input: z.object({
    draftId: uuid,
    decision: z.enum(['confirmed', 'dismissed']),
    /** decision = confirmed 时传：这条草案变成了哪一条预约 */
    appointmentId: uuid.optional(),
    /** decision = dismissed 时**必填** */
    dismissReason: draftDismissReason.optional(),
    note: z.string().max(500).optional(),
  }),
  output: z.object({ draftId: uuid, status: z.string() }),
  permission: 'appointment.write',
  ai: {
    description: '把一条来电草案标记为已确认或已忽略。忽略必须给原因。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 通话结束，记一笔。
 *
 * **幂等 required**：Telnyx 的 `call.hangup` 会重投。
 * 不去重就把同一通电话的分钟数记两遍 —— 那是直接给客户多收钱，
 * 而且是最难被发现的那种错（账单上只是一个稍微大一点的数字）。
 */
export const RecordCall = defineCommand({
  name: 'call.record',
  input: z.object({
    providerCallId: z.string().max(120),
    fromE164: z.string().max(24).optional(),
    toE164: z.string().max(24).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    endedAt: z.string().datetime({ offset: true }).optional(),
    durationSeconds: z.number().int().min(0).max(24 * 3600),
    outcome: z.enum(['completed', 'no_answer', 'transferred_to_human', 'failed'])
      .default('completed'),
  }),
  output: z.object({
    callId: uuid,
    billedMinutes: z.number().int(),
    /** 走套餐内语音额度的分钟数 */
    fromIncluded: z.number().int().min(0),
    /** 走充值余额的分钟数 —— 只有这部分是老板买过的 */
    fromBalance: z.number().int().min(0),
  }),
  permission: 'call.draft',
  ai: {
    description: '（内部）记录一通 AI 电话的时长与结果。',
    confirm: 'never',
    exposed: false,
  },
  reversible: false,
  idempotency: 'required',
});

/** 把一个 Telnyx 号码绑到门店。老板在开店配置里做一次。 */
export const SavePhoneLine = defineCommand({
  name: 'location.savePhoneLine',
  input: z.object({
    e164: phoneE164,
    provider: z.enum(['telnyx', 'twilio']).default('telnyx'),
    purpose: z.enum(['ai_voice', 'main', 'sms', 'transfer_target']).default('ai_voice'),
    assistantId: z.string().max(120).nullable().optional(),
    active: z.boolean().default(true),
    /**
     * ⭐ 换一串新的电话工具 token（sql/0036）。
     *
     * `ai_voice` 线**第一次建**的时候自动生成一串，不用传这个；
     * 传 true 是为了轮换（怀疑泄露、或者忘了当初那串是什么）。
     * 轮换之后**必须同步填进 Telnyx 的 assistant 配置**，
     * 否则那家店的电话当场全 401。
     */
    rotateToolToken: z.boolean().default(false),
  }),
  output: z.object({
    e164: z.string(),
    locationId: uuid,
    /**
     * ⭐ token 明文。**只在刚生成的那一次返回，之后永远拿不到** ——
     * 库里只有 SHA-256 摘要。没生成新的就是 null。
     */
    toolToken: z.string().nullable(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '把一个电话号码绑定到本店（AI 接听线 / 主线 / 短信线）。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 店家确认自己的两个号码，申请开通 AI 客服。
 *
 * **开通本身是人工做的**（我们去 Telnyx 买号、建 assistant、绑 tool、
 * 设转人工，一个工作日内），所以系统这一侧不需要任何编排 —— 只需要把
 * 这两个号确认下来。见 `09` §2。
 *
 *   · `storefrontE164`      对外公布的号。店家在**自己的运营商**那儿把它设成
 *                           「无应答转移」到我们给的落地号。我们不碰这个号。
 *   · `transferTargetE164`  人工客服号。AI 答不了时转给它。
 *
 * ⚠️ **两个号必须不同**，见下面 refine 里的理由。
 *
 * 一次事务写两条 `phone_lines` —— 分两次调 `savePhoneLine` 的话，
 * 「两号不同」这条校验没有地方落，而且存了一个另一个失败会留下半套配置。
 */
export const RequestAiVoice = defineCommand({
  name: 'location.requestAiVoice',
  input: z.object({
    storefrontE164: phoneE164,
    transferTargetE164: phoneE164,
    /**
     * 店家在**自己运营商**那儿设的转接方式。我们改不了它，
     * 这里记的是「他说他设的是哪种」—— 但它决定了下面那条校验。
     */
    forwardingMode: z.enum(['all', 'busy_no_answer']).default('busy_no_answer'),
  }).refine(
    (v) => v.forwardingMode !== 'all'
        || v.storefrontE164 !== v.transferTargetE164,
    {
      /**
       * ⭐ 两个号相同**本身没问题** —— 一家店就一部电话是常态，
       * 「转人工」就是打回店里，有人闲下来就接得到。
       *
       * 坏掉的只有一个组合：**全转 + 两号相同**。
       * 转人工 → 打回对外号 → 那个号无条件又转给 AI → 转人工 → ……
       * **人永远接不到，而且必然发生**（不像「无应答才转」那样
       * 至少给了店里一次接起来的机会）。
       *
       * 所以按模式判，不是一刀切。
       */
      message: '「所有来电都转给 AI」时，人工客服号不能和对外号相同 —— '
             + '转人工会被无条件转回 AI，客人永远等不到人',
      path: ['transferTargetE164'],
    }),
  output: z.object({
    locationId: uuid,
    storefrontE164: z.string(),
    transferTargetE164: z.string(),
    /** 我们的落地号。还没开通时是 null —— 前端据此显示「开通中」还是转移教程 */
    aiVoiceE164: z.string().nullable(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '登记本店对外公布的号码与人工客服号码，申请开通 AI 电话客服。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const PHONE_COMMANDS = [
  DraftFromCall, ReviewCallDraft, RecordCall, SavePhoneLine, RequestAiVoice,
] as const;
