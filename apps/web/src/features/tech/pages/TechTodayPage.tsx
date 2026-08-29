import { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Clock,
  MapPin,
  ShieldAlert,
  Play,
  CheckCircle2,
  XCircle,
  Plus,
  Coffee,
  AlertTriangle,
  UserCheck,
  Phone,
  Timer,
  ChevronDown,
  ChevronUp,
  ListOrdered,
  FlaskConical,
  DollarSign,
  TrendingUp,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { playTaskChime, playTimerCompleteChime } from '../lib/audio';
import { requestScreenWakeLock, releaseScreenWakeLock } from '../lib/wakeLock';
import { TechAddItemModal } from '../components/TechAddItemModal';
import {
  getMockStore,
  mockPunch,
  mockStartService,
  mockFinishService,
  mockDeclineTask,
  mockAssignNewTask,
  type MockTechStore,
} from '../lib/mockData';

export function TechTodayPage() {
  const { t } = useLanguage();
  const { membership } = useSession();

  const [mockStore, setMockStore] = useState<MockTechStore>(getMockStore);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  const [rotationOpen, setRotationOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState<'no_skill' | 'temporarily_busy' | 'other'>('no_skill');
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  // 1s 定时器刷新倒计时与工时
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { workbench } = mockStore;
  const currentTask = workbench.currentTask;
  const nextTask = workbench.nextTask;
  const onDuty = workbench.onDuty;
  const onBreak = workbench.onBreak;
  const workedMinutes = workbench.workedMinutes;
  const rotation = workbench.rotation;
  const standings = workbench.standings;
  const earnings = workbench.earnings;

  // 检测到新派单时播放提示音
  const lastTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentTask && currentTask.ticketItemId !== lastTaskIdRef.current) {
      if (lastTaskIdRef.current !== null && currentTask.state === 'waiting') {
        playTaskChime();
      }
      lastTaskIdRef.current = currentTask.ticketItemId;
    }
  }, [currentTask]);

  // 做工中时获取屏幕常亮锁
  useEffect(() => {
    if (currentTask?.state === 'in_service') {
      void requestScreenWakeLock();
      return () => {
        releaseScreenWakeLock();
      };
    }
    releaseScreenWakeLock();
  }, [currentTask?.state]);

  // 交互动作处理器
  const handlePunch = (kind: 'clock_in' | 'clock_out' | 'break_start' | 'break_end') => {
    const next = mockPunch(kind);
    setMockStore({ ...next });
  };

  const handleStartService = () => {
    const next = mockStartService();
    setMockStore({ ...next });
  };

  const handleFinishService = () => {
    playTimerCompleteChime();
    const next = mockFinishService();
    setMockStore({ ...next });
  };

  const handleDecline = () => {
    const next = mockDeclineTask();
    setMockStore({ ...next });
    setDeclineModalOpen(false);
  };

  const handleSimulateNewTask = (isWaiting: boolean) => {
    const next = mockAssignNewTask(isWaiting);
    setMockStore({ ...next });
    if (isWaiting) playTaskChime();
  };

  // 计算倒计时时间
  let timerDisplay = '00:00';
  let isOvertime = false;
  let progressPercent = 0;

  if (currentTask && currentTask.startedAt) {
    const startedMs = new Date(currentTask.startedAt).getTime();
    const totalDurationSec = (currentTask.durationMin || 30) * 60;
    const elapsedSec = Math.max(0, Math.floor((currentTime - startedMs) / 1000));
    const remainingSec = totalDurationSec - elapsedSec;

    if (remainingSec < 0) {
      isOvertime = true;
      const over = Math.abs(remainingSec);
      const m = String(Math.floor(over / 60)).padStart(2, '0');
      const s = String(over % 60).padStart(2, '0');
      timerDisplay = `+${m}:${s}`;
      progressPercent = 100;
    } else {
      const m = String(Math.floor(remainingSec / 60)).padStart(2, '0');
      const s = String(remainingSec % 60).padStart(2, '0');
      timerDisplay = `${m}:${s}`;
      progressPercent = Math.min(100, Math.round((elapsedSec / totalDurationSec) * 100));
    }
  }

  return (
    <div className="space-y-3.5">
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
              <Button
                size="sm"
                onClick={() => handlePunch('clock_in')}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2.5 rounded-2xl shadow-sm active:scale-95 text-xs"
              >
                <Play className="w-3.5 h-3.5 mr-1.5 fill-current" />
                {t('clockIn')}
              </Button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => handlePunch(onBreak ? 'break_end' : 'break_start')}
                  className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all active:scale-95 border ${
                    onBreak
                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Coffee className="w-3.5 h-3.5 text-amber-600" />
                  <span>{onBreak ? t('endBreak') : t('takeBreak')}</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handlePunch('clock_out')}
                  className="text-slate-600 hover:text-rose-600 hover:bg-rose-50 text-xs px-3 py-2 rounded-xl border border-slate-200 active:scale-95 font-bold"
                >
                  {t('clockOut')}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* 今日数据横幅 */}
        <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-100 text-center">
          <div className="bg-slate-50/80 py-2.5 px-1 rounded-2xl border border-slate-100 space-y-0.5">
            <div className="text-[11px] text-slate-500">{t('doneCount')}</div>
            <div className="text-base font-extrabold text-slate-900 font-mono">
              {workbench.doneCount} <span className="text-xs font-normal text-slate-500 font-sans">{t('orderUnit')}</span>
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

      {/* 2. 轮牌顺位与排牌榜折叠卡片 */}
      <div className="bg-white rounded-3xl p-4 border border-slate-200/80 shadow-xs space-y-3">
        <div
          className="flex items-center justify-between cursor-pointer"
          onClick={() => setRotationOpen(!rotationOpen)}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-teal-50 text-teal-700 border border-teal-200/60 flex items-center justify-center font-black text-sm shrink-0">
              #{rotation.position}
            </div>
            <div>
              <div className="text-xs font-bold text-slate-900 flex items-center gap-2">
                <span>{t('turnPoints')}</span>
                <span className="text-xs font-mono text-teal-700 font-black">
                  {(rotation.consumedBp / 10000).toFixed(1)} {t('turnsUnit')}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {rotation.isNextUp ? t('nextUpSoon') : `${t('totalStaffCount').replace('{n}', String(standings.length))}`}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 text-xs font-bold text-teal-700 bg-teal-50 hover:bg-teal-100/80 px-3 py-1.5 rounded-xl border border-teal-200/50 transition-colors">
            <ListOrdered className="w-3.5 h-3.5" />
            <span>{rotationOpen ? t('collapse') || '收起' : t('allStaffRotationOrder')}</span>
            {rotationOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </div>
        </div>

        {/* 展开的轮牌队列 */}
        {rotationOpen && (
          <div className="pt-2 border-t border-slate-100 space-y-2 animate-in fade-in duration-200">
            {standings.map((staff, idx) => (
              <div
                key={staff.membershipId}
                className={`p-2.5 rounded-2xl flex items-center justify-between text-xs transition-all ${
                  staff.isMe
                    ? 'bg-teal-50/80 border-2 border-teal-500 font-bold'
                    : 'bg-slate-50 border border-slate-100 text-slate-700'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`w-5 h-5 rounded-lg flex items-center justify-center font-black text-xs shrink-0 ${
                      idx === 0
                        ? 'bg-amber-500 text-white'
                        : staff.isMe
                        ? 'bg-teal-600 text-white'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <span className="truncate">{staff.name}</span>
                  {staff.isMe && (
                    <span className="text-[10px] bg-teal-600 text-white px-1.5 py-0.2 rounded-md font-semibold">
                      {t('meBadge')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="text-[11px] font-mono text-slate-500">
                    {(staff.consumedBp / 10000).toFixed(1)} {t('turnsUnit')}
                  </span>
                  <Badge
                    variant={
                      staff.state === 'in_service'
                        ? 'warning'
                        : staff.state === 'available'
                        ? 'success'
                        : 'secondary'
                    }
                    className="text-[10px] px-2 py-0.5"
                  >
                    {staff.state === 'in_service'
                      ? t('servingStatus')
                      : staff.state === 'available'
                      ? t('idleStatus')
                      : staff.state === 'on_break'
                      ? t('onBreak')
                      : t('offShiftStatus')}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
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
                {currentTask.customerName ? currentTask.customerName.slice(0, 1) : '客'}
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

          {/* 已加项目标签 */}
          {currentTask.addons && currentTask.addons.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-teal-50/70 border border-teal-200/70 text-xs space-y-2">
              <div className="font-bold text-teal-900 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-teal-700" />
                <span>{t('addServiceItem')}</span>
              </div>
              <div className="space-y-1.5">
                {currentTask.addons.map((add) => (
                  <div key={add.id} className="flex items-center justify-between text-teal-900 font-medium">
                    <span>{add.name['zh-Hans'] || add.id}</span>
                    <span className="font-mono font-bold text-teal-800">+${(add.priceCents / 100).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
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
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="ghost"
                  className="w-full text-slate-600 hover:text-rose-600 hover:bg-rose-50 border border-slate-200 font-bold text-xs py-3.5 rounded-2xl active:scale-98"
                  onClick={() => setDeclineModalOpen(true)}
                >
                  <XCircle className="w-4 h-4 mr-1.5 text-slate-400" />
                  {t('declineTask')}
                </Button>
                <Button
                  className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm py-3.5 rounded-2xl shadow-sm active:scale-98"
                  onClick={handleStartService}
                >
                  <Play className="w-4 h-4 mr-1.5 fill-current" />
                  {t('startService')}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="border border-slate-200 text-slate-700 hover:bg-slate-100 font-bold text-xs py-3.5 rounded-2xl active:scale-98"
                    onClick={() => setAddItemOpen(true)}
                  >
                    <Plus className="w-4 h-4 mr-1 text-teal-600" />
                    {t('addServiceItem')}
                  </Button>
                  <Button
                    className="col-span-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm py-3.5 rounded-2xl shadow-sm active:scale-98"
                    onClick={handleFinishService}
                  >
                    <CheckCircle2 className="w-5 h-5 mr-1.5" />
                    {t('finishService')}
                  </Button>
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

          {/* 模拟测试面板 */}
          <div className="pt-2 flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSimulateNewTask(true)}
              className="text-xs rounded-xl text-teal-700 border-teal-300 hover:bg-teal-50 font-bold"
            >
              <FlaskConical className="w-3.5 h-3.5 mr-1" />
              模拟派单 (待接单)
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSimulateNewTask(false)}
              className="text-xs rounded-xl text-slate-700 border-slate-300 hover:bg-slate-50 font-bold"
            >
              直接进入服务中
            </Button>
          </div>
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

      {/* 加项抽屉弹窗 */}
      {currentTask && (
        <TechAddItemModal
          isOpen={addItemOpen}
          onClose={() => setAddItemOpen(false)}
          ticketId={currentTask.ticketId}
          onAddSuccess={() => setMockStore(getMockStore())}
        />
      )}

      {/* 拒单 / 顺延确认弹窗 */}
      {declineModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md bg-white rounded-3xl p-5 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 text-rose-600 font-bold text-base">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>{t('declineTask')}</span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">{t('declineReason')}</p>

            <div className="space-y-2">
              {[
                { id: 'no_skill', label: t('reasonNoSkill') },
                { id: 'temporarily_busy', label: t('reasonBusy') },
                { id: 'other', label: t('reasonGuest') },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDeclineReason(opt.id as typeof declineReason)}
                  className={`w-full p-3.5 rounded-2xl border text-left text-xs font-bold flex items-center justify-between transition-all ${
                    declineReason === opt.id
                      ? 'border-rose-500 bg-rose-50 text-rose-900 ring-1 ring-rose-500 shadow-xs'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span>{opt.label}</span>
                  {declineReason === opt.id && <CheckCircle2 className="w-4 h-4 text-rose-600" />}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="ghost"
                className="flex-1 rounded-2xl font-bold"
                onClick={() => setDeclineModalOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                className="flex-1 bg-rose-600 hover:bg-rose-700 text-white rounded-2xl font-bold shadow-md"
                onClick={handleDecline}
              >
                {t('confirmDecline')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
