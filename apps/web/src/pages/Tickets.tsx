import { useCanWrite } from '@/lib/permissions';
import { printTable } from '@/features/printing/preview';
import { useMemo, useState } from 'react';
import { useSession } from '@/lib/session';
import { asCents, pickText,membershipText,serviceRefundText } from '@gf/contracts';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  RefreshCw,
  FileText,
  Ban,
  Receipt,
  AlertCircle,
  Download,
  Printer,
  Calendar,
  Filter,
  DollarSign,
  CreditCard,
  User,
  Users,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Sparkles,
  ChevronDown,
  Gift,
  Coins,
  FileSpreadsheet,
  Send,
  Eye,
  SlidersHorizontal,
  ArrowUpDown,
  Share2,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { toast } from '@heroui/react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { useStoreTime } from '@/lib/time';
import { useErrorMessage } from '@/lib/errorMessage';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { useLanguage } from '@/LanguageContext';
import {
  useTicketsList,
  useVoidTicket,
  useRefundTicket,
  useTicketRefundReview,
  useOrdersQuery,
} from '@/features/tickets/api';
import type { TicketSummary, VoidReason } from '@/features/tickets/types';
import { exportToCSV, exportToExcel } from '@/lib/exportUtils';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { cn, formatI18n, formatPhoneDisplay } from '@/lib/utils';
import { orderPaymentDisplay, fullRefundCents } from '@/features/tickets/orderDisplay';
import { formatTaxRatePercent, taxNoteKind } from '@/features/tickets/taxCopy';
import { useDeskSettingsQuery } from '@/features/settings/api';
import { customerInitials } from '@/lib/displayName';

export type TicketStatusFilter = 'all' | 'completed' | 'open' | 'voided' | 'refunded';
export type DateRangePreset = 'today' | 'yesterday' | 'last7days' | 'thisMonth' | 'all';
export type PaymentMethodFilter = 'all' | 'card' | 'cash' | 'package' | 'giftcard' | 'split';

export interface OrderItemDetail {
  id: string;
  name: string;
  priceCents: number;
  durationMin: number;
  staffId: string;
  staffName: string;
  staffTier?: string;
  isAddon?: boolean;
}

export interface TipSplitRecord {
  staffId: string;
  staffName: string;
  amountCents: number;
  percentage: number;
}

export interface EnrichedOrderRecord {
  membershipCoveredCents?:number;
  packageCoveredCents?:number;
  hasPrepaidSource?:boolean;
  newCollectedCents?:number;
  ticketId: string;
  orderNumber: string;
  businessDate: string;
  createdAt: string;
  completedAt?: string;
  customerName: string;
  customerId?: string;
  customerPhone?: string;
  customerTier: 'Black Diamond VIP' | 'Platinum Member' | 'Package Member' | 'Standard Member' | 'Walk-in Guest';
  status: 'completed' | 'open' | 'voided' | 'refunded';
  items: OrderItemDetail[];
  subtotalCents: number;
  discountCents: number;
  discountReason?: string;
  taxCents: number;
  surchargeCents: number;
  tipCents: number;
  totalPaidCents: number;
  refundCents: number;
  refundTipCents: number;
  refundTaxCents: number;
  refundFeeCents: number;
  paymentMethod: 'credit_card' | 'cash' | 'package' | 'gift_card' | 'split' | 'card' | 'unpaid' | 'mixed';
  paymentMethodLabel: string;
  cardLast4?: string;
  transactionRef?: string;
  cashierName: string;
  tipSplits: TipSplitRecord[];
  daysAgo: number;
  voidReason?: string;
  voidNotes?: string;
  notes?: string;
}


