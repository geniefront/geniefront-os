/**
 * 资金结算查询。
 *
 * 只有已经落库或由支付服务商同步的数据才应从这里返回。尚未接入的
 * 银行批次、工资批次与提成冲正返回空集合，避免经营页面展示推算数据。
 */

import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';

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
  const [monthStats] = await tx<{ card_sum: string }[]>`
    select coalesce(sum(p.amount_cents), 0)::text as card_sum
    from payments p
    join tickets t on t.id = p.ticket_id
    where p.location_id = ${ctx.locationId}
      and t.business_date >= to_char(current_date, 'YYYY-MM-01')::date
      and p.method not in ('cash', 'gift_card')`;

  const monthlyGmvCents = Number(monthStats?.card_sum ?? 0);
  return {
    availableBalanceCents: 0,
    pendingPayoutsCents: 0,
    bankAccount: null,
    payoutSchedule: null,
    nextPayoutEstimatedAt: null,
    monthlyGmvCents,
    processingFeeCents: 0,
    netCaptureRateBp: 0,
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
  _tx: postgres.TransactionSql,
  _ctx: CommandContext,
): Promise<{ batches: BankPayoutBatchItem[] }> {
  return { batches: [] };
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
  _tx: postgres.TransactionSql,
  _ctx: CommandContext,
): Promise<{ rows: PayrollBatchItem[] }> {
  return { rows: [] };
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
  _tx: postgres.TransactionSql,
  _ctx: CommandContext,
): Promise<{ rows: ClawbackItem[] }> {
  return { rows: [] };
}
