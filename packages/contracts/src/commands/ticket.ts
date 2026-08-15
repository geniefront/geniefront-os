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
export const paymentMethod = z.enum(['cash', 'card', 'external']);

export const voidReason = z.enum([
  'duplicate_booking', 'walk_out', 'guest_changed_mind',
  'input_error', 'paid_externally', 'other',
]);

/** 金额字段一律不进审计（宪法第 17 条） */
const MONEY_PATHS = [
  'subtotalCents', 'discountCents', 'taxCents', 'tipCents',
  'serviceChargeCents', 'totalCents', 'unitPriceCents', 'amountCents',
  'items.*.unitPriceCents', 'items.*.totalCents',
  'payments.*.amountCents', 'payments.*.tipCents',
  'allocations.*.amountCents',
] as const;

export const TicketOpen = defineCommand({
  name: 'ticket.open',
  input: z.object({
    customerId: uuid.nullable(),
    walkInName: z.string().max(120).optional(),
    appointmentId: uuid.optional(),
    items: z.array(z.object({
      serviceId: uuid,
      membershipId: uuid,
      minutes: z.number().int().positive().max(600).optional(),
      priceCentsOverride: cents.optional(),
    })).min(1).max(20),
  }),
  output: z.object({ ticketId: uuid, subtotalCents: cents }),
  permission: 'ticket.write',
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

export const TicketClose = defineCommand({
  name: 'ticket.close',
  input: z.object({
    ticketId: uuid,
    /** 一单可以拆多种支付方式（一部分现金一部分刷卡） */
    payments: z.array(z.object({
      method: paymentMethod,
      amountCents: cents.nonnegative(),
      tipCents: cents.nonnegative().default(0),
    })).min(1).max(5),
    discountCents: cents.nonnegative().default(0),
  }),
  output: z.object({
    ticketId: uuid,
    totalCents: cents,
    tipCents: cents,
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

export const TICKET_COMMANDS = [TicketOpen, TicketAddItem, TicketClose, TicketVoid] as const;
