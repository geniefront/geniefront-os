/**
 * 打烊日结数据类型定义。
 *
 * 与服务端 `GET /v1/desk/dayclose` 及 `dayclose.*` 命令对齐。
 */

export interface CashMovementItem {
  id: string;
  kind: string;
  amountCents: number;
  note: string | null;
  at: string;
}

export interface DayCloseMoney {
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  cashTakeCents: number;
  cardTakeCents: number;
  tipCashCents: number;
  tipCardCents: number;
  movementsCents: number;
  tipPaidOutCents: number;
}

export interface TipPayoutPlanItem {
  membershipId: string;
  name: string;
  owedCents: number;
  payCents: number;
  carryOutCents: number;
  alreadyPaidCents: number;
  bills: Record<string, number>;
}

export interface DayCloseSnapshot {
  businessDate: string;
  status: 'open' | 'counted' | 'closed' | 'no_business' | 'paper_only' | 'summary_only';
  openingFloatCents: number;
  closingFloatCents: number;
  countBreakdown: Record<string, number>;
  countedCashCents: number | null;
  expectedCashCents: number;
  cashVarianceCents: number;
  cashVarianceReason: string | null;
  cardExpectedCents: number;
  cardTerminalCents: number | null;
  cardVarianceCents: number | null;
  cardVarianceReason: string | null;
  money: DayCloseMoney;
  openTicketCount: number;
  movements: CashMovementItem[];
  tipPayouts: TipPayoutPlanItem[];
  varianceThresholdCents: number;
  safeDropCents?: number;
  terminalBatches?: Array<{
    terminalId: string;
    terminalName: string;
    status: 'settled' | 'open' | 'offline';
    transactionCount: number;
    amountCents: number;
  }>;
}

export interface SaveCashCountInput {
  businessDate?: string;
  breakdown?: Record<string, number>;
  countedCashCents?: number;
  openingFloatCents?: number;
  closingFloatCents?: number;
  cardTerminalCents?: number;
  cashVarianceReason?: string;
  cardVarianceReason?: string;
  note?: string;
}

export interface PayCashTipsInput {
  businessDate?: string;
  roundToCents?: number;
  membershipIds?: string[];
}

export interface FinalizeDayInput {
  businessDate?: string;
  force?: boolean;
  note?: string;
}

export interface ReopenDayInput {
  businessDate: string;
  reason: string;
}

export interface RecordCashMovementInput {
  businessDate?: string;
  kind: 'opening_float' | 'cash_drop' | 'supply_purchase' | 'payout_owner' | 'other';
  amountCents: number;
  note?: string;
}
