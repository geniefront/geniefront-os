/**
 * 工单命令：开单 → 加钟/加项 → 结账 → （或）作废
 *
 * 决策 22：流程必须完整走完 —— 顾客付现金还是刷卡，往往要到结账那一刻才知道。
 * 结账后两条出口：正常入账，或作废（必选原因，记录保留但不计营业额）。
 *
 * 审计只留动作不留金额：这几个命令都声明了 auditRedact。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents } from '../command.js';

/** 决策 19：只区分现金与刷卡。Zelle 按现金记，不记店内零钱流水 */
/**
 * ⚠️ `gift_card` 加于批 8 收尾。它和另外三种**不是一回事**：
 *
 *   cash / card / external —— 真的有钱进来
 *   gift_card             —— 钱**早就进来了**（卖卡那天），这次只是核销
 *
 * 所以它在日结里既不算现金也不算刷卡：算进刷卡的话，晚上和刷卡机的
 * batch total 就永远差出这一笔，而那正是日结要发现的那种差额。
 */
export const paymentMethod = z.enum(['cash', 'card', 'external', 'gift_card', 'customer_credit']);
export const paymentStage = z.enum(['service', 'tip', 'combined']);

export const voidReason = z.enum([
  'duplicate_booking', 'walk_out', 'guest_changed_mind',
  'input_error', 'paid_externally', 'other',
]);

/** 金额字段一律不进审计（宪法第 17 条） */
const MONEY_PATHS = [
  'subtotalCents', 'discountCents', 'taxCents', 'tipCents',
  'serviceChargeCents', 'totalCents', 'unitPriceCents', 'amountCents',
  'refundAmountCents', 'refundTipCents',
  'items.*.unitPriceCents', 'items.*.totalCents',
  'payments.*.amountCents', 'payments.*.tipCents',
  'payments.*.tenderedCents', 'payments.*.changeCents',
  'allocations.*.amountCents',
  'tickets.*.totalCents', 'tickets.*.tipCents',
] as const;

export const TicketOpen = defineCommand({
  name: 'ticket.open',
  input: z.object({
    customerId: uuid.nullable(),
    walkInName: z.string().max(120).optional(),
    appointmentId: uuid.optional(),
    /** 一起来的客人：开单时就知道是一组的话直接带上 */
    groupId: uuid.optional(),
    items: z.array(z.object({
      serviceId: uuid,
      /** 兼容旧客户端；新客户端用 staffAssignments 表达一项多技师。 */
      membershipId: uuid.optional(),
      staffAssignments: z.array(z.object({
        membershipId: uuid,
        role: z.enum(['primary', 'assistant']).default('primary'),
        minutes: z.number().int().positive().max(600).optional(),
      })).min(1).max(5).optional(),
      resourceId: uuid.optional(),
      minutes: z.number().int().positive().max(600).optional(),
      priceCentsOverride: cents.optional(),
    }).refine((item) => Boolean(item.membershipId || item.staffAssignments?.length), {
      message: '每个项目至少需要一位技师',
    })).min(1).max(20),
  }),
  output: z.object({
    ticketId: uuid,
    /** Newly created item ids, in the same order as input.items. */
    ticketItemIds: z.array(uuid),
    subtotalCents: cents,
  }),
  permission: 'ticket.write',
  /*
   * ⚠️ 这里**没有** override 字段，是刻意的：开单不判技师并发。
   * 并发的闸门在 `ticket.startItem`（同时服务几位客人是从点开始才成立的），
   * 放行入口也在那条命令上。
   */
  ai: { description: '给客人开一张服务单。', confirm: 'always' },
  reversible: true,
  idempotency: 'required',
  auditRedact: MONEY_PATHS,
});

