import { useState } from 'react';
import {
  Award,
  Clock,
  BarChart3,
  TrendingUp,
  Receipt,
  DollarSign,
  Calendar,
  Sparkles,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { getMockStore } from '../lib/mockData';

export function TechSummaryPage() {
  const { t } = useLanguage();
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');

  const mockStore = getMockStore();
  const { historyRecords, workbench } = mockStore;

  const earnings = workbench.earnings;

  const multiplier = period === 'today' ? 1 : period === 'week' ? 6.5 : 24;
  const totalEarned =
    ((earnings.commissionCents + earnings.tipCashCents + earnings.tipCardCents) * multiplier) / 100;
  const commissionAmt = (earnings.commissionCents * multiplier) / 100;
  const cashTipAmt = (earnings.tipCashCents * multiplier) / 100;
  const cardTipAmt = (earnings.tipCardCents * multiplier) / 100;
  const grossRevAmt = (earnings.serviceRevenueCents * multiplier) / 100;

  const trendData =
    period === 'today'
      ? [
          { day: '10:00', count: 1 },
          { day: '12:00', count: 1 },
          { day: '14:00', count: 0 },
          { day: '16:00', count: 1 },
          { day: '18:00', count: 1 },
        ]
      : period === 'week'
      ? [
          { day: 'Mon', count: 4 },
          { day: 'Tue', count: 5 },
          { day: 'Wed', count: 0 },
          { day: 'Thu', count: 6 },
          { day: 'Fri', count: 5 },
          { day: 'Sat', count: 8 },
          { day: 'Sun', count: 0 },
        ]
      : [
          { day: 'W1', count: 26 },
          { day: 'W2', count: 28 },
          { day: 'W3', count: 31 },
          { day: 'W4', count: 27 },
        ];

  return (
    <div className="space-y-3.5">
      {/* 顶部周期切换 (iOS 分段选择器质感) */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-black text-slate-900 tracking-tight">{t('navSummary')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{t('revenueComposition')}</p>
        </div>
        <div className="flex items-center bg-slate-200/70 p-1 rounded-2xl text-xs font-bold shrink-0">
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-xl transition-all ${
                period === p
                  ? 'bg-white text-slate-900 shadow-2xs font-black'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {p === 'today' ? t('todaySummary') : p === 'week' ? t('weekSummary') : t('monthSummary')}
            </button>
          ))}
        </div>
      </div>

      {/* 收益统计主卡片 */}
      <div className="p-5 bg-white rounded-3xl border border-slate-200/80 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-teal-700">
              {period === 'today' ? t('totalEarnedToday') : t('totalEarnedPeriod')}
            </span>
            <div className="text-4xl font-black tracking-tight text-slate-900 font-mono">
              ${totalEarned.toFixed(2)}
            </div>
          </div>
          <div className="w-12 h-12 rounded-2xl bg-teal-50 text-teal-700 border border-teal-200/60 flex items-center justify-center font-bold shadow-2xs">
            <Award className="w-6 h-6" />
          </div>
        </div>

        {/* 4 维收益指标网格 */}
        <div className="grid grid-cols-2 gap-2 pt-3 border-t border-slate-100 text-xs">
          <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-100 space-y-0.5">
            <span className="text-slate-500 text-[11px] font-medium">{t('commission')}</span>
            <div className="text-base font-extrabold text-teal-700 font-mono">
              ${commissionAmt.toFixed(2)}
            </div>
          </div>
          <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-100 space-y-0.5">
            <span className="text-slate-500 text-[11px] font-medium">{t('cashTip')}</span>
            <div className="text-base font-extrabold text-amber-700 font-mono">
              ${cashTipAmt.toFixed(2)}
            </div>
          </div>
          <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-100 space-y-0.5">
            <span className="text-slate-500 text-[11px] font-medium">{t('cardTip')}</span>
            <div className="text-base font-extrabold text-indigo-700 font-mono">
              ${cardTipAmt.toFixed(2)}
            </div>
          </div>
          <div className="bg-slate-50/80 p-3 rounded-2xl border border-slate-100 space-y-0.5">
            <span className="text-slate-500 text-[11px] font-medium">{t('grossRevenue')}</span>
            <div className="text-base font-extrabold text-slate-800 font-mono">
              ${grossRevAmt.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* 收益与单量可视化图表 */}
      <div className="p-4 bg-white rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center font-bold">
            <BarChart3 className="w-4 h-4" />
          </div>
          <h3 className="font-bold text-sm text-slate-900">{t('performanceChart')}</h3>
        </div>

        <div className="h-40 w-full pt-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trendData}>
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={25} />
              <Tooltip
                formatter={(val) => [`${val ?? 0} ${t('orderUnit')}`, t('ticketItem')]}
                contentStyle={{ borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', fontSize: 12 }}
              />
              <Bar dataKey="count" fill="#0d9488" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 做工明细记账清单 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1 text-xs font-extrabold text-slate-500 uppercase tracking-wider">
          <span>{t('ticketItem')}</span>
          <span className="font-mono">{t('totalServicesCount').replace('{n}', String(historyRecords.length))}</span>
        </div>

        {historyRecords.length === 0 ? (
          <div className="p-8 text-center bg-white rounded-3xl text-slate-400 text-sm border border-slate-200/80">
            {t('noHistoryRecords')}
          </div>
        ) : (
          <div className="space-y-2">
            {historyRecords.map((task) => (
              <div
                key={task.id}
                className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex items-center justify-between hover:border-slate-300 transition-colors"
              >
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900 truncate">
                      {task.serviceName}
                    </span>
                    <Badge variant="success" className="text-[10px] px-2 py-0.2 font-bold">
                      {t('serviceCompletedStatus')}
                    </Badge>
                    {task.isRequest && (
                      <Badge variant="warning" className="text-[10px] px-2 py-0.2 font-bold">
                        {t('requestedStaffGuest')}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span className="font-bold text-slate-700">{task.customerName}</span>
                    <span className="flex items-center gap-1 font-mono text-slate-500">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      {task.durationMin} {t('mins')} ({task.timeStr})
                    </span>
                  </div>
                </div>

                <div className="text-right shrink-0 pl-3">
                  <div className="text-base font-black text-teal-800 font-mono tracking-tight">
                    +${((task.commissionCents + task.tipCents) / 100).toFixed(2)}
                  </div>
                  <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{t('commissionSplit')}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
