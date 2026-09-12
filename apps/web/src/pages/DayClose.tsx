import { openPrintPreview } from '@/features/printing/preview';
import { pickText } from '@gf/contracts';
import { useState, useEffect, useMemo } from 'react';
import { useLanguage } from '@/LanguageContext';
import { PageHeader } from '@/components/ui/PageHeader';
import { useCanWrite } from '@/lib/permissions';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import {
  Printer,
  Lock,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Unlock,
  Coins,
  Calendar,
  Save,
  ChevronLeft,
  ChevronRight,
  Receipt,
  FileCheck,
  DollarSign,
  CreditCard,
  Building,
  History,
  PlusCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  Layers,
  Sparkles,
  User,
  Clock,
  FileText,
  HelpCircle,
  AlertTriangle,
  Send,
  Download,
  Share2,
  Check,
  CircleDollarSign,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { toast, Spinner } from '@heroui/react';
import { useFieldErrors } from '@/lib/formFeedback';
import { parseMoney } from '@/lib/validation';
import { useValidationMessage } from '@/lib/validationMessage';
import {
  useDayCloseQuery,
  useSaveCashCount,
  usePayCashTips,
  useFinalizeDay,
  useReopenDay,
  useRecordCashMovement,
} from '@/features/dayclose/api';
import { dollarsToCents, centsToDollars, toDisplayDollars } from '@/features/checkout/api';
import { useSession } from '@/lib/session';
import { instantToWallDate, shiftDate, useStoreTime } from '@/lib/time';
import { useErrorMessage } from '@/lib/errorMessage';
import { ApiError } from '@/lib/api';
import { displayedCashVarianceCents, hasSavedCashCount } from '@/features/dayclose/cashCount';
import { exportToCSV, exportToExcel } from '@/lib/exportUtils';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { useBusinessDay } from '@/lib/time';

// 纸币面额列表
const BILL_DENOMINATIONS = [
  { label: '$100', value: 100, cents: 10000, key: 'bill_100' },
  { label: '$50', value: 50, cents: 5000, key: 'bill_50' },
  { label: '$20', value: 20, cents: 2000, key: 'bill_20' },
  { label: '$10', value: 10, cents: 1000, key: 'bill_10' },
  { label: '$5', value: 5, cents: 500, key: 'bill_5' },
  { label: '$2', value: 2, cents: 200, key: 'bill_2' },
  { label: '$1', value: 1, cents: 100, key: 'bill_1' },
];

// 硬币面额列表
const COIN_DENOMINATIONS = [
  { labelKey: 'checkout.dcCoinQuarter' as const, value: 0.25, cents: 25, key: 'coin_25' },
  { labelKey: 'checkout.dcCoinDime' as const, value: 0.1, cents: 10, key: 'coin_10' },
  { labelKey: 'checkout.dcCoinNickel' as const, value: 0.05, cents: 5, key: 'coin_5' },
  { labelKey: 'checkout.dcCoinPenny' as const, value: 0.01, cents: 1, key: 'coin_1' },
];

export function DayClose() {
  const storeTime = useStoreTime();
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { membershipId, membership } = useSession();
  /**
   * ⭐ 日结是**唯一一个**「今天」错了就直接影响钱的页面（AUD-13）。
   *
   * 前台在打烊后封账，而打烊常常已经是凌晨一两点 —— 那一刻按日历日算
   * 会翻到下一天：页面显示「今天在营业」、金额全是零，
   * 当晚真实的营业额落在前一个日期下，前台封不了账。
   */
  const { ready: dayReady, today: defaultDate, yesterday: yesterdayDate } = useBusinessDay();

  const [selectedDate, setSelectedDate] = useState('');
  useEffect(() => {
    if (!dayReady) return;
    setSelectedDate(defaultDate);
  }, [dayReady, defaultDate, membershipId]);
  const [activeTab, setActiveTab] = useState<'overview' | 'counter' | 'tips' | 'audit'>('overview');

  const { data: dayClose, isLoading, error, refetch } = useDayCloseQuery(selectedDate);

  /*
 * 日结页此前没有任何权限判定 —— 每个按钮对每个前台账号都是活的。
 * 三条权限在这里是分开的，不能合并：
 *   dayclose.manage   点钞、录现金进出、封账
 *   tip.payout        发现金小费（有的店老板亲自发钱，前台只数抽屉）
 *   payroll.configure 重开已封的账
 */
  const canManage = useCanWrite('dayclose.manage');
  const canPayTips = useCanWrite('tip.payout');
  const canReopen = useCanWrite('payroll.configure');

  const saveCountMutation = useSaveCashCount();
  const payTipsMutation = usePayCashTips();
  const finalizeMutation = useFinalizeDay();
  const reopenMutation = useReopenDay();
  const recordMovementMutation = useRecordCashMovement();

  // 面额盘点数量记录 { bill_100: 5, bill_50: 2, ... }
  const [counts, setCounts] = useState<Record<string, number>>({});
  // 直接总Amount手动输入（备用快捷录入）
  const [manualCountedStr, setManualCountedStr] = useState<string>('');
  const [useDenominationMode, setUseDenominationMode] = useState<boolean>(true);

  // 差异原因
  const [varianceReason, setVarianceReason] = useState<string>('');
  // 留存下日备用金设置（默认 $200）
  const [reserveFloatDollars, setReserveFloatDollars] = useState<string>('200.00');

  // 弹窗状态
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [reopenModalOpen, setReopenModalOpen] = useState(false);
  const [reopenReasonText, setReopenReasonText] = useState('');
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printReceiptType, setPrintReceiptType] = useState<'thermal' | 'full'>('thermal');
  const [movementModalOpen, setMovementModalOpen] = useState(false);
  const [movementForm, setMovementForm] = useState<{
    kind: 'opening_float' | 'cash_drop' | 'supply_purchase' | 'payout_owner' | 'other';
    amountDollars: string;
    note: string;
  }>({
    kind: 'supply_purchase',
    amountDollars: '',
    note: '',
  });

  // 技师签收单弹窗
  const [tipReceiptStaff, setTipReceiptStaff] = useState<any | null>(null);

  // 同步初始化盘点数据
  useEffect(() => {
    if (dayClose) {
      const hasMeaningfulBreakdown =
        dayClose.countBreakdown &&
        Object.values(dayClose.countBreakdown).some((qty) => (Number(qty) || 0) > 0);

      if (hasMeaningfulBreakdown) {
        setCounts(dayClose.countBreakdown);
        setUseDenominationMode(true);
      } else if (dayClose.countedCashCents !== null) {
        setManualCountedStr(centsToDollars(dayClose.countedCashCents));
        setUseDenominationMode(false);
      } else {
        // 默认按账面应有Cash填入初始值
        setManualCountedStr(centsToDollars(dayClose.expectedCashCents));
        setUseDenominationMode(false);
      }
      if (dayClose.closingFloatCents !== undefined && dayClose.closingFloatCents !== null && dayClose.closingFloatCents > 0) {
        setReserveFloatDollars(centsToDollars(dayClose.closingFloatCents));
      }
      setVarianceReason(dayClose.cashVarianceReason || '');
    }
  }, [dayClose]);

  // 根据面额计算总Amount (Cents)
  const denominationTotalCents = useMemo(() => {
    let sum = 0;
    BILL_DENOMINATIONS.forEach((b) => {
      const qty = counts[b.key] || 0;
      sum += qty * b.cents;
    });
    COIN_DENOMINATIONS.forEach((c) => {
      const qty = counts[c.key] || 0;
      sum += qty * c.cents;
    });
    return sum;
  }, [counts]);

  // 实际盘点总额 (Cents)
  /*
   * ⚠️ 手工盘点金额必须判定，不能交给 `dollarsToCents`。
   *
   * 那是结账用的宽容解析器，会把非数字字符剔掉再算：手指打滑把 807 打成
   * `8o7`，它返回的是 **$8.70** —— 一个看起来完全合理的数。日结的全部意义
   * 就是发现差额，而这里错一位会把差额本身算错，人再怎么复核也对不出来。
   *
   * 留空是合法的（还没数完），按 0 计；打错字不是。
   */
  const manualCount = useMemo(
    () => parseMoney(manualCountedStr, { allowEmpty: true }),
    [manualCountedStr],
  );
  const reserveFloat = useMemo(
    () => parseMoney(reserveFloatDollars, { allowEmpty: true }),
    [reserveFloatDollars],
  );

  const finalCountedCents = useMemo(() => {
    if (useDenominationMode) {
      return denominationTotalCents;
    }
    return manualCount.ok ? manualCount.value : 0;
  }, [useDenominationMode, denominationTotalCents, manualCount]);

  const expectedCents = dayClose?.expectedCashCents ?? 0;
  const countedSaved = hasSavedCashCount(dayClose?.countedCashCents);
  const cashVarianceCents = finalCountedCents - expectedCents;
  const overviewVarianceCents = displayedCashVarianceCents({
    countedCashCents: dayClose?.countedCashCents,
    liveCountedCents: finalCountedCents,
    expectedCashCents: expectedCents,
  });
  const liveBalanced = Math.abs(cashVarianceCents) === 0;
  const liveOver = cashVarianceCents > 0;
  const isBalanced = countedSaved && liveBalanced;
  const isOver = countedSaved && liveOver;

  // 差异报警阈值 (默认 $10.00 / 1000 cents)
  const thresholdCents = dayClose?.varianceThresholdCents ?? 1000;
  const needsReason = Math.abs(cashVarianceCents) >= thresholdCents;

  // 预留下日备用金后需解存入保险箱的Amount
  const reserveFloatCents = reserveFloat.ok ? reserveFloat.value : 0;
  const safeDropCents = Math.max(0, finalCountedCents - reserveFloatCents);

  // 快捷更新面额数量
  const handleCountChange = (key: string, valStr: string) => {
    const parsed = parseInt(valStr, 10);
    setCounts((prev) => ({
      ...prev,
      [key]: isNaN(parsed) || parsed < 0 ? 0 : parsed,
    }));
  };

  // 保存实点Amount
  /** 日结差异说明的字段级校验。 */
  const closeForm = useFieldErrors<'varianceReason' | 'manualCount' | 'reserveFloat' | 'movementAmount'>();
  const invalid = useValidationMessage();

  const handleSaveCount = async () => {
    if (!canManage) return;
    if (!dayClose) return;
    closeForm.clear();
    /* 金额先判：差额说明写得再好，也补不了一个算错的差额 */
    if (!useDenominationMode && !manualCount.ok) {
      return closeForm.fail('manualCount', invalid.money(manualCount.reason));
    }
    if (!reserveFloat.ok) {
      return closeForm.fail('reserveFloat', invalid.money(reserveFloat.reason));
    }
    if (needsReason && !varianceReason.trim()) {
      closeForm.fail('varianceReason', t('varianceReasonRequired') || t('checkout.dcVarianceReasonRequired'));
      return;
    }

    try {
      await saveCountMutation.mutateAsync({
        businessDate: dayClose.businessDate,
        breakdown: useDenominationMode ? counts : undefined,
        countedCashCents: finalCountedCents,
        closingFloatCents: reserveFloatCents,
        cashVarianceReason: varianceReason.trim() || undefined,
      });
      toast.success(t('countSaved') || t('checkout.dcCountSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 结付全部Cash小费
  const handlePayAllTips = async () => {
    if (!canPayTips) return;
    if (!dayClose) return;
    try {
      await payTipsMutation.mutateAsync({
        businessDate: dayClose.businessDate,
        roundToCents: 100,
      });
      toast.success(t('tipsPaidSuccess') || t('checkout.dcTipsPaid'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 录入一笔零用金收支
  const handleRecordMovement = async () => {
    if (!canManage) return;
    if (!dayClose) return;
    closeForm.clear();
    /* 此前只判 `<= 0`，于是「打错字」和「填了 0」给的是同一句话 */
    const amount = parseMoney(movementForm.amountDollars);
    if (!amount.ok) return closeForm.fail('movementAmount', invalid.money(amount.reason));
    if (amount.value <= 0) {
      return closeForm.fail('movementAmount', t('checkout.dcInvalidAmount'));
    }
    const cents = amount.value;

    try {
      await recordMovementMutation.mutateAsync({
        businessDate: dayClose.businessDate,
        kind: movementForm.kind,
        amountCents: movementForm.kind === 'supply_purchase' || movementForm.kind === 'payout_owner' || movementForm.kind === 'cash_drop' ? -Math.abs(cents) : Math.abs(cents),
        note: movementForm.note.trim() || undefined,
      });
      toast.success(t('checkout.dcPettyCashSaved'));
      setMovementModalOpen(false);
      setMovementForm({ kind: 'supply_purchase', amountDollars: '', note: '' });
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const requestFinalize = () => {
    if (!canManage) return;
    if (!dayClose) return;
    if (!hasSavedCashCount(dayClose.countedCashCents)) {
      toast.danger(t('checkout.dcCountBeforeFinalize'));
      setActiveTab('counter');
      return;
    }
    setConfirmFinalize(true);
  };

  // 封账
  const handleFinalize = async () => {
    if (!canManage) return;
    if (!dayClose) return;
    if (!hasSavedCashCount(dayClose.countedCashCents)) {
      toast.danger(t('checkout.dcCountBeforeFinalize'));
      setActiveTab('counter');
      throw new Error('count_required');
    }
    try {
      await finalizeMutation.mutateAsync({
        businessDate: dayClose.businessDate,
        force: dayClose.openTicketCount > 0,
      });
      toast.success(t('dayClosedSuccess') || t('checkout.dcDayClosed'));
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        const reason = err.details.reason;
        if (typeof reason === 'string' && reason.includes('点钞')) {
          toast.danger(t('checkout.dcCountBeforeFinalize'));
          setActiveTab('counter');
          throw err;
        }
      }
      toast.danger(errorMessage(err));
      throw err;
    }
  };

  // 反结账重开
  const handleReopen = async () => {
    if (!canReopen) return;
    if (!dayClose || !reopenReasonText.trim()) return;
    try {
      await reopenMutation.mutateAsync({
        businessDate: dayClose.businessDate,
        reason: reopenReasonText.trim(),
      });
      toast.success(t('reopenedSuccess') || t('checkout.dcDayReopened'));
      setReopenModalOpen(false);
      setReopenReasonText('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const shiftSelectedDate = (days: number) => {
    if (!selectedDate) return;
    setSelectedDate(shiftDate(selectedDate, days));
  };

  if (isLoading && !dayClose) {
    return <PageLoading layout="detail" title={t('checkout.dcLoading')} description={t('checkout.dcLoadingDesc')} />;
  }

  if (error && !dayClose) {
    return <PageError title={t('checkout.dcLoadError')} error={error} onRetry={refetch} />;
  }

  if (!dayClose) {
    return <PageLoading layout="detail" title={t('checkout.dcLoading2')} description={t('checkout.dcLoadingDesc2')} />;
  }

  const isClosed = dayClose.status === 'closed';

  return (
    <ErrorBoundary>
      <div className="space-y-6 max-w-7xl mx-auto w-full pb-24">
        {/* Top Header */}
        <PageHeader
          title={t('dayCloseTitle') || t('checkout.dcTitle')}
          description={t('dayCloseSubtitle') || t('checkout.dcDesc')}
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              {/* 记一笔零用金收支 */}
              {!isClosed && (
                <Button
                  isDisabled={!canManage}
                  variant="outline"
                  size="sm"
                  className="bg-white border-slate-200 text-slate-700 hover:bg-slate-50 gap-1.5"
                  onClick={() => setMovementModalOpen(true)}
                >
                  <PlusCircle className="w-4 h-4 text-teal-600" />
                  <span>{t('checkout.dcRecordPettyCash')}</span>
                </Button>
              )}

              {/* 打印 Z-Report */}
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5 bg-white border-slate-200 shadow-sm text-slate-800"
                onClick={() => setPrintModalOpen(true)}
              >
                <Printer className="w-4 h-4 text-slate-600" />
                <span>{t('checkout.dcPrintZReport')}</span>
              </Button>

              {/* 导出报表 */}
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5 bg-white border-slate-200 shadow-sm text-slate-800"
                onClick={() => {
                  const headers = [
                    t('checkout.dcExportCategoryHeader'), t('checkout.dcExportAmountHeader'), t('checkout.dcExportNoteHeader'),
                  ];
                  const rows = [
                    [t('checkout.dcExportBusinessDate'), dayClose.businessDate, ''],
                    [t('checkout.dcExportGrossSales'), centsToDollars(dayClose.money.grossCents), t('checkout.dcExportGrossSalesNote')],
                    [t('checkout.dcExportDiscounts'), `-${centsToDollars(dayClose.money.discountCents)}`, ''],
                    [t('checkout.dcExportTax'), centsToDollars(dayClose.money.taxCents), ''],
                    [t('checkout.dcExportNetSales'), centsToDollars(dayClose.money.netCents), ''],
                    [t('checkout.dcExportCardRecord'), centsToDollars(dayClose.money.cardTakeCents), t('checkout.dcExportCardRecordNote')],
                    [t('checkout.dcExportCashTake'), centsToDollars(dayClose.money.cashTakeCents), t('checkout.dcExportCashTakeNote')],
                    [t('checkout.dcExportStartingFloat'), centsToDollars(dayClose.openingFloatCents), ''],
                    [t('checkout.dcExportExpectedCash'), centsToDollars(dayClose.expectedCashCents), ''],
                    [t('checkout.dcExportCountedCash'), centsToDollars(finalCountedCents), ''],
                    [t('checkout.dcExportCashVariance'), centsToDollars(cashVarianceCents), isBalanced ? t('checkout.dcExportBalanced') : isOver ? t('checkout.dcExportOver') : t('checkout.dcExportShort')],
                    [t('checkout.dcExportVarianceReason'), varianceReason || t('checkout.dcExportNone'), ''],
                  ];
                  exportToCSV(`Z-Report-${dayClose.businessDate}`, headers, rows);
                  toast.success(t('checkout.dcCsvExported'));
                }}
              >
                <Download className="w-4 h-4 text-slate-600" />
                <span>{t('checkout.dcExport')}</span>
              </Button>

              {/* 封账 / 反结账动作 */}
              {isClosed ? (
                <Button
                  isDisabled={!canReopen}
                  variant="secondary"
                  size="sm"
                  className="gap-1.5 text-amber-700 border-amber-300 bg-amber-50/50 hover:bg-amber-100"
                  onClick={() => setReopenModalOpen(true)}
                >
                  <Unlock className="w-4 h-4" />
                  <span>{t('reopenDayAction') || t('checkout.dcRequestReopen')}</span>
                </Button>
              ) : (
                <Button
                isDisabled={!canManage}
                  size="sm"
                  className="gap-1.5 bg-teal-600 hover:bg-teal-700 text-white font-bold shadow-sm"
                  onClick={requestFinalize}
                >
                  <FileCheck className="w-4 h-4" />
                  <span>{t('finalizeDayAction') || t('checkout.dcConfirmClose')}</span>
                </Button>
              )}
            </div>
          }
        />

        {/* 三条权限都没有 = 这一页只能看。单独置灰按钮不够，要先说清楚为什么 */}
        {!canManage && !canPayTips && !canReopen && <ReadOnlyNotice />}

        {/* Date Selector & Status Header Bar */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-4 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center bg-slate-100 p-0.5 rounded-xl">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-slate-600 hover:bg-white rounded-lg"
                onClick={() => shiftSelectedDate(-1)}
                title={t('checkout.dcPrevDay')}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div className="flex items-center gap-2 px-3 py-1 bg-white border border-slate-200/80 rounded-lg text-sm font-bold text-slate-900 shadow-2xs">
                <Calendar className="w-4 h-4 text-teal-600" />
                <span>{dayClose.businessDate}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-slate-600 hover:bg-white rounded-lg"
                onClick={() => shiftSelectedDate(1)}
                title={t('checkout.dcNextDay')}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            <div className="flex items-center gap-1.5 ml-1">
              <button
                type="button"
                onClick={() => setSelectedDate(defaultDate)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  selectedDate === defaultDate ? 'bg-teal-50 text-teal-700 border border-teal-200 font-bold' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                
                {t('checkout.dcToday')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!yesterdayDate) return;
                  setSelectedDate(yesterdayDate);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-100 transition-all"
              >
                
                {t('checkout.dcYesterday')}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* 状态标牌 */}
            {isClosed ? (
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900 text-white text-xs font-bold shadow-xs">
                <Lock className="w-3.5 h-3.5 text-amber-400" />
                <span>{t('checkout.dcClosedLocked')}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-800 text-xs font-bold border border-emerald-200 shadow-2xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>{t('checkout.dcOpenToday')}</span>
              </span>
            )}

            {/* 未结单预警 */}
            {dayClose.openTicketCount > 0 && (
              <span className="flex items-center gap-1.5 text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span>{dayClose.openTicketCount}  {t('checkout.dcUnsettledOrders')}</span>
              </span>
            )}

            {/* 差异状态标牌 */}
            <span
              className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold border ${
                overviewVarianceCents === null
                  ? 'bg-slate-50 text-slate-700 border-slate-200'
                  : isBalanced
                  ? 'bg-teal-50 text-teal-800 border-teal-200'
                  : isOver
                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                  : 'bg-red-50 text-red-800 border-red-200'
              }`}
            >
              {overviewVarianceCents === null ? (
                <>
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>{t('checkout.dcNotCountedYet')}</span>
                </>
              ) : isBalanced ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('checkout.dcDrawerBalanced')}</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>
                    {t('checkout.dcDrawer')}{isOver ? t('checkout.dcOverPrefix') : t('checkout.dcShortPrefix')}${Math.abs(toDisplayDollars((overviewVarianceCents))).toFixed(2)}
                  </span>
                </>
              )}
            </span>
          </div>
        </div>

        {/* 4 Core Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4 border-slate-200/90 shadow-2xs bg-gradient-to-br from-white to-teal-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t('checkout.dcNetSales')}</span>
              <DollarSign className="w-4 h-4 text-teal-600" />
            </div>
            <p className="text-2xl font-black text-slate-900 mt-2 font-mono">
              ${centsToDollars(dayClose.money.netCents)}
            </p>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
              <span>{t('checkout.dcGross')}{centsToDollars(dayClose.money.grossCents)}</span>
              <span className="text-red-500">{t('checkout.dcDiscounts')}{centsToDollars(dayClose.money.discountCents)}</span>
            </div>
          </Card>

          <Card className="p-4 border-slate-200/90 shadow-2xs bg-gradient-to-br from-white to-blue-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t('checkout.dcTenderTotal')}</span>
              <CreditCard className="w-4 h-4 text-blue-600" />
            </div>
            <p className="text-2xl font-black text-slate-900 mt-2 font-mono">
              ${centsToDollars(dayClose.money.cardTakeCents + dayClose.money.cashTakeCents)}
            </p>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
              <span>{t('checkout.dcCardTender')}{centsToDollars(dayClose.money.cardTakeCents)}</span>
              <span>{t('checkout.dcCashTender')}{centsToDollars(dayClose.money.cashTakeCents)}</span>
            </div>
          </Card>

          <Card className="p-4 border-slate-200/90 shadow-2xs bg-gradient-to-br from-white to-amber-50/20">
            <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
              <span>{t('checkout.dcExpectedCash')}</span>
              <Coins className="w-4 h-4 text-amber-600" />
            </div>
            <p className="text-2xl font-black text-slate-900 mt-2 font-mono">
              ${centsToDollars(dayClose.expectedCashCents)}
            </p>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
              <span>{t('checkout.dcOpeningFloat')}{centsToDollars(dayClose.openingFloatCents)}</span>
              <span>{t('checkout.dcCashReceived')}{centsToDollars(dayClose.money.cashTakeCents)}</span>
            </div>
          </Card>

          <Card className={`p-4 border shadow-2xs ${
            overviewVarianceCents === null
              ? 'bg-gradient-to-br from-white to-slate-50/30 border-slate-200'
              : isBalanced ? 'bg-gradient-to-br from-white to-emerald-50/30 border-emerald-200' : 'bg-gradient-to-br from-white to-red-50/30 border-red-200'
          }`}>
            <div className="flex items-center justify-between text-xs font-medium">
              <span className={
                overviewVarianceCents === null ? 'text-slate-600'
                  : isBalanced ? 'text-emerald-700' : isOver ? 'text-amber-700' : 'text-red-700'
              }>
                {t('checkout.dcVariance')}
              </span>
              {overviewVarianceCents === null ? (
                <AlertCircle className="w-4 h-4 text-slate-500" />
              ) : isBalanced ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              ) : (
                <AlertCircle className="w-4 h-4 text-red-600" />
              )}
            </div>
            <p className={`text-2xl font-black mt-2 font-mono ${
              overviewVarianceCents === null ? 'text-slate-700'
                : isBalanced ? 'text-emerald-700' : isOver ? 'text-amber-700' : 'text-red-700'
            }`}>
              {overviewVarianceCents === null
                ? t('checkout.dcNotCountedYet')
                : `${isOver ? '+' : ''}$${centsToDollars(overviewVarianceCents)}`}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              
              {t('checkout.dcCountedTotal')}{centsToDollars(finalCountedCents)}
            </p>
          </Card>
        </div>

        {/* Tab Navigation Switcher */}
        <div className="flex border-b border-slate-200 gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all ${
              activeTab === 'overview'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Receipt className="w-4 h-4" />
            <span>{t('checkout.dcTabZReport')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('counter')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all ${
              activeTab === 'counter'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Coins className="w-4 h-4" />
            <span>{t('checkout.dcTabCounter')}</span>
            {!isBalanced && (
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tips')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all ${
              activeTab === 'tips'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <CircleDollarSign className="w-4 h-4" />
            <span>{t('checkout.dcTabTipsPrefix')}{dayClose.tipPayouts?.length ?? 0}  {t('checkout.dcTabTipsSuffix')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all ${
              activeTab === 'audit'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <History className="w-4 h-4" />
            <span>{t('checkout.dcTabPettyCash')}</span>
          </button>
        </div>

        {/* TAB 1: Z-Report 全貌 */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 左侧 2 列：销售与通道详细核算 */}
            <div className="lg:col-span-2 space-y-6">
              {/* 营收与扣减拆解 */}
              <Card className="border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Receipt className="w-4 h-4 text-teal-600" />
                    
                    {t('checkout.dcSalesBreakdown')}
                  </CardTitle>
                  <Badge variant="outline" className="text-[11px] font-mono">
                    
                    {t('checkout.dcOrdersToday')} {dayClose.openTicketCount ? t('checkout.dcOrdersRemaining', { p0: dayClose.openTicketCount }) : t('checkout.dcAllSettled')}
                  </Badge>
                </CardHeader>
                <CardContent className="p-5 space-y-3 text-sm">
                  <div className="flex justify-between items-center py-1">
                    <span className="text-slate-600">{t('checkout.dcServiceGross')}</span>
                    <span className="font-mono font-semibold text-slate-900">
                      ${centsToDollars(dayClose.money.grossCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1">
                    <span className="text-slate-600">{t('checkout.dcDiscountsComps')}</span>
                    <span className="font-mono font-semibold text-red-600">
                      -${centsToDollars(dayClose.money.discountCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1">
                    <span className="text-slate-600">{t('checkout.dcTaxSurcharge')}</span>
                    <span className="font-mono font-semibold text-slate-800">
                      ${centsToDollars(dayClose.money.taxCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center pt-3 border-t border-dashed border-slate-200">
                    <span className="font-bold text-slate-900">{t('checkout.dcNetSalesTotal')}</span>
                    <span className="font-mono font-black text-xl text-teal-700">
                      ${centsToDollars(dayClose.money.netCents)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {/* 支付通道结算核对 */}
              <Card className="border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-blue-600" />
                    
                    {t('checkout.dcTenderReconciliation')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-3 text-sm">
                  <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-slate-700 font-medium">{t('checkout.dcStripePos')}</span>
                    </div>
                    <span className="font-mono font-bold text-slate-900">
                      ${centsToDollars(dayClose.money.cardTakeCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-slate-700 font-medium">{t('checkout.dcCashInDrawer')}</span>
                    </div>
                    <span className="font-mono font-bold text-slate-900">
                      ${centsToDollars(dayClose.money.cashTakeCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-1.5 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-500" />
                      <span className="text-slate-700 font-medium">{t('checkout.dcTipsTotal')}</span>
                    </div>
                    <span className="font-mono font-bold text-amber-700">
                      ${centsToDollars(dayClose.money.tipCardCents + dayClose.money.tipCashCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center pt-2">
                    <span className="font-bold text-slate-900">{t('checkout.dcTotalCollected')}</span>
                    <span className="font-mono font-black text-lg text-slate-900">
                      ${centsToDollars(dayClose.money.cardTakeCents + dayClose.money.cashTakeCents)}
                    </span>
                  </div>
                </CardContent>
              </Card>

            </div>

            {/* 右侧 1 列：钱箱对账与结付摘要 */}
            <div className="space-y-6">
              {/* 钱箱结存速查 */}
              <Card className="border-teal-200 bg-gradient-to-b from-teal-50/40 to-white shadow-2xs">
                <CardHeader className="py-3.5 px-5 border-b border-teal-100">
                  <CardTitle className="text-sm font-bold text-teal-900 flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-teal-600" />
                    
                    {t('checkout.dcDrawerMath')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 space-y-3 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">{t('checkout.dcOpeningFloatLine')}</span>
                    <span className="font-mono font-semibold text-slate-800">
                      ${centsToDollars(dayClose.openingFloatCents)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">{t('checkout.dcCashSalesLine')}</span>
                    <span className="font-mono font-semibold text-emerald-700">
                      +${centsToDollars(dayClose.money.cashTakeCents)}
                    </span>
                  </div>
                  {dayClose.money.tipPaidOutCents > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-slate-600">{t('checkout.dcTipPayoutsLine')}</span>
                      <span className="font-mono font-semibold text-red-600">
                        -${centsToDollars(dayClose.money.tipPaidOutCents)}
                      </span>
                    </div>
                  )}
                  {dayClose.money.movementsCents !== 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-slate-600">{t('checkout.dcMovementsLine')}</span>
                      <span className={`font-mono font-semibold ${dayClose.money.movementsCents > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {dayClose.money.movementsCents > 0 ? '+' : ''}${centsToDollars(dayClose.money.movementsCents)}
                      </span>
                    </div>
                  )}
                  <div className="pt-3 border-t border-teal-200 flex justify-between items-center">
                    <span className="font-bold text-teal-950 text-sm">{t('checkout.dcExpectedCashLine')}</span>
                    <span className="font-mono font-black text-lg text-teal-950">
                      ${centsToDollars(dayClose.expectedCashCents)}
                    </span>
                  </div>

                  <div className="mt-4 pt-4 border-t border-slate-200/80 space-y-2">
                    <div className="flex justify-between text-slate-600">
                      <span>{t('checkout.dcCountedNow')}</span>
                      <span className="font-mono font-bold text-slate-900">${centsToDollars(finalCountedCents)}</span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full text-xs font-bold gap-1.5 mt-2"
                      onClick={() => setActiveTab('counter')}
                    >
                      <Coins className="w-3.5 h-3.5 text-teal-600" />
                      
                      {t('checkout.dcOpenCounter')}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* 留存备用金与解存保险箱推荐 */}
              <Card className="border-slate-200 shadow-2xs p-5 space-y-3 text-xs">
                <h4 className="font-bold text-slate-900 flex items-center gap-2">
                  <Building className="w-4 h-4 text-slate-600" />
                  
                  {t('checkout.dcSafeDepositTitle')}
                </h4>
                <div className="p-3 bg-slate-50 rounded-xl space-y-2">
                  <div className="flex justify-between text-slate-600">
                    <span>{t('checkout.dcNextDayFloat')}</span>
                    <span className="font-mono font-bold text-slate-900">${reserveFloatDollars}</span>
                  </div>
                  <div className="flex justify-between text-teal-900 font-bold pt-2 border-t border-slate-200">
                    <span>{t('checkout.dcDropToSafe')}</span>
                    <span className="font-mono font-black text-sm text-teal-700">
                      ${centsToDollars(safeDropCents)}
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  
                  {t('checkout.dcSafeDepositNote')}
                </p>
              </Card>
            </div>
          </div>
        )}

        {/* TAB 2: 钱箱精细面额盘点器 */}
        {activeTab === 'counter' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* 左侧 2 列：面额录入表格 */}
            <div className="lg:col-span-2 space-y-6">
              <Card className="border-slate-200 shadow-2xs">
                <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Coins className="w-4 h-4 text-teal-600" />
                    
                    {t('checkout.dcCounterTitle')}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setUseDenominationMode(!useDenominationMode)}
                      className="text-xs text-teal-700 hover:text-teal-800 font-semibold"
                    >
                      {useDenominationMode ? t('checkout.dcSwitchToTotal') : t('checkout.dcSwitchToDenominations')}
                    </button>
                  </div>
                </CardHeader>
                <CardContent className="p-6">
                  {useDenominationMode ? (
                    <div className="space-y-6">
                      {/* 纸币 Bills */}
                      <div>
                        <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                          <DollarSign className="w-3.5 h-3.5 text-teal-600" />
                          
                          {t('checkout.dcBills')}
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                          {BILL_DENOMINATIONS.map((b) => {
                            const count = counts[b.key] || 0;
                            const subtotalDollars = ((count * b.cents) / 100).toFixed(2);
                            return (
                              <div
                                key={b.key}
                                className="p-3 bg-slate-50/80 border border-slate-200/80 rounded-xl space-y-1.5"
                              >
                                <div className="flex justify-between items-center text-xs font-bold text-slate-800">
                                  <span>{b.label}</span>
                                  <span className="text-[11px] font-mono text-teal-700 font-bold">
                                    ${subtotalDollars}
                                  </span>
                                </div>
                                <Input
                                  type="number"
                                  min="0"
                                  disabled={isClosed}
                                  placeholder={t('checkout.dcZeroNotes')}
                                  value={counts[b.key] || ''}
                                  onChange={(e) => handleCountChange(b.key, e.target.value)}
                                  className="h-8 text-xs font-bold bg-white text-right font-mono"
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* 硬币 Coins */}
                      <div className="pt-4 border-t border-slate-100">
                        <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                          <Coins className="w-3.5 h-3.5 text-amber-600" />
                          
                          {t('checkout.dcCoins')}
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          {COIN_DENOMINATIONS.map((c) => {
                            const count = counts[c.key] || 0;
                            const subtotalDollars = ((count * c.cents) / 100).toFixed(2);
                            return (
                              <div
                                key={c.key}
                                className="p-3 bg-slate-50/80 border border-slate-200/80 rounded-xl space-y-1.5"
                              >
                                <div className="flex justify-between items-center text-xs font-bold text-slate-800">
                                  <span>{t(c.labelKey)}</span>
                                  <span className="text-[11px] font-mono text-amber-700 font-bold">
                                    ${subtotalDollars}
                                  </span>
                                </div>
                                <Input
                                  type="number"
                                  min="0"
                                  disabled={isClosed}
                                  placeholder={t('checkout.dcZeroCoins')}
                                  value={counts[c.key] || ''}
                                  onChange={(e) => handleCountChange(c.key, e.target.value)}
                                  className="h-8 text-xs font-bold bg-white text-right font-mono"
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex justify-end gap-2 pt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isClosed}
                          onClick={() => setCounts({})}
                          className="text-xs text-slate-500"
                        >
                          
                          {t('checkout.dcClearDenominations')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4 max-w-md">
                      <div>
                        <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                          
                          {t('checkout.dcCountedCashTotal')}
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                          <Input
                            type="text"
                            disabled={isClosed}
                            {...closeForm.bind('manualCount')}
                    value={manualCountedStr}
                            onChange={(e) => setManualCountedStr(e.target.value)}
                            placeholder="0.00"
                            className="pl-8 text-lg font-bold font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 右侧 1 列：核对与保存 */}
            <div className="space-y-6">
              <Card className="border-slate-200 shadow-2xs p-5 space-y-4">
                <h4 className="font-bold text-slate-900 text-sm">{t('checkout.dcVerification')}</h4>

                <div className="space-y-2.5 text-xs">
                  <div className="flex justify-between items-center text-slate-600">
                    <span>{t('checkout.dcExpectedLabel')}</span>
                    <span className="font-mono font-bold text-slate-900">${centsToDollars(expectedCents)}</span>
                  </div>
                  <div className="flex justify-between items-center text-slate-600">
                    <span>{t('checkout.dcCountedLabel')}</span>
                    <span className="font-mono font-bold text-teal-700">${centsToDollars(finalCountedCents)}</span>
                  </div>
                  <div className="pt-2 border-t border-slate-200 flex justify-between items-center font-bold">
                    <span className={liveBalanced ? 'text-emerald-700' : liveOver ? 'text-amber-700' : 'text-red-700'}>
                      {t('checkout.dcVarianceLabel')}
                    </span>
                    <span className={`font-mono text-base ${liveBalanced ? 'text-emerald-700' : liveOver ? 'text-amber-700' : 'text-red-700'}`}>
                      {liveOver ? '+' : ''}${centsToDollars(cashVarianceCents)}
                    </span>
                  </div>
                </div>

                {/* 状态指示框 */}
                <div
                  className={`p-3.5 rounded-xl text-xs space-y-1 ${
                    liveBalanced
                      ? 'bg-emerald-50 text-emerald-900 border border-emerald-200'
                      : liveOver
                      ? 'bg-amber-50 text-amber-900 border border-amber-200'
                      : 'bg-red-50 text-red-900 border border-red-200'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-bold">
                    {liveBalanced ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        <span>{t('checkout.dcExactMatch')}</span>
                      </>
                    ) : liveOver ? (
                      <>
                        <AlertCircle className="w-4 h-4 text-amber-600" />
                        <span>{t('checkout.dcOverPrefix')}</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4 text-red-600" />
                        <span>{t('checkout.dcShortPrefix')}</span>
                      </>
                    )}
                  </div>
                  <p className="text-[11px] opacity-80">
                    {liveBalanced
                      ? t('checkout.dcCashAligned')
                      : liveOver
                      ? t('checkout.dcCashOver')
                      : t('checkout.dcCashShort')}
                  </p>
                </div>

                {/* 差异超限说明输入 */}
                {!liveBalanced && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-bold text-slate-700">
                      
                      {t('checkout.dcVarianceReasonLabel')} {needsReason && <span className="text-red-500">{t('checkout.dcRequired')}</span>}
                    </label>
                    <Input
                      {...closeForm.bind('varianceReason')}
                      disabled={isClosed}
                      value={varianceReason}
                      onChange={(e) => { setVarianceReason(e.target.value); closeForm.clearField('varianceReason'); }}
                      placeholder={t('checkout.dcVarianceReasonPlaceholder')}
                      className="text-xs"
                    />
                  </div>
                )}

                {/* 留存底钱设置 */}
                <div className="space-y-1.5 pt-2 border-t border-slate-100">
                  <label className="block text-xs font-bold text-slate-700">
                    
                    {t('checkout.dcNextDayFloatLabel')}
                  </label>
                  <Input
                    type="text"
                    disabled={isClosed}
                    {...closeForm.bind('reserveFloat')}
                    value={reserveFloatDollars}
                    onChange={(e) => setReserveFloatDollars(e.target.value)}
                    className="text-xs font-mono font-bold"
                  />
                  <div className="flex justify-between text-[11px] text-slate-500 pt-1">
                    <span>{t('checkout.dcToSafeLabel')}</span>
                    <span className="font-mono font-bold text-teal-700">${centsToDollars(safeDropCents)}</span>
                  </div>
                </div>

                {!isClosed && (
                  <Button
                    isDisabled={!canManage}
                    isPending={saveCountMutation.isPending}
                    className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold gap-2 mt-2"
                    onClick={handleSaveCount}
                    disabled={saveCountMutation.isPending}
                  >
                    <Save className="w-4 h-4" />
                    <span>{saveCountMutation.isPending ? t('checkout.dcSaving') : t('checkout.dcSaveSnapshot')}</span>
                  </Button>
                )}
              </Card>
            </div>
          </div>
        )}

        {/* TAB 3: 小费结付看板 */}
        {activeTab === 'tips' && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <CircleDollarSign className="w-4 h-4 text-teal-600" />
                    
                    {t('checkout.dcTipPayoutsTitle')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    
                    {t('checkout.dcCardTipsCollected')}{centsToDollars(dayClose.money.tipCardCents)}  {t('checkout.dcCashTipsSep')}{centsToDollars(dayClose.money.tipCashCents)}
                  </p>
                </div>
                {!isClosed && (
                  <Button
                    isDisabled={!canPayTips}
                    isPending={payTipsMutation.isPending}
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold gap-1.5"
                    onClick={handlePayAllTips}
                    disabled={payTipsMutation.isPending || (dayClose.tipPayouts?.length ?? 0) === 0}
                  >
                    <DollarSign className="w-4 h-4" />
                    <span>{t('checkout.dcPayAllCashTips')}</span>
                  </Button>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {(!dayClose.tipPayouts || dayClose.tipPayouts.length === 0) ? (
                  <div className="py-12 text-center text-slate-400 text-xs">
                    
                    {dayClose.money.tipCardCents > 0
                      ? t('checkout.dcNoCashTipsCardOnly')
                      : t('checkout.dcNoTipsToday')}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                          <th className="py-3 px-5">{t('checkout.dcColStaffName')}</th>
                          <th className="py-3 px-5">{t('checkout.dcColTipsDue')}</th>
                          <th className="py-3 px-5">{t('checkout.dcColCashPaid')}</th>
                          <th className="py-3 px-5">{t('checkout.dcColAlreadyPaid')}</th>
                          <th className="py-3 px-5">{t('checkout.dcColCarryover')}</th>
                          <th className="py-3 px-5 text-right">{t('checkout.dcColActions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {dayClose.tipPayouts.map((ts) => (
                          <tr key={ts.membershipId} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-5 font-bold text-slate-900 flex items-center gap-2">
                              <User className="w-3.5 h-3.5 text-slate-400" />
                              <span>{ts.name}</span>
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-slate-900">
                              ${centsToDollars(ts.owedCents)}
                            </td>
                            <td className="py-3 px-5 font-mono font-bold text-emerald-700">
                              ${centsToDollars(ts.payCents)}
                            </td>
                            <td className="py-3 px-5 font-mono text-slate-500">
                              ${centsToDollars(ts.alreadyPaidCents)}
                            </td>
                            <td className="py-3 px-5 font-mono">
                              <Badge variant={ts.carryOutCents > 0 ? 'warning' : 'outline'} className="text-[11px]">
                                ${centsToDollars(ts.carryOutCents)}
                              </Badge>
                            </td>
                            <td className="py-3 px-5 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-teal-700 hover:text-teal-800 hover:bg-teal-50"
                                onClick={() => setTipReceiptStaff(ts)}
                              >
                                <Printer className="w-3.5 h-3.5 mr-1" />
                                
                                {t('checkout.dcPrintAckSlip')}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 4: 零用金与审计轨迹 */}
        {activeTab === 'audit' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 零用金变动流水 */}
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Coins className="w-4 h-4 text-teal-600" />
                  
                  {t('checkout.dcPettyCashTitle')}
                </CardTitle>
                {!isClosed && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-teal-700 font-bold"
                    onClick={() => setMovementModalOpen(true)}
                  >
                    
                    {t('checkout.dcAddMovement')}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {(!dayClose.movements || dayClose.movements.length === 0) ? (
                  <p className="text-xs text-slate-400 py-10 text-center">{t('checkout.dcNoMovements')}</p>
                ) : (
                  <div className="divide-y divide-slate-100 text-xs">
                    {dayClose.movements.map((m) => (
                      <div key={m.id} className="p-4 flex items-center justify-between hover:bg-slate-50/70">
                        <div className="flex items-center gap-3">
                          {m.amountCents > 0 ? (
                            <ArrowDownCircle className="w-5 h-5 text-emerald-500" />
                          ) : (
                            <ArrowUpCircle className="w-5 h-5 text-amber-500" />
                          )}
                          <div>
                            <p className="font-bold text-slate-800">
                              {m.kind === 'opening_float'
                                ? t('checkout.dcMoveOpeningFloat')
                                : m.kind === 'cash_drop'
                                ? t('checkout.dcMoveToSafe')
                                : m.kind === 'supply_purchase'
                                ? t('checkout.dcMoveSupplies')
                                : m.kind === 'payout_owner'
                                ? t('checkout.dcMoveOwnerDraw')
                                : t('checkout.dcMoveOther')}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {m.note || t('checkout.dcNoNote')} • {storeTime.time(m.at)}
                            </p>
                          </div>
                        </div>
                        <span className={`font-mono font-bold ${m.amountCents > 0 ? 'text-emerald-700' : 'text-slate-800'}`}>
                          {m.amountCents > 0 ? '+' : ''}${centsToDollars(m.amountCents)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 审计日志轨迹 */}
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5">
                <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <History className="w-4 h-4 text-slate-600" />
                  
                  {t('checkout.dcAuditTrail')}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 space-y-4 text-xs">
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">
                      1
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">{t('checkout.dcAuditOpeningFloat')}</p>
                      <p className="text-slate-500 text-[11px]">Amount: ${centsToDollars(dayClose.openingFloatCents)}  {t('checkout.dcAuditAutoApproved')}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">
                      2
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">{t('checkout.dcAuditCount')}</p>
                      <p className="text-slate-500 text-[11px]">
                        
                        {t('checkout.dcAuditCounted')}{centsToDollars(finalCountedCents)}  {t('checkout.dcAuditVariance')} {isBalanced ? t('checkout.dcBalanced') : `$${centsToDollars(cashVarianceCents)}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5 ${
                      isClosed ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'
                    }`}>
                      3
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">
                        {isClosed ? t('checkout.dcArchivedClosed') : t('checkout.dcPendingClose')}
                      </p>
                      <p className="text-slate-500 text-[11px]">
                        {isClosed ? t('checkout.dcLockedNote') : t('checkout.dcPendingNote')}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-[11px] text-slate-500 space-y-1">
                  <p className="font-bold text-slate-700">{t('checkout.dcComplianceTitle')}</p>
                  <p>{t('checkout.dcComplianceBody')}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 封账确认模态框 */}
        <ConfirmDialog
          isOpen={confirmFinalize}
          onOpenChange={setConfirmFinalize}
          title={t('checkout.dcCloseConfirmTitle')}
          description={
            dayClose.openTicketCount > 0
              ? t('checkout.dcCloseConfirmUnsettled', { p0: dayClose.openTicketCount })
              : t('checkout.dcCloseConfirmBody')
          }
          confirmLabel={t('checkout.dcCloseConfirmAction')}
          onConfirm={handleFinalize}
        />

        {/* 反结账申请模态框 */}
        <Modal
          isOpen={reopenModalOpen}
          onOpenChange={setReopenModalOpen}
          size="sm"
          title={t('checkout.dcReopenModalTitle')}
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setReopenModalOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                isDisabled={!canReopen}
                isPending={reopenMutation.isPending}
                onClick={handleReopen}
                disabled={!reopenReasonText.trim() || reopenMutation.isPending}
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold"
              >
                
                {t('checkout.dcReopenConfirm')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              
              {t('checkout.dcReopenBody')}
            </p>
            <div>
              <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                
                {t('checkout.dcReopenReasonLabel')} <span className="text-red-500">*</span>
              </label>
              <Input
                value={reopenReasonText}
                onChange={(e) => setReopenReasonText(e.target.value)}
                placeholder={t('checkout.dcReopenReasonPlaceholder')}
                className="text-xs"
              />
            </div>
          </div>
        </Modal>

        {/* 录入零用金模态框 */}
        <Modal
          isOpen={movementModalOpen}
          onOpenChange={setMovementModalOpen}
          size="sm"
          title={t('checkout.dcPettyCashModalTitle')}
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setMovementModalOpen(false)}>
                
                {t('checkout.dcPettyCancel')}
              </Button>
              <Button
                isDisabled={!canManage}
                isPending={recordMovementMutation.isPending}
                onClick={handleRecordMovement}
                disabled={recordMovementMutation.isPending}
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              >
                
                {t('checkout.dcPettySave')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">{t('checkout.dcMovementType')}</label>
              <select
                value={movementForm.kind}
                onChange={(e) => setMovementForm((prev) => ({ ...prev, kind: e.target.value as any }))}
                className="w-full h-9 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium"
              >
                <option value="supply_purchase">{t('checkout.dcMoveSupplies2')}</option>
                <option value="cash_drop">{t('checkout.dcMoveToSafe2')}</option>
                <option value="opening_float">{t('checkout.dcMoveAddFloat')}</option>
                <option value="payout_owner">{t('checkout.dcMoveOwnerDraw2')}</option>
                <option value="other">{t('checkout.dcMoveOther2')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Amount ($)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                <Input
                  type="text"
                  placeholder="0.00"
                  {...closeForm.bind('movementAmount')}
                    value={movementForm.amountDollars}
                  onChange={(e) => setMovementForm((prev) => ({ ...prev, amountDollars: e.target.value }))}
                  className="pl-8 text-xs font-bold font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">{t('checkout.dcMovementNote')}</label>
              <Input
                type="text"
                placeholder={t('checkout.dcMovementNotePlaceholder')}
                value={movementForm.note}
                onChange={(e) => setMovementForm((prev) => ({ ...prev, note: e.target.value }))}
                className="text-xs"
              />
            </div>
          </div>
        </Modal>

        {/* 打印 Z-Report 预览与打印模态框 */}
        <Modal
          isOpen={printModalOpen}
          onOpenChange={setPrintModalOpen}
          size="md"
          title={t('checkout.dcZReportModalTitle')}
          footer={
            <div className="flex justify-between items-center w-full">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPrintReceiptType('thermal')}
                  className={`px-3 py-1 text-xs rounded-lg font-bold transition-all ${
                    printReceiptType === 'thermal' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  
                  {t('checkout.dcThermal80')}
                </button>
                <button
                  type="button"
                  onClick={() => setPrintReceiptType('full')}
                  className={`px-3 py-1 text-xs rounded-lg font-bold transition-all ${
                    printReceiptType === 'full' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  
                  US Letter
                </button>
              </div>

              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setPrintModalOpen(false)}>
                  
                  {t('checkout.dcZReportClose')}
                </Button>
                <Button
                  onClick={() => { openPrintPreview(document.querySelector('[data-print-zreport]'), 'Daily close report', printReceiptType === 'thermal' ? 'thermal' : 'letter'); setPrintModalOpen(false); }}
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1.5"
                >
                  <Printer className="w-4 h-4" />
                  
                  {t('checkout.dcZReportPrint')}
                </Button>
              </div>
            </div>
          }
        >
          {/* Printable Receipt Preview */}
          <div data-print-zreport className="bg-slate-100 p-4 rounded-xl max-h-[60vh] overflow-y-auto">
            {printReceiptType === 'thermal' ? (
              <div className="bg-white p-6 rounded-lg shadow-sm font-mono text-xs max-w-[320px] mx-auto text-slate-900 border border-slate-200">
                <div className="text-center pb-4 border-b border-dashed border-slate-300">
                  <h3 className="text-base font-bold tracking-wider uppercase">GENIE FRONT DAILY RECORD</h3>
                  <p className="text-[11px] text-slate-500">*** Z-REPORT (DAILY CLOSE) ***</p>
                  <p className="text-[10px] text-slate-400 mt-1">DATE: {dayClose.businessDate}</p>
                  <p className="text-[10px] text-slate-400">STORE: {pickText(membership?.locationName, 'en', '—')}</p>
                </div>

                <div className="py-3 border-b border-dashed border-slate-300 space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span>GROSS SALES:</span>
                    <span>${centsToDollars(dayClose.money.grossCents)}</span>
                  </div>
                  <div className="flex justify-between text-red-600">
                    <span>DISCOUNTS:</span>
                    <span>-${centsToDollars(dayClose.money.discountCents)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>TAX TOTAL:</span>
                    <span>${centsToDollars(dayClose.money.taxCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-sm pt-1 border-t border-slate-200">
                    <span>NET SALES:</span>
                    <span>${centsToDollars(dayClose.money.netCents)}</span>
                  </div>
                </div>

                <div className="py-3 border-b border-dashed border-slate-300 space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span>CARD (STRIPE):</span>
                    <span>${centsToDollars(dayClose.money.cardTakeCents)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>CASH TAKE:</span>
                    <span>${centsToDollars(dayClose.money.cashTakeCents)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>TOTAL TIPS:</span>
                    <span>${centsToDollars(dayClose.money.tipCardCents + dayClose.money.tipCashCents)}</span>
                  </div>
                </div>

                <div className="py-3 border-b border-dashed border-slate-300 space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span>STARTING FLOAT:</span>
                    <span>${centsToDollars(dayClose.openingFloatCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span>EXPECTED CASH:</span>
                    <span>${centsToDollars(dayClose.expectedCashCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span>ACTUAL COUNTED:</span>
                    <span>${centsToDollars(finalCountedCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-teal-700">
                    <span>VARIANCE:</span>
                    <span>{isOver ? '+' : ''}${centsToDollars(cashVarianceCents)}</span>
                  </div>
                </div>

                <div className="pt-4 text-center text-[10px] text-slate-400 space-y-2">
                  <p>OPERATOR SIGNATURE: _______________</p>
                  <p>MANAGER SIGNATURE: _______________</p>
                  <p>GENERATED AT: {storeTime.time(new Date())}</p>
                </div>
              </div>
            ) : (
              <div className="bg-white p-8 rounded-lg shadow-sm text-xs text-slate-900 border border-slate-200 space-y-6">
                <div className="border-b border-slate-200 pb-4 text-center">
                  <h2 className="text-xl font-bold">{t('checkout.dcZReportTitle')}</h2>
                  <p className="text-slate-500 mt-1">{t('checkout.dcZBusinessDate')} {dayClose.businessDate}  {pickText(membership?.locationName, 'en', '—')}</p>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <h4 className="font-bold border-b pb-1 text-slate-800">{t('checkout.dcZRevenueSection')}</h4>
                    <div className="flex justify-between"><span>{t('checkout.dcZGross')}</span><span className="font-mono">${centsToDollars(dayClose.money.grossCents)}</span></div>
                    <div className="flex justify-between text-red-600"><span>{t('checkout.dcZDiscounts')}</span><span className="font-mono">-${centsToDollars(dayClose.money.discountCents)}</span></div>
                    <div className="flex justify-between"><span>{t('checkout.dcZTax')}</span><span className="font-mono">${centsToDollars(dayClose.money.taxCents)}</span></div>
                    <div className="flex justify-between font-bold pt-1 border-t"><span>{t('checkout.dcZNet')}</span><span className="font-mono">${centsToDollars(dayClose.money.netCents)}</span></div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-bold border-b pb-1 text-slate-800">{t('checkout.dcZTenderSection')}</h4>
                    <div className="flex justify-between"><span>{t('checkout.dcZCard')}</span><span className="font-mono">${centsToDollars(dayClose.money.cardTakeCents)}</span></div>
                    <div className="flex justify-between"><span>{t('checkout.dcZCash')}</span><span className="font-mono">${centsToDollars(dayClose.money.cashTakeCents)}</span></div>
                    <div className="flex justify-between"><span>{t('checkout.dcZTips')}</span><span className="font-mono">${centsToDollars(dayClose.money.tipCardCents + dayClose.money.tipCashCents)}</span></div>
                    <div className="flex justify-between font-bold pt-1 border-t"><span>{t('checkout.dcZTotal')}</span><span className="font-mono">${centsToDollars(dayClose.money.cardTakeCents + dayClose.money.cashTakeCents)}</span></div>
                  </div>
                </div>

                <div className="pt-8 border-t border-slate-200 grid grid-cols-2 gap-8 text-center text-slate-500">
                  <div>{t('checkout.dcZSignFrontDesk')}</div>
                  <div>{t('checkout.dcZSignManager')}</div>
                </div>
              </div>
            )}
          </div>
        </Modal>

        {/* 技师小费签收小票模态框 */}
        {tipReceiptStaff && (
          <Modal
            isOpen={Boolean(tipReceiptStaff)}
            onOpenChange={() => setTipReceiptStaff(null)}
            size="sm"
            title={t('checkout.dcTipSlipTitle')}
            footer={
              <div className="flex justify-end gap-2 w-full">
                <Button variant="secondary" onClick={() => setTipReceiptStaff(null)}>
                  
                  {t('checkout.dcTipSlipClose')}
                </Button>
                <Button
                  onClick={() => { openPrintPreview(document.querySelector('[data-print-tip-slip]'), 'Tip acknowledgement', 'thermal'); setTipReceiptStaff(null); }}
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1.5"
                >
                  <Printer className="w-4 h-4" />
                  
                  {t('checkout.dcTipSlipPrint')}
                </Button>
              </div>
            }
          >
            <div data-print-tip-slip className="bg-slate-50 p-5 rounded-xl border border-slate-200 font-mono text-xs space-y-3">
              <div className="text-center border-b border-dashed pb-2">
                <p className="font-bold text-sm text-slate-900">{t('checkout.dcTipSlipHeading')}</p>
                <p className="text-[11px] text-slate-500">{dayClose.businessDate}</p>
              </div>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between"><span className="text-slate-500">{t('checkout.dcTipSlipName')}</span><span className="font-bold text-slate-900">{tipReceiptStaff.name}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t('checkout.dcTipSlipDue')}</span><span className="font-bold text-slate-900">${centsToDollars(tipReceiptStaff.owedCents)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t('checkout.dcTipSlipPaid')}</span><span className="font-bold text-emerald-700">${centsToDollars(tipReceiptStaff.payCents)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t('checkout.dcTipSlipCarryover')}</span><span className="font-bold text-slate-700">${centsToDollars(tipReceiptStaff.carryOutCents)}</span></div>
              </div>
              <div className="pt-4 text-center text-[10px] text-slate-400">
                <p>{t('checkout.dcTipSlipSign')}</p>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </ErrorBoundary>
  );
}
