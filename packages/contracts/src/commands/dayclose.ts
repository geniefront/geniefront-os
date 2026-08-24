/**
 * 打烊日结（Phase 1b）
 *
 * 四个命令对应打烊时的四个动作，顺序固定但都可以跳过重来：
 *   录现金进出 → 点钞 → 发现金小费 → 封账
 *
 * 设计立场：**系统不追求「不许差」，只追求「差额有出处」**。
 * 前台每天摸几千块现金，差几十块是常态；能说清差在哪一步、谁经手、
 * 当时写了什么，才是老板真正需要的东西（04 §6）。
 *
 * 决策 19：现金进出条目全部可选。一条不填也能完成日结。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents } from '../command.js';

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 金额一律不进审计（宪法第 17 条）。谁点的钞、几点点的照常留痕 */
const MONEY_PATHS = [
  'countedCashCents', 'expectedCashCents', 'varianceCents', 'amountCents',
  'openingFloatCents', 'closingFloatCents', 'cardTerminalCents',
  'payouts.*.paidCents', 'payouts.*.owedCents', 'payouts.*.carryOutCents',
  'totalPaidCents', 'grossCents', 'netCents', 'tipCashCents', 'tipCardCents',
] as const;

/**
 * ⭐ 现金进出。正 = 进抽屉，负 = 出抽屉。
 *
 * 「拿两百块去买棉片」「中午存了五百去银行」—— 这些不记，
 * 晚上点钞就会凭空少两百，然后老板开始怀疑前台。
 */
