/**
 * 资金结算查询。
 *
 * 只有已经落库或由支付服务商同步的数据才应从这里返回。尚未接入的
 * 银行批次、工资批次与提成冲正返回空集合，避免经营页面展示推算数据。
 */

import type postgres from 'postgres';
import { AppError, ERROR_CODES, asCents, pickText, type CommandContext } from '@gf/contracts';

export interface MerchantBalanceResponse {
  availableBalanceCents: number;
  pendingPayoutsCents: number;
  bankAccount: {
    bankName: string;
    last4: string;
    status: 'verified' | 'pending';
  } | null;
  payoutSchedule: 'daily' | 'weekly' | 'manual' | null;
  nextPayoutEstimatedAt: string | null;
  monthlyGmvCents: number;
  processingFeeCents: number;
  netCaptureRateBp: number;
}

export async function loadMerchantBalance(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<MerchantBalanceResponse> {
  const [connection] = await tx<{ id: string }[]>`
    select id from provider_connections
    where location_id = ${ctx.locationId} and capability = 'payments' and status = 'active'
    order by updated_at desc limit 1`;
  if (!connection) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'payment_provider', reason: 'not_configured' },
    });
  }
  const [balance] = await tx<{
    available: number; pending: number; fees: number; bank_name: string | null;
    bank_last4: string | null; bank_status: 'verified' | 'pending' | null;
    schedule: 'daily' | 'weekly' | 'manual' | null; next_at: string | null;
  }[]>`select available_cents as available, pending_cents as pending,
       processing_fee_cents as fees, bank_name, bank_last4, bank_status,
       payout_schedule as schedule, next_payout_at::text as next_at
       from merchant_balance_snapshots where provider_connection_id = ${connection.id}
       order by provider_as_of desc limit 1`;
  if (!balance) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'payment_provider', reason: 'not_synced' },
    });
  }
  const [monthStats] = await tx<{ card_sum: string }[]>`
    select coalesce(sum(p.amount_cents), 0)::text as card_sum
    from payments p
    join tickets t on t.id = p.ticket_id
    where p.location_id = ${ctx.locationId}
      and t.business_date >= to_char(current_date, 'YYYY-MM-01')::date
      and p.method in ('card', 'external')`;

  const monthlyGmvCents = asCents(monthStats?.card_sum ?? 0);
  return {
    availableBalanceCents: balance.available,
    pendingPayoutsCents: balance.pending,
    bankAccount: balance.bank_name && balance.bank_last4 && balance.bank_status
      ? { bankName: balance.bank_name, last4: balance.bank_last4, status: balance.bank_status }
      : null,
    payoutSchedule: balance.schedule,
    nextPayoutEstimatedAt: balance.next_at,
    monthlyGmvCents,
    processingFeeCents: balance.fees,
    netCaptureRateBp: monthlyGmvCents > 0
      ? Math.trunc(((monthlyGmvCents - balance.fees) * 10000) / monthlyGmvCents) : 0,
  };
}

export interface BankPayoutBatchItem {
  id: string;
  payoutId: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  transactionCount: number;
  bankAccount: string;
  status: 'paid' | 'in_transit' | 'failed';
  arrivalDate: string;
  createdAt: string;
}

export async function loadBankPayoutBatches(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ batches: BankPayoutBatchItem[] }> {
  const [connection] = await tx<{ id: string }[]>`
    select id from provider_connections where location_id = ${ctx.locationId}
      and capability = 'payments' and status = 'active' limit 1`;
  if (!connection) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { service: 'payment_provider', reason: 'not_configured' },
  });
  const rows = await tx<{
    id: string; provider_payout_id: string; amount_cents: number; fee_cents: number;
    net_cents: number; transaction_count: number; bank_last4: string | null;
    status: BankPayoutBatchItem['status']; arrival_date: string | null; created_at: string;
  }[]>`select id, provider_payout_id, amount_cents, fee_cents, net_cents,
       transaction_count, bank_last4, status, arrival_date::text as arrival_date,
       provider_created_at::text as created_at
       from payout_batches where provider_connection_id = ${connection.id}
       order by provider_created_at desc limit 100`;
  return { batches: rows.map((row) => ({
    id: row.id, payoutId: row.provider_payout_id, amountCents: row.amount_cents,
    feeCents: row.fee_cents, netCents: row.net_cents,
    transactionCount: row.transaction_count,
    bankAccount: row.bank_last4 ? `•••• ${row.bank_last4}` : '', status: row.status,
    arrivalDate: row.arrival_date ?? '', createdAt: row.created_at,
  })) };
}

export interface PayrollBatchItem {
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
  status: 'paid' | 'pending' | 'draft';
}

export async function loadPayrollBatches(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<{ rows: PayrollBatchItem[] }> {
  const rows = await tx<{
    membership_id: string; name: unknown; job_title: unknown; base_salary_cents: number;
    service_sales_cents: number; service_commission_cents: number; retail_sales_cents: number;
    retail_commission_cents: number; card_tips_cents: number; bonus_cents: number;
    deductions_cents: number; net_pay_cents: number; status: 'paid' | 'pending' | 'draft';
  }[]>`select pbi.membership_id, sp.display_name as name, sp.job_title,
       pbi.base_salary_cents, pbi.service_sales_cents, pbi.service_commission_cents,
       pbi.retail_sales_cents, pbi.retail_commission_cents, pbi.card_tips_cents,
       pbi.bonus_cents, pbi.deductions_cents, pbi.net_pay_cents, pb.status
       from payroll_batch_items pbi join payroll_batches pb on pb.id = pbi.payroll_batch_id
       left join staff_profiles sp on sp.membership_id = pbi.membership_id
       where pb.location_id = ${ctx.locationId} and pb.status <> 'voided'
       order by pb.period_end desc, pbi.membership_id limit 200`;
  return { rows: rows.map((row) => ({
    membershipId: row.membership_id, name: pickText(row.name, ctx.locale),
    jobTitle: pickText(row.job_title, ctx.locale), baseSalaryCents: row.base_salary_cents,
    serviceSalesCents: row.service_sales_cents,
    serviceCommissionCents: row.service_commission_cents,
    retailSalesCents: row.retail_sales_cents,
    retailCommissionCents: row.retail_commission_cents, cardTipsCents: row.card_tips_cents,
    bonusCents: row.bonus_cents, deductionsCents: row.deductions_cents,
    netPayCents: row.net_pay_cents, status: row.status,
  })) };
}

export async function loadPayrollStub(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  membershipId: string,
): Promise<{ stub: PayrollBatchItem }> {
  const list = await loadPayrollBatches(tx, ctx);
  const found = list.rows.find((row) => row.membershipId === membershipId);
  if (found) return { stub: found };
  throw new AppError(ERROR_CODES.NOT_FOUND, {
    details: { entity: 'payroll_stub', membershipId },
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
