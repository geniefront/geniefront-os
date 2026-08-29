import { Award, Clock } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { Badge } from '@/components/ui/Badge';
import { PageError, PageLoading } from '@/components/ui/QueryState';
import { useTechTodayQuery } from '../api';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function TechSummaryPage() {
  const { t } = useLanguage();
  const todayQuery = useTechTodayQuery();

  if (todayQuery.isPending) {
    return <PageLoading title={t('loadingWorkbench')} className="min-h-[55vh]" />;
  }
  if (todayQuery.isError || !todayQuery.data) {
    return <PageError error={todayQuery.error} onRetry={() => void todayQuery.refetch()} className="min-h-[55vh]" />;
  }

  const { earnings, tasks, businessDate } = todayQuery.data;
  const completed = tasks.filter((task) => task.state === 'done');

  return (
    <div className="space-y-3.5">
      <div>
        <h2 className="text-xl font-black tracking-tight text-slate-900">{t('navSummary')}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{businessDate} · {t('todaySummary')}</p>
      </div>

      <div className="space-y-4 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-teal-700">
              {t('totalEarnedToday')}
            </span>
            <div className="font-mono text-4xl font-black tracking-tight text-slate-900">
              {dollars(earnings.payCents)}
            </div>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-teal-200/60 bg-teal-50 text-teal-700 shadow-2xs">
            <Award className="h-6 w-6" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-xs">
          {([
            { label: t('commission'), amount: earnings.commissionCents, color: 'text-teal-700' },
            { label: t('cashTip'), amount: earnings.tipCashCents, color: 'text-amber-700' },
            { label: t('cardTip'), amount: earnings.tipCardCents, color: 'text-indigo-700' },
            { label: t('grossRevenue'), amount: earnings.serviceRevenueCents, color: 'text-slate-800' },
          ] satisfies Array<{ label: string; amount: number; color: string }>).map((metric) => (
            <div key={metric.label} className="space-y-0.5 rounded-2xl border border-slate-100 bg-slate-50/80 p-3">
              <span className="text-[11px] font-medium text-slate-500">{metric.label}</span>
              <div className={`font-mono text-base font-extrabold ${metric.color}`}>
                {dollars(metric.amount)}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="font-bold">{t('cashOwed')}</div>
          <div className="mt-0.5 font-mono text-lg font-black">{dollars(earnings.cashTipOwedCents)}</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between px-1 text-xs font-extrabold uppercase tracking-wider text-slate-500">
          <span>{t('ticketItem')}</span>
          <span className="font-mono">{t('totalServicesCount').replace('{n}', String(completed.length))}</span>
        </div>

        {completed.length === 0 ? (
          <div className="rounded-3xl border border-slate-200/80 bg-white p-8 text-center text-sm text-slate-400">
            {t('noHistoryRecords')}
          </div>
        ) : (
          <div className="space-y-2">
            {completed.map((task) => (
              <div key={task.ticketItemId} className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold text-slate-900">{task.serviceName}</span>
                    <Badge variant="success" className="px-2 py-0.5 text-[10px] font-bold">
                      {t('serviceCompletedStatus')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="font-bold text-slate-700">{task.customerName}</span>
                    <span className="flex items-center gap-1 font-mono">
                      <Clock className="h-3.5 w-3.5 text-slate-400" />
                      {task.durationMin} {t('mins')}
                    </span>
                  </div>
                </div>
                {task.isRequest && (
                  <Badge variant="warning" className="ml-2 px-2 py-0.5 text-[10px] font-bold">
                    {t('requestedStaffGuest')}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