function TicketsContent() {
  const { membership } = useSession();
  const storeTime = useStoreTime();
  const errorMessage = useErrorMessage();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch: refetchTickets } = useTicketsList();
  const settingsQ = useDeskSettingsQuery();
  const taxRatePercent = Number(settingsQ.data?.checkout?.salesTaxRatePercent ?? 0);
  const taxNote = taxNoteKind(taxRatePercent) === 'none'
    ? t('checkout.tkTaxNoteNone')
    : t('checkout.tkTaxNote', { p0: formatTaxRatePercent(taxRatePercent) });
  const salesTaxLine = t('checkout.tkSalesTaxLine', { p0: formatTaxRatePercent(taxRatePercent) });
  const voidMutation = useVoidTicket();
  const refundMutation = useRefundTicket();
  const canRefund = useCanWrite('ticket.refund');

  // 1. 筛选状态控制
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>('all');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('all');
  const [customDate, setCustomDate] = useState<string>('');
  const [staffFilter, setStaffFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<PaymentMethodFilter>('all');
  const [amountRange, setAmountRange] = useState<string>('all');

  // 查询后端真实 /v1/desk/orders 接口
  const { data: ordersData, isLoading: ordersLoading, isError: ordersError, error: ordersErr, refetch: refetchOrders } = useOrdersQuery({
    status: statusFilter !== 'all' ? statusFilter : undefined,
    q: searchTerm || undefined,
  });

  const isInitialLoading = (isLoading || ordersLoading) && !ordersData && !data;

  // 2. 电子小票与全明细查看抽屉/模态框
  const [selectedRecord, setSelectedRecord] = useState<EnrichedOrderRecord | null>(null);

  // 3. 作废工单确认弹窗
  const [voidModalRecord, setVoidModalRecord] = useState<EnrichedOrderRecord | null>(null);
  const [voidReason, setVoidReason] = useState<VoidReason>('guest_changed_mind');
  const [voidNotes, setVoidNotes] = useState('');

  // 4. 订单退款与售后冲正弹窗
  const [refundModalRecord, setRefundModalRecord] = useState<EnrichedOrderRecord | null>(null);
  const [refundType, setRefundType] = useState<'full' | 'partial' | 'items'>('full');
  const [refundItemAmounts,setRefundItemAmounts]=useState<Record<string,string>>({});
  const [refundAmountDollars, setRefundAmountDollars] = useState('');
  const [refundRemainingTip, setRefundRemainingTip] = useState(false);
  const [refundMethod, setRefundMethod] = useState<'original_payment' | 'cash' | 'store_credit'>('original_payment');
  const [refundReason, setRefundReason] = useState<'customer_dissatisfied' | 'wrong_charge' | 'duplicate' | 'other'>('customer_dissatisfied');
  const [refundNotes, setRefundNotes] = useState('');
  const itemOptions=useTicketRefundReview(refundModalRecord&&canRefund&&refundModalRecord.totalPaidCents>refundModalRecord.refundCents?{ticketId:refundModalRecord.ticketId,amountCents:refundModalRecord.totalPaidCents-refundModalRecord.refundCents,refundTipCents:Math.max(0,refundModalRecord.tipCents-refundModalRecord.refundTipCents),method:'original_payment'}:null);
  const selectedRefundItems=(itemOptions.data?.items??[]).filter(i=>Object.hasOwn(refundItemAmounts,i.ticketItemId)).map(i=>({ticketItemId:i.ticketItemId,amountCents:Math.round(Number(refundItemAmounts[i.ticketItemId])*100)}));
  const selectedItemsValid=selectedRefundItems.length>0&&selectedRefundItems.every(i=>Number.isSafeInteger(i.amountCents)&&i.amountCents>0&&i.amountCents<=(itemOptions.data?.items?.find(o=>o.ticketItemId===i.ticketItemId)?.remainingCents??0));
  const requestedNonTip=refundModalRecord?(refundType==='items'?selectedRefundItems.reduce((n,i)=>n+i.amountCents,0):refundType==='full'?Math.max(0,refundModalRecord.totalPaidCents-refundModalRecord.tipCents-(refundModalRecord.refundCents-refundModalRecord.refundTipCents)):Math.round(Number(refundAmountDollars)*100)):0;
  const requestedTip=refundModalRecord&&refundRemainingTip?Math.max(0,refundModalRecord.tipCents-refundModalRecord.refundTipCents):0;
  const reviewInput=refundModalRecord&&canRefund&&Number.isSafeInteger(requestedNonTip)&&requestedNonTip>=0&&(refundType!=='items'||selectedItemsValid)?{ticketId:refundModalRecord.ticketId,amountCents:requestedNonTip+requestedTip,refundTipCents:requestedTip,method:refundMethod,...(refundType==='items'?{refundItems:selectedRefundItems}:{})}:null;
  const refundReview=useTicketRefundReview(reviewInput);

  // 5. 导出模态框
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'excel' | 'print'>('csv');
  const [exportScope, setExportScope] = useState<'filtered' | 'all'>('filtered');

  // 辅助Amount转换函数（防止 NaN 或 undefined）
  const centsToDollars = (c: number | undefined | null) => (Number(c ?? 0) / 100).toFixed(2);
  const remainingNonTipRefundCents = (record: EnrichedOrderRecord) => Math.max(
    0,
    record.totalPaidCents - record.tipCents - (record.refundCents - record.refundTipCents),
  );

  // 辅助时间/日期格式化
  const formatTimeOrDate = (completedAt?: string | null, businessDate?: string | null) => {
    if (completedAt) {
      try {
        const d = new Date(completedAt);
        if (!isNaN(d.getTime())) {
          return storeTime.time(d);
        }
      } catch {
        // fallback to businessDate
      }
    }
    return formatI18n(businessDate, language) || t('todayLabel');
  };

  // 融合后端接口真实订单 + 实时待结工单 + 历史订单记录（超强 null-safety 与多语言防白屏保护）
  const combinedOrders = useMemo<EnrichedOrderRecord[]>(() => {
    const list: EnrichedOrderRecord[] = [];
    const openTicketIds = new Set<string>();

    // 1. 如果后端 orders 接口返回了真实历史数据，优先使用
    if (ordersData?.rows && Array.isArray(ordersData.rows) && ordersData.rows.length > 0) {
      ordersData.rows.forEach((row: any) => {
        if (!row || !row.ticketId) return;
        openTicketIds.add(row.ticketId);

        const isCompleted = row.status === 'closed' || row.status === 'paid';
        const isOpen = row.status === 'open' || row.status === 'in_service' || row.status === 'ready_to_pay';
        const isVoided = row.status === 'voided';
        const isRefunded = row.status === 'refunded';
        const normalizedStatus: 'completed' | 'open' | 'voided' | 'refunded' = isRefunded
          ? 'refunded'
          : isVoided
            ? 'voided'
            : isCompleted
              ? 'completed'
              : 'open';

        const rowItems = Array.isArray(row.items) ? row.items : [];
        const rowPayments = Array.isArray(row.payments) ? row.payments : [];
        const rowTips = Array.isArray(row.tipAllocations) ? row.tipAllocations : [];

        const positivePayments=rowPayments.filter((p:{amountCents:number})=>p.amountCents>0);
        const pay = orderPaymentDisplay({ status: normalizedStatus, payments: positivePayments });
        const paymentMethod: EnrichedOrderRecord['paymentMethod'] =
          (row.packageCoveredCents??0)>0&&positivePayments.length===0?'package':pay.method === 'card' ? 'credit_card'
            : pay.method === 'unpaid' ? 'unpaid'
              : pay.method === 'mixed' ? 'split'
                : pay.method;
        const receivedLabel =
          pay.method === 'unpaid'
            ? t('checkout.tkUnpaid')
            : pay.method === 'card'
              ? (pay.last4 ? t('paymentCreditCard', { p0: pay.last4 }) : t('payCard'))
              : pay.method === 'cash'
                ? t('paymentCash')
                : pay.method === 'gift_card'
                  ? t('paymentGiftCard')
                  : pay.method === 'package'
                    ? t('paymentPackage')
                    : pay.method === 'mixed'
                      ? t('paymentMixed')
                      : t('checkout.tkUnpaid');

        const quotaLabels=[(row.membershipCoveredCents??0)>0?membershipText(language,'title'):null,(row.packageCoveredCents??0)>0?serviceRefundText(language,'package'):null].filter(Boolean);
        const paymentLabels=[...new Set(positivePayments.map((p:{method:string})=>p.method))].map(method=>method==='deposit'?serviceRefundText(language,'deposit'):method==='customer_credit'?serviceRefundText(language,'store_credit'):method==='gift_card'?t('paymentGiftCard'):method==='cash'?t('paymentCash'):t('payCard'));
        const paymentLabel=[...quotaLabels,...paymentLabels].join(' + ')||receivedLabel;

        list.push({
          ticketId: row.ticketId,
          orderNumber: `ORD-${(row.ticketId || '').slice(0, 5).toUpperCase()}`,
          businessDate: formatI18n(row.businessDate, language) || '',
          createdAt: row.openedAt || new Date().toISOString(),
          completedAt: row.closedAt || undefined,
          customerName: formatI18n(row.customerName, language) || t('walkInGuest'),
          customerId: row.customerId || undefined,
          customerPhone: row.customerPhone ? String(row.customerPhone) : undefined,
          customerTier: 'Standard Member',
          status: normalizedStatus,
          items: rowItems.map((it: any, idx: number) => ({
            id: it?.itemId || `it-${idx}`,
            name: formatI18n(it?.name ?? it?.name_snapshot ?? it?.nameSnapshot, language) || t('service'),
            priceCents: asCents(it?.totalCents ?? 0),
            durationMin: Number(it?.durationMin ?? 0),
            staffId: it?.membershipId || '',
            staffName: formatI18n(it?.staffName ?? it?.staff_name ?? it?.displayName, language) || t('therapistLabel'),
            isAddon: it?.kind === 'addon',
          })),
          subtotalCents: asCents(row.subtotalCents ?? 0),
          discountCents: asCents(row.discountCents ?? 0),
          discountReason: formatI18n(row.discountReason, language) || undefined,
          taxCents: asCents(row.taxCents ?? 0),
          surchargeCents: asCents(row.surchargeCents ?? 0),
          tipCents: asCents(row.tipCents ?? 0),
          totalPaidCents: asCents(row.totalCents ?? 0),
          membershipCoveredCents:row.membershipCoveredCents??0,
          packageCoveredCents:row.packageCoveredCents??0,
          hasPrepaidSource:quotaLabels.length>0||positivePayments.some((p:{method:string})=>['deposit','gift_card','customer_credit'].includes(p.method)),
          newCollectedCents:rowPayments.filter((p:any)=>['cash','card','external'].includes(p.method)).reduce((sum:number,p:any)=>sum+asCents(p.amountCents),0),
          refundCents: asCents(row.refundCents ?? 0),
          refundTipCents: asCents(row.refundTipCents ?? 0),
          refundTaxCents: asCents(row.refundTaxCents ?? 0),
          refundFeeCents: asCents(row.refundFeeCents ?? 0),
          paymentMethod,
          paymentMethodLabel: paymentLabel,
          cardLast4: pay.last4 || undefined,
          cashierName: formatI18n(row.cashierName, language) || t('roleFrontDeskKey'),
          // ⚠️ 回调参数不能叫 `t` —— 会遮蔽外层 useLanguage() 的翻译函数，
          // 导致下一行的 t('therapistLabel') 静默调用错误的东西。
          tipSplits: rowTips.map((tip: any) => ({
            staffId: '',
            staffName: formatI18n(tip?.staffName ?? tip?.display_name, language) || t('therapistLabel'),
            amountCents: asCents(tip?.amountCents ?? 0),
            percentage:
              asCents(row.tipCents ?? 0) > 0
                ? Math.round((asCents(tip?.amountCents ?? 0) / asCents(row.tipCents ?? 1)) * 100)
                : 100,
          })),
          daysAgo: 0,
          voidReason: formatI18n(row.voidReason, language) || undefined,
          voidNotes: formatI18n(row.voidNotes, language) || undefined,
          notes: formatI18n(row.notes, language) || undefined,
        });
      });
    }

    // 2. 结合来自服务端的实时待结工单
    if (data?.tickets && Array.isArray(data.tickets)) {
      data.tickets.forEach((tk: any) => {
        if (!tk || !tk.ticketId) return;
        if (!openTicketIds.has(tk.ticketId)) {
          openTicketIds.add(tk.ticketId);
          const tkItems = Array.isArray(tk.items) ? tk.items : [];
          const subtotal = asCents(tk.subtotalCents ?? 0);
          /*
           * 未结工单不预估税费与手续费。
           *
           * ⚠️ 此处此前按 8.875%（纽约州税率）与 3.5% 写死推算并计入"已付金额"，
           * 存在两重问题：税率随门店所在地而异，不能由前端假定；且工单尚未结账，
           * 呈现一个并不存在的收款金额会误导对账。
           * 实际税费与手续费由服务端在 `ticket.close` 时依门店设置计算。
           */

          list.push({
            ticketId: tk.ticketId,
            orderNumber: `ORD-${(tk.ticketId || '').slice(0, 5).toUpperCase()}`,
            businessDate: formatI18n(tk.businessDate || data.businessDate || '2026-08-26', language),
            createdAt: new Date().toISOString(),
            customerName: formatI18n(tk.customerName, language) || t('walkInGuest'),
            customerId: undefined,
            customerTier: 'Standard Member',
            status: 'open',
            items: tkItems.map((item: any, idx: number) => ({
              id: item?.ticketItemId || `item-${idx}`,
              name: formatI18n(item?.name ?? item?.nameSnapshot ?? item?.name_snapshot, language) || t('service'),
              priceCents: asCents(item?.totalCents ?? 0),
              durationMin: Number(item?.durationMin || 60),
              staffId: item?.membershipId || '',
              staffName: formatI18n(item?.staffName ?? item?.display_name, language) || t('staffUnassigned'),
            })),
            subtotalCents: subtotal,
            discountCents: 0,
            taxCents: 0,
            surchargeCents: 0,
            tipCents: 0,
            totalPaidCents: subtotal,
            refundCents: 0,
            refundTipCents: 0,
            refundTaxCents: 0,
            refundFeeCents: 0,
            paymentMethod: 'unpaid',
            paymentMethodLabel: t('checkout.tkUnpaid'),
            cashierName: t('roleFrontDeskKey'),
            tipSplits: [],
            daysAgo: Number(tk.daysAgo ?? 0),
          });
        }
      });
    }

    return list;
  }, [data, ordersData, language]);

  /**
   * 提取所有技师名单用于筛选器。
   *
   * ⚠️ 排除「没有真人接单」的判据是 `staffId` 是否有值，不是把
   * `staffName` 拿去跟某个中文占位字符串做比较——占位文字现在跟着
   * 界面语言走（"未指定技师" / "No therapist assigned" / …），
   * 字符串比较在非中文语言下会静默失效，把占位文案本身当成一个
   * "技师" 塞进筛选器选项里。
   */
  const allStaffOptions = useMemo(() => {
    const names = new Set<string>();
    (combinedOrders || []).forEach((o) => {
      (o?.items || []).forEach((it) => {
        if (it?.staffId && it?.staffName) {
          names.add(it.staffName);
        }
      });
    });
    return Array.from(names);
  }, [combinedOrders]);

  // 多维度联动过滤逻辑 (支持错别字容错模糊搜索)
  const filteredOrders = useMemo(() => {
    let list = (combinedOrders || []).filter((ord) => {
      if (!ord) return false;

      // 1. 状态筛选
      if (statusFilter !== 'all' && ord.status !== statusFilter) {
        return false;
      }

      // 2. 日期筛选
      if (datePreset === 'today' && ord.daysAgo !== 0) return false;
      if (datePreset === 'yesterday' && ord.daysAgo !== 1) return false;
      if (datePreset === 'last7days' && (ord.daysAgo ?? 0) > 7) return false;
      if (customDate && ord.businessDate !== customDate) return false;

      // 3. 技师筛选
      if (staffFilter !== 'all') {
        const hasStaff = (ord.items || []).some((it) => it?.staffName === staffFilter);
        if (!hasStaff) return false;
      }

      // 4. 支付方式筛选
      if (paymentFilter !== 'all') {
        if (paymentFilter === 'card' && ord.paymentMethod !== 'credit_card') return false;
        if (paymentFilter === 'cash' && ord.paymentMethod !== 'cash') return false;
        if (paymentFilter === 'package' && ord.paymentMethod !== 'package' && !(ord.packageCoveredCents??0)) return false;
        if (paymentFilter === 'giftcard' && ord.paymentMethod !== 'gift_card') return false;
        if (paymentFilter === 'split' && ord.paymentMethod !== 'split') return false;
      }

      // 5. Amount区间筛选
      if (amountRange !== 'all') {
        const totalDollars = (asCents(ord.totalPaidCents ?? 0)) / 100;
        if (amountRange === '0-50' && (totalDollars < 0 || totalDollars > 50)) return false;
        if (amountRange === '50-100' && (totalDollars < 50 || totalDollars > 100)) return false;
        if (amountRange === '100-200' && (totalDollars < 100 || totalDollars > 200)) return false;
        if (amountRange === '200+' && totalDollars < 200) return false;
      }

      return true;
    });

    // 6. 搜索关键词容错模糊检索
    if (searchTerm.trim()) {
      list = fuzzySearch(list, searchTerm, {
        keys: [
          { name: 'customerName', weight: 0.5 },
          { name: 'customerPhone', weight: 0.3 },
          { name: 'orderNumber', weight: 0.3 },
          { name: 'ticketId', weight: 0.2 },
          { name: 'items.name', weight: 0.25 },
          { name: 'items.staffName', weight: 0.2 },
        ],
        threshold: 0.45,
      });
    }

    return list;
  }, [combinedOrders, searchTerm, statusFilter, datePreset, customDate, staffFilter, paymentFilter, amountRange]);

  // 核心财务与经营指标卡片统计
  const metrics = useMemo(() => {
    const orders = filteredOrders || [];
    const completedList = orders.filter((x) => x?.status === 'completed');
    const openList = orders.filter((x) => x?.status === 'open');
    const voidedList = orders.filter((x) => x?.status === 'voided' || x?.status === 'refunded');

    const totalRevenueCents = completedList.reduce(
      (sum, x) => sum + Math.max(0, asCents(x?.totalPaidCents ?? 0) - asCents(x?.refundCents ?? 0)),
      0,
    );
    const totalTipsCents = completedList.reduce(
      (sum, x) => sum + Math.max(0, asCents(x?.tipCents ?? 0) - asCents(x?.refundTipCents ?? 0)),
      0,
    );
    const totalTaxSurchargeCents = completedList.reduce(
      (sum, x) => sum
        + asCents(x?.taxCents ?? 0) + asCents(x?.surchargeCents ?? 0)
        - asCents(x?.refundTaxCents ?? 0) - asCents(x?.refundFeeCents ?? 0),
      0,
    );
    const avgTicketCents =
      completedList.length > 0 ? Math.round(totalRevenueCents / completedList.length) : 0;

    return {
      totalCount: orders.length,
      completedCount: completedList.length,
      openCount: openList.length,
      voidedCount: voidedList.length,
      totalRevenueCents,
      totalTipsCents,
      totalTaxSurchargeCents,
      avgTicketCents,
    };
  }, [filteredOrders]);

  // 作废工单处理
  const handleConfirmVoid = async () => {
    if (!voidModalRecord) return;
    try {
      await voidMutation.mutateAsync({
        ticketId: voidModalRecord.ticketId,
        reason: voidReason,
        note: voidNotes || undefined,
      });
      toast.success(t('voided') || t('checkout.tkVoided'), { description: voidModalRecord.ticketId });
      setVoidModalRecord(null);
      setVoidNotes('');
      if (selectedRecord?.ticketId === voidModalRecord.ticketId) {
        setSelectedRecord(null);
      }
    } catch (e: any) {
      toast.danger(t('saveFailed') || t('checkout.tkVoidFailed') + (e?.message || t('checkout.tkNetworkError')));
    }
  };

  // 打开退款处理弹窗
  const handleOpenRefund = (record: EnrichedOrderRecord) => {
    const refundableCents = fullRefundCents(record);
    if (!canRefund) return;
    setRefundModalRecord(record);
    setRefundType('full');
    setRefundAmountDollars(centsToDollars(refundableCents));
    setRefundRemainingTip(false);
    setRefundMethod('original_payment');
    setRefundReason('customer_dissatisfied');
    setRefundNotes('');
    setRefundItemAmounts({});
  };

  // 执行退款处理
  const handleRetrySavedRefund=async()=>{
    const saved=refundMutation.pendingRefund;if(!saved||!canRefund||refundMutation.isPending)return;
    try{await refundMutation.mutateAsync(saved);setRefundModalRecord(null);setSelectedRecord(null);toast.success(t('checkout.tkRefundRecorded'));}
    catch(err){toast.danger(errorMessage(err));}
  };
  const handleConfirmRefund = async () => {
    if (!refundModalRecord || !canRefund || !refundReview.data || !reviewInput || refundMutation.pendingRefund) return;
    const remainingTipCents = Math.max(
      0,
      refundModalRecord.tipCents - refundModalRecord.refundTipCents,
    );
    const maxNonTipCents = Math.max(
      0,
      asCents(refundModalRecord.totalPaidCents || refundModalRecord.subtotalCents || 0)
        - refundModalRecord.tipCents
        - (refundModalRecord.refundCents - refundModalRecord.refundTipCents),
    );
    const nonTipAmountCents = refundType==='items'?requestedNonTip:refundType === 'full'
      ? maxNonTipCents
      : Math.round(parseFloat(refundAmountDollars || '0') * 100);
    const refundTipCents = refundRemainingTip ? remainingTipCents : 0;
    const amountCents = nonTipAmountCents + refundTipCents;

    if (!amountCents || amountCents <= 0) {
      toast.danger(t('checkout.tkInvalidRefund'));
      return;
    }

    if (nonTipAmountCents > maxNonTipCents) {
      toast.danger(t('checkout.tkRefundTooLarge', { p0: centsToDollars(maxNonTipCents) }));
      return;
    }

    try {
      const response = await refundMutation.mutateAsync({
        ticketId: refundModalRecord.ticketId,
        amountCents,
        refundTipCents,
        reason: refundReason,
        method: refundMethod,
        notes: refundNotes || undefined,
        reviewHash: refundReview.data.reviewHash,
        ...(refundType==='items'?{refundItems:selectedRefundItems}:{}),
      });
      toast.success(t('checkout.tkRefundRecorded'), {
        description: t('checkout.tkRefundDetail', { p0: refundModalRecord.orderNumber || refundModalRecord.ticketId, p1: centsToDollars(amountCents) }),
      });
      setRefundModalRecord(null);
      if (selectedRecord?.ticketId === refundModalRecord.ticketId) {
        setSelectedRecord(null);
      }
    } catch (err: any) {
      toast.danger(err?.details?.reason==='refund_review_changed'?serviceRefundText(language,'changed'):errorMessage(err));
    }
  };

  // 订单状态的界面语言文案：导出与打印共用同一套口径。
  const statusLabel = (status: string) =>
    status === 'completed'
      ? t('checkout.tkExportStatusCompleted')
      : status === 'open'
        ? t('readyCheckoutLabel')
        : status === 'voided'
          ? t('statusVoided')
          : t('statusRefunded');

  // 执行数据导出操作
  const handleExecuteExport = () => {
    const recordsToExport = exportScope === 'filtered' ? filteredOrders : combinedOrders;

    if (recordsToExport.length === 0) {
      toast.danger(t('checkout.tkNoExportData'));
      return;
    }

    if (exportFormat === 'print') {
      // 内部对账单跟随界面语言；顾客面向的收据仍固定英文。
      printTable(t('checkout.tkPrintStatementTitle', { p0: recordsToExport.length }),
        [t('checkout.tkPrintColReceipt'), t('checkout.tkExportBusinessDate'), t('checkout.tkExportCustomerName'), t('checkout.tkExportStatus'),
          { label: t('checkout.tkExportTotalCollected'), numeric: true }, { label: t('checkout.tkPrintColRefund'), numeric: true }],
        recordsToExport.map(order => [order.orderNumber || order.ticketId, order.businessDate || '', order.customerName || '', statusLabel(order.status),
          centsToDollars(order.totalPaidCents), centsToDollars(order.refundCents)]));
      setExportModalOpen(false);
      return;
    }

    const headers = [
      t('checkout.tkExportOrderNumber'),
      t('checkout.tkExportTicketId'),
      t('checkout.tkExportBusinessDate'),
      t('checkout.tkExportCustomerName'),
      t('checkout.tkExportCustomerPhone'),
      t('checkout.tkExportCustomerTier'),
      t('checkout.tkExportLineItems'),
      t('checkout.tkExportStaff'),
      t('checkout.tkExportSubtotal'),
      t('checkout.tkExportDiscount'),
      t('checkout.tkExportTax'),
      t('checkout.tkExportSurcharge'),
      t('checkout.tkExportTotalTips'),
      t('checkout.tkExportTipSplit'),
      t('checkout.tkExportTotalCollected'),
      t('checkout.tkExportPaymentChannel'),
      t('checkout.tkExportTxnRef'),
      t('checkout.tkExportCashier'),
      t('checkout.tkExportStatus'),
      t('checkout.tkExportVoidNote'),
    ];

    const rows = recordsToExport.map((ord) => [
      ord.orderNumber || '',
      ord.ticketId || '',
      ord.businessDate || '',
      ord.customerName || t('walkInGuest'),
      ord.customerPhone || t('checkout.tkExportNoPhone'),
      ord.customerTier === 'Standard Member' ? t('standardMember') : (ord.customerTier || t('standardMember')),
      (ord.items || []).map((i) => `${i?.name || t('service')} (${i?.durationMin || 60}m)`).join('; '),
      (ord.items || []).map((i) => i?.staffName || t('staffUnassigned')).join(' / '),
      centsToDollars(ord.subtotalCents),
      centsToDollars(ord.discountCents),
      centsToDollars(ord.taxCents),
      centsToDollars(ord.surchargeCents),
      centsToDollars(ord.tipCents),
      (ord.tipSplits || [])
        .map((s) => `${s?.staffName || t('therapistLabel')}: $${centsToDollars(s?.amountCents)}`)
        .join('; ') || t('checkout.tkExportNoTip'),
      centsToDollars(ord.totalPaidCents),
      ord.paymentMethodLabel || t('creditCardLabel'),
      ord.cardLast4 ? `*${ord.cardLast4}` : ord.transactionRef || '-',
      ord.cashierName || t('roleFrontDeskKey'),
      statusLabel(ord.status),
      ord.voidReason ? `${ord.voidReason} ${ord.voidNotes ? `(${ord.voidNotes})` : ''}` : ord.notes || '',
    ]);

    const filename = `GenieFront_Order_Records_${new Date().toISOString().slice(0, 10)}`;

    if (exportFormat === 'csv') {
      exportToCSV(filename, headers, rows);
      toast.success(t('checkout.tkExportedCsv', { p0: recordsToExport.length }));
    } else {
      exportToExcel(filename, headers, rows);
      toast.success(t('checkout.tkExportedExcel', { p0: recordsToExport.length }));
    }

    setExportModalOpen(false);
  };

  // 清空筛选
  const handleResetFilters = () => {
    setSearchTerm('');
    setStatusFilter('all');
    setDatePreset('all');
    setCustomDate('');
    setStaffFilter('all');
    setPaymentFilter('all');
    setAmountRange('all');
    toast.success(t('checkout.tkFiltersReset'));
  };

  const hasActiveFilters =
    searchTerm !== '' ||
    statusFilter !== 'all' ||
    datePreset !== 'all' ||
    customDate !== '' ||
    staffFilter !== 'all' ||
    paymentFilter !== 'all' ||
    amountRange !== 'all';

  if (isInitialLoading) {
    return <PageLoading layout="list" title={t('checkout.tkLoading')} description={t('checkout.tkLoadingDesc')} />;
  }

  if ((error || ordersError) && !ordersData && !data) {
    return (
      <PageError
        title={t('checkout.tkLoadError')}
        error={error || ordersErr}
        onRetry={() => {
          void refetchTickets();
          void refetchOrders();
        }}
      />
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {canRefund&&refundMutation.pendingRefund?<div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2">
        <p>{serviceRefundText(language,'unknown')} · #{refundMutation.pendingRefund.ticketId.slice(0,8)}</p>
        <Button disabled={refundMutation.isPending} onClick={()=>void handleRetrySavedRefund()}>{serviceRefundText(language,'retry')}</Button>
      </div>:null}
      {/* 顶部标题与全局操作 */}
      <PageHeader
        title={t('ticketsTitle') || t('checkout.tkTitle')}
        description={
          (t('selectBusinessDate') || t('checkout.tkBusinessDate')) +
          ': ' +
          (data?.businessDate || '2026-08-26') +
          t('checkout.tkLiveCount') +
          filteredOrders.length +
          t('checkout.tkOrderUnit')
        }
        actions={
          <div className="flex items-center gap-2.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setExportModalOpen(true)}
              className="gap-1.5 font-bold"
            >
              <Download className="w-4 h-4 text-teal-600" />
              <span>{t('checkout.tkExportTransactions')}</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                refetchTickets();
                refetchOrders();
                toast.success(t('checkout.tkListRefreshed'));
              }}
              className="gap-1.5 font-bold"
              disabled={isLoading || ordersLoading}
            >
              <RefreshCw className={'w-4 h-4 ' + (isLoading || ordersLoading ? 'animate-spin' : '')} />
              <span>{t('refresh') || t('checkout.tkRefresh')}</span>
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md gap-1.5 font-bold"
              onClick={() => navigate('/checkout')}
            >
              <Receipt className="w-4 h-4" />
              <span>{t('checkout') || t('checkout.tkGoToCheckout')}</span>
            </Button>
          </div>
        }
      />

      {/* 跨日未结工单强提醒横幅 */}
      {data && Number(data.staleCount ?? 0) > 0 && (
        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 flex items-start justify-between gap-4 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-sm">
                {(t('staleTicket') || t('checkout.tkCarryOverExists')) + ' (' + data.staleCount + ')'}
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                
                {t('checkout.tkCarryOverDesc')}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 text-white shrink-0 font-bold"
            onClick={() => setStatusFilter('open')}
          >
            
            {t('checkout.tkFilterUnsettled')}
          </Button>
        </div>
      )}

      {/* 4 大核心关键指标卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. 总营业流水 */}
        <Card className="p-4 bg-white border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{t('checkout.tkTotalCollected')}</span>
            <div className="p-2 rounded-xl bg-teal-50 text-teal-600">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <span className="text-2xl font-black font-mono text-slate-900">
              ${centsToDollars(metrics.totalRevenueCents)}
            </span>
            <p className="text-[11px] text-slate-500 font-medium">
              
              {t('checkout.tkSettledPrefix')} <strong className="text-teal-700 font-bold">{metrics.completedCount}</strong>  {t('checkout.tkOrderUnit2')}
            </p>
          </div>
        </Card>

        {/* 2. Total Tips */}
        <Card className="p-4 bg-white border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{t('checkout.tkVoluntaryTips')}</span>
            <div className="p-2 rounded-xl bg-amber-50 text-amber-600">
              <Coins className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <span className="text-2xl font-black font-mono text-amber-800">
              ${centsToDollars(metrics.totalTipsCents)}
            </span>
            <p className="text-[11px] text-slate-500 font-medium">{t('checkout.tkTipsNote')}</p>
          </div>
        </Card>

        {/* 3. 税费与刷卡通道费 */}
        <Card className="p-4 bg-white border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{t('checkout.tkTaxAndFees')}</span>
            <div className="p-2 rounded-xl bg-blue-50 text-blue-600">
              <CreditCard className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <span className="text-2xl font-black font-mono text-slate-900">
              ${centsToDollars(metrics.totalTaxSurchargeCents)}
            </span>
            <p className="text-[11px] text-slate-500 font-medium">{taxNote}</p>
          </div>
        </Card>

        {/* 4. 平均客单价与状态概览 */}
        <Card className="p-4 bg-white border-slate-200 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{t('checkout.tkAov')}</span>
            <div className="p-2 rounded-xl bg-purple-50 text-purple-600">
              <Sparkles className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-2 space-y-1">
            <span className="text-2xl font-black font-mono text-purple-900">
              ${centsToDollars(metrics.avgTicketCents)}
            </span>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-amber-700 font-bold">{t('checkout.tkAwaitingPayment')} {metrics.openCount}</span>
              <span className="text-slate-300">|</span>
              <span className="text-red-600 font-bold">{t('checkout.tkVoidedRefunded')} {metrics.voidedCount}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* 筛选与检索控制工具栏 */}
      <Card className="p-4 bg-white border-slate-200 shadow-sm space-y-4">
        {/* 顶部：状态快速选项卡 + 搜索框 + 重置 */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          {/* 状态 Tabs */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-100/90 rounded-2xl shrink-0 overflow-x-auto">
            {[
              { id: 'all', label: t('checkout.tkTabAll'), count: combinedOrders.length },
              { id: 'completed', label: t('checkout.tkTabSettled'), count: combinedOrders.filter((o) => o.status === 'completed').length },
              { id: 'open', label: t('checkout.tkTabPending'), count: combinedOrders.filter((o) => o.status === 'open').length },
              { id: 'voided', label: t('checkout.tkTabVoided'), count: combinedOrders.filter((o) => o.status === 'voided').length },
              { id: 'refunded', label: t('checkout.tkTabRefunded'), count: combinedOrders.filter((o) => o.status === 'refunded').length },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id as any)}
                className={cn(
                  'px-3 py-1.5 text-xs font-bold rounded-xl transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer',
                  statusFilter === tab.id
                    ? 'bg-white text-teal-800 shadow-xs ring-1 ring-slate-200'
                    : 'text-slate-600 hover:text-slate-900',
                )}
              >
                <span>{tab.label}</span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 rounded-md text-[10px] font-mono',
                    statusFilter === tab.id ? 'bg-teal-50 text-teal-700' : 'bg-slate-200/70 text-slate-500',
                  )}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* 搜索框与重置 */}
          <div className="flex items-center gap-2 flex-1 max-w-md ml-auto">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={t('checkout.tkSearchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-200 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
                >
                  ✕
                </button>
              )}
            </div>

            {hasActiveFilters && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleResetFilters}
                className="text-xs font-bold text-slate-600 hover:text-red-600 shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                <span>{t('checkout.tkReset')}</span>
              </Button>
            )}
          </div>
        </div>

        {/* 底部：高级多维组合筛选 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-100 text-xs">
          {/* 1. 日期快捷筛选 */}
          <div>
            <select
              value={datePreset}
              onChange={(e) => {
                setDatePreset(e.target.value as any);
                if (e.target.value !== 'all') setCustomDate('');
              }}
              className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            >
              <option value="all">{t('checkout.tkDateAll')}</option>
              <option value="today">{t('checkout.tkDateToday')}</option>
              <option value="yesterday">{t('checkout.tkDateYesterday')}</option>
              <option value="last7days">{t('checkout.tkDate7Days')}</option>
              <option value="thisMonth">{t('checkout.tkDateMonth')}</option>
            </select>
          </div>

          {/* 2. 技师筛选 */}
          <div>
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            >
              <option value="all">{t('checkout.tkStaffAll')}</option>
              {allStaffOptions.map((name) => (
                <option key={name} value={name}>
                  
                  {t('checkout.tkStaffPrefix')} {name}
                </option>
              ))}
            </select>
          </div>

          {/* 3. 支付方式筛选 */}
          <div>
            <select
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value as any)}
              className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            >
              <option value="all">{t('checkout.tkPaymentAll')}</option>
              <option value="card">{t('checkout.tkPaymentCard')}</option>
              <option value="cash">{t('checkout.tkPaymentCash')}</option>
              <option value="package">{t('checkout.tkPaymentPackage')}</option>
              <option value="giftcard">{t('checkout.tkPaymentGiftCard')}</option>
              <option value="split">{t('checkout.tkPaymentSplit')}</option>
            </select>
          </div>

          {/* 4. Amount区间筛选 */}
          <div>
            <select
              value={amountRange}
              onChange={(e) => setAmountRange(e.target.value)}
              className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
            >
              <option value="all">{t('checkout.tkAmountAll')}</option>
              <option value="0-50">{t('checkout.tkAmount0to50')}</option>
              <option value="50-100">{t('checkout.tkAmount50to100')}</option>
              <option value="100-200">{t('checkout.tkAmount100to200')}</option>
              <option value="200+">{t('checkout.tkAmount200plus')}</option>
            </select>
          </div>
        </div>
      </Card>

      {/* 订单核心数据表格 */}
      <Card className="p-4 bg-white border-slate-200 shadow-sm overflow-hidden">
        {filteredOrders.length === 0 ? (
          <EmptyState
            icon={<FileText className="w-10 h-10 text-slate-400" />}
            title={t('noOpenTickets') || t('checkout.tkNoOrders')}
            description={
              searchTerm || hasActiveFilters
                ? t('checkout.tkNoOrdersFiltered')
                : t('checkout.tkNoOrdersToday')
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/80 text-[11px] text-slate-600 font-bold uppercase tracking-wider whitespace-nowrap">
                  <TableHead className="min-w-[110px]">{t('checkout.tkColTicket')}</TableHead>
                  <TableHead className="min-w-[140px]">{t('checkout.tkColCustomer')}</TableHead>
                  <TableHead className="min-w-[170px]">{t('checkout.tkColService')}</TableHead>
                  <TableHead className="min-w-[90px]">{filteredOrders.some(o=>o.hasPrepaidSource)?membershipText(language,'settlementTotal'):t('checkout.tkTotalCollected')}</TableHead>
                  <TableHead className="min-w-[105px]">{t('checkout.tkColPayment')}</TableHead>
                  <TableHead className="min-w-[100px]">{t('checkout.tkColTips')}</TableHead>
                  <TableHead className="min-w-[75px] text-center">{t('checkout.tkColStatus')}</TableHead>
                  <TableHead className="w-[104px] min-w-[96px] text-right">{t('checkout.tkColActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((ord, idx) => (
                  <TableRow
                    key={`${ord.ticketId}-${idx}`}
                    className="hover:bg-slate-50/80 transition-colors cursor-pointer text-xs"
                    onClick={() => setSelectedRecord(ord)}
                  >
                    {/* 单号与时间 */}
                    <TableCell className="space-y-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono font-bold text-slate-900">{ord.orderNumber || ord.ticketId}</span>
                        {Number(ord.daysAgo ?? 0) > 0 && (
                          <Badge variant="warning" className="text-[9px] px-1 py-0 font-bold whitespace-nowrap shrink-0">
                            {ord.daysAgo}{t('checkout.tkDaysAgo')}
                          </Badge>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono block">
                        {formatTimeOrDate(ord.completedAt, ord.businessDate)}
                      </span>
                    </TableCell>

                    {/* 顾客 */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-xl bg-teal-50 text-teal-700 font-bold flex items-center justify-center text-xs shrink-0 border border-teal-200">
                          {customerInitials(ord.customerName || t('checkout.tkGuestShort'))}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-slate-900 leading-tight">{ord.customerName || t('checkout.tkWalkInGuest')}</span>
                            <Badge
                              variant="secondary"
                              className={cn(
                                'text-[9px] px-1.5 py-0.5 font-bold whitespace-nowrap shrink-0',
                                ord.customerTier === 'Black Diamond VIP'
                                    ? 'bg-amber-100 text-amber-900 border-amber-300'
                                    : 'bg-slate-100 text-slate-600',
                              )}
                            >
                              {ord.customerTier === 'Standard Member' ? t('standardMember') : (ord.customerTier || t('standardMember'))}
                            </Badge>
                          </div>
                          {ord.customerPhone && (
                            <span className="text-[10px] text-slate-400 font-mono block mt-0.5">
                              {formatPhoneDisplay(ord.customerPhone)}
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>

                    {/* 服务项目与技师 */}
                    <TableCell>
                      <div className="space-y-1 max-w-xs">
                        {(ord.items || []).map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate font-medium text-slate-800 flex items-center gap-1">
                              {item?.isAddon && <span className="text-[9px] text-purple-600 font-bold shrink-0">{t('checkout.tkAddOn')}</span>}
                              <span className="truncate">{item?.name || t('checkout.tkServiceItem')}</span>
                              {item?.durationMin ? (
                                <span className="text-slate-400 font-mono shrink-0">({item.durationMin}m)</span>
                              ) : null}
                            </span>
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0.5 bg-slate-100 text-slate-700 shrink-0 font-bold whitespace-nowrap">
                              {item?.staffName || t('checkout.tkTherapist')}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </TableCell>

                    {/* Total Collected (如有优惠紧凑展示已省) */}
                    <TableCell>
                      <div className="space-y-0.5">
                        <span className="text-sm font-black font-mono text-teal-700 block">
                          ${centsToDollars(ord.totalPaidCents)}
                        </span>
                        {ord.hasPrepaidSource&&<span className="text-[10px] text-slate-500 block">{membershipText(language,'newCollected')}: ${centsToDollars(ord.newCollectedCents??0)}</span>}
                        {asCents(ord.discountCents ?? 0) > 0 && (
                          <span className="text-[10px] text-emerald-700 font-bold block font-mono">
                            
                            {t('checkout.tkSaved')}{centsToDollars(ord.discountCents)}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    {/* 支付方式 */}
                    <TableCell>
                      <div className="space-y-0.5">
                        <span className="font-medium text-slate-800 text-xs block whitespace-nowrap">
                          {ord.paymentMethodLabel || t('checkout.tkCardSettlement')}
                        </span>
                        {ord.transactionRef && (
                          <span className="text-[10px] text-slate-400 font-mono block">
                            {ord.transactionRef}
                          </span>
                        )}
                      </div>
                    </TableCell>

                    {/* 小费分账 */}
                    <TableCell>
                      {asCents(ord.tipCents ?? 0) > 0 ? (
                        <div className="space-y-0.5">
                          <span className="font-mono font-bold text-amber-700 text-xs">
                            ${centsToDollars(ord.tipCents)}
                          </span>
                          <div className="text-[10px] text-slate-500 truncate max-w-[110px]">
                            {(ord.tipSplits || []).map((s) => `${s?.staffName || t('therapistLabel')}: $${centsToDollars(s?.amountCents)}`).join(' · ')}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-400 text-xs whitespace-nowrap">{t('checkout.tkNoTip')}</span>
                      )}
                    </TableCell>

                    {/* 状态徽章 (固定不折行药丸徽章) */}
                    <TableCell className="text-center">
                      {ord.status === 'completed' && canRefund && (
                        <div className="flex flex-col items-center gap-1">
                          <Badge variant="success" className="text-[10px] font-bold whitespace-nowrap px-2.5 py-0.5">
                            {t('checkout.tkStatusSettled')}
                          </Badge>
                          {ord.refundCents > 0 && (
                            <Badge variant="secondary" className="text-[9px] whitespace-nowrap bg-purple-50 text-purple-800 border-purple-200">
                              {t('checkout.tkRefundPartial')} ${centsToDollars(ord.refundCents)}
                            </Badge>
                          )}
                        </div>
                      )}
                      {ord.status === 'open' && (
                        <Badge variant="warning" className="text-[10px] font-bold whitespace-nowrap px-2.5 py-0.5">
                          
                          {t('checkout.tkStatusPending')}
                        </Badge>
                      )}
                      {ord.status === 'voided' && (
                        <Badge variant="destructive" className="text-[10px] font-bold whitespace-nowrap px-2.5 py-0.5">
                          {t('checkout.tkStatusVoidedLabel')}
                        </Badge>
                      )}
                      {ord.status === 'refunded' && (
                        <Badge variant="secondary" className="text-[10px] font-bold whitespace-nowrap px-2.5 py-0.5 bg-purple-100 text-purple-800 border-purple-200">
                          {t('checkout.tkStatusRefundedLabel')}
                        </Badge>
                      )}
                    </TableCell>

                    {/* 操作 */}
                    <TableCell className="text-right align-middle py-2.5">
                      <div className="flex flex-col items-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {ord.status === 'open' && (
                          <Button
                            size="sm"
                            className="text-xs font-bold gap-1 rounded-xl h-7 px-2 bg-teal-600 hover:bg-teal-700 text-white w-[88px] justify-center shadow-xs shrink-0"
                            onClick={() => navigate(`/checkout?ticketId=${ord.ticketId}`)}
                          >
                            <Receipt className="w-3.5 h-3.5 shrink-0" />
                            <span>{t('checkout.tkGoCheckout')}</span>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          className="text-xs font-bold gap-1 rounded-xl h-7 px-2 bg-white hover:bg-slate-100 border-slate-200 text-slate-700 w-[88px] justify-center shrink-0"
                          onClick={() => setSelectedRecord(ord)}
                          title={t('checkout.tkViewReceipt')}
                        >
                          <Eye className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span>{t('checkout.tkDetail')}</span>
                        </Button>
                        {ord.status === 'completed' && canRefund && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="text-xs font-bold gap-1 rounded-xl h-7 px-2 text-purple-700 bg-purple-50 hover:bg-purple-100 border-purple-200 w-[88px] justify-center shrink-0"
                            onClick={() => handleOpenRefund(ord)}
                            title={t('checkout.tkProcessRefund')}
                          >
                            <RotateCcw className="w-3 h-3 text-purple-600 shrink-0" />
                            <span>{t('checkout.tkRefund')}</span>
                          </Button>
                        )}
                        {ord.status === 'open' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="text-xs font-bold text-red-600 hover:bg-red-50 border-red-200 gap-1 rounded-xl h-7 px-2 w-[88px] justify-center shrink-0"
                            onClick={() => setVoidModalRecord(ord)}
                          >
                            <Ban className="w-3.5 h-3.5 text-red-500 shrink-0" />
                            <span>{t('checkout.tkVoid')}</span>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* 订单电子小票与全明细抽屉 / 模态框 */}
      {selectedRecord && (
        <Modal
          isOpen={Boolean(selectedRecord)}
          onOpenChange={(open) => {
            if (!open) setSelectedRecord(null);
          }}
          title={
            <div className="flex items-center gap-2 text-teal-900 font-bold">
              <Receipt className="w-5 h-5 text-teal-600" />
              <span>{t('checkout.tkReceiptTitle')} {selectedRecord.orderNumber || selectedRecord.ticketId}</span>
            </div>
          }
          size="lg"
          footer={
            <div className="flex justify-between items-center w-full">
              <Button
                variant="secondary"
                size="sm"
                className="text-xs font-bold gap-1"
                onClick={() => {
                  navigate(`/print/receipt/${selectedRecord.ticketId}`);
                }}
              >
                <Printer className="w-3.5 h-3.5 text-slate-600" />
                <span>Print Receipt</span>
              </Button>
              <div className="flex items-center gap-2">
                {selectedRecord.status === 'completed' && canRefund && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-xs font-bold gap-1 text-purple-700 bg-purple-50 border-purple-200 hover:bg-purple-100"
                    onClick={() => {
                      const rec = selectedRecord;
                      setSelectedRecord(null);
                      handleOpenRefund(rec);
                    }}
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-purple-600" />
                    <span>{t('checkout.tkDoRefund')}</span>
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setSelectedRecord(null)}>
                  
                  {t('checkout.tkClose')}
                </Button>
                {selectedRecord.status === 'open' && (
                  <Button
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
                    onClick={() => {
                      const id = selectedRecord.ticketId;
                      setSelectedRecord(null);
                      navigate(`/checkout?ticketId=${id}`);
                    }}
                  >
                    
                    {t('checkout.tkGoToTill')}
                  </Button>
                )}
              </div>
            </div>
          }
        >
          <div className="space-y-4 text-xs text-slate-800 max-h-[75vh] overflow-y-auto custom-scrollbar pr-1">
            {/* 仿真电子热敏小票卡片 */}
            <div className="p-5 bg-slate-50/80 rounded-3xl border border-slate-200 space-y-4 shadow-sm relative">
              {/* 店铺抬头 */}
              <div className="text-center pb-3 border-b border-dashed border-slate-300 space-y-1">
                <h3 className="text-base font-black text-slate-900 tracking-wider">
                  {pickText(membership?.locationName, 'en', '—')}
                </h3>
                <p className="text-[11px] text-slate-500">
                  
                  {t('checkout.tkReceiptSubtitle')}
                </p>
                <p className="text-[10px] text-slate-400 font-mono">
                  
                  {t('checkout.tkReceiptNo')} {selectedRecord.orderNumber || selectedRecord.ticketId} ({selectedRecord.ticketId})
                </p>
              </div>

              {/* 订单基础信息 */}
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600 pb-3 border-b border-dashed border-slate-300">
                <div>
                  <span>{t('checkout.tkReceiptCustomer')} </span>
                  <strong className="text-slate-900">{selectedRecord.customerName || t('checkout.tkWalkInGuest2')}</strong>
                  <span className="text-[10px] text-amber-700 font-bold ml-1">({selectedRecord.customerTier === 'Standard Member' ? t('standardMember') : (selectedRecord.customerTier || t('standardMember'))})</span>
                </div>
                <div>
                  <span>{t('checkout.tkReceiptPhone')} </span>
                  <strong className="font-mono text-slate-900">{selectedRecord.customerPhone ? formatPhoneDisplay(selectedRecord.customerPhone) : t('walkInGuest')}</strong>
                </div>
                <div>
                  <span>{t('checkout.tkReceiptDate')} </span>
                  <strong className="text-slate-900">{selectedRecord.businessDate || t('checkout.tkToday')}</strong>
                </div>
                <div>
                  <span>{t('checkout.tkReceiptCashier')} </span>
                  <strong className="text-slate-900">{selectedRecord.cashierName || t('checkout.tkFrontDesk')}</strong>
                </div>
                <div>
                  <span>{t('checkout.tkReceiptStatus')} </span>
                  <span className="font-bold text-teal-700">
                    {selectedRecord.status === 'completed'
                      ? t('checkout.tkStatusSettled2')
                      : selectedRecord.status === 'open'
                        ? t('checkout.tkStatusPending2')
                        : selectedRecord.status === 'voided'
                          ? t('checkout.tkStatusVoidedLabel')
                          : t('checkout.tkStatusRefundedLabel')}
                  </span>
                </div>
                <div>
                  <span>{t('checkout.tkReceiptChannel')} </span>
                  <strong className="text-slate-900">{selectedRecord.paymentMethodLabel || t('checkout.tkCardSettlement2')}</strong>
                </div>
              </div>

              {/* 服务项目清单 */}
              <div className="space-y-2 pb-3 border-b border-dashed border-slate-300">
                <div className="flex justify-between font-bold text-[11px] text-slate-500 uppercase">
                  <span>{t('checkout.tkReceiptItemsHeader')}</span>
                  <span>{t('checkout.tkReceiptAmount')}</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {(selectedRecord.items || []).map((it, idx) => (
                    <div key={idx} className="py-1.5 flex items-center justify-between text-xs">
                      <div>
                        <p className="font-bold text-slate-900">
                          {it?.isAddon && <span className="text-purple-600 mr-1">{t('checkout.tkAddOn2')}</span>}
                          {it?.name || t('checkout.tkServiceItem2')}
                        </p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          
                          {t('checkout.tkLeadTherapist2')} <strong>{it?.staffName || t('checkout.tkLeadTherapist')}</strong> {it?.staffTier ? `(${it.staffTier})` : ''} · {it?.durationMin || 60}  {t('checkout.tkMinutes')}
                        </p>
                      </div>
                      <span className="font-bold font-mono text-slate-900">
                        ${centsToDollars(it?.priceCents)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* 费用核算小计 */}
              <div className="space-y-1.5 text-xs text-slate-600 pb-3 border-b border-dashed border-slate-300">
                <div className="flex justify-between">
                  <span>{t('checkout.tkItemsSubtotal')}</span>
                  <span className="font-mono font-bold text-slate-800">${centsToDollars(selectedRecord.subtotalCents)}</span>
                </div>
                {asCents(selectedRecord.discountCents ?? 0) > 0 && (
                  <div className="flex justify-between text-emerald-700 font-bold">
                    <span>{t('checkout.tkDiscountLine')}{selectedRecord.discountReason || t('checkout.tkDiscountApplied')})</span>
                    <span className="font-mono">-${centsToDollars(selectedRecord.discountCents)}</span>
                  </div>
                )}
                {asCents(selectedRecord.taxCents ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span>{salesTaxLine}</span>
                    <span className="font-mono">${centsToDollars(selectedRecord.taxCents)}</span>
                  </div>
                )}
                {asCents(selectedRecord.surchargeCents ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <span>{t('checkout.tkCardFeeLine')}</span>
                    <span className="font-mono">${centsToDollars(selectedRecord.surchargeCents)}</span>
                  </div>
                )}
                {asCents(selectedRecord.tipCents ?? 0) > 0 && (
                  <div className="flex justify-between text-amber-800 font-bold">
                    <span>{t('checkout.tkTipLine')}</span>
                    <span className="font-mono">+${centsToDollars(selectedRecord.tipCents)}</span>
                  </div>
                )}
                <div className="flex justify-between items-end pt-2 text-slate-900 font-black text-sm">
                  <span>{t('checkout.tkTotalCollectedLine')}</span>
                  <span className="text-xl text-teal-700 font-mono">
                    ${centsToDollars(selectedRecord.totalPaidCents)}
                  </span>
                </div>
              </div>

              {/* 技师小费分配明细 */}
              {(selectedRecord.tipSplits || []).length > 0 && (
                <div className="p-3 bg-white rounded-2xl border border-amber-200 space-y-1.5">
                  <div className="flex items-center justify-between font-bold text-amber-900 text-xs">
                    <span className="flex items-center gap-1">
                      <Coins className="w-3.5 h-3.5 text-amber-600" />
                      <span>{t('checkout.tkTipAllocation')}</span>
                    </span>
                    <span className="font-mono">${centsToDollars(selectedRecord.tipCents)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                    {(selectedRecord.tipSplits || []).map((s, idx) => (
                      <div key={idx} className="p-2 bg-amber-50/50 rounded-xl border border-amber-100 flex justify-between items-center">
                        <span className="font-bold text-slate-800">{s?.staffName || t('checkout.tkTherapist2')}</span>
                        <span className="font-mono font-bold text-amber-900">${centsToDollars(s?.amountCents)} ({s?.percentage ?? 100}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 备注或作废审计 */}
              {(selectedRecord.voidReason || selectedRecord.notes) && (
                <div className="p-3 bg-white rounded-2xl border border-slate-200 text-[11px] text-slate-600 space-y-1">
                  <span className="font-bold text-slate-800 block">{t('checkout.tkAuditNotes')}</span>
                  <p>{selectedRecord.voidReason ? t('checkout.tkVoidRefundReason', { p0: selectedRecord.voidReason, p1: selectedRecord.voidNotes || '' }) : selectedRecord.notes}</p>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 导出选项弹窗 */}
      {exportModalOpen && (
        <Modal
          isOpen={exportModalOpen}
          onOpenChange={setExportModalOpen}
          title={
            <div className="flex items-center gap-2 text-teal-900 font-bold">
              <Download className="w-5 h-5 text-teal-600" />
              <span>{t('checkout.tkExportModalTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex flex-wrap justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setExportModalOpen(false)}>
                
                {t('checkout.tkExportCancel')}
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1.5 shadow-md shadow-teal-600/20"
                onClick={handleExecuteExport}
              >
                <Download className="w-4 h-4" />
                <span>{t('checkout.tkExportDownload')}</span>
              </Button>
            </div>
          }
        >
          <div className="space-y-4 py-2 text-xs text-slate-700">
            {/* 1. 导出范围 */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-2">{t('checkout.tkExportScope')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setExportScope('filtered')}
                  className={cn(
                    'p-3 rounded-2xl border text-left font-medium transition-all cursor-pointer',
                    exportScope === 'filtered'
                      ? 'border-teal-500 bg-teal-50 text-teal-950 font-bold ring-1 ring-teal-400'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                  )}
                >
                  <p className="font-bold text-xs">{t('checkout.tkScopeFiltered')}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-mono">{t('checkout.tkTotalPrefix')} {filteredOrders.length}  {t('checkout.tkOrderUnit3')}</p>
                </button>

                <button
                  type="button"
                  onClick={() => setExportScope('all')}
                  className={cn(
                    'p-3 rounded-2xl border text-left font-medium transition-all cursor-pointer',
                    exportScope === 'all'
                      ? 'border-teal-500 bg-teal-50 text-teal-950 font-bold ring-1 ring-teal-400'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                  )}
                >
                  <p className="font-bold text-xs">{exportFormat === 'print' ? 'All loaded records' : t('checkout.tkScopeAll')}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5 font-mono">{t('checkout.tkTotalPrefix2')} {combinedOrders.length}  {t('checkout.tkOrderUnit4')}</p>
                </button>
              </div>
            </div>

            {/* 2. 导出格式 */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-2">{t('checkout.tkExportFormat')}</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'csv', label: t('checkout.tkFormatCsv'), desc: t('checkout.tkFormatCsvExt'), icon: FileSpreadsheet },
                  { id: 'excel', label: t('checkout.tkFormatExcel'), desc: t('checkout.tkFormatExcelExt'), icon: FileText },
                  { id: 'print', label: t('checkout.tkFormatPrint'), desc: t('checkout.tkFormatPrintExt'), icon: Printer },
                ].map((fmt) => {
                  const Icon = fmt.icon;
                  const isSelected = exportFormat === fmt.id;
                  return (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => setExportFormat(fmt.id as any)}
                      className={cn(
                        'p-2.5 rounded-2xl border text-center font-medium transition-all flex flex-col items-center gap-1 cursor-pointer',
                        isSelected
                          ? 'border-teal-500 bg-teal-50 text-teal-950 font-bold ring-1 ring-teal-400'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                      )}
                    >
                      <Icon className="w-5 h-5 text-teal-600" />
                      <span className="text-xs">{fmt.label}</span>
                      <span className="text-[10px] text-slate-400 font-mono">{fmt.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 包含字段说明 */}
            <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-1 text-[11px] text-slate-600">
              <span className="font-bold text-slate-800 block">{t('checkout.tkExportFieldsTitle')}</span>
              <p>{t('checkout.tkExportFields1')}</p>
              <p>{t('checkout.tkExportFields2')}</p>
              <p>{t('checkout.tkExportFields3')}</p>
              <p>{t('checkout.tkExportFields4')}</p>
            </div>
          </div>
        </Modal>
      )}

      {/* 作废确认模态框 */}
      {voidModalRecord && (
        <Modal
          isOpen={Boolean(voidModalRecord)}
          onOpenChange={(open) => {
            if (!open) {
              setVoidModalRecord(null);
              setVoidNotes('');
            }
          }}
          title={(t('voidTicketAction') || t('checkout.tkVoidModalTitle')) + ' #' + (voidModalRecord.ticketId || '').slice(0, 8).toUpperCase()}
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button
                variant="secondary"
                onClick={() => {
                  setVoidModalRecord(null);
                  setVoidNotes('');
                }}
              >
                {t('cancel') || t('checkout.tkVoidCancel')}
              </Button>
              <Button
                isPending={voidMutation.isPending}
                className="bg-red-600 hover:bg-red-700 text-white font-bold"
                disabled={voidMutation.isPending}
                onClick={handleConfirmVoid}
              >
                {voidMutation.isPending ? t('checkout.tkVoiding') : t('voidTicketAction') || t('checkout.tkVoidConfirm')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-xs text-slate-700 py-2">
            <p className="text-red-700 bg-red-50 p-3 rounded-2xl border border-red-200 leading-relaxed font-medium">
              {t('voidTicketAction') || t('checkout.tkVoidWarning')}
            </p>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                {t('cancelReasonLabel') || t('checkout.tkVoidReasonLabel')}
              </label>
              <select
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value as VoidReason)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
              >
                <option value="guest_changed_mind">{t('reasonChangedMind') || t('checkout.tkVoidReasonChangedMind')}</option>
                <option value="walk_out">{t('reasonWalkOut') || t('checkout.tkVoidReasonWaited')}</option>
                <option value="duplicate_booking">{t('reasonDuplicate') || t('checkout.tkVoidReasonDuplicate')}</option>
                <option value="input_error">{t('reasonInputError') || t('checkout.tkVoidReasonWrongItem')}</option>
                <option value="paid_externally">{t('checkout.tkVoidReasonSettledElsewhere')}</option>
                <option value="other">{t('reasonOther') || t('checkout.tkVoidReasonOther')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">
                {t('note') || t('checkout.tkVoidNotesLabel')}
              </label>
              <input
                type="text"
                placeholder={t('checkout.tkVoidNotesPlaceholder')}
                value={voidNotes}
                onChange={(e) => setVoidNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"
              />
            </div>
          </div>
        </Modal>
      )}

      {/* 订单退款与售后冲正模态框 */}
      {refundModalRecord && (
        <Modal
          isOpen={Boolean(refundModalRecord)}
          onOpenChange={(open) => {
            if (!open) setRefundModalRecord(null);
          }}
          title={
            <div className="flex items-center gap-2 text-purple-900 font-bold">
              <RotateCcw className="w-5 h-5 text-purple-600" />
              <span>{t('checkout.tkRefundModalTitle')} {refundModalRecord.orderNumber || refundModalRecord.ticketId}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button
                variant="secondary"
                onClick={() => setRefundModalRecord(null)}
              >
                
                {t('checkout.tkRefundCancel')}
              </Button>
              <Button
                isPending={refundMutation.isPending}
                className="max-w-full h-auto min-h-10 whitespace-normal bg-purple-600 hover:bg-purple-700 text-white font-bold gap-1 shadow-md shadow-purple-600/20"
                disabled={refundMutation.isPending || !canRefund || !!refundMutation.pendingRefund || !reviewInput || !refundReview.data || refundReview.isFetching}
                onClick={handleConfirmRefund}
              >
                <Check className="w-4 h-4" />
                <span className="whitespace-normal break-words">{refundMutation.isPending ? t('checkout.tkRefunding') : t('checkout.tkRefundConfirm')}</span>
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-xs text-slate-700 py-1">
            {refundMutation.pendingRefund?.ticketId===refundModalRecord.ticketId?<div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2">
              <p>{serviceRefundText(language,'unknown')}</p><Button variant="secondary" disabled={refundMutation.isPending} onClick={()=>void handleRetrySavedRefund()}>{serviceRefundText(language,'retry')}</Button>
            </div>:null}
            {/* 订单概览卡片 */}
            <div className="p-3 bg-purple-50/70 border border-purple-200 rounded-2xl flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900 text-sm">{refundModalRecord.customerName || t('checkout.tkWalkInGuest3')}</span>
                  <span className="font-mono text-xs font-bold text-purple-950">
                    {refundModalRecord.orderNumber || refundModalRecord.ticketId}
                  </span>
                </div>
                <span className="text-[11px] text-purple-800 block mt-0.5">
                  {refundModalRecord.hasPrepaidSource?membershipText(language,'settlementTotal'):t('checkout.tkTotalCollected')}: <strong>${centsToDollars(refundModalRecord.totalPaidCents)}</strong>  {t('checkout.tkPaymentMethodSep')} {refundModalRecord.paymentMethodLabel || t('checkout.tkCardSettlement3')}
                </span>
              </div>
              <Badge variant="secondary" className="text-[10px] font-bold bg-purple-100 text-purple-900 border-purple-300">
                
                {t('checkout.tkRefundableUpTo')}{centsToDollars(
                  Math.max(0, refundModalRecord.totalPaidCents - refundModalRecord.refundCents),
                )}
              </Badge>
            </div>

            {refundModalRecord.hasPrepaidSource&&<p className="text-sm text-purple-800">{membershipText(language,'newCollected')}: ${centsToDollars(refundModalRecord.newCollectedCents??0)}</p>}
            <section aria-label={serviceRefundText(language,'title')} className="rounded-xl border border-purple-200 p-3 space-y-2">
              <h3 className="font-semibold">{serviceRefundText(language,'title')}</h3>
              {refundReview.data?<><dl className="space-y-1">{refundReview.data.destinations.map(d=><div key={d.kind} className="flex justify-between gap-3"><dt>{serviceRefundText(language,d.kind)}</dt><dd>${centsToDollars(d.amountCents)}</dd></div>)}</dl>
                <p>{serviceRefundText(language,'tip')}: ${centsToDollars(refundReview.data.tipCents)} · {serviceRefundText(language,'tax')}: ${centsToDollars(refundReview.data.taxCents)} · {serviceRefundText(language,'fee')}: ${centsToDollars(refundReview.data.feeCents)}</p>
                {refundReview.data.destinations.some(d=>d.kind==='package'||d.kind==='membership')?<p>{serviceRefundText(language,'quota')}</p>:null}</>:<p role="status">{serviceRefundText(language,refundReview.error?'unavailable':'loading')}</p>}
              {refundReview.error?<Button variant="secondary" onClick={()=>void refundReview.refetch()}>{t('refresh')}</Button>:null}
            </section>

            {/* 1. 退款形式与Amount */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3">
              <label className="block text-xs font-bold text-slate-800">{t('checkout.tkRefundTypeLabel')}</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRefundType('full');
                    setRefundAmountDollars(centsToDollars(fullRefundCents(refundModalRecord)));
                    setRefundRemainingTip(false);
                  }}
                  className={cn(
                    'p-2.5 rounded-xl border text-center font-bold transition-all flex flex-col items-center justify-center cursor-pointer',
                    refundType === 'full'
                      ? 'border-purple-500 bg-purple-50/80 text-purple-950 ring-1 ring-purple-400'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700',
                  )}
                >
                  <span className="text-xs">{t('checkout.tkRefundFull')}</span>
                  <span className="font-mono text-sm font-black text-purple-700 mt-0.5">
                    ${centsToDollars(
                      remainingNonTipRefundCents(refundModalRecord)
                        + (refundRemainingTip
                          ? Math.max(0, refundModalRecord.tipCents - refundModalRecord.refundTipCents)
                          : 0),
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRefundType('partial');
                    setRefundAmountDollars('');
                  }}
                  className={cn(
                    'p-2.5 rounded-xl border text-center font-bold transition-all flex flex-col items-center justify-center cursor-pointer',
                    refundType === 'partial'
                      ? 'border-purple-500 bg-purple-50/80 text-purple-950 ring-1 ring-purple-400'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700',
                  )}
                >
                  <span className="text-xs">{t('checkout.tkRefundPartial')}</span>
                  <span className="text-[10px] text-slate-400 font-normal mt-0.5">{t('checkout.tkRefundCustomAmount')}</span>
                </button>
                <button type="button" disabled={!itemOptions.data?.itemGraphAvailable} onClick={()=>{setRefundType('items');setRefundRemainingTip(false);setRefundItemAmounts({});}}
                  className={cn('p-2.5 rounded-xl border text-center font-bold transition-all break-words disabled:opacity-50',refundType==='items'?'border-purple-500 bg-purple-50/80 text-purple-950 ring-1 ring-purple-400':'border-slate-200 hover:bg-slate-50 text-slate-700')}>
                  {serviceRefundText(language,'selectItems')}
                </button>
              </div>
              {!itemOptions.isFetching&&itemOptions.data&&!itemOptions.data.itemGraphAvailable?<p className="text-slate-600">{serviceRefundText(language,'historical')}</p>:null}
              {refundType==='items'?<fieldset className="space-y-3"><legend>{serviceRefundText(language,'selectItemsHint')}</legend>
                {(itemOptions.data?.items??[]).map((item,index)=><div key={item.ticketItemId} className="rounded-lg border p-3 space-y-2">
                  <label className="flex gap-2"><input type="checkbox" checked={Object.hasOwn(refundItemAmounts,item.ticketItemId)} disabled={!item.remainingCents}
                    onChange={e=>{setRefundItemAmounts(old=>{const next={...old};if(e.target.checked)next[item.ticketItemId]=centsToDollars(item.remainingCents);else delete next[item.ticketItemId];return next;});}}/>{item.name} · {serviceRefundText(language,'remaining')}: ${centsToDollars(item.remainingCents)}</label>
                  {Object.hasOwn(refundItemAmounts,item.ticketItemId)?<label className="block">{serviceRefundText(language,'itemAmount')} {index+1}<input aria-label={`${serviceRefundText(language,'itemAmount')} ${index+1}`} type="number" min="0.01" step="0.01" max={centsToDollars(item.remainingCents)} value={refundItemAmounts[item.ticketItemId]??''}
                    onChange={e=>setRefundItemAmounts(old=>({...old,[item.ticketItemId]:e.target.value}))} className="w-full mt-1 rounded-lg border p-2 font-mono"/></label>:null}
                </div>)}
              </fieldset>:null}

              {refundType === 'partial' && (
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    
                    {t('checkout.tkRefundAmountLabel')}
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-slate-400 font-bold">$</span>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={refundAmountDollars}
                      onChange={(e) => setRefundAmountDollars(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                    />
                  </div>
                </div>
              )}

              {refundModalRecord.tipCents - refundModalRecord.refundTipCents > 0 && (
                <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={refundRemainingTip}
                    onChange={(event) => setRefundRemainingTip(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-[11px] text-amber-950">
                    <strong>{t('checkout.tkRefundRemainingTip', {
                      p0: centsToDollars(refundModalRecord.tipCents - refundModalRecord.refundTipCents),
                    })}</strong>
                    <span className="block mt-0.5 text-amber-800">{t('checkout.tkRefundTipExplicit')}</span>
                  </span>
                </label>
              )}
            </div>

            {/* 2. 退款返还渠道 */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">{t('checkout.tkRefundChannelLabel')}</label>
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as any)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
              >
                <option value="original_payment">{refundModalRecord.hasPrepaidSource?membershipText(language,'originalReturn'):t('checkout.tkRefundChannelOriginal')}</option>
                <option value="cash" disabled={refundModalRecord.hasPrepaidSource}>{t('checkout.tkRefundChannelCash')}</option>
                <option value="store_credit" disabled={!refundModalRecord.customerId||refundModalRecord.hasPrepaidSource}>
                  {t('checkout.tkRefundChannelCredit')}
                </option>
              </select>
              {(refundModalRecord.membershipCoveredCents??0)>0&&<p className="mt-2 text-xs text-slate-600">{membershipText(language,'restoreHint')}</p>}
            </div>

            {/* 3. 退款原因 */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">{t('checkout.tkRefundReasonLabel')}</label>
              <select
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value as any)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
              >
                <option value="customer_dissatisfied">{t('checkout.tkRefundReasonUnhappy')}</option>
                <option value="wrong_charge">{t('checkout.tkRefundReasonWrongCharge')}</option>
                <option value="duplicate">{t('checkout.tkRefundReasonDuplicate')}</option>
                <option value="other">{t('checkout.tkRefundReasonOther')}</option>
              </select>
            </div>

            {/* 4. 详细备注 */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5">{t('checkout.tkRefundAuditLabel')}</label>
              <input
                type="text"
                placeholder={t('checkout.tkRefundAuditPlaceholder')}
                value={refundNotes}
                onChange={(e) => setRefundNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
              />
            </div>

            {/* 财务与提成冲销联动说明 */}
            <div className="p-3 bg-amber-50/80 rounded-2xl border border-amber-200/80 space-y-1 text-[11px] text-amber-900">
              <span className="font-bold block flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span>{t('checkout.tkRefundLinkTitle')}</span>
              </span>
              <p>{t('checkout.tkRefundLink1')}</p>
              <p>{t('checkout.tkRefundLink2')}</p>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Tickets() {
  return (
    <ErrorBoundary fallbackTitleKey="tickets">
      <TicketsContent />
    </ErrorBoundary>
  );
}
