/**
 * 礼品卡（批 5，sql/0043）。
 *
 * ## 三条纪律，每一条都是「错了就是钱错了」
 *
 * 1. **余额是账本推出来的。** `gift_cards.balance_cents` 只是缓存，
 *    每次动账都用 `balanceOfLedger()` 重算一遍再写回去。
 * 2. **只追加。** 退款不是把余额加回去，是插一条反向记录并
 *    `reversal_of_id` 指向被冲的那一行。数据库有触发器兜底。
 * 3. **面值 ≠ 售价。** 卖出 = 负债，核销 = 营收。混成一笔的话，
 *    卖了一万块卡的店会以为自己赚了一万。
 */

import { randomBytes } from 'node:crypto';
import {
  SaveGiftCardTemplate, IssueGiftCard, RedeemGiftCard, RefundGiftCard, AdjustGiftCard,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import {
  balanceOfLedger, planRedeem, commissionBaseForGiftCard,
  encodeCardCode, normalizeCardCode, type CommissionBasis, type LedgerRow,
} from '@gf/payroll';
import { jsonb, ts } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

type Tx = HandlerArgs<unknown>['tx'];
type Ctx = HandlerArgs<unknown>['ctx'];

/** 门店的礼品卡口径（`settings.gift_card`）。缺字段按最保守的兜底 */
async function giftCardSettings(tx: Tx, locationId: string): Promise<{
  commissionBasis: CommissionBasis; defaultScope: 'location' | 'org';
}> {
  const [loc] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${locationId}`;
  const raw = ((loc?.settings ?? {})['gift_card'] ?? {}) as Record<string, unknown>;
  return {
    commissionBasis: raw['commission_basis'] === 'sale' ? 'sale' : 'face',
    defaultScope: raw['default_scope'] === 'org' ? 'org' : 'location',
  };
}

/** 按账本重算余额。**唯一的取余额方式** */
async function ledgerBalance(tx: Tx, giftCardId: string): Promise<number> {
  const rows = await tx<LedgerRow[]>`
    select entry, amount_cents as "amountCents" from customer_credit_ledger
    where kind = 'gift_card' and subject_id = ${giftCardId}
    order by seq`;
  return balanceOfLedger(rows);
}

/**
 * 写一条账本行并把缓存余额同步回卡上。
 *
 * ⚠️ 先算余额再写行、写完再回写缓存 —— 顺序反了会让 `balance_after_cents`
 * 记成写这一行之前的数，而那一列正是对账时用来找断点的。
 */
async function appendLedger(
  tx: Tx, ctx: Ctx,
  e: {
    giftCardId: string; entry: 'issue' | 'redeem' | 'refund' | 'adjust' | 'expire';
    amountCents: number; customerId?: string | null; ticketId?: string | null;
    reversalOfId?: string | null; reason?: string | null; idemKey?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<{ balanceCents: number; rowId: string }> {
  const before = await ledgerBalance(tx, e.giftCardId);
  const after = before + e.amountCents;

  const [row] = await tx<{ id: string }[]>`
    insert into customer_credit_ledger
      (org_id, location_id, kind, subject_id, customer_id, entry,
       amount_cents, balance_after_cents, ticket_id, reversal_of_id,
       reason, actor_membership_id, idem_key, meta)
    values (${ctx.orgId}, ${ctx.locationId}, 'gift_card', ${e.giftCardId},
            ${e.customerId ?? null}, ${e.entry}, ${e.amountCents}, ${after},
            ${e.ticketId ?? null}, ${e.reversalOfId ?? null}, ${e.reason ?? null},
            ${ctx.membershipId}, ${e.idemKey ?? null}, ${jsonb(e.meta ?? {})}::jsonb)
    returning id`;

  /*
   * 缓存回写 + 状态。
   * ⚠️ 余额归零就标 `depleted` —— 不标的话前台在「有效卡」列表里
   * 会一直看到一堆 $0 的卡，而她要从里面找那张还有钱的。
   */
  await tx`
    update gift_cards set
      balance_cents = ${after},
      status = case when ${after} <= 0 and status = 'active' then 'depleted'
                    when ${after} > 0 and status = 'depleted' then 'active'
                    else status end,
      updated_at = now()
    where id = ${e.giftCardId}`;

  return { balanceCents: after, rowId: row!.id };
}

/**
 * 把卡找出来。
 *
 * ⭐ **scope 决定能不能在本店用**：`location` 的卡只能在售出店核销，
 * `org` 的卡同 org 任意店都行。RLS 已经把跨 org 挡死了，
 * 这里判的是 org 内部的那一层。
 */
async function loadCard(tx: Tx, ctx: Ctx, by: { code?: string; id?: string }) {
  const code = by.code ? normalizeCardCode(by.code) : null;
  const [card] = await tx<{
    id: string; location_id: string; scope: string; status: string;
    balance_cents: number; face_value_cents: number; sale_price_cents: number;
    holder_customer_id: string | null; expires_at: Date | string | null;
  }[]>`
    select id, location_id, scope, status, balance_cents,
           face_value_cents, sale_price_cents, holder_customer_id, expires_at
    from gift_cards
    where ${by.id ? tx`id = ${by.id}` : tx`replace(code, '-', '') = ${code}`}
    for update`;

  if (!card) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'gift_card' } });

  if (card.scope !== 'org' && card.location_id !== ctx.locationId) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'gift_card_other_location', giftCardId: card.id },
    });
  }
  if (card.status === 'void' || card.status === 'expired') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: `gift_card_${card.status}`, giftCardId: card.id },
    });
  }
  if (card.expires_at && new Date(ts(card.expires_at)).getTime() < Date.now()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'gift_card_expired', giftCardId: card.id },
    });
  }
  return card;
}

// ───────────────────────────────────────────────────────────────── 模板

registerHandler(SaveGiftCardTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveGiftCardTemplate.input._type>) => {
  /*
   * ⚠️ 售价高于面值直接拦下。
   *
   * 那不是促销是打反了 —— 客人付 $100 拿到一张 $80 的卡。
   * 允许它的话，第一个发现的人是客人，而他会当场认为这家店在骗人。
   */
  if (input.salePriceCents > input.faceValueCents) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'sale_price_above_face_value',
        faceValueCents: input.faceValueCents, salePriceCents: input.salePriceCents,
      },
    });
  }

  const [row] = input.id
    ? await tx<{ id: string }[]>`
        update gift_card_templates set
          name = ${jsonb(input.name)}::jsonb,
          face_value_cents = ${input.faceValueCents},
          sale_price_cents = ${input.salePriceCents},
          valid_days = ${input.validDays ?? null},
          scope = ${input.scope}, online_sale = ${input.onlineSale},
          active = ${input.active}, updated_at = now()
        where id = ${input.id} and location_id = ${ctx.locationId}
        returning id`
    : await tx<{ id: string }[]>`
        insert into gift_card_templates
          (org_id, location_id, name, face_value_cents, sale_price_cents,
           valid_days, scope, online_sale, active)
        values (${ctx.orgId}, ${ctx.locationId}, ${jsonb(input.name)}::jsonb,
                ${input.faceValueCents}, ${input.salePriceCents},
                ${input.validDays ?? null}, ${input.scope}, ${input.onlineSale}, ${input.active})
        returning id`;

  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'gift_card_template' } });

  audit({
    entityType: 'gift_card_template', entityId: row.id,
    after: {
      faceValueCents: input.faceValueCents, salePriceCents: input.salePriceCents,
      scope: input.scope, active: input.active,
    },
  });
  return { templateId: row.id };
});

// ───────────────────────────────────────────────────────────────── 发卡

registerHandler(IssueGiftCard, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof IssueGiftCard.input._type>) => {
  const settings = await giftCardSettings(tx, ctx.locationId);

  let face = input.faceValueCents ?? 0;
  let sale = input.salePriceCents ?? 0;
  let scope = input.scope ?? settings.defaultScope;
  let validDays: number | null = null;

  if (input.templateId) {
    const [t] = await tx<{
      face: number; sale: number; scope: string; valid_days: number | null; active: boolean;
    }[]>`
      select face_value_cents as face, sale_price_cents as sale, scope, valid_days, active
      from gift_card_templates
      where id = ${input.templateId} and location_id = ${ctx.locationId}`;
    if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'gift_card_template' } });
    if (!t.active) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'template_inactive' } });
    }
    face = t.face; sale = t.sale;
    scope = (input.scope ?? t.scope) as 'location' | 'org';
    validDays = t.valid_days;
  }

  if (face <= 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'missing_face_value' },
    });
  }

  /*
   * 卡号：22 位 Crockford base32（≈110 bit）。
   * ⚠️ 随机源必须是 `node:crypto` —— 能猜的卡号等于把店里的钱放门口。
   * 撞号的概率可以忽略，但**还是要重试**：唯一索引撞了直接 500
   * 比多写三行难看得多。
   */
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = encodeCardCode(randomBytes(32));
    const [taken] = await tx<{ id: string }[]>`
      select id from gift_cards where code = ${candidate}`;
    if (!taken) { code = candidate; break; }
  }
  if (!code) throw new AppError(ERROR_CODES.INTERNAL, { details: { reason: 'code_generation' } });

  const expiresAt = validDays
    ? new Date(Date.now() + validDays * 86400_000) : null;

  const [card] = await tx<{ id: string }[]>`
    insert into gift_cards
      (org_id, location_id, template_id, code, face_value_cents, sale_price_cents,
       balance_cents, scope, purchaser_customer_id, holder_customer_id,
       recipient_name, recipient_note, source, sold_ticket_id, issued_by, expires_at)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.templateId ?? null}, ${code},
            ${face}, ${sale}, 0, ${scope},
            ${input.purchaserCustomerId ?? null}, ${input.holderCustomerId ?? null},
            ${input.recipientName ?? null}, ${input.recipientNote ?? null},
            ${input.source}, ${input.soldTicketId ?? null}, ${ctx.membershipId},
            ${expiresAt ? ts(expiresAt) : null}::timestamptz)
    returning id`;

  // 余额从账本来：先建卡（balance 0），再记一条 issue 把面值加上去
  const { balanceCents } = await appendLedger(tx, ctx, {
    giftCardId: card!.id, entry: 'issue', amountCents: face,
    customerId: input.purchaserCustomerId ?? null,
    ticketId: input.soldTicketId ?? null,
    meta: { salePriceCents: sale, source: input.source },
  });

  audit({
    entityType: 'gift_card', entityId: card!.id,
    // ⚠️ 审计里**不留卡号** —— audit_log 是给人翻的，
    // 而卡号就是钱（同「审计留动作不留金额」的思路）
    after: {
      faceValueCents: face, salePriceCents: sale, scope,
      source: input.source, balanceCents,
    },
  });

  return {
    giftCardId: card!.id, code,
    faceValueCents: face, salePriceCents: sale,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
});

// ───────────────────────────────────────────────────────────────── 核销

registerHandler(RedeemGiftCard, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RedeemGiftCard.input._type>) => {
  if (!input.code && !input.giftCardId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_card' } });
  }
  const card = await loadCard(tx, ctx, {
    ...(input.code ? { code: input.code } : {}),
    ...(input.giftCardId ? { id: input.giftCardId } : {}),
  });

  const balance = await ledgerBalance(tx, card.id);
  const plan = planRedeem(balance, input.dueCents);

  if (plan.appliedCents === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'gift_card_empty', giftCardId: card.id, balanceCents: balance },
    });
  }

  await appendLedger(tx, ctx, {
    giftCardId: card.id, entry: 'redeem', amountCents: -plan.appliedCents,
    customerId: card.holder_customer_id,
    ticketId: input.ticketId ?? null,
  });

  const settings = await giftCardSettings(tx, ctx.locationId);
  const commissionBaseCents = commissionBaseForGiftCard(
    settings.commissionBasis, plan.appliedCents,
    card.face_value_cents, card.sale_price_cents);

  audit({
    entityType: 'gift_card', entityId: card.id,
    before: { balanceCents: balance },
    after: {
      appliedCents: plan.appliedCents, remainingCents: plan.remainingCents,
      commissionBasis: settings.commissionBasis, ticketId: input.ticketId ?? null,
    },
  });

  return {
    giftCardId: card.id,
    appliedCents: plan.appliedCents,
    remainingCents: plan.remainingCents,
    shortfallCents: plan.shortfallCents,
    commissionBaseCents,
  };
});

// ───────────────────────────────────────────────────────────────── 退与调整

registerHandler(RefundGiftCard, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RefundGiftCard.input._type>) => {
  const card = await loadCard(tx, ctx, { id: input.giftCardId });

  /*
   * 不指定金额时退**最近一次核销**的全额。
   * 前台最常见的动作是「刚才刷错了，退回去」，让她算金额是多余的一步。
   */
  let amount = input.amountCents ?? 0;
  let reversalOf = input.reversalOfId ?? null;
  if (!input.amountCents) {
    const [last] = await tx<{ id: string; amount_cents: number }[]>`
      select id, amount_cents from customer_credit_ledger
      where kind = 'gift_card' and subject_id = ${card.id} and entry = 'redeem'
        and not exists (
          select 1 from customer_credit_ledger r where r.reversal_of_id = customer_credit_ledger.id)
      order by seq desc limit 1`;
    if (!last) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'nothing_to_refund', giftCardId: card.id },
      });
    }
    amount = Math.abs(last.amount_cents);
    reversalOf = last.id;
  }

  const { balanceCents } = await appendLedger(tx, ctx, {
    giftCardId: card.id, entry: 'refund', amountCents: amount,
    customerId: card.holder_customer_id,
    reversalOfId: reversalOf, reason: input.reason,
  });

  audit({
    entityType: 'gift_card', entityId: card.id,
    after: { refundedCents: amount, reason: input.reason, reversalOfId: reversalOf },
  });
  return { giftCardId: card.id, refundedCents: amount, balanceCents };
});

registerHandler(AdjustGiftCard, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AdjustGiftCard.input._type>) => {
  const card = await loadCard(tx, ctx, { id: input.giftCardId });

  if (input.amountCents === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'zero_adjustment' } });
  }
  const balance = await ledgerBalance(tx, card.id);
  /*
   * ⚠️ 不让调成负数。
   *
   * 负余额在这个模型里没有意义（卡不是信用额度），而它一旦出现，
   * 下一次核销的 `planRedeem` 会算出 0，前台看到的是「这张卡没钱」——
   * 而账上那个负数没人会去查。
   */
  if (balance + input.amountCents < 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'would_go_negative', balanceCents: balance, delta: input.amountCents },
    });
  }

  const { balanceCents } = await appendLedger(tx, ctx, {
    giftCardId: card.id, entry: 'adjust', amountCents: input.amountCents,
    customerId: card.holder_customer_id, reason: input.reason,
  });

  audit({
    entityType: 'gift_card', entityId: card.id,
    before: { balanceCents: balance },
    after: { delta: input.amountCents, balanceCents, reason: input.reason },
  });
  return { giftCardId: card.id, balanceCents };
});


// ────────────────────────────────────── 给结账链路用的核销（批 8 收尾）

/**
 * `ticket.close` 里那一步。
 *
 * ⚠️ **不走命令总线**，因为它已经在 `ticket.close` 这条命令的事务里了 ——
 * 嵌套 dispatch 会开第二个事务，而那意味着「单结了但卡没扣」这种半截状态
 * 有可能真的落地。这里直接复用同一个 `tx`，同生共死。
 *
 * ⚠️ **不足额直接抛错，不悄悄少扣。** 前台看到的必须是「这张卡只有 $30，
 * 请改成 $30 再把余下的另开一行」，而不是单据写着 $80、实际扣了 $30 ——
 * 后者会让日结永远差出那一笔，而没人知道差在哪。
 */
export async function redeemForTicket(
  tx: Tx, ctx: Ctx,
  args: { ticketId: string; dueCents: number; giftCardId?: string; code?: string },
): Promise<{ appliedCents: number; commissionBaseCents: number; giftCardId: string }> {
  const card = await loadCard(tx, ctx, {
    ...(args.code ? { code: args.code } : {}),
    ...(args.giftCardId ? { id: args.giftCardId } : {}),
  });

  const balance = await ledgerBalance(tx, card.id);
  const plan = planRedeem(balance, args.dueCents);

  if (plan.shortfallCents > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'gift_card_insufficient',
        giftCardId: card.id,
        balanceCents: balance,
        requestedCents: args.dueCents,
        /** 前台照着这个数改 —— 省掉她自己心算 */
        maxApplicableCents: plan.appliedCents,
      },
    });
  }

  await appendLedger(tx, ctx, {
    giftCardId: card.id, entry: 'redeem', amountCents: -plan.appliedCents,
    customerId: card.holder_customer_id, ticketId: args.ticketId,
  });

  const settings = await giftCardSettings(tx, ctx.locationId);
  return {
    giftCardId: card.id,
    appliedCents: plan.appliedCents,
    commissionBaseCents: commissionBaseForGiftCard(
      settings.commissionBasis, plan.appliedCents,
      card.face_value_cents, card.sale_price_cents),
  };
}