export const RecordCashMovement = defineCommand({
  name: 'dayclose.recordCash',
  input: z.object({
    businessDate: businessDate.optional(),
    kind: z.enum([
      'opening_float',    // 早上放备用金
      'cash_drop',        // 中途取走存银行/进保险柜
      'supply_purchase',  // 拿现金买东西
      'payout_owner',     // 老板拿走
      'other',
    ]),
    /** 正进负出。买东西/取走一律传负数 */
    amountCents: cents,
    note: z.string().max(200).optional(),
  }),
  output: z.object({ movementId: uuid, businessDate: z.string() }),
  permission: 'dayclose.manage',
  ai: {
    description: '记一笔现金进出（备用金、取现存银行、拿现金买东西）。出账传负数。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
  auditRedact: MONEY_PATHS,
});

/**
 * ⭐ 点钞。按面额填张数，也可以只填一个总额。
 *
 * 面额表是可选的，但一旦开始按面额点就要求点完 ——
 * 半途而废的面额表会让第二天查账的人以为那是完整的。
 */
export const SaveCashCount = defineCommand({
  name: 'dayclose.saveCount',
  input: z.object({
    businessDate: businessDate.optional(),
    /** 面额（分）→ 张数。{"10000":3,"2000":7} */
    breakdown: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()).default({}),
    /** 不按面额点时直接给总额。两个都给时以 breakdown 为准 */
    countedCashCents: cents.nonnegative().optional(),
    openingFloatCents: cents.nonnegative().optional(),
    closingFloatCents: cents.nonnegative().optional(),
    /** 刷卡机打出来的 batch total（含小费）。前台照着小票敲 */
    cardTerminalCents: cents.nonnegative().optional(),
    cashVarianceReason: z.string().max(300).optional(),
    cardVarianceReason: z.string().max(300).optional(),
    note: z.string().max(500).optional(),
  }),
  output: z.object({
    businessDate: z.string(),
    countedCashCents: cents,
    expectedCashCents: cents,
    cashVarianceCents: cents,
    cardExpectedCents: cents,
    cardVarianceCents: cents,
    needsCashReason: z.boolean(),
    needsCardReason: z.boolean(),
  }),
  permission: 'dayclose.manage',
  ai: {
    description: '录入打烊点钞结果与刷卡机汇总，返回账实差异。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
  auditRedact: MONEY_PATHS,
});

/**
 * ⭐ 发现金小费。老板逐人数钞票、确认入账。
 *
 * 发多少由前端按 planTipPayouts() 算好再传上来，服务端**重算一遍**校对 ——
 * 前端算的数只是给人看的，落库的必须是服务端自己算的。
 *
 * 零头结转：欠 $37.60 时给 $37，剩六毛明天一起给。
 * 这不是我们发明的，这是本子上原本就在记的东西。
 */
export const PayCashTips = defineCommand({
  name: 'dayclose.payTips',
  input: z.object({
    businessDate: businessDate.optional(),
    /** 发放粒度：100 = 发到整元（默认），1 = 有硬币能发到分 */
    roundToCents: z.number().int().min(1).max(10000).default(100),
    /** 只发这几个人；不传就是今天有现金小费的所有人 */
    membershipIds: z.array(uuid).max(50).optional(),
  }),
  output: z.object({
    businessDate: z.string(),
    totalPaidCents: cents,
    payouts: z.array(z.object({
      membershipId: uuid,
      name: z.string(),
      owedCents: cents,
      paidCents: cents,
      carryOutCents: cents,
      /** 照着数的钞票面额：{"2000":1,"1000":1,"500":1} */
      bills: z.record(z.string(), z.number().int()),
    })),
  }),
  permission: 'tip.payout',
  ai: {
    description: '发放今日现金小费。零头结转到明天，并自动记一笔现金出账。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
  auditRedact: MONEY_PATHS,
});

/**
 * 封账。封了之后这一天的单不能再改。
 *
 * 拦两件事：还有单没结完、差异超阈值却没写原因。
 * 两条都可以被人为绕过（结掉/写原因），但绝不静默放行 ——
 * 「封了但没数」是最没用的一种日结。
 */
export const FinalizeDay = defineCommand({
  name: 'dayclose.finalize',
  input: z.object({
    businessDate: businessDate.optional(),
    /** 还有单没结完时，确认是否照样封账（那些单会留到明天） */
    force: z.boolean().default(false),
    note: z.string().max(500).optional(),
  }),
  output: z.object({
    businessDate: z.string(),
    grossCents: cents,
    netCents: cents,
    tipCashCents: cents,
    tipCardCents: cents,
    cashVarianceCents: cents,
    cardVarianceCents: cents,
  }),
  permission: 'dayclose.manage',
  ai: {
    description: '封账。还有未结单或差异未说明时会被拒绝。',
    confirm: 'always',
  },
  reversible: false,      // 封账本身要靠 reopen 撤，不套撤销窗口
  idempotency: 'optional',
  auditRedact: MONEY_PATHS,
});

/** 封错了得能开回来 —— 但要留痕，而且只有老板/店长能做 */
export const ReopenDay = defineCommand({
  name: 'dayclose.reopen',
  input: z.object({
    businessDate,
    reason: z.string().min(2).max(300),
  }),
  output: z.object({ businessDate: z.string(), status: z.literal('counted') }),
  permission: 'payroll.configure',
  ai: { description: '重新打开一个已封账的营业日。必须给原因。', confirm: 'always' },
  reversible: false,
  idempotency: 'optional',
});

/**
 * ⭐ 标记一个断档的日子（2026-08-20 补）。
 *
 * 门店会有整天不用系统的时候 —— 前台请假、太忙、干脆用回纸本子。
 * 这件事本身完全正常，系统不该阻止；但第二天回来的时候，
 * 得有一条路把那天**说清楚**，否则报表会在没人察觉的情况下少一块。
 *
 * 三个终态，对应老板真正会说的三句话：
 *
 *   no_business   「那天没开门」   → 报表里是真实的 0
 *   paper_only    「用纸记的，不补了」→ 报表里是空白，合计不含它
 *   summary_only  「我把总数敲给你」 → 营业额对得上
 *
 * ⚠️ **summary_only 补得了营业额，补不了提成。** 系统不知道那天
 * 哪一单是谁做的，所以 earnings 一条都不会生成。界面上必须当面说清楚，
 * 不能让老板以为补上了，月底发工资才发现那天的提成是空的。
 *
 * ⚠️ 那天**已经有真实工单**的话，这个命令一律拒绝。真实数据比一句
 * 事后的概括可信得多，用概括去盖住它是在销毁证据。
 */
export const MarkGapDay = defineCommand({
  name: 'dayclose.markDay',
  input: z.object({
    /** 必填。这个命令天生是给历史用的，「默认今天」在这儿没有意义 */
    businessDate,
    mark: z.enum(['no_business', 'paper_only', 'summary_only']),
    /** mark = summary_only 时必填。照着纸本子敲的总数 */
    summary: z.object({
      grossCents: cents.nonnegative(),
      cashCents: cents.nonnegative().default(0),
      cardCents: cents.nonnegative().default(0),
      tipCashCents: cents.nonnegative().default(0),
      tipCardCents: cents.nonnegative().default(0),
    }).optional(),
    /** 「Lily 请假，我用本子记的」「下雪关门」 */
    note: z.string().max(300).optional(),
  }),
  output: z.object({
    businessDate: z.string(),
    status: z.enum(['no_business', 'paper_only', 'summary_only']),
    /** ⭐ 提醒界面：这天的提成仍然是空的。true 时前端必须显式告知 */
    earningsStillMissing: z.boolean(),
  }),
  permission: 'dayclose.manage',
  ai: {
    description:
      '把一个没记的营业日标成「没营业」「用纸记的不补了」或「补个总数」。'
      + '补总数只补营业额，那天的提成依然算不出来。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
  auditRedact: [...MONEY_PATHS, 'summary.grossCents', 'summary.cashCents',
                'summary.cardCents', 'summary.tipCashCents', 'summary.tipCardCents'],
});

export const DAYCLOSE_COMMANDS = [
  RecordCashMovement, SaveCashCount, PayCashTips, FinalizeDay, ReopenDay, MarkGapDay,
] as const;
