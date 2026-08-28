import { useState, useMemo } from 'react';
import {
  CreditCard,
  Building,
  DollarSign,
  RefreshCw,
  CheckCircle2,
  Clock,
  Landmark,
  ArrowUpRight,
  ArrowDownRight,
  Download,
  Printer,
  Calendar,
  User,
  Users,
  AlertCircle,
  FileText,
  BadgePercent,
  Check,
  Search,
  ChevronDown,
  ChevronRight,
  Send,
  Eye,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Layers,
  Banknote,
  Receipt,
  FileSpreadsheet,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { toast, Spinner } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { useDayCloseQuery } from '@/features/dayclose/api';
import { usePayrollPlansQuery } from '@/features/payroll/api';
import {
  useMerchantBalanceQuery,
  useBankPayoutBatchesQuery,
  usePayrollBatchesQuery,
  useClawbacksQuery,
} from '@/features/payouts/api';
import { centsToDollars, dollarsToCents } from '@/features/checkout/api';
import { exportToCSV, exportToExcel } from '@/lib/exportUtils';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';

// 模拟银行打款批次记录 (Stripe Payouts Batches)
interface BankPayoutBatch {
  id: string;
  payoutId: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  transactionCount: number;
  bankAccount: string;
  status: 'paid' | 'in_transit' | 'pending' | 'failed';
  arrivalDate: string;
  createdAt: string;
}

const MOCK_BANK_PAYOUTS: BankPayoutBatch[] = [
  {
    id: 'po-101',
    payoutId: 'po_1Nk8F2Lkd82a01',
    amountCents: 384500,
    feeCents: 9612,
    netCents: 374888,
    transactionCount: 38,
    bankAccount: 'JPMorgan Chase (****8892)',
    status: 'paid',
    arrivalDate: '2026-08-26',
    createdAt: '2026-08-25 23:45',
  },
  {
    id: 'po-102',
    payoutId: 'po_1Nk8F2Lkd82a02',
    amountCents: 421000,
    feeCents: 10525,
    netCents: 410475,
    transactionCount: 42,
    bankAccount: 'JPMorgan Chase (****8892)',
    status: 'paid',
    arrivalDate: '2026-08-25',
    createdAt: '2026-08-24 23:40',
  },
  {
    id: 'po-103',
    payoutId: 'po_1Nk8F2Lkd82a03',
    amountCents: 298000,
    feeCents: 7450,
    netCents: 290550,
    transactionCount: 29,
    bankAccount: 'JPMorgan Chase (****8892)',
    status: 'paid',
    arrivalDate: '2026-08-24',
    createdAt: '2026-08-23 23:50',
  },
  {
    id: 'po-104',
    payoutId: 'po_1Nk8F2Lkd82a04',
    amountCents: 185000,
    feeCents: 4625,
    netCents: 180375,
    transactionCount: 19,
    bankAccount: 'JPMorgan Chase (****8892)',
    status: 'in_transit',
    arrivalDate: '2026-08-28 (预计明日到账)',
    createdAt: '2026-08-27 10:30',
  },
];

// 模拟周期性薪资结算批次 (Bi-Weekly Payroll)
interface StaffPayrollRecord {
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

const MOCK_STAFF_PAYROLL: StaffPayrollRecord[] = [
  {
    membershipId: 'st-01',
    name: 'Elena Vance',
    jobTitle: '首席美甲设计师',
    baseSalaryCents: 120000,
    serviceSalesCents: 685000,
    serviceCommissionCents: 342500, // 50%
    retailSalesCents: 45000,
    retailCommissionCents: 4500, // 10%
    cardTipsCents: 85000,
    bonusCents: 10000,
    deductionsCents: 0,
    netPayCents: 562000,
    status: 'pending',
  },
  {
    membershipId: 'st-02',
    name: 'Marcus Chen',
    jobTitle: '资深芳疗理疗师',
    baseSalaryCents: 140000,
    serviceSalesCents: 590000,
    serviceCommissionCents: 295000, // 50%
    retailSalesCents: 32000,
    retailCommissionCents: 3200,
    cardTipsCents: 78000,
    bonusCents: 5000,
    deductionsCents: 0,
    netPayCents: 521200,
    status: 'pending',
  },
  {
    membershipId: 'st-03',
    name: 'Sophia Williams',
    jobTitle: '高级Lashes & Brows师',
    baseSalaryCents: 100000,
    serviceSalesCents: 480000,
    serviceCommissionCents: 240000,
    retailSalesCents: 28000,
    retailCommissionCents: 2800,
    cardTipsCents: 62000,
    bonusCents: 0,
    deductionsCents: 0,
    netPayCents: 404800,
    status: 'paid',
  },
  {
    membershipId: 'st-04',
    name: 'David Miller',
    jobTitle: '前台主管 / 收银店务',
    baseSalaryCents: 220000,
    serviceSalesCents: 0,
    serviceCommissionCents: 0,
    retailSalesCents: 12000,
    retailCommissionCents: 1200,
    cardTipsCents: 0,
    bonusCents: 15000,
    deductionsCents: 0,
    netPayCents: 236200,
    status: 'paid',
  },
];

// 模拟退款冲正记录 (Commission Clawbacks)
interface ClawbackRecord {
  id: string;
  ticketId: string;
  customerName: string;
  staffName: string;
  refundAmountCents: number;
  clawbackCommissionCents: number;
  reason: string;
  date: string;
}

const MOCK_CLAWBACKS: ClawbackRecord[] = [
  {
    id: 'cb-01',
    ticketId: '#TK-9021',
    customerName: 'Jennifer Lopez',
    staffName: 'Elena Vance',
    refundAmountCents: 6800,
    clawbackCommissionCents: 3400,
    reason: '客户指甲甲油起翘，前台办理全额退款并冲正提成',
    date: '2026-08-24',
  },
  {
    id: 'cb-02',
    ticketId: '#TK-8942',
    customerName: 'Robert De Niro',
    staffName: 'Marcus Chen',
    refundAmountCents: 8800,
    clawbackCommissionCents: 4400,
    reason: '客户因临时急事中途取消 SPA 服务，退还未服务款项',
    date: '2026-08-20',
  },
];

export function Payouts() {
  const { t } = useLanguage();
  const { data: dayClose, isLoading: isDayCloseLoading, refetch: refetchDayClose } = useDayCloseQuery();
  const balanceQ = useMerchantBalanceQuery();
  const bankBatchesQ = useBankPayoutBatchesQuery();
  const payrollBatchesQ = usePayrollBatchesQuery();
  const clawbacksQ = useClawbacksQuery();

  const isLoading = isDayCloseLoading || balanceQ.isLoading || bankBatchesQ.isLoading;

  const isInitialLoading = isLoading && !bankBatchesQ.data && !balanceQ.data && !dayClose;

  const [activeTab, setActiveTab] = useState<'bank' | 'tips' | 'payroll' | 'clawback'>('bank');

  // 工资条 Pay Stub 弹窗
  const [selectedPayStub, setSelectedPayStub] = useState<StaffPayrollRecord | null>(null);

  // 划拨订单穿透明细弹窗
  const [selectedPayoutBatch, setSelectedPayoutBatch] = useState<BankPayoutBatch | null>(null);

  const bankBatchesList = useMemo(() => {
    if (bankBatchesQ.data?.batches && bankBatchesQ.data.batches.length > 0) {
      return bankBatchesQ.data.batches;
    }
    return MOCK_BANK_PAYOUTS;
  }, [bankBatchesQ.data]);

  const payrollList = useMemo(() => {
    if (payrollBatchesQ.data?.rows && payrollBatchesQ.data.rows.length > 0) {
      return payrollBatchesQ.data.rows;
    }
    return MOCK_STAFF_PAYROLL;
  }, [payrollBatchesQ.data]);

  const clawbackList = useMemo(() => {
    if (clawbacksQ.data?.rows && clawbacksQ.data.rows.length > 0) {
      return clawbacksQ.data.rows;
    }
    return MOCK_CLAWBACKS;
  }, [clawbacksQ.data]);

  // KPI 计算
  const balanceData = balanceQ.data;
  const availableBalanceCents = balanceData?.availableBalanceCents ?? dayClose?.money?.cardTakeCents ?? 312000;
  const pendingPayoutsCents = balanceData?.pendingPayoutsCents ?? 185000;
  const monthlyGmvCents = balanceData?.monthlyGmvCents ?? 4285000;
  const processingFeeCents = balanceData?.processingFeeCents ?? 111410;
  const netCaptureRateBp = balanceData?.netCaptureRateBp ?? 9740;
  const bankName = balanceData?.bankAccount?.bankName ?? 'JPMorgan Chase (****8892)';

  const tipCents = (dayClose?.money?.tipCardCents ?? 48000) + (dayClose?.money?.tipCashCents ?? 12000);
  const tipPayouts = dayClose?.tipPayouts ?? [];

  if (isInitialLoading) {
    return <PageLoading title={t('finance.poLoading')} description={t('finance.poLoadingDesc')} />;
  }

  if ((balanceQ.isError || bankBatchesQ.isError) && !bankBatchesQ.data && !balanceQ.data && !dayClose) {
    return (
      <PageError
        title={t('finance.poLoadError')}
        error={balanceQ.error || bankBatchesQ.error}
        onRetry={() => {
          void bankBatchesQ.refetch();
          void balanceQ.refetch();
          void payrollBatchesQ.refetch();
          void clawbacksQ.refetch();
        }}
      />
    );
  }

  return (
    <ErrorBoundary>
      <div className="space-y-6 max-w-7xl mx-auto w-full pb-24">
        {/* Top Header */}
        <PageHeader
          title={t('payoutsTitle') || t('finance.poTitle')}
          description={t('payoutsSubtitle') || t('finance.poSubtitle')}
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="secondary"
                size="sm"
                className="bg-white border-slate-200 shadow-2xs gap-1.5"
                onClick={() => {
                  void refetchDayClose();
                  void balanceQ.refetch();
                  void bankBatchesQ.refetch();
                  void payrollBatchesQ.refetch();
                  void clawbacksQ.refetch();
                  toast.success(t('finance.poRefreshed'));
                }}
                disabled={isLoading}
              >
                <RefreshCw className={`w-4 h-4 text-slate-600 ${isLoading ? 'animate-spin' : ''}`} />
                <span>{t('refresh') || t('finance.poRefresh')}</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="bg-white border-slate-200 text-xs font-bold gap-1.5"
                onClick={() => {
                  const headers = ['划拨编号', '入账银行', '总Amount ($)', '手续费 ($)', '净入账 ($)', '笔数', '状态', '到账日期'];
                  const rows = bankBatchesList.map((p) => [
                    p.payoutId,
                    p.bankAccount,
                    centsToDollars(p.amountCents),
                    centsToDollars(p.feeCents),
                    centsToDollars(p.netCents),
                    p.transactionCount,
                    p.status,
                    p.arrivalDate,
                  ]);
                  exportToCSV('merchant-bank-payouts', headers, rows);
                  toast.success(t('finance.poExported'));
                }}
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('finance.poExport')}</span>
              </Button>

              <Button
                size="sm"
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1.5 shadow-sm"
                onClick={() => {
                  toast.success(t('finance.poStripeConnected', { p0: bankName }));
                }}
              >
                <Landmark className="w-3.5 h-3.5" />
                <span>{t('finance.poManageBank')}</span>
              </Button>
            </div>
          }
        />

        {/* 3 Core Capital Account Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* 商户收单结算账户 (Merchant Balance) */}
          <Card className="border-teal-200 shadow-2xs bg-gradient-to-br from-white via-teal-50/20 to-teal-50/40 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-900 text-sm">
                <Landmark className="w-4 h-4 text-teal-600" />
                <span>{t('finance.poMerchantAccount')}</span>
              </div>
              <Badge variant="success" className="text-[11px]">
                
                {t('finance.poAutoPayout')}
              </Badge>
            </div>

            <div>
              <p className="text-xs text-slate-500">{t('finance.poAvailableBalance')}</p>
              <p className="text-3xl font-black text-slate-900 mt-1 font-mono">
                ${centsToDollars(availableBalanceCents)}
              </p>
            </div>

            <div className="space-y-1.5 text-xs text-slate-600 pt-2 border-t border-teal-100">
              <div className="flex justify-between">
                <span>{t('finance.poInTransit')}</span>
                <span className="font-mono font-bold text-teal-700">${centsToDollars(pendingPayoutsCents)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('finance.poDestinationBank')}</span>
                <span className="font-semibold text-slate-800">{bankName}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('finance.poNextPayout')}</span>
                <span className="text-slate-500">{t('finance.poNextPayoutTime')}</span>
              </div>
            </div>
          </Card>

          {/* 技师待结佣金与小费池 (Staff Payroll & Tips) */}
          <Card className="border-slate-200 shadow-2xs bg-gradient-to-br from-white to-amber-50/20 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-900 text-sm">
                <Users className="w-4 h-4 text-amber-600" />
                <span>{t('finance.poPendingPool')}</span>
              </div>
              <Badge variant="warning" className="text-[11px]">
                
                {t('finance.poBiweekly')}
              </Badge>
            </div>

            <div>
              <p className="text-xs text-slate-500">{t('finance.poPendingPayroll')}</p>
              <p className="text-3xl font-black text-slate-900 mt-1 font-mono text-amber-900">
                $10,832.00
              </p>
            </div>

            <div className="space-y-1.5 text-xs text-slate-600 pt-2 border-t border-amber-100">
              <div className="flex justify-between">
                <span>{t('finance.poServiceCommission')}</span>
                <span className="font-mono font-bold text-slate-900">$8,775.00</span>
              </div>
              <div className="flex justify-between">
                <span>{t('finance.poPendingCardTips')}</span>
                <span className="font-mono font-bold text-slate-900">${centsToDollars(tipCents)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('finance.poPayoutDay')}</span>
                <span className="text-slate-500">{t('finance.poPayoutSchedule')}</span>
              </div>
            </div>
          </Card>

          {/* 收单流水与费率汇总 (Fee & Capture Summary) */}
          <Card className="border-slate-200 shadow-2xs bg-gradient-to-br from-white to-blue-50/20 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-slate-900 text-sm">
                <BadgePercent className="w-4 h-4 text-blue-600" />
                <span>{t('finance.poFeeEfficiency')}</span>
              </div>
              <span className="text-xs font-semibold text-blue-700">{t('finance.poMonthToDate')}</span>
            </div>

            <div>
              <p className="text-xs text-slate-500">{t('finance.poMonthlyGmv')}</p>
              <p className="text-3xl font-black text-slate-900 mt-1 font-mono">
                $42,850.00
              </p>
            </div>

            <div className="space-y-1.5 text-xs text-slate-600 pt-2 border-t border-blue-100">
              <div className="flex justify-between">
                <span>{t('finance.poProcessingFee')}</span>
                <span className="font-mono text-slate-700">-$1,114.10</span>
              </div>
              <div className="flex justify-between">
                <span>{t('finance.poAvgSettlement')}</span>
                <span className="font-semibold text-emerald-700">{t('finance.poSettlementT1')}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('finance.poNetRate')}</span>
                <span className="font-mono font-bold text-slate-900">97.4%</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Tab Navigation Switcher */}
        <div className="flex border-b border-slate-200 gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('bank')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === 'bank'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Building className="w-4 h-4" />
            <span>{t('finance.poTabTransfers')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tips')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === 'tips'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Banknote className="w-4 h-4" />
            <span>{t('finance.poTabTips')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('payroll')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === 'payroll'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>{t('finance.poTabStubs')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('clawback')}
            className={`pb-3 px-4 text-sm font-bold flex items-center gap-2 border-b-2 transition-all shrink-0 ${
              activeTab === 'clawback'
                ? 'border-teal-600 text-teal-700 font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <RotateCcw className="w-4 h-4" />
            <span>{t('finance.poTabClawbacks')}</span>
          </button>
        </div>

        {/* TAB 1: 银行收单划拨流水 */}
        {activeTab === 'bank' && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Landmark className="w-4 h-4 text-teal-600" />
                    
                    {t('finance.poBatchTitle')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    
                    {t('finance.poBatchDesc')}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                        <th className="py-3 px-5">{t('finance.poColBatchId')}</th>
                        <th className="py-3 px-5">{t('finance.poColBank')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColGross')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColFee')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColNet')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColOrders')}</th>
                        <th className="py-3 px-5">{t('finance.poColStatus')}</th>
                        <th className="py-3 px-5">{t('finance.poColDate')}</th>
                        <th className="py-3 px-5 text-right">{t('finance.poColActions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {bankBatchesList.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-5 font-mono font-bold text-slate-900">{p.payoutId}</td>
                          <td className="py-3 px-5 font-medium text-slate-700">{p.bankAccount}</td>
                          <td className="py-3 px-5 font-mono font-bold text-slate-900">${centsToDollars(p.amountCents)}</td>
                          <td className="py-3 px-5 font-mono text-red-600">-${centsToDollars(p.feeCents)}</td>
                          <td className="py-3 px-5 font-mono font-black text-teal-700">${centsToDollars(p.netCents)}</td>
                          <td className="py-3 px-5 font-mono">{p.transactionCount}  {t('finance.poOrderUnit')}</td>
                          <td className="py-3 px-5">
                            {p.status === 'paid' ? (
                              <Badge variant="success" className="text-[11px]">{t('finance.poStatusPaid')}</Badge>
                            ) : p.status === 'in_transit' ? (
                              <Badge variant="warning" className="text-[11px]">{t('finance.poStatusInTransit')}</Badge>
                            ) : (
                              <Badge variant="error" className="text-[11px]">{t('finance.poStatusFailed')}</Badge>
                            )}
                          </td>
                          <td className="py-3 px-5 font-mono text-slate-500">{p.arrivalDate}</td>
                          <td className="py-3 px-5 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-teal-700 hover:text-teal-800"
                              onClick={() => setSelectedPayoutBatch(p)}
                            >
                              <Eye className="w-3.5 h-3.5 mr-1" />
                              
                              {t('finance.poDrillDown')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 2: 每日技师小费清算明细 */}
        {activeTab === 'tips' && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Banknote className="w-4 h-4 text-teal-600" />
                    
                    {t('finance.poTipsTitle')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    
                    {t('finance.poTipsDesc')}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {tipPayouts.length === 0 ? (
                  <div className="py-12 text-center text-slate-400 text-xs">
                    
                    {t('finance.poNoTips')}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                          <th className="py-3 px-5">{t('finance.poColStaffName')}</th>
                          <th className="py-3 px-5 font-mono">{t('finance.poColTipsDue')}</th>
                          <th className="py-3 px-5 font-mono">{t('finance.poColCashPaid')}</th>
                          <th className="py-3 px-5 font-mono">{t('finance.poColTipsPaid')}</th>
                          <th className="py-3 px-5 font-mono">{t('finance.poColCarryForward')}</th>
                          <th className="py-3 px-5 text-right">{t('finance.poColTipActions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700">
                        {tipPayouts.map((ts) => (
                          <tr key={ts.membershipId} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 px-5 font-bold text-slate-900">{ts.name}</td>
                            <td className="py-3 px-5 font-mono font-bold text-slate-900">${centsToDollars(ts.owedCents)}</td>
                            <td className="py-3 px-5 font-mono font-bold text-emerald-700">${centsToDollars(ts.payCents)}</td>
                            <td className="py-3 px-5 font-mono text-slate-500">${centsToDollars(ts.alreadyPaidCents)}</td>
                            <td className="py-3 px-5 font-mono">
                              <Badge variant={ts.carryOutCents > 0 ? 'warning' : 'outline'} className="text-[11px]">
                                ${centsToDollars(ts.carryOutCents)}
                              </Badge>
                            </td>
                            <td className="py-3 px-5 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-teal-700 font-bold"
                                onClick={() => {
                                  toast.success(t('finance.poTipSlipPrinted', { p0: ts.name }));
                                }}
                              >
                                <Printer className="w-3.5 h-3.5 mr-1" />
                                
                                {t('finance.poPrintSlip')}
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

        {/* TAB 3: 周期性薪资提成与工资条 (Pay Stubs) */}
        {activeTab === 'payroll' && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5 flex flex-row items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-teal-600" />
                    
                    {t('finance.poPayrollBatchTitle')}
                  </CardTitle>
                  <p className="text-xs text-slate-500 mt-0.5">
                    
                    {t('finance.poPayrollBatchDesc')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1.5"
                    onClick={() => {
                      toast.success(t('finance.poBatchMarkedPaid'));
                    }}
                  >
                    <Check className="w-4 h-4" />
                    <span>{t('finance.poConfirmBatch')}</span>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                        <th className="py-3 px-5">{t('finance.poColEmployee')}</th>
                        <th className="py-3 px-5">{t('finance.poColRole')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColBasePay')}</th>
                        <th className="py-3 px-5 font-mono">Service Commission ($)</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColRetailCommission')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColCardTips')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColNetPay')}</th>
                        <th className="py-3 px-5">{t('finance.poColStubStatus')}</th>
                        <th className="py-3 px-5 text-right">{t('finance.poColStub')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {payrollList.map((sp) => (
                        <tr key={sp.membershipId} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-5 font-bold text-slate-900">{sp.name}</td>
                          <td className="py-3 px-5 text-slate-600">{sp.jobTitle}</td>
                          <td className="py-3 px-5 font-mono">${centsToDollars(sp.baseSalaryCents)}</td>
                          <td className="py-3 px-5 font-mono text-teal-700 font-bold">${centsToDollars(sp.serviceCommissionCents)}</td>
                          <td className="py-3 px-5 font-mono text-blue-700 font-bold">${centsToDollars(sp.retailCommissionCents)}</td>
                          <td className="py-3 px-5 font-mono text-amber-700 font-bold">${centsToDollars(sp.cardTipsCents)}</td>
                          <td className="py-3 px-5 font-mono font-black text-slate-900 text-sm">
                            ${centsToDollars(sp.netPayCents)}
                          </td>
                          <td className="py-3 px-5">
                            {sp.status === 'paid' ? (
                              <Badge variant="success" className="text-[11px]">{t('finance.poStubPaid')}</Badge>
                            ) : (
                              <Badge variant="warning" className="text-[11px]">{t('finance.poStubPendingReview')}</Badge>
                            )}
                          </td>
                          <td className="py-3 px-5 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-teal-700 hover:text-teal-800 font-bold"
                              onClick={() => setSelectedPayStub(sp)}
                            >
                              <FileText className="w-3.5 h-3.5 mr-1" />
                              
                              {t('finance.poViewStub')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* TAB 4: 售后退款与提成冲正追溯 */}
        {activeTab === 'clawback' && (
          <div className="space-y-6">
            <Card className="border-slate-200 shadow-2xs">
              <CardHeader className="bg-slate-50/70 border-b border-slate-100 py-3.5 px-5">
                <CardTitle className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-red-600" />
                  
                  {t('finance.poClawbackTitle')}
                </CardTitle>
                <p className="text-xs text-slate-500 mt-0.5">
                  
                  {t('finance.poClawbackDesc')}
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/60 text-slate-500 font-bold">
                        <th className="py-3 px-5">{t('finance.poColRelatedOrder')}</th>
                        <th className="py-3 px-5">{t('finance.poColCustomer')}</th>
                        <th className="py-3 px-5">{t('finance.poColTherapist')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColRefundAmount')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColClawback')}</th>
                        <th className="py-3 px-5">{t('finance.poColRefundReason')}</th>
                        <th className="py-3 px-5 font-mono">{t('finance.poColProcessedAt')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {clawbackList.map((cb) => (
                        <tr key={cb.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-5 font-mono font-bold text-teal-700">{cb.ticketId}</td>
                          <td className="py-3 px-5 font-medium text-slate-800">{cb.customerName}</td>
                          <td className="py-3 px-5 font-medium text-slate-800">{cb.staffName}</td>
                          <td className="py-3 px-5 font-mono font-bold text-red-600">-${centsToDollars(cb.refundAmountCents)}</td>
                          <td className="py-3 px-5 font-mono font-black text-red-700">-${centsToDollars(cb.clawbackCommissionCents)}</td>
                          <td className="py-3 px-5 text-slate-500 max-w-xs truncate">{cb.reason}</td>
                          <td className="py-3 px-5 font-mono text-slate-400">{cb.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 工资条 Pay Stub 详情模态框 */}
        {selectedPayStub && (
          <Modal
            isOpen={Boolean(selectedPayStub)}
            onOpenChange={() => setSelectedPayStub(null)}
            size="md"
            title={t('finance.poStubModalTitle')}
            footer={
              <div className="flex justify-between items-center w-full">
                <Button variant="secondary" onClick={() => setSelectedPayStub(null)}>
                  
                  {t('finance.poStubClose')}
                </Button>
                <Button
                  onClick={() => window.print()}
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1.5"
                >
                  <Printer className="w-4 h-4" />
                  
                  {t('finance.poPrintStub')}
                </Button>
              </div>
            }
          >
            <div className="bg-white p-6 rounded-xl border border-slate-200 font-sans text-xs space-y-6">
              <div className="border-b pb-4 flex justify-between items-start">
                <div>
                  <h3 className="text-base font-bold text-slate-900">GENIE FRONT SALON & SPA</h3>
                  <p className="text-xs text-slate-500">{t('finance.poEarningsStatement')}</p>
                </div>
                <div className="text-right font-mono text-[11px] text-slate-500">
                  <p>{t('finance.poStubPeriod')}</p>
                  <p>{t('finance.poStubPayDate')}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3 rounded-lg text-slate-700">
                <div><span>{t('finance.poStubName')} </span><strong className="text-slate-900">{selectedPayStub.name}</strong></div>
                <div><span>{t('finance.poStubRole')} </span><strong>{selectedPayStub.jobTitle}</strong></div>
                <div><span>{t('finance.poStubNo')} </span><span className="font-mono">{selectedPayStub.membershipId}</span></div>
                <div><span>{t('finance.poStubMethod')} </span><span>Direct Deposit ACH</span></div>
              </div>

              <div className="space-y-2">
                <h4 className="font-bold text-slate-800 border-b pb-1">{t('finance.poEarningsDetail')}</h4>
                <div className="space-y-1 text-slate-600">
                  <div className="flex justify-between"><span>{t('finance.poBaseGuarantee')}</span><span className="font-mono font-bold">${centsToDollars(selectedPayStub.baseSalaryCents)}</span></div>
                  <div className="flex justify-between"><span>{t('finance.poServiceCommission50')}</span><span className="font-mono font-bold text-teal-700">${centsToDollars(selectedPayStub.serviceCommissionCents)}</span></div>
                  <div className="flex justify-between"><span>{t('finance.poRetailCommission10')}</span><span className="font-mono font-bold text-blue-700">${centsToDollars(selectedPayStub.retailCommissionCents)}</span></div>
                  <div className="flex justify-between"><span>{t('finance.poCardTipsLine')}</span><span className="font-mono font-bold text-amber-700">${centsToDollars(selectedPayStub.cardTipsCents)}</span></div>
                  {selectedPayStub.bonusCents > 0 && (
                    <div className="flex justify-between"><span>{t('finance.poAttendanceBonus')}</span><span className="font-mono font-bold text-emerald-700">+${centsToDollars(selectedPayStub.bonusCents)}</span></div>
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-dashed flex justify-between items-center text-sm font-bold">
                <span className="text-slate-900">{t('finance.poNetPay')}</span>
                <span className="text-xl font-mono font-black text-teal-700">
                  ${centsToDollars(selectedPayStub.netPayCents)}
                </span>
              </div>
            </div>
          </Modal>
        )}

        {/* 银行划拨批次穿透明细模态框 */}
        {selectedPayoutBatch && (
          <Modal
            isOpen={Boolean(selectedPayoutBatch)}
            onOpenChange={() => setSelectedPayoutBatch(null)}
            size="md"
            title={t('finance.poBatchDetailTitle', { p0: selectedPayoutBatch.payoutId })}
            footer={
              <Button variant="secondary" onClick={() => setSelectedPayoutBatch(null)}>
                
                {t('finance.poBatchClose')}
              </Button>
            }
          >
            <div className="space-y-4 text-xs">
              <div className="p-4 bg-slate-50 rounded-xl space-y-2">
                <div className="flex justify-between"><span>{t('finance.poBatchBank')}</span><strong className="text-slate-900">{selectedPayoutBatch.bankAccount}</strong></div>
                <div className="flex justify-between"><span>{t('finance.poBatchGross')}</span><strong className="font-mono">${centsToDollars(selectedPayoutBatch.amountCents)}</strong></div>
                <div className="flex justify-between"><span>{t('finance.poBatchFee')}</span><strong className="font-mono text-red-600">-${centsToDollars(selectedPayoutBatch.feeCents)}</strong></div>
                <div className="flex justify-between font-bold text-sm pt-2 border-t text-teal-800">
                  <span>{t('finance.poBatchNet')}</span>
                  <span className="font-mono font-black">${centsToDollars(selectedPayoutBatch.netCents)}</span>
                </div>
              </div>
              <p className="text-slate-500 text-[11px]">
                
                {t('finance.poBatchNote')}
              </p>
            </div>
          </Modal>
        )}
      </div>
    </ErrorBoundary>
  );
}