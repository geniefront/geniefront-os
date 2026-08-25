/**
 * 礼品卡命令（批 5）。
 *
 * ⭐ 所有金额变动都落 `customer_credit_ledger`，**只追加、只冲销、
 * 永不 UPDATE**（宪法第 9 条）。退卡不是把余额加回去，是插一条
 * 反向记录并指向被冲的那一行。
 */

import { z } from 'zod';
import { defineCommand } from '../command.js';

const uuid = z.string().uuid();
const cents = z.number().int();
const i18nText = z.record(z.string().min(1), z.string().max(200));

export const SaveGiftCardTemplate = defineCommand({
  name: 'giftcard.saveTemplate',
  input: z.object({
    id: uuid.optional(),
    name: i18nText,
    /** 卡里有多少钱 */
    faceValueCents: cents.positive(),
    /**
     * 客人付多少钱。**可以小于面值** —— 「买 $100 付 $80」是这行
     * 最常见的促销，两个数分开存才算得清负债和促销成本。
     */
    salePriceCents: cents.nonnegative(),
    /**
     * 多少天后过期。不填 = 永不过期。
     *
     * ⚠️ 美国多数州禁止礼品卡在 5 年内过期，有的州完全禁止。
     * 我们不替店家判法律 —— 但**不填就是不过期**，那是唯一安全的默认。
     */
    validDays: z.number().int().positive().max(3650).nullable().optional(),
    /** `location`（只能在售出店用）/ `org`（同 org 任意店） */
    scope: z.enum(['location', 'org']).default('location'),
    onlineSale: z.boolean().default(false),
    active: z.boolean().default(true),
  }),
  output: z.object({ templateId: uuid }),
  permission: 'settings.manage',
  ai: { description: '新建或修改一种礼品卡（面值、售价、有效期）。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const IssueGiftCard = defineCommand({
  name: 'giftcard.issue',
  input: z.object({
    templateId: uuid.optional(),
    /** 不用模板时直接给面值与售价 */
    faceValueCents: cents.positive().optional(),
    salePriceCents: cents.nonnegative().optional(),
    scope: z.enum(['location', 'org']).optional(),
    purchaserCustomerId: uuid.nullable().optional(),
    holderCustomerId: uuid.nullable().optional(),
    recipientName: z.string().max(120).optional(),
    recipientNote: z.string().max(500).optional(),
    source: z.enum(['front_desk', 'online', 'bulk', 'auto']).default('front_desk'),
    /** 卖卡也是一笔生意，挂在哪张单上 */
    soldTicketId: uuid.nullable().optional(),
  }),
  output: z.object({
    giftCardId: uuid,
    /** ⚠️ 明文卡号。前台要念给客人或印在卡上 */
    code: z.string(),
    faceValueCents: cents,
    salePriceCents: cents,
    expiresAt: z.string().nullable(),
  }),
  permission: 'ticket.write',
  ai: { description: '发一张礼品卡。', confirm: 'always' },
  reversible: true,
  idempotency: 'required',
});

export const RedeemGiftCard = defineCommand({
  name: 'giftcard.redeem',
  input: z.object({
    /** 卡号或卡 id，二选一。前台扫码给 id，客人念号给 code */
    code: z.string().max(60).optional(),
    giftCardId: uuid.optional(),
    /** 这一单要付多少。**不足额时扣一部分，不整笔拒绝** */
    dueCents: cents.positive(),
    ticketId: uuid.nullable().optional(),
  }),
  output: z.object({
    giftCardId: uuid,
    appliedCents: cents,
    remainingCents: cents,
    /** 还差多少要用别的方式付 */
    shortfallCents: cents,
    /** 这次用卡付的部分，技师提成该按多少算（老板设的口径） */
    commissionBaseCents: cents,
  }),
  permission: 'ticket.write',
  ai: { description: '用礼品卡抵扣一笔金额。', confirm: 'always' },
  reversible: true,
  idempotency: 'required',
});

export const RefundGiftCard = defineCommand({
  name: 'giftcard.refund',
  input: z.object({
    giftCardId: uuid,
    /** 退多少回卡里。不填 = 把这张卡上最近一次核销全退回 */
    amountCents: cents.positive().optional(),
    /** ⚠️ 必填。财务冲销永远要有理由（同作废工单） */
    reason: z.string().min(2).max(200),
    /** 冲的是账本上哪一行 */
    reversalOfId: uuid.optional(),
  }),
  output: z.object({ giftCardId: uuid, refundedCents: cents, balanceCents: cents }),
  permission: 'ticket.void',
  ai: { description: '把礼品卡上已核销的金额退回卡里。', confirm: 'always' },
  reversible: false,
  idempotency: 'required',
});

export const AdjustGiftCard = defineCommand({
  name: 'giftcard.adjust',
  input: z.object({
    giftCardId: uuid,
    /** 有符号。加钱为正，扣钱为负 */
    amountCents: cents,
    reason: z.string().min(2).max(200),
  }),
  output: z.object({ giftCardId: uuid, balanceCents: cents }),
  /**
   * ⚠️ 权限是 `dayclose.manage` 而不是 `ticket.write` ——
   * 「凭空给一张卡加钱」和「收一笔钱」不是同一件事，
   * 前者只有能封账的人（老板/店长）该有。
   */
  permission: 'dayclose.manage',
  ai: { description: '人工调整礼品卡余额，必须写原因。', confirm: 'always' },
  reversible: false,
  idempotency: 'required',
});

export const GIFTCARD_COMMANDS = [
  SaveGiftCardTemplate, IssueGiftCard, RedeemGiftCard, RefundGiftCard, AdjustGiftCard,
] as const;