export const TicketAddItem = defineCommand({
  name: 'ticket.addItem',
  input: z.object({
    ticketId: uuid,
    serviceId: uuid,
    membershipId: uuid,
    resourceId: uuid.optional(),
    kind: z.enum(['service', 'addon']).default('addon'),
    minutes: z.number().int().positive().max(600).optional(),
    priceCentsOverride: cents.optional(),
  }),
  output: z.object({ ticketItemId: uuid, subtotalCents: cents }),
  permission: 'ticket.write',
  ai: {
    description: '给已开的单加钟或加项（客人做到一半要加个护理）。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
  auditRedact: MONEY_PATHS,
});

/**
 * ⭐ 一笔收款。
 *
 * `amountCents` **含小费** —— 和刷卡机小票上那个数一致，
 * 这样日结拿系统数去比终端 batch total 才对得上。
 *
 * 现金三件套（tendered / change / keepChange）是 Phase 1b 补的：
 * 客人给 $100 做 $85 的活儿说「不用找了」，那 $15 必须落成小费。
 * 不记的话打烊点钞会平白多出 $15，老板只能怀疑前台。
 */
export const paymentLine = z.object({
  method: paymentMethod,
  amountCents: cents.nonnegative(),
  /**
   * `method = 'gift_card'` 时必填其一：扫码给 id，客人念号给 code。
   *
   * ⚠️ 金额以 `amountCents` 为准，但**卡上不够就只扣得动那么多** ——
   * 结账时会当场校验，不足额直接拒绝这一行（让前台改成实际能扣的数，
   * 剩下的另开一行走现金或刷卡）。悄悄少扣的话，单据和账本会对不上。
   */
  giftCardId: z.string().uuid().optional(),
  giftCardCode: z.string().max(60).optional(),
  tipCents: cents.nonnegative().default(0),
  /** 客人递过来的现金。刷卡不填 */
  tenderedCents: cents.nonnegative().optional(),
  /** 实际找出去的现金 */
  changeCents: cents.nonnegative().default(0),
  /** 「不用找了」—— 找零转小费。为 true 时 changeCents 必须是 0 */
  keepChange: z.boolean().default(false),
}).refine((p) => !p.keepChange || p.changeCents === 0, {
  message: '「不用找了」时不该同时有找零',
}).refine(
  (p) => p.method !== 'gift_card' || Boolean(p.giftCardId ?? p.giftCardCode),
  { message: '用礼品卡付要给卡号或卡 id' },
).refine(
  // 礼品卡没有找零这回事 —— 余额不足就少扣，扣多了不会退现金
  (p) => p.method !== 'gift_card' || (p.changeCents === 0 && !p.keepChange),
  { message: '礼品卡没有找零' },
).refine(
  (p) => !['gift_card', 'customer_credit'].includes(p.method) || p.tipCents === 0,
  { message: '礼品卡和客户储值不能支付小费' },
).refine(
  (p) => p.method !== 'customer_credit'
    || (p.tenderedCents === undefined && p.changeCents === 0 && !p.keepChange),
  { message: '客户储值没有现金找零' },
).refine(
  (p) => p.tenderedCents === undefined || p.tenderedCents >= p.amountCents + p.changeCents,
  { message: '客人给的钱不够付这一单' },
);

export const TicketClose = defineCommand({
  name: 'ticket.close',
  input: z.object({
    ticketId: uuid,
    /** 一单可以拆多种支付方式（一部分现金一部分刷卡） */
    payments: z.array(paymentLine).min(1).max(5),
    discountCents: cents.nonnegative().default(0),
    taxCents: cents.nonnegative().default(0),
    taxRateBp: z.number().int().nonnegative().optional(),
    taxCalculationMode: z.enum(['exclusive', 'inclusive']).optional(),
    surchargeCents: cents.nonnegative().default(0),
    surchargeRateBp: z.number().int().nonnegative().optional(),
    tipTotalCents: cents.nonnegative().optional(),
    tipSplits: z.array(z.object({
      staffMembershipId: uuid,
      staffName: z.string().optional(),
      amountCents: cents,
      percentageBp: z.number().optional(),
    })).optional(),
    packageRedemptions: z.array(z.object({
      customerPackageId: uuid,
      units: z.number().int().min(1).default(1),
    })).max(10).optional(),
    itemCommissionSplits: z.array(z.object({
      ticketItemId: uuid,
      staffMembershipId: uuid,
      commissionCents: cents,
    })).optional(),
    notes: z.string().max(2000).optional(),
    /** Legacy close is intentionally the after-service combined entry point. */
    paymentStage: z.literal('combined').default('combined'),
  }),
  output: z.object({
    ticketId: uuid,
    totalCents: cents,
    tipCents: cents,
    taxCents: cents.nonnegative().optional(),
    subtotalCents: cents.nonnegative().optional(),
    allocations: z.array(z.object({
      membershipId: uuid,
      name: z.string(),
      amountCents: cents,
      source: z.enum(['cash', 'card']),
      explain: z.string(),
    })),
  }),
  permission: 'ticket.write',
  ai: {
    description: '结账。现金还是刷卡要到这一刻才知道，所以不能提前假设。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
  auditRedact: MONEY_PATHS,
});

export const TicketPay = defineCommand({
  name: 'ticket.pay',
  input: TicketClose.input.extend({
    payments: z.array(paymentLine).max(5),
    paymentStage: paymentStage.default('combined'),
  }),
  output: TicketClose.output,
  permission: 'ticket.write',
  ai: {
    description: '结账收银与多技师小费分账。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
  auditRedact: MONEY_PATHS,
});

export const TicketVoid = defineCommand({
  name: 'ticket.void',
  input: z.object({
    ticketId: uuid,
    reason: voidReason,
    note: z.string().max(500).optional(),
  }),
  output: z.object({ ticketId: uuid, status: z.literal('voided') }),
  permission: 'ticket.void',
  ai: {
    description: '作废一张单。记录保留不删除，但不计入营业额与日结。必须给原因。',
    confirm: 'always',
  },
  reversible: false,     // 作废本身就是撤销动作，不再套一层
  idempotency: 'optional',
  auditRedact: MONEY_PATHS,
});

// ────────────────────────────────────────────────────────────── 组单

/**
 * ⭐ 把几张单归成一组（一起来的客人）。
 *
 * 为什么不做成「一张单多个客人」：提成、小费、轮牌全部按人次算，
 * 合成一张之后拆不回去。所以永远是一人一单，用组把它们串起来。
 *
 * 归组这个动作往往发生在**结账台**而不是进门时 ——
 * 「我请客」是掏钱那一刻才说的，所以这个命令对已经开着的单也能用。
 */
export const TicketGroup = defineCommand({
  name: 'ticket.group',
  input: z.object({
    ticketIds: z.array(uuid).min(1).max(20),
    /** 前台看得懂的名字：「Lisa 一行 4 位」 */
    label: z.string().max(80).optional(),
    /** 传了就并进已有的组；不传就新建一个 */
    groupId: uuid.optional(),
  }),
  output: z.object({ groupId: uuid, ticketCount: z.number().int() }),
  permission: 'ticket.write',
  ai: {
    description: '把几张单归成一组（一起来的一行客人），之后可以合并结账。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const TicketUngroup = defineCommand({
  name: 'ticket.ungroup',
  input: z.object({ ticketId: uuid }),
  output: z.object({ ticketId: uuid }),
  permission: 'ticket.write',
  ai: { description: '把一张单从组里拆出来（这位客人要自己付）。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

/**
 * ⭐ 组单合并结账：一个人付掉一组单。
 *
 * 拆分规则：按各单的服务金额占比，用最大余额法把收款额与小费摊回每张单，
 * **各单的提成、小费分配、报表口径全都不变** —— 合并的只是「谁掏的钱」。
 *
 * 想各付各的就不用这个命令，照常一张张 ticket.close。
 * 这两种在真店里天天切换，所以两条路都必须一样顺。
 */
export const TicketCloseGroup = defineCommand({
  name: 'ticket.closeGroup',
  input: z.object({
    groupId: uuid,
    /** 明确要一起结的单 —— 组里可能有人先走了、有人要自己付 */
    ticketIds: z.array(uuid).min(1).max(20),
    payments: z.array(paymentLine).min(1).max(5),
    /** 整组的折扣，按各单金额摊 */
    discountCents: cents.nonnegative().default(0),
    taxCents: cents.nonnegative().default(0),
    surchargeCents: cents.nonnegative().default(0),
    /** 掏钱的是哪一位（哪张单）。事后想问「谁付的」看这个 */
    payerTicketId: uuid.optional(),
  }),
  output: z.object({
    groupId: uuid,
    tickets: z.array(z.object({
      ticketId: uuid,
      totalCents: cents,
      tipCents: cents,
    })),
    allocations: z.array(z.object({
      membershipId: uuid,
      name: z.string(),
      amountCents: cents,
      source: z.enum(['cash', 'card']),
      explain: z.string(),
    })),
  }),
  permission: 'ticket.write',
  ai: {
    description: '一个人付掉一组单。钱按各单金额摊回去，提成和小费照常各算各的。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
  auditRedact: MONEY_PATHS,
});


export const TicketRefund = defineCommand({
  name: 'ticket.refund',
  input: z.object({
    ticketId: uuid,
    refundAmountCents: cents.positive(),
    /** 默认只退消费本身；退小费必须明确给出金额。 */
    refundTipCents: cents.nonnegative().default(0),
    reason: z.enum(['customer_dissatisfied', 'wrong_charge', 'accidental_duplicate', 'other']),
    refundMethod: z.enum(['original_payment', 'cash', 'store_credit']).default('original_payment'),
    notes: z.string().max(1000).optional(),
  }),
  output: z.object({
    ticketId: uuid,
    status: z.enum(['closed', 'refunded']),
    refundedCents: cents,
    refundMethod: z.string(),
  }),
  permission: 'ticket.void',
  ai: {
    description: '对已结账单据发起部分或全额退款冲销。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
  auditRedact: MONEY_PATHS,
});

export const TICKET_COMMANDS = [
  TicketOpen, TicketAddItem, TicketClose, TicketPay, TicketVoid,
  TicketGroup, TicketUngroup, TicketCloseGroup, TicketRefund,
] as const;
