/**
 * 结账数据层。
 *
 * 读：`GET /v1/desk/tickets` 未结工单列表。
 * 写：`ticket.close` 结账、`ticket.void` 作废。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { CloseResult, OpenTicketsView, PaymentLine, PaymentStage } from './types';

export const checkoutKeys = {
  openTickets: (membershipId: string | null) => ['desk', 'tickets', membershipId] as const,
};

export function useOpenTickets() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: checkoutKeys.openTickets(membershipId),
    queryFn: () => apiGet<OpenTicketsView>('/v1/desk/tickets'),
    enabled: status === 'ready' && membershipId !== null,
    /* 工单会被技师端与门口 Kiosk 同时改动，窗口重新聚焦时重新拉取。 */
    refetchOnWindowFocus: true,
  });
}

export interface CloseTicketInput {
  ticketId: string;
  payments: PaymentLine[];
  discountCents: number;
  taxCents?: number;
  taxRateBp?: number;
  taxCalculationMode?: 'exclusive' | 'inclusive';
  surchargeCents?: number;
  surchargeRateBp?: number;
  tipTotalCents?: number;
  tipSplits?: Array<{
    staffMembershipId: string;
    staffName?: string;
    amountCents: number;
    percentageBp?: number;
  }>;
  packageRedemptions?: Array<{ customerPackageId: string; units: number }>;
  notes?: string;
  idempotencyKey?: string;
  paymentStage?: PaymentStage;
}

export function useCloseTicket() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    /*
     * ⚠️ 幂等键为必填。结账是最不能被重复执行的操作 —— 超时后的重试若换了键，
     * 客人会被扣两次款，而这类错误往往要到对账时才被发现。
     */
    mutationFn: async (input: CloseTicketInput) =>
      (await runCommand<CloseResult>(
        'ticket.pay',
        {
          ticketId: input.ticketId,
          paymentStage: input.paymentStage ?? 'combined',
          payments: input.payments.map((p) => ({
            method: p.method,
            amountCents: p.amountCents,
            tipCents: p.tipCents,
            changeCents: p.changeCents,
            keepChange: p.keepChange,
            ...(p.tenderedCents !== undefined ? { tenderedCents: p.tenderedCents } : {}),
            ...(p.giftCardId ? { giftCardId: p.giftCardId } : {}),
            ...(p.giftCardCode ? { giftCardCode: p.giftCardCode } : {}),
          })),
          discountCents: input.discountCents,
          taxCents: input.taxCents ?? 0,
          ...(input.taxRateBp !== undefined ? { taxRateBp: input.taxRateBp } : {}),
          ...(input.taxCalculationMode ? { taxCalculationMode: input.taxCalculationMode } : {}),
          surchargeCents: input.surchargeCents ?? 0,
          ...(input.surchargeRateBp !== undefined ? { surchargeRateBp: input.surchargeRateBp } : {}),
          ...(input.tipTotalCents !== undefined ? { tipTotalCents: input.tipTotalCents } : {}),
          ...(input.tipSplits ? { tipSplits: input.tipSplits } : {}),
          ...(input.packageRedemptions ? { packageRedemptions: input.packageRedemptions } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        },
        membershipId!,
        input.idempotencyKey,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: checkoutKeys.openTickets(membershipId) });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'orders'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'dayclose'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export interface VoidTicketInput {
  ticketId: string;
  reason: string;
  note?: string;
}

export function useVoidTicket() {
  const queryClient = useQueryClient();
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (input: VoidTicketInput) =>
      (await runCommand<{ ticketId: string }>(
        'ticket.void',
        {
          ticketId: input.ticketId,
          reason: input.reason,
          ...(input.note ? { note: input.note } : {}),
        },
        membershipId!,
      )).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: checkoutKeys.openTickets(membershipId) });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'orders'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'dayclose'] });
      void queryClient.invalidateQueries({ queryKey: ['desk', 'day'] });
    },
  });
}

export async function verifyGiftCard(code: string): Promise<import('./types').GiftCardVerifyResult> {
  return apiGet<import('./types').GiftCardVerifyResult>(
    `/v1/desk/gift-cards/verify?code=${encodeURIComponent(code.trim())}`,
  );
}


/**
 * 金额解析：把用户输入的美元字符串转为整数分。
 *
 * ⚠️ 不使用 `Number(x) * 100`：浮点乘法在 `1.005` 这类输入上得到
 * 100.49999999999999，四舍五入后少一分。全程按字符串解析、整数运算。
 * 多余小数位一律截断而非进位 —— 宁可少收，不可多收。
 */
export function dollarsToCents(input: string): number {
  const cleaned = input.trim().replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const negative = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const cents = (Number(whole) || 0) * 100 + Number(`${frac}00`.slice(0, 2));
  return negative ? -cents : cents;
}

/** 整数分 → 展示用金额字符串，始终两位小数。 */
export function centsToDollars(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 整数分 → 展示用美元数值。
 *
 * 仅供图表坐标、比例计算这类**必须是数字**的呈现场景使用。
 *
 * ⚠️ 不要先用 `centsToDollars` 格式化成字符串再解析回浮点：那既多一次有损
 * 转换，也让「金额只用整数分」的静态检查无法把它与真正的浮点解析区分开。
 * **任何金额的加减乘除仍必须在分上进行**，本函数只用于最后一步呈现。
 */
export function toDisplayDollars(cents: number): number {
  return cents / 100;
}
