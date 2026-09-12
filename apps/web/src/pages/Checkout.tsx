import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast, Spinner } from '@heroui/react';
import {
  CreditCard, Banknote, Gift, Receipt, Trash2, Plus, AlertTriangle, Wallet,
  CheckCircle2, Send, RefreshCw, Scissors, User, BedDouble, Sparkles,
  Percent, DollarSign, Users, Award, ShieldCheck, Check, ChevronRight,
  Clock, AlertCircle, Info, Calculator, FileCheck, CheckCircle
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { useErrorMessage } from '@/lib/errorMessage';
import { Search } from 'lucide-react';
import {
  useOpenTickets, useCloseTicket, useVoidTicket, verifyGiftCard,
  dollarsToCents, centsToDollars,
} from '@/features/checkout/api';
import { allocateTips, splitItemRevenueAcrossStaff } from '@/features/queue/checkoutMath';
import { PAYMENT_METHODS } from '@/features/checkout/types';
import { paymentStageFor } from '@/features/checkout/types';
import type { OpenTicket, PaymentLine, PaymentMethod } from '@/features/checkout/types';
import { BundleCheckoutSummary } from '@/features/bundles/BundleCheckoutSummary';
import { useSchedule, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { useCanWrite } from '@/lib/permissions';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { cn, formatI18n, formatPhoneInput } from '@/lib/utils';
import type { TranslationKey } from '@/i18n';

const METHOD_LABELS: Record<PaymentMethod, TranslationKey> = {
  cash: 'payCash',
  card: 'payCard',
  gift_card: 'payGift',
  external: 'methodExternal',
};

const METHOD_ICONS: Record<PaymentMethod, typeof CreditCard> = {
  cash: Banknote,
  card: CreditCard,
  gift_card: Gift,
  external: Wallet,
};

/** 服务端对单张工单的收款笔数上限。 */
const MAX_PAYMENT_LINES = 5;

/** 默认信用卡手续费率 (3.0%) */
const DEFAULT_CARD_SURCHARGE_RATE = 0.03;

/**
 * 界面上的一笔收款。
 */
interface DraftLine {
  method: PaymentMethod;
  baseCents: number;
  tipCents: number;
  tenderedCents?: number;
  tenderedInput?: string;
  changeCents: number;
  keepChange: boolean;
  giftCardId?: string;
  giftCardCode?: string;
  giftCardBalanceCents?: number;
  giftCardRecipient?: string;
  giftCardVerified?: boolean;
  giftCardError?: string;
}

function emptyLine(method: PaymentMethod = 'card'): DraftLine {
  return { method, baseCents: 0, tipCents: 0, changeCents: 0, keepChange: false };
}

/** 该笔的实收额 = 服务Amount + 小费，与刷卡机小票一致。 */
function chargedCents(line: DraftLine): number {
  return line.baseCents + line.tipCents;
}

/** 界面草稿 → 服务端入参。 */
function toPaymentLine(line: DraftLine): PaymentLine {
  return {
    method: line.method,
    amountCents: chargedCents(line),
    tipCents: line.tipCents,
    changeCents: line.changeCents,
    keepChange: line.keepChange,
    ...(line.tenderedCents !== undefined ? { tenderedCents: line.tenderedCents } : {}),
    ...(line.giftCardId ? { giftCardId: line.giftCardId } : {}),
    ...(line.giftCardCode ? { giftCardCode: line.giftCardCode } : {}),
  };
}

/**
 * 收银结账台（高信息密度 · 完工单筛选 · 多技师小费拆分 · 职级提成 · 税费与手续费）。
 */
function CheckoutContent() {
  const navigate = useNavigate();
  const [lastReceiptId, setLastReceiptId] = useState<string | null>(null);

  const errorMessage = useErrorMessage();
  const { t, language } = useLanguage();
  const [searchParams] = useSearchParams();
  const urlTicketId = searchParams.get('ticketId');

  const { staff, services } = useSchedule();
  const { data, isLoading, error, refetch } = useOpenTickets();
  const close = useCloseTicket();
  const voidTicketMut = useVoidTicket();
  const canDiscount = useCanWrite('ticket.discount');

  // 1. 工单状态筛选（有服务中单时默认停在服务中，而不是空的已完工）
  const [statusFilter, setStatusFilter] = useState<'ready_to_pay' | 'in_service' | 'open' | 'all'>('ready_to_pay');
  const [userPickedTicketFilter, setUserPickedTicketFilter] = useState(false);
  const [ticketSearch, setTicketSearch] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [discountInput, setDiscountInput] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  /** 一次结账意图内复用同一个幂等键，重试不会重复扣款。 */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [selectedPackageId, setSelectedPackageId] = useState('');

  // 税费开关与自定义Amount
  const [taxRatePercent, setTaxRatePercent] = useState('0');

  // 信用卡手续费开关与比例
  const [enableCardSurcharge, setEnableCardSurcharge] = useState(false);
  const [cardSurchargePercent, setCardSurchargePercent] = useState('3.0');

  // 多技师小费分配模式
  const [tipMode, setTipMode] = useState<'total_split' | 'custom_per_staff'>('total_split');
  const [totalTipInput, setTotalTipInput] = useState('0.00');
  const [splitStrategy, setSplitStrategy] = useState<'proportional' | 'equal'>('proportional');
  const [customStaffTips, setCustomStaffTips] = useState<Record<string, string>>({});

  // Gift Card正在验证中的索引
  const [verifyingIndex, setVerifyingIndex] = useState<number | null>(null);

  // 作废工单弹窗
  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('guest_changed_mind');
  const [voidNote, setVoidNote] = useState('');

  // 发送电子小票弹窗

  const allTickets = data?.tickets ?? [];

  // 统计各状态数量
  const statusCounts = useMemo(() => {
    const ready = allTickets.filter((t) => t.status === 'ready_to_pay' || t.status === 'done' || !t.status).length;
    const inService = allTickets.filter((t) => t.status === 'in_service').length;
    const open = allTickets.filter((t) => t.status === 'open').length;
    return { ready, inService, open, all: allTickets.length };
  }, [allTickets]);

  useEffect(() => {
    if (userPickedTicketFilter) return;
    if (statusCounts.inService > 0 && statusCounts.ready === 0) {
      setStatusFilter('in_service');
    }
  }, [statusCounts.inService, statusCounts.ready, userPickedTicketFilter]);

  // 根据选定状态与容错模糊搜索过滤
  const filteredTickets = useMemo(() => {
    let list = allTickets;
    if (statusFilter !== 'all') {
      if (statusFilter === 'ready_to_pay') {
        list = list.filter((t) => t.status === 'ready_to_pay' || t.status === 'done' || !t.status);
      } else {
        list = list.filter((t) => t.status === statusFilter);
      }
    }
    if (ticketSearch.trim()) {
      list = fuzzySearch(list, ticketSearch, {
        keys: [
          { name: 'customerName', weight: 0.5 },
          { name: 'items.name', weight: 0.3 },
          { name: 'ticketId', weight: 0.2 },
        ],
        threshold: 0.45,
      });
    }
    return list;
  }, [allTickets, statusFilter, ticketSearch]);

  const selected: OpenTicket | null = useMemo(
    () => allTickets.find((x) => x.ticketId === selectedId) ?? filteredTickets[0] ?? null,
    [allTickets, selectedId, filteredTickets],
  );
  const paymentStage = selected ? paymentStageFor(selected) : null;
  const uniqueTicketItems = useMemo(() => {
    const byId = new Map<string, OpenTicket['items'][number]>();
    for (const item of selected?.items ?? []) byId.set(item.ticketItemId, item);
    return [...byId.values()];
  }, [selected]);
  const packageCoverageMode = data?.checkoutSettings?.packageCoverageMode ?? 'bundle';
  const eligiblePackages = useMemo(() => (selected?.availablePackages ?? []).filter((pkg) => {
    if (pkg.serviceIds.length === 0) return uniqueTicketItems.length > 0;
    if (packageCoverageMode === 'bundle') {
      return pkg.serviceIds.every((serviceId) => uniqueTicketItems.some((item) => item.serviceId === serviceId));
    }
    return uniqueTicketItems.some((item) => Boolean(item.serviceId && pkg.serviceIds.includes(item.serviceId)));
  }), [selected, uniqueTicketItems, packageCoverageMode]);
  const selectedPackage = eligiblePackages.find((pkg) => pkg.customerPackageId === selectedPackageId) ?? null;
  const packageCoveredCents = useMemo(() => {
    if (!selectedPackage || paymentStage === 'tip') return 0;
    if (packageCoverageMode === 'bundle' && selectedPackage.serviceIds.length > 0) {
      return selectedPackage.serviceIds.reduce((sum, serviceId) => {
        const item = uniqueTicketItems.find((candidate) => candidate.serviceId === serviceId);
        return sum + (item?.totalCents ?? 0);
      }, 0);
    }
    const item = uniqueTicketItems.find((candidate) =>
      selectedPackage.serviceIds.length === 0
        || Boolean(candidate.serviceId && selectedPackage.serviceIds.includes(candidate.serviceId)));
    return item?.totalCents ?? 0;
  }, [selectedPackage, uniqueTicketItems, packageCoverageMode, paymentStage]);

  // 监听 URL 中的 ticketId 自动选中
  useEffect(() => {
    if (urlTicketId && allTickets.length > 0) {
      const matched = allTickets.find((tk) => tk.ticketId === urlTicketId);
      if (matched && selectedId !== urlTicketId) {
        selectTicket(matched);
      }
    } else if (!selectedId && filteredTickets.length > 0) {
      selectTicket(filteredTickets[0]);
    }
  }, [urlTicketId, allTickets, filteredTickets]);

  // A 模式从项目款阶段切到小费阶段时，清掉上一阶段的本金支付行。
  useEffect(() => {
    if (!selected || paymentStage !== 'tip') return;
    setDiscountInput('');
    setSelectedPackageId('');
    setLines([{
      method: 'card',
      baseCents: 0,
      tipCents: 0,
      changeCents: 0,
      keepChange: false,
    }]);
    setIdempotencyKey(crypto.randomUUID());
  }, [selected?.ticketId, paymentStage]);

  // 参与本单的所有技师列表与项目明细归集
  const staffAssignments = useMemo(() => {
    if (!selected) return [];
    const map = new Map<string, {
      membershipId: string;
      staffName: string;
      items: Array<{ name: string; durationMin: number; priceCents: number; roomName?: string }>;
      totalServiceCents: number;
    }>();

    /*
     * ⚠️ 必须先摊分再归并。`/v1/desk/tickets` 按 `ticket_item_staff` 展开：
     * 一个项目派了几位技师就返回几行，**每行都带着该项目的完整金额**。直接
     * 遍历原始行会把双人项目的 $100 记成 A 一百、B 一百 —— 而下面的比例分账
     * 正是按 `totalServiceCents` 算权重的，双人项目与单人项目混在同一张单里
     * 时，分给各人的小费与实际执行不符，页面上给前台看的每人营收也是错的。
     */
    splitItemRevenueAcrossStaff(selected.items as Array<{ ticketItemId: string; totalCents: number } & Record<string, any>>).forEach((item: any) => {
      const staffMember = staff.find((s) => s.membershipId === item.membershipId || s.name === item.staffName);
      const membershipId = item.membershipId || staffMember?.membershipId;
      if (!membershipId) return;
      const staffName = formatI18n(item.staffName || staffMember?.name, language) || t('checkout.primaryTherapistFallback');
      const roomName = typeof item.roomName === 'string' ? item.roomName : undefined;

      const existing: {
        membershipId: string;
        staffName: string;
        items: Array<{ name: string; durationMin: number; priceCents: number; roomName?: string }>;
        totalServiceCents: number;
      } = map.get(membershipId) ?? {
        membershipId,
        staffName,
        items: [],
        totalServiceCents: 0,
      };

      existing.items.push({
        name: formatI18n(item.name ?? item.name_snapshot ?? item.nameSnapshot, language) || t('service'),
        durationMin: item.durationMin ?? 0,
        priceCents: item.shareCents,
        roomName,
      });
      existing.totalServiceCents += item.shareCents;
      map.set(membershipId, existing);
    });

    return [...map.values()];
  }, [selected, staff, language]);

  // 自动从门店设置同步税率。0 是合法值（金足未开征），不能当成「没配」。
  useEffect(() => {
    const raw = data?.checkoutSettings?.salesTaxRatePercent;
    if (raw == null || raw === '') return;
    setTaxRatePercent(String(raw));
  }, [data?.checkoutSettings]);

  /*
   * 本店是否开征销售税 —— 由税率直接推导，**不是**一个可勾选的开关。
   *
   * 此前它是一个 useState 加一个勾选框，而下面的 `taxCents` 从来不看它：
   * 取消勾选只会让税这一行从费用明细里消失，`totalDueCents` 照样含税、
   * 提交时照样上报 —— 前台对着一张不含税的单子收款，客人卡上却多扣了一笔。
   * 反过来在未开征的店里勾上它，会露出一个税率输入框，而那个数字是真的会
   * 改变应收的。销售税是法定的，不是收银台的选项。
   */
  const hasSalesTax = parseFloat(taxRatePercent || '0') > 0;

  // 折扣与基础应付
  const discountCents = canDiscount && paymentStage !== 'tip' ? Math.max(0, dollarsToCents(discountInput)) : 0;
  const baseSubtotalCents = selected?.subtotalCents ?? 0;
  const afterDiscountCents = Math.max(0, baseSubtotalCents - discountCents - packageCoveredCents);

  // 税费按门店设置算。开关只反映「本店是否开征」，不能把已开征的税关掉。
  const taxCents = paymentStage !== 'tip'
    ? Math.round(afterDiscountCents * (parseFloat(taxRatePercent || '0') / 100))
    : 0;

  /*
   * 小费总额。
   *
   * ⚠️ 按人录入时只累计**本单实际在册的技师**，不是把 `customStaffTips` 里所有
   * 键相加。那份 record 是按 membershipId 存的，换单时若有一个键没被清掉，
   * 上报的 `tipTotalCents` 就会比各行分账之和多出那一笔 —— 服务端对二者不等
   * 是硬拒（PAYMENT_MISMATCH），这一单当场收不了款。总额与分账必须同源。
   */
  const totalTipCents = useMemo(() => {
    if (paymentStage === 'service') return 0;
    if (tipMode === 'total_split') {
      return Math.max(0, dollarsToCents(totalTipInput));
    }
    return staffAssignments.reduce(
      (sum, st) => sum + Math.max(0, dollarsToCents(customStaffTips[st.membershipId] || '0')),
      0,
    );
  }, [paymentStage, tipMode, totalTipInput, customStaffTips, staffAssignments]);

  // 各技师分配到的小费明细
  const staffTipAllocations = useMemo(() => {
    if (staffAssignments.length === 0) return [];
    if (tipMode === 'custom_per_staff') {
      return staffAssignments.map((st) => {
        const cents = Math.max(0, dollarsToCents(customStaffTips[st.membershipId] || '0'));
        const percent = totalTipCents > 0 ? Math.round((cents / totalTipCents) * 100) : 0;
        return { ...st, allocatedTipCents: cents, percent };
      });
    }

    if (totalTipCents === 0) {
      return staffAssignments.map((st) => ({ ...st, allocatedTipCents: 0, percent: 0 }));
    }

    /*
     * 平摊与按营收比例都走看板那份 `allocateTips()`（最大余额法）。
     *
     * ⚠️ 这里原本是逐人 `Math.round`，各行之和可以比总额多一分或少一分 ——
     * 而服务端对 `tipSplits` 是**硬拒**：`splitTotal !== totalTip` 直接抛
     * PAYMENT_MISMATCH。也就是说差这一分不是对账上多一条差异，而是这一单
     * 当场收不了款，且前台完全看不出为什么。三位技师平摊 $10 就能复现：
     * round(1000/3) × 3 = 999。
     */
    const allocated = allocateTips(
      staffAssignments.map((st) => ({
        membershipId: st.membershipId,
        name: st.staffName,
        items: [],
        totalRevenueCents: st.totalServiceCents,
      })),
      totalTipCents,
      splitStrategy,
    );
    return staffAssignments.map((st, index) => {
      const cents = allocated[index] ?? 0;
      return { ...st, allocatedTipCents: cents, percent: Math.round((cents / totalTipCents) * 100) };
    });
  }, [staffAssignments, tipMode, totalTipCents, splitStrategy, customStaffTips]);

  // 刷卡手续费计算
  const hasCardPayment = lines.some((l) => l.method === 'card');
  const cardSurchargeCents = enableCardSurcharge && hasCardPayment && paymentStage !== 'tip'
    ? Math.round((afterDiscountCents + taxCents + totalTipCents) * (parseFloat(cardSurchargePercent || '0') / 100))
    : 0;

  // 应收总额（含税、加项、手续费、折扣后）
  const totalDueCents = paymentStage === 'tip' ? 0 : afterDiscountCents + taxCents + cardSurchargeCents;

  const paidBaseCents = lines.reduce((sum, l) => sum + l.baseCents, 0);
  const paidTipCents = lines.reduce((sum, l) => sum + l.tipCents, 0);
  const chargedTotalCents = paidBaseCents + paidTipCents;
  const remainingCents = totalDueCents - paidBaseCents;

  function selectTicket(ticket: OpenTicket) {
    setSelectedId(ticket.ticketId);
    setDiscountInput('');
    setSelectedPackageId('');
    setTotalTipInput('0.00');
    setCustomStaffTips({});
    const estTax = Math.round(ticket.subtotalCents * (parseFloat(taxRatePercent || '0') / 100));
    const stage = paymentStageFor(ticket);
    setLines([
      {
        method: 'card',
        baseCents: stage === 'tip' ? 0 : ticket.subtotalCents + estTax,
        tipCents: 0,
        changeCents: 0,
        keepChange: false,
      },
    ]);
    setIdempotencyKey(crypto.randomUUID());
  }

  function patchLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  // 当总应收变动且仅有单笔支付行时，自动平账同步基准Amount
  useEffect(() => {
    if (lines.length === 1 && lines[0].baseCents !== totalDueCents) {
      setLines((prev) => prev.map((l, i) => (i === 0 ? { ...l, baseCents: totalDueCents } : l)));
    }
  }, [totalDueCents, lines.length]);

  // 同步总小费到第一笔收款行
  useEffect(() => {
    if (lines.length > 0) {
      patchLine(0, { tipCents: totalTipCents });
    }
  }, [totalTipCents]);

  async function handleVerifyGiftCard(index: number, code: string) {
    if (!code.trim()) return;
    setVerifyingIndex(index);
    try {
      const res = await verifyGiftCard(code.trim());
      if (res.valid) {
        patchLine(index, {
          giftCardId: res.giftCardId,
          giftCardCode: res.code,
          giftCardBalanceCents: res.balanceCents,
          giftCardRecipient: res.recipientName,
          giftCardVerified: true,
          giftCardError: undefined,
          baseCents: lines[index].baseCents === 0 ? Math.min(res.balanceCents, Math.max(0, remainingCents)) : lines[index].baseCents,
        });
        toast.success(t('checkout.giftCardValid', { p0: centsToDollars(res.balanceCents) }));
      } else {
        patchLine(index, {
          giftCardVerified: false,
          giftCardError: t('checkout.giftCardInvalid'),
        });
        toast.danger(t('checkout.giftCardInvalid'));
      }
    } catch (err: any) {
      patchLine(index, {
        giftCardVerified: false,
        giftCardError: err.message || t('checkout.giftCardVerifyFailed'),
      });
      toast.danger(errorMessage(err));
    } finally {
      setVerifyingIndex(null);
    }
  }

  async function handleConfirmVoid() {
    if (!selected) return;
    try {
      await voidTicketMut.mutateAsync({
        ticketId: selected.ticketId,
        reason: voidReason,
        note: voidNote.trim() || undefined,
      });
      toast.success(t('voided') || t('checkout.ticketVoided'), { description: selected.ticketId });
      setVoidModalOpen(false);
      setSelectedId(null);
      setVoidNote('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  }


  async function settle() {
    if (!selected) return;
    if (!paymentStage) {
      toast.danger(t('checkout.stageUnavailable'));
      return;
    }
    if (remainingCents !== 0) {
      toast.danger(t('checkout.paymentShort', { p0: centsToDollars(remainingCents) }));
      return;
    }

    for (const line of lines) {
      if (line.method === 'gift_card') {
        if (line.giftCardBalanceCents !== undefined && chargedCents(line) > line.giftCardBalanceCents) {
          toast.danger(t('checkout.giftCardOverspend', { p0: centsToDollars(chargedCents(line)), p1: centsToDollars(line.giftCardBalanceCents) }));
          return;
        }
      }
    }

    try {
      const payments = paymentStage === 'tip' && totalTipCents === 0
        ? []
        : lines.map(toPaymentLine);
      const result = await close.mutateAsync({
        ticketId: selected.ticketId,
        payments,
        paymentStage,
        discountCents,
        taxCents,
        taxRateBp: Math.round(parseFloat(taxRatePercent || '0') * 100),
        taxCalculationMode: data?.checkoutSettings?.taxCalculationMode || 'exclusive',
        surchargeCents: cardSurchargeCents,
        surchargeRateBp: Math.round(parseFloat(cardSurchargePercent || '0') * 100),
        tipTotalCents: totalTipCents,
        tipSplits: data?.checkoutSettings?.allowTipSplitOverride === false ? undefined : staffTipAllocations.map((a) => ({
          staffMembershipId: a.membershipId,
          staffName: a.staffName,
          amountCents: a.allocatedTipCents,
          percentageBp: a.percent * 100,
        })),
        packageRedemptions: selectedPackage ? [{ customerPackageId: selectedPackage.customerPackageId, units: 1 }] : undefined,
        idempotencyKey,
      });
      const allocationText = result.allocations
        .map((a) => t('checkout.tipAllocationLine', { p0: a.name, p1: centsToDollars(a.amountCents) }))
        .join(' · ');
      toast.success(t(paymentStage === 'service' ? 'checkout.servicePaymentSucceeded' : 'checkout.checkoutSucceeded'), {
        description: allocationText || `$${centsToDollars(result.totalCents)}`,
      });

      /*
       * ⚠️ 结账后不再弹「发送电子小票」——
       * 小票的短信与邮件已于 2026-09-01 整体取消，只保留打印（店主定）。
       */
      setLastReceiptId(result.ticketId);
      if (data?.checkoutSettings?.autoPrintReceipt !== false) navigate(`/print/receipt/${result.ticketId}`);
      if (paymentStage === 'service') setIdempotencyKey(crypto.randomUUID());
      else setSelectedId(null);
    } catch (err) {
      toast.danger(t('saveFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  if (isLoading && !data) {
    return <PageLoading layout="list" title={t('checkout.checkoutLoading')} description={t('checkout.checkoutLoadingDesc')} />;
  }

  if (error && !data) {
    return <PageError title={t('checkout.checkoutLoadError')} error={error} onRetry={refetch} />;
  }

  return (
    <div className="min-h-full lg:h-full flex flex-col lg:flex-row gap-4 lg:overflow-hidden">
      {lastReceiptId && <div className="rounded-xl border border-teal-200 bg-white p-3 shrink-0" role="status">
        <Button onClick={() => navigate(`/print/receipt/${lastReceiptId}`)}>Print last receipt</Button>
      </div>}
      {/* 左栏：工单列表（带状态快速筛选） */}
      <Card className="w-full lg:w-80 max-h-[24rem] lg:max-h-none shrink-0 flex flex-col overflow-hidden">
        {/* 顶部标题与状态统计 */}
        <div className="p-3 border-b border-slate-100 bg-slate-50 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <Receipt className="w-4 h-4 text-teal-600" />
              <span>{t('openTickets') || t('checkout.openTickets')}</span>
            </h2>
            <span className="text-xs font-mono font-bold text-slate-500">
              
              {t('checkout.totalPrefix')} {filteredTickets.length}  {t('checkout.totalSuffix')}
            </span>
          </div>

          {/* 状态筛选切换器（默认：服务完成Open / Unpaid） */}
          {/*
            四等分只在桌面的宽工单栏里放得下。平板字号下这条工具条每格仅约
            65px，四个标签一律被截成「已完…」「服务中…」「已到店…」，彼此无法
            区分。1280px 以下改为 2×2：格宽翻倍，标签完整可读。
          */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 p-1 bg-slate-200/70 rounded-xl text-[11px] font-bold text-slate-600">
            <button
              type="button"
              onClick={() => { setUserPickedTicketFilter(true); setStatusFilter('ready_to_pay'); }}
              className={cn(
                'py-1 rounded-lg transition-all text-center truncate',
                statusFilter === 'ready_to_pay'
                  ? 'bg-white text-teal-900 shadow-sm font-black'
                  : 'hover:bg-slate-100 text-slate-600',
              )}
            >
              
              {t('checkout.tabFinished')}{statusCounts.ready})
            </button>
            <button
              type="button"
              onClick={() => { setUserPickedTicketFilter(true); setStatusFilter('in_service'); }}
              className={cn(
                'py-1 rounded-lg transition-all text-center truncate',
                statusFilter === 'in_service'
                  ? 'bg-white text-purple-900 shadow-sm font-black'
                  : 'hover:bg-slate-100 text-slate-600',
              )}
            >
              
              {t('checkout.tabInService')}{statusCounts.inService})
            </button>
            <button
              type="button"
              onClick={() => { setUserPickedTicketFilter(true); setStatusFilter('open'); }}
              className={cn(
                'py-1 rounded-lg transition-all text-center truncate',
                statusFilter === 'open'
                  ? 'bg-white text-amber-900 shadow-sm font-black'
                  : 'hover:bg-slate-100 text-slate-600',
              )}
            >
              
              {t('checkout.tabArrived')}{statusCounts.open})
            </button>
            <button
              type="button"
              onClick={() => { setUserPickedTicketFilter(true); setStatusFilter('all'); }}
              className={cn(
                'py-1 rounded-lg transition-all text-center truncate',
                statusFilter === 'all'
                  ? 'bg-white text-slate-900 shadow-sm font-black'
                  : 'hover:bg-slate-100 text-slate-600',
              )}
            >
              
              {t('checkout.tabAll')}{statusCounts.all})
            </button>
          </div>

          <div className="relative mt-2">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={ticketSearch}
              onChange={(e) => setTicketSearch(e.target.value)}
              placeholder={t('checkout.searchPlaceholder')}
              className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-all"
            />
          </div>
        </div>

        {/* 单据列表 */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 custom-scrollbar">
          {filteredTickets.map((ticket) => {
            const isSelected = ticket.ticketId === selected?.ticketId;
            const isReady = ticket.status === 'ready_to_pay' || ticket.status === 'done' || !ticket.status;
            return (
              <button
                key={ticket.ticketId}
                type="button"
                onClick={() => selectTicket(ticket)}
                className={cn(
                  'w-full text-left p-3 transition-colors hover:bg-slate-50 relative',
                  isSelected && 'bg-teal-50/70 border-l-4 border-teal-600',
                )}
              >
                <div className="flex items-start justify-between gap-1.5 mb-1">
                  <span className="font-bold text-slate-900 text-sm truncate">
                    {formatI18n(ticket.customerName, language) || t('checkout.walkInGuest')}
                  </span>
                  <span className="text-sm font-mono font-black text-teal-800 shrink-0">
                    ${centsToDollars(ticket.subtotalCents)}
                  </span>
                </div>

                <div className="text-xs text-slate-500 truncate">
                  {(ticket.items || []).map((i: any) => formatI18n(i.name, language)).join(' · ')}
                </div>

                <div className="flex items-center gap-1.5 mt-2">
                  <Badge
                    variant={isReady ? 'success' : ticket.status === 'in_service' ? 'secondary' : 'warning'}
                    className="text-[10px] px-1.5 py-0 font-bold"
                  >
                    {isReady ? t('checkout.statusFinished') : ticket.status === 'in_service' ? t('checkout.statusInService') : t('checkout.statusWaiting')}
                  </Badge>

                  {ticket.daysAgo > 0 && (
                    <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0">
                      
                      {t('checkout.carryOverPrefix')} {ticket.daysAgo}{t('checkout.carryOverSuffix')}
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          {filteredTickets.length === 0 && (
            <div className="py-16 text-center space-y-2">
              <Receipt className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="text-xs text-slate-500 font-medium">{t('checkout.noOpenTickets')}</p>
              {statusFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => { setUserPickedTicketFilter(true); setStatusFilter('all'); }}
                  className="text-xs text-teal-600 font-bold hover:underline"
                >
                  
                  {t('checkout.viewAllOpen')}
                </button>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* 右栏：全维度结账核算明细 */}
      {!selected ? (
        <Card className="flex-1 grid place-items-center">
          <EmptyState icon={<Receipt />} title={t('selectTicket')} />
        </Card>
      ) : (
        <Card className="flex-1 flex flex-col overflow-hidden">
          {/* 单据顶栏与操作 */}
          <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/80 flex items-center justify-between shrink-0">
            <div className="min-w-0 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-teal-600 text-white flex items-center justify-center font-bold text-base shadow-sm shrink-0">
                {(formatI18n(selected.customerName, language) || 'Walk-in Guest').slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900 truncate">
                    {formatI18n(selected.customerName, language) || t('checkout.walkInGuest2')}
                  </h2>
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    
                    {t('checkout.ticketNo')}{(selected.ticketId || '').slice(0, 8)}
                  </Badge>
                  <Badge variant="success" className="text-[10px] font-bold">
                    {paymentStage === 'service'
                      ? t('checkout.stageService')
                      : paymentStage === 'tip'
                        ? t('checkout.stageTip')
                        : paymentStage === 'combined'
                          ? t('checkout.stageCombined')
                          : t('checkout.stageWaiting')}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                  <span>{t('checkout.businessDate')} {formatI18n(selected.businessDate, language)}</span>
                  <span>•</span>
                  <span>{t('checkout.servingStaff')} {staffAssignments.map((s) => s.staffName).join('、') || t('checkout.unassigned')}</span>
                </p>
              </div>
            </div>

            <GuardedButton
              permission="ticket.void"
              fallback="hide"
              variant="outline"
              size="sm"
              className="border-red-200 text-red-600 hover:bg-red-50 gap-1.5 h-8 text-xs font-bold shrink-0"
              onClick={() => setVoidModalOpen(true)}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('voidTicketAction') || t('checkout.voidTicket')}</span>
            </GuardedButton>
          </div>

          {/* 可滚动的高密度结账内容 */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar bg-slate-50/40">
            <div className={cn(
              'rounded-xl border px-4 py-3 text-xs font-medium',
              paymentStage ? 'border-teal-200 bg-teal-50 text-teal-900' : 'border-amber-200 bg-amber-50 text-amber-900',
            )}>
              {paymentStage === 'service' && t('checkout.stageServiceHint')}
              {paymentStage === 'tip' && t('checkout.stageTipHint')}
              {paymentStage === 'combined' && selected.checkoutTiming === 'upfront_combined' && t('checkout.stageUpfrontHint')}
              {paymentStage === 'combined' && selected.checkoutTiming !== 'upfront_combined' && t('checkout.stageAfterHint')}
              {!paymentStage && (selected.serviceSettledAt
                ? t('checkout.stagePaidWaitingCompletion')
                : t('checkout.stageWaitingCompletion'))}
            </div>

            {/* 组合套餐明细（U10）：原价 / 套餐优惠 / 套餐价 / 子项 */}
            <BundleCheckoutSummary bundles={selected.bundles} items={selected.items} />

            {/* 1. 项目、加项、包厢、多技师分工明细卡片 */}
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <Scissors className="w-4 h-4 text-teal-600" />
                  <span>{t('checkout.lineItemsTitle')}</span>
                </h3>
                <span className="text-[11px] font-bold text-slate-500">
                  
                  {t('checkout.itemsPrefix')} {selected.items.length}  {t('checkout.itemsSuffix')}
                </span>
              </div>

              <div className="space-y-2.5">
                {staffAssignments.map((staffGroup) => (
                  <div
                    key={staffGroup.membershipId}
                    className="p-3 bg-slate-50/80 rounded-xl border border-slate-200/80 space-y-2"
                  >
                    {/* 技师头部信息 */}
                    <div className="flex items-center justify-between text-xs pb-1.5 border-b border-slate-200/60">
                      <div className="flex items-center gap-2">
                        <User className="w-3.5 h-3.5 text-teal-600" />
                        <span className="font-bold text-slate-900">{staffGroup.staffName}</span>
                      </div>
                    </div>

                    {/* 该技师执行的服务与加项 */}
                    <div className="space-y-1.5">
                      {staffGroup.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-center text-xs">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-slate-800">{item.name}</span>
                              <Badge variant="outline" className="font-mono text-[9px] px-1 py-0">
                                {item.durationMin}m
                              </Badge>
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-1">
                              <BedDouble className="w-3 h-3 text-slate-400" />
                              <span>{item.roomName ? `${t('checkout.serviceRoom')} ${item.roomName}` : t('checkout.roomUnassigned')}</span>
                            </div>
                          </div>
                          <span className="font-mono font-bold text-slate-900 text-sm">
                            ${centsToDollars(item.priceCents)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {paymentStage !== 'tip' && eligiblePackages.length > 0 && (
              <div className="bg-white p-4 rounded-2xl border border-emerald-200 shadow-sm space-y-3">
                <div className="flex items-center gap-2">
                  <Gift className="w-4 h-4 text-emerald-600" />
                  <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider">{t('checkout.packageRedemption')}</h3>
                </div>
                <select value={selectedPackageId} onChange={(e) => setSelectedPackageId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium">
                  <option value="">{t('checkout.packageDoNotUse')}</option>
                  {eligiblePackages.map((pkg) => (
                    <option key={pkg.customerPackageId} value={pkg.customerPackageId}>
                      {pkg.name} · {pkg.totalSessions === 0 ? t('checkout.packageUnlimited') : t('checkout.packageRemaining', { p0: pkg.remainingSessions })}
                    </option>
                  ))}
                </select>
                {selectedPackage && (
                  <div className="flex justify-between text-xs text-emerald-800 bg-emerald-50 rounded-xl px-3 py-2">
                    <span>{t('checkout.packageApplyHint')}</span>
                    <span className="font-mono font-black">-${centsToDollars(packageCoveredCents)}</span>
                  </div>
                )}
              </div>
            )}

            {/* 2. 多技师小费分配与分成计算器 */}
            {paymentStage !== 'service' && (
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <Award className="w-4 h-4 text-amber-600" />
                  <span>{t('checkout.tipSplitTitle')}</span>
                </h3>
                {data?.checkoutSettings?.allowTipSplitOverride !== false ? (
                <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => setTipMode('total_split')}
                    className={cn(
                      'px-2 py-0.5 rounded-md transition-all',
                      tipMode === 'total_split' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500',
                    )}
                  >
                    {t('checkout.tipSmartSplit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTipMode('custom_per_staff')}
                    className={cn(
                      'px-2 py-0.5 rounded-md transition-all',
                      tipMode === 'custom_per_staff' ? 'bg-white shadow-sm text-teal-800' : 'text-slate-500',
                    )}
                  >
                    {t('checkout.tipEnterByStaff')}
                  </button>
                </div>
                ) : <Badge variant="secondary">{t('checkout.tipRuleLocked')}</Badge>}
              </div>

              {tipMode === 'total_split' ? (
                <div className="space-y-2.5">
                  {/* 快捷小费比例按钮 */}
                  <div className="grid grid-cols-5 gap-1.5 text-xs">
                    {[0, ...(data?.checkoutSettings?.suggestedTipPercentages ?? [15, 18, 20, 25])].map((percent) => {
                      const btn = { label: percent === 0 ? t('checkout.noTip') : `${percent}%`, rate: percent / 100 };
                      const tipAmt = centsToDollars(Math.round(afterDiscountCents * btn.rate));
                      const isSelected = totalTipInput === tipAmt;
                      return (
                        <button
                          key={btn.label}
                          type="button"
                          onClick={() => setTotalTipInput(tipAmt)}
                          className={cn(
                            'p-1.5 rounded-xl border text-center font-bold transition-all',
                            isSelected
                              ? 'border-teal-500 bg-teal-50 text-teal-900 ring-1 ring-teal-400'
                              : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700',
                          )}
                        >
                          <span className="block text-[11px]">{btn.label}</span>
                          <span className="block text-[10px] font-mono text-slate-400 mt-0.5">${tipAmt}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">{t('checkout.tipCustomTotal')}</label>
                      <Input
                        inputMode="decimal"
                        value={totalTipInput}
                        onChange={(e) => setTotalTipInput(e.target.value)}
                        placeholder="0.00"
                        className="font-mono font-bold"
                      />
                    </div>
                    {data?.checkoutSettings?.allowTipSplitOverride !== false && <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">{t('checkout.splitStrategy')}</label>
                      <select
                        value={splitStrategy}
                        onChange={(e) => setSplitStrategy(e.target.value as any)}
                        className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
                      >
                        <option value="proportional">{t('checkout.splitByRevenue')}</option>
                        <option value="equal">{t('checkout.splitEqual')}</option>
                      </select>
                    </div>}
                  </div>
                </div>
              ) : (
                /* 按技师分别录入 */
                <div className="space-y-2">
                  <p className="text-[11px] text-slate-500">{t('checkout.splitManualHint')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {staffAssignments.map((st) => (
                      <div key={st.membershipId} className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                        <span className="font-bold text-xs text-slate-800 block">{st.staffName}</span>
                        <Input
                          inputMode="decimal"
                          value={customStaffTips[st.membershipId] || ''}
                          onChange={(e) =>
                            setCustomStaffTips((prev) => ({ ...prev, [st.membershipId]: e.target.value }))
                          }
                          placeholder="0.00"
                          className="font-mono text-xs h-8"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 实时技师分成明细预览 */}
              {data?.checkoutSettings?.allowTipSplitOverride !== false ? <div className="p-3 bg-teal-50/50 rounded-xl border border-teal-100 space-y-1.5">
                <span className="text-[11px] font-bold text-teal-900 block flex items-center justify-between">
                  <span>{t('checkout.splitSummary')}</span>
                  <span className="font-mono text-teal-700">{t('checkout.tipTotal')}{centsToDollars(totalTipCents)}</span>
                </span>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {staffTipAllocations.map((st) => {
                    return (
                      <div key={st.membershipId} className="p-2 bg-white rounded-lg border border-teal-200/80 space-y-0.5">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-slate-800">{st.staffName}</span>
                          <Badge variant="secondary" className="text-[9px] font-mono px-1 py-0 bg-teal-100 text-teal-900">
                            {st.percent}{t('checkout.tipPercent')}
                          </Badge>
                        </div>
                        <div className="text-[10px] text-slate-500">
                          
                          {t('checkout.tipEarned')} <span className="font-mono font-bold text-teal-700">${centsToDollars(st.allocatedTipCents)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div> : (
                <p className="p-3 bg-teal-50/50 rounded-xl border border-teal-100 text-[11px] text-teal-800">
                  {t('checkout.tipRuleLockedHint')}
                </p>
              )}
            </div>
            )}

            {/* 3. 税费与信用卡手续费配置 */}
            {paymentStage !== 'tip' && (
            <div className="grid grid-cols-2 gap-3">
              {/* Sales Tax */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-800">{t('checkout.salesTaxToggle')}</span>
                  <span className="font-mono font-bold text-slate-700">+${centsToDollars(taxCents)}</span>
                </div>
                {hasSalesTax && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[11px] text-slate-500">{t('checkout.taxRateLabel')}</span>
                    <Input
                      inputMode="decimal"
                      value={taxRatePercent}
                      onChange={(e) => setTaxRatePercent(e.target.value)}
                      className="h-7 w-20 text-xs font-mono"
                    />
                  </div>
                )}
              </div>

              {/* 信用卡手续费 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enableCardSurcharge}
                      onChange={(e) => setEnableCardSurcharge(e.target.checked)}
                      className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500/20"
                    />
                    <span>{t('checkout.cardSurchargeToggle')}</span>
                  </label>
                  <span className="font-mono font-bold text-purple-700">+${centsToDollars(cardSurchargeCents)}</span>
                </div>
                {enableCardSurcharge && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[11px] text-slate-500">{t('checkout.surchargeRateLabel')}</span>
                    <Input
                      inputMode="decimal"
                      value={cardSurchargePercent}
                      onChange={(e) => setCardSurchargePercent(e.target.value)}
                      className="h-7 w-16 text-xs font-mono"
                    />
                    <div className="flex gap-1">
                      {['3.0', '3.5', '4.0'].map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          onClick={() => setCardSurchargePercent(rate)}
                          className={cn(
                            'px-1.5 py-0.5 text-[10px] rounded border font-bold',
                            cardSurchargePercent === rate ? 'bg-purple-600 text-white border-purple-600' : 'bg-slate-100',
                          )}
                        >
                          {rate}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            )}

            {/* 4. 费用汇总清单 */}
            <div className="rounded-2xl border border-slate-200 p-4 space-y-2.5 bg-white shadow-sm text-xs">
              <div className="flex justify-between text-slate-600">
                <span>{t('checkout.baseServicesSubtotal')} ({selected.items.length} {t('checkout.itemsCountSuffix')}</span>
                <span className="font-mono font-bold text-slate-800">${centsToDollars(baseSubtotalCents)}</span>
              </div>

              {canDiscount && paymentStage !== 'tip' && (
                <div className="flex justify-between items-center text-slate-600">
                  <span className="flex items-center gap-1">
                    <Percent className="w-3.5 h-3.5 text-teal-600" />
                    <span>{t('checkout.ticketDiscount')}</span>
                  </span>
                  <Input
                    inputMode="decimal"
                    value={discountInput}
                    onChange={(e) => setDiscountInput(e.target.value)}
                    className="h-7 w-24 text-right font-mono text-xs"
                    placeholder="0.00"
                  />
                </div>
              )}

              {packageCoveredCents > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>{t('checkout.packageCovered')}</span>
                  <span className="font-mono font-bold">-${centsToDollars(packageCoveredCents)}</span>
                </div>
              )}

              {hasSalesTax && (
                <div className="flex justify-between text-slate-600">
                  <span>{t('checkout.salesTax')} ({taxRatePercent}%)</span>
                  <span className="font-mono font-bold text-slate-800">+${centsToDollars(taxCents)}</span>
                </div>
              )}

              {enableCardSurcharge && (
                <div className="flex justify-between text-purple-700">
                  <span>{t('checkout.cardProcessingFee')} ({cardSurchargePercent}%)</span>
                  <span className="font-mono font-bold">+${centsToDollars(cardSurchargeCents)}</span>
                </div>
              )}

              <div className="pt-2 border-t border-slate-100 flex justify-between items-end">
                <span className="font-bold text-slate-800 text-sm">{t('checkout.totalDue')}</span>
                <span className="text-xl font-black text-teal-700 font-mono">
                  ${centsToDollars(totalDueCents)}
                </span>
              </div>
            </div>

            {/* 5. Split Payment收款行 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-teal-600" />
                  <span>{t('checkout.paymentMethods')}</span>
                </h3>
              </div>

              {lines.map((line, index) => {
                const Icon = METHOD_ICONS[line.method];
                const rawChangeDue = line.tenderedCents !== undefined
                  ? Math.max(0, line.tenderedCents - line.baseCents)
                  : 0;
                return (
                  <div key={index} className="rounded-2xl border border-slate-200 p-4 space-y-3 bg-white shadow-sm">
                    <div className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-slate-400 shrink-0" />
                      <select
                        value={line.method}
                        onChange={(e) => patchLine(index, {
                          ...emptyLine(e.target.value as PaymentMethod),
                          baseCents: line.baseCents,
                          tipCents: line.tipCents,
                        })}
                        className="flex-1 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                      >
                        {PAYMENT_METHODS.filter((m) => paymentStage !== 'tip' || m !== 'gift_card').map((m) => (
                          <option key={m} value={m}>{t(METHOD_LABELS[m])}</option>
                        ))}
                      </select>
                      {lines.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('removePayment')}
                          className="text-slate-400 hover:text-red-500"
                          onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 mb-1">
                          {t('baseAmount') || t('checkout.servicePayAmount')}
                        </label>
                        <Input
                          inputMode="decimal"
                          value={line.baseCents ? centsToDollars(line.baseCents) : ''}
                          onChange={(e) => patchLine(index, { baseCents: dollarsToCents(e.target.value) })}
                          placeholder="0.00"
                          className="font-mono text-xs font-bold"
                          disabled={paymentStage === 'tip'}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 mb-1">
                          {t('tip') || t('checkout.channelTip')}
                        </label>
                        <Input
                          inputMode="decimal"
                          value={line.tipCents ? centsToDollars(line.tipCents) : ''}
                          onChange={(e) => patchLine(index, { tipCents: dollarsToCents(e.target.value) })}
                          placeholder="0.00"
                          className="font-mono text-xs font-bold text-teal-700"
                          disabled={paymentStage === 'service'}
                        />
                      </div>
                    </div>

                    {chargedCents(line) > 0 && (
                      <div className="flex justify-between items-baseline text-xs pt-1 border-t border-slate-100">
                        <span className="text-slate-500">
                          {t('chargedAmount') || t('checkout.cardTerminalCharge')}:
                        </span>
                        <span className="font-mono font-black text-slate-900 text-sm">
                          ${centsToDollars(chargedCents(line))}
                        </span>
                      </div>
                    )}

                    {line.method === 'cash' && (
                      <div className="space-y-2 pt-1 border-t border-slate-100">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-500 mb-1">
                            {t('amountReceived') || t('checkout.cashTendered')}
                          </label>
                          <Input
                            inputMode="decimal"
                            value={line.tenderedInput !== undefined ? line.tenderedInput : (line.tenderedCents !== undefined ? centsToDollars(line.tenderedCents) : '')}
                            onChange={(e) => {
                              const rawVal = e.target.value;
                              const tenderedCents = dollarsToCents(rawVal);
                              const rawChange = Math.max(0, tenderedCents - line.baseCents);
                              patchLine(index, {
                                tenderedInput: rawVal,
                                tenderedCents,
                                changeCents: line.keepChange ? 0 : rawChange,
                                ...(line.keepChange ? { tipCents: rawChange } : {}),
                              });
                            }}
                            onBlur={() => {
                              if (line.tenderedCents !== undefined) {
                                patchLine(index, {
                                  tenderedInput: centsToDollars(line.tenderedCents),
                                });
                              }
                            }}
                            placeholder="0.00"
                            className="font-mono text-xs"
                          />
                        </div>
                        {(rawChangeDue > 0 || line.keepChange) && (
                          <>
                            <div className="flex justify-between text-xs">
                              <span className="text-slate-600 font-bold">{t('changeDue') || t('checkout.changeDue')}:</span>
                              <span className="font-mono font-black text-emerald-700 text-sm">
                                ${centsToDollars(line.keepChange ? 0 : rawChangeDue)}
                              </span>
                            </div>
                            {paymentStage !== 'service' && (
                              <label className="flex items-start gap-2 cursor-pointer p-2 bg-emerald-50/60 rounded-xl border border-emerald-200">
                                <input
                                  type="checkbox"
                                  checked={Boolean(line.keepChange)}
                                  onChange={(e) => patchLine(index, {
                                    keepChange: e.target.checked,
                                    changeCents: e.target.checked ? 0 : rawChangeDue,
                                    tipCents: e.target.checked ? rawChangeDue : 0,
                                  })}
                                  className="mt-0.5 w-4 h-4 rounded text-teal-600 focus:ring-teal-500/20"
                                />
                                <span className="text-xs text-emerald-900 font-bold">
                                  {t('checkout.keepChange')}
                                </span>
                              </label>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {line.method === 'gift_card' && (
                      <div className="space-y-2 pt-1 border-t border-slate-100">
                        <label className="block text-[11px] font-bold text-slate-500 mb-1">
                          {t('giftCardCode') || t('checkout.giftCardCode')}
                        </label>
                        <div className="flex gap-2">
                          <Input
                            value={line.giftCardCode ?? ''}
                            onChange={(e) => patchLine(index, { giftCardCode: e.target.value, giftCardVerified: false })}
                            placeholder={t('checkout.giftCardCodeHint')}
                            className="text-xs font-mono"
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!line.giftCardCode?.trim() || verifyingIndex === index}
                            onClick={() => handleVerifyGiftCard(index, line.giftCardCode || '')}
                            className="shrink-0 text-xs font-bold"
                          >
                            {verifyingIndex === index ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : t('checkout.giftCardVerify')}
                          </Button>
                        </div>
                        {line.giftCardVerified && (
                          <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs flex items-center justify-between text-emerald-800 font-bold">
                            <span className="flex items-center gap-1.5">
                              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                              {line.giftCardRecipient ? t('checkout.giftCardOf', { p0: line.giftCardRecipient }) : t('checkout.giftCardValidLabel')}
                            </span>
                            <span className="font-mono">
                              
                              {t('checkout.availableBalance')}{centsToDollars(line.giftCardBalanceCents ?? 0)}
                            </span>
                          </div>
                        )}
                        {line.giftCardError && (
                          <p className="text-xs text-red-600 font-medium">{line.giftCardError}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {lines.length < MAX_PAYMENT_LINES && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-dashed gap-2 font-bold text-xs h-9"
                  onClick={() => setLines((prev) => [...prev, emptyLine()])}
                >
                  <Plus className="w-4 h-4" />
                  <span>{t('checkout.addSplitChannel')}</span>
                </Button>
              )}
            </div>
          </div>

          {/* 结账底部对账栏 */}
          <div className="border-t border-slate-200 bg-white px-6 py-4 sm:pr-20 space-y-2.5 shrink-0">
            <div className="flex justify-between text-xs text-slate-600">
              <span>{t('checkout.netServiceCollected')} <strong className="font-mono text-slate-800">${centsToDollars(paidBaseCents)}</strong></span>
              <span>{t('checkout.tipTotal')}<strong className="font-mono text-teal-700">{centsToDollars(totalTipCents)}</strong></span>
              <span>{t('checkout.terminalTotal')} <strong className="font-mono text-slate-900 font-black">${centsToDollars(chargedTotalCents)}</strong></span>
            </div>

            {remainingCents !== 0 && (
              <div className={cn(
                'flex justify-between items-center text-xs font-bold p-2 rounded-xl border',
                remainingCents > 0
                  ? 'bg-amber-50 text-amber-900 border-amber-200'
                  : 'bg-red-50 text-red-900 border-red-200',
              )}>
                <span>{remainingCents > 0 ? t('checkout.stillDue') : t('checkout.overPaid')}</span>
                <span className="font-mono text-sm font-black">${centsToDollars(Math.abs(remainingCents))}</span>
              </div>
            )}

            <GuardedButton
              permission="ticket.write"
              size="lg"
              isPending={close.isPending}
              isDisabled={remainingCents !== 0 || !paymentStage}
              className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold h-12 text-sm rounded-xl shadow-lg"
              onClick={() => void settle()}
            >
              {paymentStage === 'service'
                ? t('checkout.collectServicePayment')
                : paymentStage === 'tip'
                  ? t('checkout.collectTipOrNoTip')
                  : t('checkout.confirmCheckout')} (${centsToDollars(chargedTotalCents)})
            </GuardedButton>
          </div>
        </Card>
      )}

      {/* 作废确认模态框 */}
      {voidModalOpen && selected && (
        <Modal
          isOpen={voidModalOpen}
          onOpenChange={setVoidModalOpen}
          title={`${t('voidTicketAction') || '作废工单'} · #${selected.ticketId.slice(0, 8)}`}
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setVoidModalOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white font-bold"
                disabled={voidTicketMut.isPending}
                onClick={handleConfirmVoid}
              >
                {voidTicketMut.isPending ? t('checkout.voiding') : t('checkout.confirmVoid')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-xs text-slate-700 py-2">
            <p className="text-red-600 bg-red-50 p-3 rounded-xl border border-red-200 leading-relaxed font-medium">
              
              {t('checkout.voidWarning')}
            </p>
            <div>
              <label className="block font-bold text-slate-700 mb-1.5">{t('checkout.voidReasonRequired')}</label>
              <select
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200"
              >
                <option value="guest_changed_mind">{t('reasonChangedMind') || t('checkout.voidReasonChangedMind')}</option>
                <option value="walk_out">{t('reasonWalkOut') || t('checkout.voidReasonWalkOut')}</option>
                <option value="duplicate_booking">{t('reasonDuplicate') || t('checkout.voidReasonDuplicate')}</option>
                <option value="input_error">{t('reasonInputError') || t('checkout.voidReasonInputError')}</option>
                <option value="paid_externally">{t('checkout.voidReasonHandledElsewhere')}</option>
                <option value="other">{t('reasonOther') || t('checkout.voidReasonOther')}</option>
              </select>
            </div>
            <div>
              <label className="block font-bold text-slate-700 mb-1.5">{t('checkout.voidNotes')}</label>
              <Input
                value={voidNote}
                onChange={(e) => setVoidNote(e.target.value)}
                placeholder={t('checkout.voidNotesPlaceholder')}
              />
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
}

export function Checkout() {
  return (
    <ErrorBoundary fallbackTitleKey="checkout">
      <CheckoutContent />
    </ErrorBoundary>
  );
}
