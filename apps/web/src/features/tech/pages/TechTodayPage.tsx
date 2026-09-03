import { useState, useEffect } from 'react';
import {
  Sparkles,
  Clock,
  MapPin,
  ShieldAlert,
  Play,
  CheckCircle2,
  Coffee,
  UserCheck,
  Phone,
  Timer,
  ListOrdered,
  RefreshCw,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { PageError, PageLoading } from '@/components/ui/QueryState';
import { useErrorMessage } from '@/lib/errorMessage';
import { playTimerCompleteChime, unlockTechAudio } from '../lib/audio';
import { requestScreenWakeLock, releaseScreenWakeLock } from '../lib/wakeLock';
import { readTechWakeLockEnabled } from '../lib/preferences';
import {
  useTechFinishServiceMutation,
  useTechDirectCashTipMutation,
  useTechPunchMutation,
  useTechStartServiceMutation,
  useTechTodayQuery,
} from '../api';
import type { PunchKind } from '../types';
import { selectTechTaskCards, serviceTimerView } from '../lib/viewModel';

export function TechTodayPage() {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();
  const todayQuery = useTechTodayQuery();
  const punchMutation = useTechPunchMutation();
  const startMutation = useTechStartServiceMutation();
  const finishMutation = useTechFinishServiceMutation();
  const directTipMutation = useTechDirectCashTipMutation();
  const [tipEditorItemId, setTipEditorItemId] = useState<string | null>(null);
  const [tipDollars, setTipDollars] = useState('');
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  // 1s 定时器刷新倒计时与工时
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const snapshot = todayQuery.data;
  const { primary: currentTask, next: nextTask } = snapshot
    ? selectTechTaskCards(snapshot)
    : { primary: null, next: null };
  const onDuty = snapshot?.onDuty ?? false;
  const onBreak = snapshot?.rotation.onBreak ?? false;
  const workedMinutes = snapshot?.workedMinutes ?? 0;
  const rotation = snapshot?.rotation ?? { position: null, isNextUp: false, onBreak: false };
  const earnings = snapshot?.earnings ?? {
    commissionCents: 0,
    tipCashCents: 0,
    tipCardCents: 0,
    cashTipOwedCents: 0,
    serviceRevenueCents: 0,
    payCents: 0,
  };

  // 做工中时获取屏幕常亮锁
  useEffect(() => {
    if (currentTask?.state === 'in_service' && readTechWakeLockEnabled()) {
      void requestScreenWakeLock();
      return () => {
        releaseScreenWakeLock();
      };
    }
    releaseScreenWakeLock();
  }, [currentTask?.state]);

  // 交互动作处理器
  const handlePunch = (kind: PunchKind) => {
    void unlockTechAudio();
    punchMutation.mutate(kind);
  };

  const handleStartService = () => {
    void unlockTechAudio();
    if (currentTask) startMutation.mutate(currentTask.ticketItemId);
  };

  const handleFinishService = () => {
    void unlockTechAudio();
    if (!currentTask) return;
    finishMutation.mutate(currentTask.ticketItemId, {
      onSuccess: () => playTimerCompleteChime(),
    });
  };

  if (todayQuery.isPending) {
    return <PageLoading title={t('loadingWorkbench')} className="min-h-[55vh]" />;
  }

  if (todayQuery.isError || !snapshot) {
    return (
      <PageError
        error={todayQuery.error}
        onRetry={() => void todayQuery.refetch()}
        className="min-h-[55vh]"
      />
    );
  }

  const actionError = punchMutation.error ?? startMutation.error ?? finishMutation.error ?? directTipMutation.error;
  const actionPending = punchMutation.isPending || startMutation.isPending || finishMutation.isPending || directTipMutation.isPending;

  const saveDirectTip = (ticketItemId: string) => {
    const normalized = tipDollars.trim().replace(/^\$/, '');
    if (!/^\d{1,4}(?:\.\d{0,2})?$/.test(normalized)) return;
    const [whole = '0', fraction = ''] = normalized.split('.');
    const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    directTipMutation.mutate({ ticketItemId, amountCents }, {
      onSuccess: () => {
        setTipEditorItemId(null);
        setTipDollars('');
      },
    });
  };

  // 计算倒计时时间
  const timer = serviceTimerView(
    currentTask?.startedAt ?? null,
    currentTask?.durationMin ?? 30,
    currentTime,
  );
  const timerDisplay = timer.display;
  const isOvertime = timer.overtime;
  const progressPercent = timer.progressPercent;

  return (
    <div className="space-y-3.5">
      {actionError && (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-800">
          {errorMessage(actionError)}
        </div>
      )}
      {/* 1. 考勤打卡与今日做工概览卡片 */}
      <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/80 shadow-xs space-y-4">
        <div className="flex items-center justify-between gap-3">
          {/* 左侧：工时展示 */}
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  onDuty ? (onBreak ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-slate-400'
                }`}
              />
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                {onDuty ? (onBreak ? t('onBreak') : t('onDuty')) : t('offDuty')}
              </span>
            </div>
            <div className="text-2xl font-black text-slate-900 tracking-tight flex items-baseline gap-1.5 font-mono">
              <span>{Math.floor(workedMinutes / 60)}h {workedMinutes % 60}m</span>
              <span className="text-xs font-normal text-slate-400 font-sans">{t('workedTime')}</span>
            </div>
          </div>

          {/* 右侧：打卡操作按钮 */}
          <div className="flex items-center gap-2">
            {!onDuty ? (
              <GuardedButton
                permission="timeclock.punch_self"
                size="sm"
                onClick={() => handlePunch('clock_in')}
                isDisabled={actionPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2.5 rounded-2xl shadow-sm active:scale-95 text-xs"
              >
                <Play className="w-3.5 h-3.5 mr-1.5 fill-current" />
                {t('clockIn')}
              </GuardedButton>
            ) : (
              <>
                <GuardedButton
                  permission="timeclock.punch_self"
                  onClick={() => handlePunch(onBreak ? 'break_end' : 'break_start')}
                  isDisabled={actionPending}
                  className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all active:scale-95 border ${
                    onBreak
                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Coffee className="w-3.5 h-3.5 text-amber-600" />
                  <span>{onBreak ? t('endBreak') : t('takeBreak')}</span>
                </GuardedButton>
                <GuardedButton
                  permission="timeclock.punch_self"
                  variant="ghost"
                  size="sm"
                  onClick={() => handlePunch('clock_out')}
                  isDisabled={actionPending}
                  className="text-slate-600 hover:text-rose-600 hover:bg-rose-50 text-xs px-3 py-2 rounded-xl border border-slate-200 active:scale-95 font-bold"
                >
                  {t('clockOut')}
                </GuardedButton>
              </>
            )}
          </div>
        </div>

        {/* 今日数据横幅 */}
        <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-100 text-center">
          <div className="bg-slate-50/80 py-2.5 px-1 rounded-2xl border border-slate-100 space-y-0.5">
            <div className="text-[11px] text-slate-500">{t('doneCount')}</div>
            <div className="text-base font-extrabold text-slate-900 font-mono">
              {snapshot.doneCount} <span className="text-xs font-normal text-slate-500 font-sans">{t('orderUnit')}</span>
            </div>
          </div>
          <div className="bg-slate-50/80 py-2.5 px-1 rounded-2xl border border-slate-100 space-y-0.5">
            <div className="text-[11px] text-slate-500">{t('estEarnings')}</div>
            <div className="text-base font-extrabold text-teal-700 font-mono">
              ${((earnings.commissionCents + earnings.tipCashCents + earnings.tipCardCents) / 100).toFixed(0)}
            </div>
          </div>
          <div className="bg-slate-50/80 py-2.5 px-1 rounded-2xl border border-slate-100 space-y-0.5">
            <div className="text-[11px] text-slate-500">{t('cashOwed')}</div>
            <div className="text-base font-extrabold text-amber-700 font-mono">
              ${(earnings.cashTipOwedCents / 100).toFixed(0)}
            </div>
          </div>
        </div>
      </div>

      {/* 2. 轮牌顺位。完整队列属于前台运营数据，技师快照只返回本人位置。 */}
      <div className="bg-white rounded-3xl p-4 border border-slate-200/80 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-teal-50 text-teal-700 border border-teal-200/60 flex items-center justify-center font-black text-sm shrink-0">
              {rotation.position === null ? '—' : `#${rotation.position}`}
            </div>
            <div>
              <div className="text-xs font-bold text-slate-900 flex items-center gap-2">
                <span>{t('rotationPosition')}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {rotation.isNextUp ? t('nextUpSoon') : t('stayReadyPrompt').replace('{pos}', String(rotation.position ?? '-'))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-xs font-bold text-teal-700 bg-teal-50 px-3 py-1.5 rounded-xl border border-teal-200/50">
            <ListOrdered className="w-3.5 h-3.5" />
            <span>{rotation.isNextUp ? t('isNextUp') : t('rotationPosition')}</span>
          </div>
        </div>
      </div>

      {/* 3. 核心卡片：当前任务 (Active / Waiting Task) */}
      {currentTask ? (
        <div className="overflow-hidden border-2 border-teal-500/40 shadow-sm rounded-3xl bg-white space-y-4 p-5">
          {/* 卡片头部：状态与房间工位 */}
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-teal-800 bg-teal-50 border border-teal-200/60 px-2.5 py-0.5 rounded-lg">
                  {currentTask.state === 'waiting' ? t('newAssignment') : t('activeService')}
                </span>
                {currentTask.isRequest && (
                  <Badge variant="warning" className="text-[10px] px-2 py-0.5 font-bold">
                    {t('requestedStaffGuest')}
                  </Badge>
                )}
              </div>
              <h2 className="text-xl font-black text-slate-900 tracking-tight">{currentTask.serviceName}</h2>
            </div>

            {currentTask.resourceName && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-slate-100 border border-slate-200/60 text-slate-800 text-xs font-bold shrink-0">
                <MapPin className="w-3.5 h-3.5 text-teal-600" />
                <span>{currentTask.resourceName}</span>
              </div>
            )}
          </div>

          {/* 客户信息 (脱敏隐私保护) */}
          <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 border border-slate-200/60 text-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-teal-600 text-white font-black flex items-center justify-center text-sm shadow-xs">
                {currentTask.customerName ? currentTask.customerName.slice(0, 1) : t('customer').slice(0, 1)}
              </div>
              <div>
                <span className="font-bold text-slate-900">{currentTask.customerName || t('walkInGuest')}</span>
                {currentTask.customerPhone && (
                  <div className="text-xs text-slate-500 font-mono flex items-center gap-1 mt-0.5">
                    <Phone className="w-3 h-3 text-slate-400" />
                    <span>{currentTask.customerPhone}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="text-right text-xs text-slate-500">
              <span className="font-bold text-slate-800 text-sm font-mono">
                {currentTask.durationMin} <span className="text-xs font-normal text-slate-500 font-sans">{t('mins')}</span>
              </span>
              <div className="text-[11px] text-slate-400">{t('serviceDuration')}</div>
            </div>
          </div>

          {/* 重点：健康安全禁忌提示 (红底置顶高亮) */}
          {currentTask.alerts && currentTask.alerts.length > 0 && (
            <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200/80 text-rose-900 space-y-2 animate-in fade-in duration-200">
              <div className="flex items-center gap-2 font-bold text-xs text-rose-800">
                <ShieldAlert className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{t('safetyAlerts')}</span>
              </div>
              <ul className="list-disc list-inside text-xs space-y-1 font-medium text-rose-850 pl-1 leading-relaxed">
                {currentTask.alerts.map((alert, idx) => (
                  <li key={idx}>{alert}</li>
                ))}
              </ul>
            </div>
          )}

          {currentTask.details.length > 0 && (
            <dl className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
              {currentTask.details.map((detail) => (
                <div key={detail.key} className="flex items-start justify-between gap-4">
                  <dt className="text-slate-500">{detail.label}</dt>
                  <dd className="text-right font-semibold text-slate-900">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* 大屏服务倒计时器 (如果是 in_service 状态) */}
          {currentTask.state === 'in_service' && (
            <div className="py-5 flex flex-col items-center justify-center bg-slate-900 rounded-3xl text-white shadow-inner relative overflow-hidden border border-slate-800">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1 flex items-center gap-1.5">
                <Timer className="w-4 h-4 text-teal-400" />
                <span>{isOvertime ? t('overtime') : t('remainingTime')}</span>
              </div>
              <div
                className={`text-5xl font-black font-mono tracking-wider tabular-nums ${
                  isOvertime ? 'text-rose-400 animate-pulse' : 'text-teal-400'
                }`}
              >
                {timerDisplay}
              </div>

              {/* 进度条 */}
              <div className="w-4/5 h-2 bg-slate-800 rounded-full mt-4 overflow-hidden p-0.5">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ${
                    isOvertime ? 'bg-rose-500' : 'bg-gradient-to-r from-teal-500 to-emerald-400'
                  }`}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* 底部交互动作栏 */}
          <div className="pt-2 flex flex-col gap-2.5">
            {currentTask.state === 'waiting' ? (
              <div>
                <GuardedButton
                  permission="ticket.write"
                  className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm py-4 rounded-2xl shadow-sm active:scale-98"
                  onClick={handleStartService}
                  isDisabled={actionPending || !onDuty || onBreak}
                >
                  <Play className="w-4 h-4 mr-1.5 fill-current" />
                  {t('startService')}
                </GuardedButton>
              </div>
            ) : (
              <div className="space-y-2">
                <div>
                  <GuardedButton
                    permission="ticket.write"
                    className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm py-4 rounded-2xl shadow-sm active:scale-98"
                    onClick={handleFinishService}
                    isDisabled={actionPending}
                  >
                    <CheckCircle2 className="w-5 h-5 mr-1.5" />
                    {t('finishService')}
                  </GuardedButton>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* 空闲等待卡片 */
        <div className="p-8 text-center bg-white rounded-3xl shadow-xs border border-slate-200/80 space-y-4">
          <div className="w-16 h-16 rounded-3xl bg-teal-50 text-teal-600 flex items-center justify-center mx-auto shadow-inner border border-teal-100">
            <Sparkles className="w-8 h-8" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-lg font-bold text-slate-900 tracking-tight">{t('noActiveTask')}</h3>
            <p className="text-xs text-slate-500 max-w-xs mx-auto leading-relaxed">
              {onDuty
                ? t('stayReadyPrompt').replace('{pos}', String(rotation.position ?? '-'))
                : t('clockInPrompt')}
            </p>
          </div>

          <Button variant="outline" size="sm" onClick={() => void todayQuery.refetch()} className="mx-auto rounded-xl text-xs font-bold">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('refresh')}
          </Button>
        </div>
      )}

      {/* 下一位排队客人预览 */}
      {nextTask && (
        <div className="p-4 bg-white rounded-2xl border border-slate-200/80 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium mb-1.5">
            <span className="flex items-center gap-1.5 font-bold text-slate-700">
              <UserCheck className="w-4 h-4 text-indigo-600" />
              {t('nextUpGuest')}
            </span>
            <span className="font-mono">{nextTask.durationMin} {t('mins')}</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="font-bold text-slate-900 text-sm">{nextTask.serviceName}</div>
            <div className="text-xs font-semibold text-slate-600">{nextTask.customerName}</div>
          </div>
        </div>
      )}

      {snapshot.tasks.filter((task) => task.state === 'done').length > 0 && (
        <div className="space-y-2 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <h3 className="text-sm font-black text-slate-900">{t('completedServicesAndTips')}</h3>
          {snapshot.tasks.filter((task) => task.state === 'done').map((task) => (
            <div key={task.ticketItemId} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-slate-900">{task.serviceName}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{task.customerName}</div>
                </div>
                <Badge
                  variant={task.tip.status === 'settled' || task.tip.status === 'received_direct' ? 'success' : task.tip.status === 'awaiting_payout' ? 'warning' : 'secondary'}
                  className="shrink-0 text-[10px]"
                >
                  {t(`tipStatus_${task.tip.status}`)}
                </Badge>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2">
                <span className="text-[11px] text-slate-500">
                  {t('directCashReceived')}: ${(task.tip.directCashCents / 100).toFixed(2)}
                </span>
                {task.tip.editable && (
                  <button
                    type="button"
                    onClick={() => {
                      setTipEditorItemId(task.ticketItemId);
                      setTipDollars((task.tip.directCashCents / 100).toFixed(2));
                    }}
                    className="text-[11px] font-bold text-teal-700"
                  >
                    {t('editDirectCashTip')}
                  </button>
                )}
              </div>
              {tipEditorItemId === task.ticketItemId && (
                <div className="mt-2 flex gap-2">
                  <label className="flex flex-1 items-center rounded-xl border border-slate-300 bg-white px-3">
                    <span className="text-xs font-bold text-slate-500">$</span>
                    <input
                      inputMode="decimal"
                      value={tipDollars}
                      onChange={(event) => setTipDollars(event.target.value)}
                      aria-label={t('directCashTipAmount')}
                      className="min-w-0 flex-1 bg-transparent px-1 py-2 text-sm font-bold outline-none"
                    />
                  </label>
                  <Button size="sm" onClick={() => saveDirectTip(task.ticketItemId)} isDisabled={directTipMutation.isPending}>
                    {t('save')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setTipEditorItemId(null)}>
                    {t('cancel')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] leading-relaxed text-slate-400">{t('directCashTipAuditHint')}</p>
        </div>
      )}

    </div>
  );
}
