/**
 * 礼品卡列表查询（Marketing.tsx / Checkout.tsx，P1 营销体系）
 */

import type postgres from 'postgres';
import { pickText, type CommandContext, asInt } from '@gf/contracts';

export interface GiftCardRowDto {
  id: string;
  code: string;
  faceValueCents: number;
  salePriceCents: number;
  balanceCents: number;
  scope: string;
  status: 'active' | 'depleted' | 'expired' | 'void';
  source: string;
  purchaserName: string | null;
  holderName: string | null;
  recipientName: string | null;
  templateName: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function loadGiftCards(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  params: {
    status?: string | undefined;
    q?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {},
): Promise<{ total: number; rows: GiftCardRowDto[] }> {
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);
  const q = params.q?.trim() ?? '';
  const status = params.status && params.status !== 'all' ? params.status : null;

  const whereStatus = status ? tx`and gc.status = ${status}` : tx``;
  const whereQ = q
    ? tx`and (gc.code ilike ${`%${q}%`} or gc.recipient_name ilike ${`%${q}%`} or c1.display_name ilike ${`%${q}%`} or c2.display_name ilike ${`%${q}%`})`
    : tx``;

  const [countRow] = await tx<{ total: string }[]>`
    select count(*)::text as total
    from gift_cards gc
    left join customers c1 on c1.id = gc.purchaser_customer_id
    left join customers c2 on c2.id = gc.holder_customer_id
    where gc.org_id = ${ctx.orgId}
      ${whereStatus}
      ${whereQ}`;

  const total = asInt(countRow?.total, 0);

  const rows = await tx<{
    id: string; code: string; face_value_cents: number; sale_price_cents: number;
    balance_cents: number; scope: string; status: string; source: string;
    purchaser_name: string | null; holder_name: string | null;
    recipient_name: string | null; template_name: unknown;
    expires_at: string | null; created_at: string;
  }[]>`
    select gc.id, gc.code, gc.face_value_cents, gc.sale_price_cents,
           gc.balance_cents, gc.scope, gc.status, gc.source,
           c1.display_name as purchaser_name,
           c2.display_name as holder_name,
           gc.recipient_name,
           t.name as template_name,
           gc.expires_at::text as expires_at,
           gc.created_at::text as created_at
    from gift_cards gc
    left join gift_card_templates t on t.id = gc.template_id
    left join customers c1 on c1.id = gc.purchaser_customer_id
    left join customers c2 on c2.id = gc.holder_customer_id
    where gc.org_id = ${ctx.orgId}
      ${whereStatus}
      ${whereQ}
    order by gc.created_at desc
    limit ${limit} offset ${offset}`;

  const dtoList: GiftCardRowDto[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    faceValueCents: r.face_value_cents,
    salePriceCents: r.sale_price_cents,
    balanceCents: r.balance_cents,
    scope: r.scope,
    status: r.status as GiftCardRowDto['status'],
    source: r.source,
    purchaserName: r.purchaser_name,
    holderName: r.holder_name,
    recipientName: r.recipient_name,
    templateName: r.template_name ? pickText(r.template_name, ctx.locale, '') : null,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));

  return { total, rows: dtoList };
}

export interface GiftCardVerifyDto {
  valid: boolean;
  giftCardId?: string;
  code: string;
  balanceCents: number;
  recipientName?: string | null;
  status: 'active' | 'depleted' | 'expired' | 'void';
}

export async function loadGiftCardVerify(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  code: string,
): Promise<GiftCardVerifyDto> {
  const cleanCode = code.trim();
  const [gc] = await tx<{
    id: string; code: string; balance_cents: number;
    recipient_name: string | null; status: string;
    expires_at: string | null;
  }[]>`
    select id, code, balance_cents, recipient_name, status, expires_at::text
    from gift_cards
    where org_id = ${ctx.orgId} and (code = ${cleanCode} or lower(code) = lower(${cleanCode}))
    limit 1`;

  if (!gc) {
    return {
      valid: false,
      code: cleanCode,
      balanceCents: 0,
      status: 'void',
    };
  }

  const isExpired = gc.expires_at && new Date(gc.expires_at).getTime() < Date.now();
  const effectiveStatus = (isExpired ? 'expired' : gc.status) as GiftCardVerifyDto['status'];
  const isValid = effectiveStatus === 'active' && gc.balance_cents > 0;

  return {
    valid: isValid,
    giftCardId: gc.id,
    code: gc.code,
    balanceCents: gc.balance_cents,
    recipientName: gc.recipient_name,
    status: effectiveStatus,
  };
}

