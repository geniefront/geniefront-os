import type { ReactNode } from 'react';
import { RefreshCw, Download, Users, Banknote, RotateCcw, Info } from 'lucide-react';
import { toast } from '@heroui/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useDayCloseQuery } from '@/features/dayclose/api';
import { useEarningsEstimatesQuery, useClawbacksQuery } from '@/features/payouts/api';
import { centsToDollars } from '@/features/checkout/api';
import { exportToCSV } from '@/lib/exportUtils';
import { useLanguage } from '@/LanguageContext';

export function Payouts() {
  const { t } = useLanguage();
  const dayClose = useDayCloseQuery();
  const estimates = useEarningsEstimatesQuery();
  const clawbacks = useClawbacksQuery();
  const rows = estimates.data?.rows ?? [];
  const tips = dayClose.data?.tipPayouts ?? [];
  const adjustments = clawbacks.data?.rows ?? [];
  const isLoading = dayClose.isLoading || estimates.isLoading || clawbacks.isLoading;
  const estimateTotal = rows.reduce((sum, row) => sum + row.netPayCents, 0);
  const commissionTotal = rows.reduce((sum, row) => sum + row.serviceCommissionCents, 0);
  const recordedTips = tips.reduce((sum, row) => sum + row.alreadyPaidCents, 0);

  const refresh = () => {
    void Promise.all([dayClose.refetch(), estimates.refetch(), clawbacks.refetch()]);
    toast.success(t('finance.recordRefreshed'));
  };

  if (isLoading && !estimates.data && !dayClose.data) {
    return <PageLoading layout="table" title={t('finance.recordLoading')} description={t('finance.recordLoadingDesc')} />;
  }
  if ((estimates.isError || dayClose.isError) && !estimates.data && !dayClose.data) {
    return <PageError title={t('finance.recordLoadError')} error={estimates.error || dayClose.error} onRetry={refresh} />;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 pb-24">
      <PageHeader
        title={t('finance.recordTitle')}
        description={t('finance.recordSubtitle')}
        actions={(
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={refresh} disabled={isLoading}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />{t('finance.poRefresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              onClick={() => exportToCSV(
                'earnings-estimates',
                [
                  t('finance.payoutsExportStaff'), t('finance.payoutsExportJobTitle'), t('finance.payoutsExportServiceSales'),
                  t('finance.payoutsExportCommission'), t('finance.payoutsExportCardTips'), t('finance.payoutsExportNetPay'),
                ],
                rows.map((row) => [row.name, row.jobTitle, centsToDollars(row.serviceSalesCents),
                  centsToDollars(row.serviceCommissionCents), centsToDollars(row.cardTipsCents),
                  centsToDollars(row.netPayCents)]),
              )}
            >
              <Download className="mr-1.5 h-4 w-4" />{t('finance.recordExport')}
            </Button>
          </div>
        )}
      />

      <div className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
        <div>
          <p className="font-bold">{t('finance.recordNoticeTitle')}</p>
          <p className="mt-1 text-blue-800">{t('finance.recordNotice')}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <SummaryCard icon={<Users className="h-4 w-4" />} label={t('finance.recordEstimate14d')} cents={estimateTotal} />
        <SummaryCard icon={<Banknote className="h-4 w-4" />} label={t('finance.recordCommission')} cents={commissionTotal} />
        <SummaryCard icon={<Banknote className="h-4 w-4" />} label={t('finance.recordCashTips')} cents={recordedTips} />
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" />{t('finance.recordEstimateTitle')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? <EmptyState icon={<Users />} title={t('finance.recordEmpty')} description={t('finance.recordEmptyDesc')} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-y bg-slate-50 text-xs text-slate-500"><tr>
                  <th className="px-5 py-3">{t('finance.recordStaff')}</th><th className="px-5 py-3">{t('finance.recordServiceSales')}</th>
                  <th className="px-5 py-3">{t('finance.recordCommissionEstimate')}</th><th className="px-5 py-3">{t('finance.recordCardTips')}</th>
                  <th className="px-5 py-3">{t('finance.recordTotalEstimate')}</th><th className="px-5 py-3">{t('finance.recordNature')}</th>
                </tr></thead>
                <tbody className="divide-y">{rows.map((row) => <tr key={row.membershipId}>
                  <td className="px-5 py-3"><p className="font-semibold">{row.name}</p><p className="text-xs text-slate-500">{row.jobTitle}</p></td>
                  <Money cents={row.serviceSalesCents} /><Money cents={row.serviceCommissionCents} />
                  <Money cents={row.cardTipsCents} /><Money cents={row.netPayCents} strong />
                  <td className="px-5 py-3"><Badge variant="secondary">{t('finance.recordNotPayroll')}</Badge></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Banknote className="h-4 w-4" />{t('finance.recordTipsTitle')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {tips.length === 0 ? <EmptyState icon={<Banknote />} title={t('finance.recordTipsEmpty')} description={t('finance.recordTipsEmptyDesc')} /> : (
            <div className="divide-y">{tips.map((tip) => <div key={tip.membershipId} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="font-semibold">{tip.name}</span><span className="font-mono">{t('finance.recordRecorded')} ${centsToDollars(tip.alreadyPaidCents)}</span>
            </div>)}</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><RotateCcw className="h-4 w-4" />{t('finance.recordAdjustmentsTitle')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {adjustments.length === 0 ? <EmptyState icon={<RotateCcw />} title={t('finance.recordAdjustmentsEmpty')} description={t('finance.recordAdjustmentsEmptyDesc')} /> : (
            <div className="divide-y">{adjustments.map((item) => <div key={item.id} className="grid gap-2 px-5 py-3 text-sm md:grid-cols-4">
              <span className="font-semibold">{item.staffName}</span><span>{item.customerName}</span>
              <span className="text-red-700">-${centsToDollars(item.clawbackCommissionCents)}</span><span className="text-slate-500">{item.reason}</span>
            </div>)}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ icon, label, cents }: { icon: ReactNode; label: string; cents: number }) {
  return <Card><CardContent className="p-5"><div className="flex items-center gap-2 text-sm text-slate-500">{icon}{label}</div><p className="mt-2 font-mono text-2xl font-black">${centsToDollars(cents)}</p></CardContent></Card>;
}

function Money({ cents, strong = false }: { cents: number; strong?: boolean }) {
  return <td className={`px-5 py-3 font-mono ${strong ? 'font-black text-teal-700' : ''}`}>${centsToDollars(cents)}</td>;
}
