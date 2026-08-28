/**
 * 门店收入估算与记账查询。
 * GenieFront 不代收客户款、不操作银行打款，也不执行工资支付。
 */

import type postgres from 'postgres';
import { AppError, ERROR_CODES, pickText, type CommandContext } from '@gf/contracts';

export interface EarningsEstimateItem {
  membershipId: string;
  name: string;
  jobTitle: string;
  baseSalaryCents: number;
  serviceSalesCents: number;
  serviceCommissionCents: number;
  retailSalesCents: number;
  retailCommissionCents: number;
  cardTipsCents: number;
  bonusCents: number;
  deductionsCents: number;
  netPayCents: number;
  status: 'estimate';
}

export async function loadEarningsEstimates(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ rows: EarningsEstimateItem[] }> {
  const rows = await tx<{
    membership_id: string; name: unknown; job_title: unknown; base_salary_cents: number;
    service_sales_cents: number; service_commission_cents: number; retail_sales_cents: number;
    retail_commission_cents: number; card_tips_cents: number; bonus_cents: number;
    deductions_cents: number; net_pay_cents: number;
  }[]>`select e.membership_id, sp.display_name as name, sp.job_title,
       0::int as base_salary_cents,
       coalesce(sum(e.base_cents) filter (where e.kind = 'commission'), 0)::int as service_sales_cents,
       coalesce(sum(e.amount_cents) filter (where e.kind = 'commission'), 0)::int as service_commission_cents,
       0::int as retail_sales_cents, 0::int as retail_commission_cents,
       coalesce(sum(e.amount_cents) filter (where e.kind = 'tip_card'), 0)::int as card_tips_cents,
       0::int as bonus_cents, 0::int as deductions_cents,
       coalesce(sum(e.amount_cents), 0)::int as net_pay_cents
       from earnings e
       left join staff_profiles sp on sp.membership_id = e.membership_id
       where e.location_id = ${ctx.locationId}
         and e.business_date between current_date - 13 and current_date
         and e.reversed_at is null
       group by e.membership_id, sp.display_name, sp.job_title
       order by net_pay_cents desc, e.membership_id limit 200`;
  return { rows: rows.map((row) => ({
    membershipId: row.membership_id, name: pickText(row.name, ctx.locale),
    jobTitle: pickText(row.job_title, ctx.locale), baseSalaryCents: row.base_salary_cents,
    serviceSalesCents: row.service_sales_cents,
    serviceCommissionCents: row.service_commission_cents,
    retailSalesCents: row.retail_sales_cents,
    retailCommissionCents: row.retail_commission_cents, cardTipsCents: row.card_tips_cents,
    bonusCents: row.bonus_cents, deductionsCents: row.deductions_cents,
    netPayCents: row.net_pay_cents, status: 'estimate',
  })) };
}

export async function loadEarningsEstimate(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  membershipId: string,
): Promise<{ estimate: EarningsEstimateItem }> {
  const list = await loadEarningsEstimates(tx, ctx);
  const found = list.rows.find((row) => row.membershipId === membershipId);
  if (found) return { estimate: found };
  throw new AppError(ERROR_CODES.NOT_FOUND, {
    details: { entity: 'earnings_estimate', membershipId },
  });
}

export interface ClawbackItem {
  id: string;
  ticketId: string;
  customerName: string;
  staffName: string;
  refundAmountCents: number;
  clawbackCommissionCents: number;
  reason: string;
  date: string;
}

export async function loadClawbacks(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ rows: ClawbackItem[] }> {
  const rows = await tx<{
    id: string; ticket_id: string; customer_name: string | null; staff_name: unknown;
    refund_amount: number; clawback: number; reason: string; date: string;
  }[]>`select e.id, e.ticket_id, c.display_name as customer_name, sp.display_name as staff_name,
       tr.amount_cents as refund_amount, -e.amount_cents as clawback,
       tr.reason, tr.created_at::text as date
       from earnings e
       join ticket_refunds tr on tr.id::text = e.basis->>'refundId'
       join tickets t on t.id = e.ticket_id
       left join customers c on c.id = t.customer_id
       left join staff_profiles sp on sp.membership_id = e.membership_id
       where e.location_id = ${ctx.locationId} and e.kind = 'commission'
         and e.amount_cents < 0 and e.reversed_at is null
       order by tr.created_at desc limit 200`;
  return { rows: rows.map((row) => ({
    id: row.id, ticketId: row.ticket_id, customerName: row.customer_name ?? '',
    staffName: pickText(row.staff_name, ctx.locale), refundAmountCents: row.refund_amount,
    clawbackCommissionCents: row.clawback, reason: row.reason, date: row.date,
  })) };
}
