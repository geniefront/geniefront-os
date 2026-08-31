/**
 * 日程表。
 *
 * ── 关于这一页里的数字 z-index ──────────────────────────────────────────────
 * 这页内部还留着 `z-10`…`z-50`（时间轴、列头、当前时间线、卡片叠放）。它们**是安全的**，
 * 因为 `<main>` 开了 `isolation: isolate`，整页自成一个层叠上下文 —— 这些数字只在
 * 这一页内部比较大小，压不到顶栏、侧栏和抽屉。
 *
 * 但反过来也成立：这页里 `position: fixed` 的全屏弹窗**必须**包 `<Portal>` 送到 body，
 * 否则会被关在这一层里，盖不住应用外壳。四个弹窗都已经这么处理了。
 *
 * 跨页面的浮层（下拉、抽屉、弹窗、提示条）一律用 index.css 里的语义层级
 * （`z-dropdown` / `z-drawer` / `z-modal` / `z-toast`），别在这里发明新的数字。
 */
import { useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useLanguage } from '@/LanguageContext';
import {
  useSchedule, useScheduleMutations, useWeekItems, UNASSIGNED_STAFF_ID, serviceColor,
} from '@/context/ScheduleContext';
import type { ScheduleItem } from '@/context/ScheduleContext';
import type { DayService, CancelReason } from '@/features/schedule/types';
import { CANCEL_REASONS } from '@/features/schedule/types';
import {
  isOverridableConflict, OVERRIDE_REASONS, type Override,
} from '@/features/schedule/api';
import { formatWallTime, instantToWallDate, instantToWallMinutes, wallMinutesToInstant } from '@/lib/time';
import { gridBounds } from '@/features/schedule/gridBounds';
import { useDaysRange } from '@/features/schedule/api';
import { useCanWrite } from '@/lib/permissions';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { Search } from 'lucide-react';
import { toast, Spinner } from '@heroui/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { formatI18n } from '@/lib/utils';

/** 放行原因与取消原因的文案映射。取值与服务端枚举一一对应，不得增删。 */
const OVERRIDE_REASON_LABELS = {
  guest_requested: 'overrideGuestRequested',
  staff_on_break: 'overrideStaffOnBreak',
  desk_coordination: 'overrideDeskCoordination',
  walk_in_stacking: 'overrideWalkInStacking',
  other: 'overrideOther',
} as const;

const CANCEL_REASON_LABELS = {
  duplicate_booking: 'reasonDuplicate',
  walk_out: 'reasonWalkOut',
  guest_changed_mind: 'reasonChangedMind',
  input_error: 'reasonInputError',
  no_show: 'reasonNoShow',
  other: 'reasonOther',
} as const;

import { Button } from '@/components/ui/Button';
import { Portal } from '@/components/ui/Portal';
import type { TranslationKey } from '@/i18n';

/** 周一到周日。顺序写死是因为这一页的周视图从周一起，不跟随 locale */
const WEEKDAY_KEYS: TranslationKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
import {
  Plus,
  ChevronLeft,
  X,
  ChevronRight,
  Clock,
  Users,
  Scissors,
  AlertTriangle,
  CheckCircle,
  Trash2,
  HelpCircle,
  Calendar,
} from 'lucide-react';

const timeToMins = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const minsToTime = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

const PIXELS_PER_MIN = 2;


function ScheduleContent() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { openAppointment, openCreateAppointment } = useOutletContext<{
    setRightDrawerOpen: (open: boolean) => void;
    openAppointment?: (id?: string | null) => void;
    openCreateAppointment?: (options?: {
      defaultDate?: string;
      defaultStaffId?: string;
      defaultTime?: string;
      defaultCustomerName?: string;
      defaultPhone?: string;
      defaultServiceId?: string;
    }) => void;
  }>();
  const { t, language } = useLanguage();
  const {
    services, staff, items, currentDate, setCurrentDate,
    isLoading, error: dayError, refetch, timezone, openMin: storeOpenMin, closeMin: storeCloseMin,
  } = useSchedule();
  const { create, reschedule, cancel } = useScheduleMutations();

  useEffect(() => {
    const linkedAppointmentId = searchParams.get('appointmentId');
    if (!linkedAppointmentId || !openAppointment) return;
    openAppointment(linkedAppointmentId);
    const next = new URLSearchParams(searchParams);
    next.delete('appointmentId');
    setSearchParams(next, { replace: true });
  }, [openAppointment, searchParams, setSearchParams]);

  /*
   * 写操作可用性。同时考虑权限与网络状态：
   * 断网期间不提供写入口（本系统不做离线写入队列，请求必然失败），
   * 无权限时同样禁用 —— 按角色推断会得到「亮着但点下去 403」的按钮。
   */
  const canWriteAppointment = useCanWrite('appointment.write');
  
  const [view, setView] = useState<'overview' | 'week' | 'month'>('overview');
  const [showStaffColumns, setShowStaffColumns] = useState(true);
  const [filterStaffId, setFilterStaffId] = useState('all');
  const [filterRole, setFilterRole] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedMonthDate, setExpandedMonthDate] = useState<string | null>(null);

  // 预约项目容错模糊搜索过滤
  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return items;
    return fuzzySearch(items, searchQuery, {
      keys: [
        { name: 'customerName', weight: 0.5 },
        { name: 'customerPhone', weight: 0.3 },
        { name: 'serviceName', weight: 0.3 },
      ],
      threshold: 0.45,
    });
  }, [items, searchQuery]);

  
  const parseLocal = (ds: string) => {
    if (!ds) return new Date();
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const getWeekDays = (dateStr: string) => {
    const d = parseLocal(dateStr);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    const days = [];
    for(let i=0; i<7; i++) {
      const x = new Date(d);
      x.setDate(x.getDate() + i);
      const y = x.getFullYear();
      const m = String(x.getMonth()+1).padStart(2,'0');
      const dS = String(x.getDate()).padStart(2,'0');
      days.push(`${y}-${m}-${dS}`);
    }
    return days;
  };

  const getMonthDays = (dateStr: string) => {
    const d = parseLocal(dateStr);
    const year = d.getFullYear();
    const month = d.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    
    const startWeekDay = firstDay.getDay() || 7;
    for(let i=1; i<startWeekDay; i++) {
      days.push(null);
    }
    
    for(let i=1; i<=lastDay.getDate(); i++) {
      const x = new Date(year, month, i);
      const y = x.getFullYear();
      const m = String(x.getMonth()+1).padStart(2,'0');
      const dS = String(x.getDate()).padStart(2,'0');
      days.push(`${y}-${m}-${dS}`);
    }
    return days;
  };

  const weekDays = React.useMemo(() => getWeekDays(currentDate), [currentDate]);

  /*
   * 周视图的多日数据。仅在处于周视图时请求，其余视图传空数组避免无谓往返。
   *
   * ⚠️ 月视图未接入：服务端目前只有单日接口，按月拉取需要 30 余次并行请求，
   * 在门店网络下会明显拖慢首屏。需服务端补出区间接口后再启用。
   */
  /*
   * 时间轴范围由营业时间与当日实际单据共同决定，不使用固定常量。
   * 详见 gridBounds 的说明：写死范围会静默裁掉范围外的单据。
   */
  const { start: DAY_START, end: DAY_END } = React.useMemo(
    () => gridBounds(storeOpenMin, storeCloseMin, items),
    [storeOpenMin, storeCloseMin, items],
  );

  const weekItemsByDate = useWeekItems(view === 'week' ? weekDays : []);

  const viewItems = React.useMemo(
    () => (view === 'week' ? [...weekItemsByDate.values()].flat() : items),
    [view, weekItemsByDate, items],
  );
  const monthDays = React.useMemo(() => getMonthDays(currentDate), [currentDate]);

  /*
   * 月视图的按日聚合。一次请求覆盖整个日历网格，不逐日拉取完整快照 ——
   * 后者是上百次查询，且返回的员工 / 项目 / 房间在格子上完全用不到。
   * 点进某一天时才请求该日的完整快照。
   */
  const monthRange = React.useMemo(() => {
    const real = monthDays.filter((d): d is string => d !== null);
    return { from: real[0] ?? '', to: real[real.length - 1] ?? '' };
  }, [monthDays]);
  const monthSummary = useDaysRange(
    view === 'month' ? monthRange.from : '',
    view === 'month' ? monthRange.to : '',
  );
  /** 当月单日最大项目数，作为密度条的基准。 */
  const maxMonthItems = React.useMemo(
    () => Math.max(0, ...(monthSummary.data?.days ?? []).map((d) => d.items)),
    [monthSummary.data],
  );

  const summaryByDate = React.useMemo(
    () => new Map((monthSummary.data?.days ?? []).map((d) => [d.businessDate, d])),
    [monthSummary.data],
  );

  const handlePrev = () => {
    const d = parseLocal(currentDate);
    if (view === 'month') d.setMonth(d.getMonth() - 1);
    else if (view === 'week') d.setDate(d.getDate() - 7);
    else d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dS = String(d.getDate()).padStart(2,'0');
    setCurrentDate(`${y}-${m}-${dS}`);
  };

  const handleNext = () => {
    const d = parseLocal(currentDate);
    if (view === 'month') d.setMonth(d.getMonth() + 1);
    else if (view === 'week') d.setDate(d.getDate() + 7);
    else d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dS = String(d.getDate()).padStart(2,'0');
    setCurrentDate(`${y}-${m}-${dS}`);
  };

  
  // Modals state
  /**
   * 软容量冲突的放行确认。
   *
   * `pendingConflict.retry` 存在时表示这是一次改期，重试由它承担；
   * 否则为开单，重试走 `submitAppointment` 并复用同一个幂等键。
   */
  const [conflictModal, setConflictModal] = useState<{
    isOpen: boolean;
    pendingConflict: { message: string; key?: string; retry?: (o: Override) => void } | null;
  }>({ isOpen: false, pendingConflict: null });

  /** 取消预约的原因采集。`keepStaffTurn` 必须由前台明确选择。 */
  const [cancelModal, setCancelModal] = useState<{
    isOpen: boolean; appointmentId: string | null; customerName: string;
  }>({ isOpen: false, appointmentId: null, customerName: '' });
  const [cancelReason, setCancelReason] = useState<CancelReason>('guest_changed_mind');
  const [keepStaffTurn, setKeepStaffTurn] = useState(true);
  const [overrideReason, setOverrideReason] = useState<Override['reason']>('desk_coordination');
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; title: string; message: React.ReactNode; confirmText: string; isDanger?: boolean; onConfirm: () => void }>({ isOpen: false, title: '', message: '', confirmText: '', onConfirm: () => {} });
  
  // Drag State
  const [dragTarget, setDragTarget] = useState<{ staffId: string, top: number, height: number, isConflict?: boolean } | null>(null);
  const [draggedApptInfo, setDraggedApptInfo] = useState<{ id: string, durationMin: number } | null>(null);

  const [hoveredApptId, setHoveredApptId] = useState<string | null>(null);
  const [hoveredColId, setHoveredColId] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const todayStr = timezone ? instantToWallDate(nowIso, timezone) : '';
  const currentMins = timezone ? instantToWallMinutes(nowIso, timezone) : 0;

  // Auto-scroll to current time on initial load
  useEffect(() => {
    if (scrollContainerRef.current) {
      // Aim to put the current time about 1/3 down the viewport, or just default to 08:00
      let targetMins = currentMins;
      if (currentMins < DAY_START) targetMins = DAY_START;
      if (currentMins > DAY_END) targetMins = DAY_START;
      
      const targetY = (targetMins - DAY_START) * PIXELS_PER_MIN;
      const offset = 100; // Offset for header
      
      scrollContainerRef.current.scrollTop = Math.max(0, targetY - offset);
    }
  }, [view]); // Re-scroll when switching views that use this container

  const handleNewAppointment = (targetDate?: string) => {
    if (!canWriteAppointment) return;
    openCreateAppointment?.({ defaultDate: targetDate || currentDate });
  };

  const handleSlotClick = (staffId: string, timeString: string, date?: string) => {
    if (!canWriteAppointment) return;
    const [h, m] = timeString.split(':').map(Number);
    const mins = h * 60 + m;
    
    const openModal = () => {
      openCreateAppointment?.({
        defaultStaffId: staffId === 't0' ? UNASSIGNED_STAFF_ID : staffId,
        defaultTime: timeString,
        defaultDate: date || currentDate,
      });
    };

    if (mins < storeOpenMin || mins >= storeCloseMin) {
      setConfirmModal({
        isOpen: true,
        title: t('offHoursTitle'),
        message: `${timeString} · ${minsToTime(storeOpenMin)}–${minsToTime(storeCloseMin)}｜${t('offHoursBody')}`,
        confirmText: t('confirmCreate'),
        onConfirm: () => {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          openModal();
        }
      });
    } else {
      openModal();
    }
  };

  const handleEditClick = (item: ScheduleItem, e: React.MouseEvent) => {
    openAppointment?.(item.appointmentId);
    e.stopPropagation();
  };

  // HTML5 Drag and Drop
  const handleDragStart = (e: React.DragEvent, appt: ScheduleItem) => {
    e.dataTransfer.setData('apptId', appt.id);
    setDraggedApptInfo({ id: appt.id, durationMin: appt.durationMin });
    setTimeout(() => { (e.target as HTMLElement).style.opacity = '0.5'; }, 0);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.target as HTMLElement).style.opacity = '1';
    setDragTarget(null);
    setDraggedApptInfo(null);
  };

  const handleDragOver = (e: React.DragEvent, staffId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedApptInfo) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minsFromStart = (y / PIXELS_PER_MIN);
    const snappedMins = Math.round(minsFromStart / 15) * 15;
    const newStartMins = DAY_START + snappedMins;
    const newEndMins = newStartMins + draggedApptInfo.durationMin;

    if (newEndMins > DAY_END) return;

    /*
     * 落点仅做视觉预览，不预判冲突。
     *
     * 前端推算冲突等于把服务端的判定抄第二份：软容量上限、技师并发数、
     * 房间容量都可由老板随时调整，抄来的那份必然滞后。预览只负责显示
     * 「要放到哪个位置」，是否允许由 reschedule 的返回决定。
     */
    setDragTarget({
      staffId,
      top: snappedMins * PIXELS_PER_MIN,
      height: draggedApptInfo.durationMin * PIXELS_PER_MIN,
      isConflict: false,
    });
  };

  const handleDrop = (e: React.DragEvent, targetStaffId: string) => {
    e.preventDefault();
    setDragTarget(null);
    const apptId = e.dataTransfer.getData('apptId');
    if (!apptId) return;

    const appt = items.find(a => a.id === apptId);
    if (!appt) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minsFromStart = (y / PIXELS_PER_MIN);
    const snappedMins = Math.round(minsFromStart / 15) * 15;
    const newStartMins = DAY_START + snappedMins;
    
    if (newStartMins + appt.durationMin > DAY_END) return;

    const newStartTime = minsToTime(newStartMins);
    const targetStaff = staff.find(s => s.membershipId === targetStaffId);

    // Double confirmation for Drop
    setConfirmModal({
      isOpen: true,
      title: t('confirmMoveTitle'),
      message: (
        <span>
          {t('moveApptTo')} <strong>{targetStaff?.membershipId === UNASSIGNED_STAFF_ID ? t('staffPool') : targetStaff?.name}</strong>
          {' · '}<strong>{newStartTime}</strong>
          <span className="block mt-1 text-slate-500">{appt.customerName}</span>
        </span>
      ),
      confirmText: t('confirmMove'),
      onConfirm: () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        void moveItem(appt, targetStaffId, newStartMins);
      }
    });
  };

  const confirmCancel = async () => {
    if (!cancelModal.appointmentId) return;
    try {
      await cancel.mutateAsync({
        appointmentId: cancelModal.appointmentId,
        reason: cancelReason,
        keepStaffTurn,
      });
      setCancelModal({ isOpen: false, appointmentId: null, customerName: '' });
      toast.success(t('cancelled'));
    } catch (err) {
      toast.danger(t('saveFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  /** 改期。软容量冲突交回前台确认原因后重试，硬冲突直接报错。 */
  const moveItem = async (
    item: ScheduleItem, targetStaffId: string, newStartMins: number, override?: Override,
  ) => {
    try {
      await reschedule.mutateAsync({
        appointmentId: item.appointmentId,
        itemId: item.id,
        startsAt: wallMinutesToInstant(currentDate, newStartMins, timezone),
        membershipId: targetStaffId === UNASSIGNED_STAFF_ID ? null : targetStaffId,
        ...(override ? { override } : {}),
      });
      setConflictModal({ isOpen: false, pendingConflict: null });
      toast.success(t('saved'));
    } catch (err) {
      if (isOverridableConflict(err)) {
        setConflictModal({
          isOpen: true,
          pendingConflict: {
            message: err.code,
            retry: (o: Override) => void moveItem(item, targetStaffId, newStartMins, o),
          },
        });
        return;
      }
      toast.danger(t('saveFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const timeSlots: string[] = [];
  for (let m = DAY_START; m < DAY_END; m += 30) {
    timeSlots.push(minsToTime(m));
  }

  /*
   * 可指派技师。
   *
   * ⚠️ 服务端的当日快照未下发「技师-服务」资质关系（services 与 staff 是两张
   * 独立列表），因此此处不做资质过滤，仅排除不可预约的人员。资质约束由服务端
   * 在 appointment.create 时裁定；前端若自行过滤，会在老板刚给某人开通新项目时
   * 把人藏起来，而前台无从得知原因。
   */
  const availableStaff = staff.filter(s => s.isBookable);

  /*
   * 加载与错误态必须显式呈现。
   *
   * 缺省渲染一张空日历会被前台读作「今天没有预约」—— 那是一个关于经营状况的
   * 错误结论，可能导致她把客人推给别家。
   */
  if (isLoading) {
    return <PageLoading title={t('schedule.loadingTitle')} description={t('schedule.loadingDesc')} />;
  }

  if (dayError) {
    return <PageError title={t('schedule.loadErrorTitle')} error={dayError} onRetry={refetch} />;
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col bg-slate-50 text-slate-800 rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="flex-none h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-4">
          <div className="relative flex items-center group cursor-pointer overflow-hidden rounded-md">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight group-hover:text-teal-600 transition-colors pr-2 flex items-center gap-2">
              {(() => {
                const d = parseLocal(currentDate);
                /*
                  别再手拼「年 / 月 / 日」—— 换成英文界面就成了「2026年8月25日」。
                  交给 Intl，各语言自己的写法它比我们清楚。
                */
                return new Intl.DateTimeFormat(language, {
                  year: 'numeric',
                  month: 'long',
                  ...(view === 'month' ? {} : { day: 'numeric' }),
                }).format(d);
              })()}
              <Calendar className="w-5 h-5 text-slate-400 group-hover:text-teal-600 transition-colors" />
            </h2>
            <input 
              type="date"
              value={currentDate}
              onChange={(e) => {
                if (e.target.value) setCurrentDate(e.target.value);
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
              style={{ colorScheme: 'light' }}
              title={t('pickDate')}
            />
          </div>
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
            <Button variant="ghost" size="icon" onClick={handlePrev} className="h-8 w-8 text-slate-500 hover:text-slate-900 cursor-pointer"><ChevronLeft className="w-4 h-4" /></Button>
            <button onClick={() => setCurrentDate(todayStr)} className="text-sm font-medium px-2 text-slate-600 hover:text-teal-600 transition-colors">{t('scheduleToday')}</button>
            <Button variant="ghost" size="icon" onClick={handleNext} className="h-8 w-8 text-slate-500 hover:text-slate-900 cursor-pointer"><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {view === 'overview' && (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-600 font-medium bg-white px-3 py-1.5 rounded-lg border border-slate-200 shadow-sm hover:bg-slate-50 transition-colors">
                <input 
                  type="checkbox" 
                  checked={showStaffColumns} 
                  onChange={(e) => setShowStaffColumns(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-600 cursor-pointer"
                />
                {t('splitByStaff')}
              </label>
              
              {showStaffColumns && (
                <select
                  value={filterRole}
                  onChange={(e) => setFilterRole(e.target.value)}
                  className="bg-white border border-slate-200 text-slate-700 text-sm rounded-lg focus:ring-teal-500 focus:border-teal-500 block px-3 py-1.5 shadow-sm transition-colors cursor-pointer"
                >
                  {/*
                    服务端的当日快照不含「岗位」字段，原先按岗位筛选的下拉无数据支撑。
                    改为按可预约 / 参与轮牌筛选 —— 这两项都在快照里，且正是前台
                    分列时真正关心的维度。
                  */}
                  <option value="all">{t('staffFilterAll')}</option>
                  <option value="bookable">{t('staffFilterBookable')}</option>
                  <option value="rotation">{t('staffFilterRotation')}</option>
                </select>
              )}
            </div>
          )}
          {(view === 'week' || view === 'month' || (view === 'overview' && !showStaffColumns)) && (
            <select
              value={filterStaffId}
              onChange={(e) => setFilterStaffId(e.target.value)}
              className="bg-white border border-slate-200 text-slate-700 text-sm rounded-lg focus:ring-teal-500 focus:border-teal-500 block px-3 py-1.5 shadow-sm transition-colors cursor-pointer"
            >
              <option value="all">{t('allStoreSchedule')}</option>
              {staff.map(s => (
                <option key={s.membershipId} value={s.membershipId}>
                  {s.membershipId === UNASSIGNED_STAFF_ID ? t('staffPool') : s.name}
                </option>
              ))}
            </select>
          )}
          <div className="relative w-40 sm:w-48">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('schedule.searchPlaceholder')}
              className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50/70 text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:bg-white transition-all"
            />
          </div>

          <div className="flex bg-slate-100 p-1 rounded-lg">
            {(['overview', 'week', 'month'] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
                  view === v ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {v === 'overview' ? t('viewOverview') : v === 'week' ? t('viewWeek') : t('viewMonth')}
              </button>
            ))}
          </div>
          <Button className="bg-teal-600 hover:bg-teal-700 text-white shadow-md shadow-teal-200 gap-1.5 rounded-xl px-4 text-xs font-bold" onClick={() => handleNewAppointment()}>
            <Plus className="w-4 h-4" /> {t('newAppt')}
          </Button>
        </div>
      </div>

            <div className="flex-1 overflow-auto bg-slate-50/50 relative" ref={scrollContainerRef}>
        {view === 'month' ? (
          <div className="min-w-[800px] h-full p-6 grid grid-cols-7 gap-4 auto-rows-[minmax(120px,_1fr)]">
            {WEEKDAY_KEYS.map(d => (
              <div key={d} className="font-bold text-center text-slate-400 text-sm pb-1">{t(d)}</div>
            ))}
            {monthDays.map((dateStr, i) => {
              if (!dateStr) return <div key={`empty-${i}`} className="bg-transparent" />;
              
              /*
                月视图使用区间聚合，不逐日拉取完整快照。因此格子上只呈现
                「有多少项、几人当班、是否休息、是否已日结」——
                单条预约的明细在点进当日后由 GET /v1/desk/day 提供。
              */
              const summary = summaryByDate.get(dateStr);
              const itemCount = summary?.items ?? 0;
              const isClosed = summary ? !summary.isOpen : false;
              /* isOpen 为 true 但 openMin 为 null，表示新店尚未配置营业时间。 */
              const hoursUnset = Boolean(summary?.isOpen && summary.openMin === null);

              return (
                <div
                  key={dateStr}
                  onClick={() => setExpandedMonthDate(dateStr)}
                  className={`rounded-2xl border p-3 shadow-sm flex flex-col gap-2 transition-all hover:shadow-md hover:-translate-y-0.5 cursor-pointer group ${
                    isClosed ? 'bg-slate-50 border-slate-200' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="flex justify-between items-center px-1">
                    <span className={`text-sm font-bold w-7 h-7 flex items-center justify-center rounded-full transition-colors ${dateStr === todayStr ? 'bg-teal-600 text-white shadow-sm ring-4 ring-teal-50' : 'text-slate-700 group-hover:bg-teal-50 group-hover:text-teal-600'}`}>
                      {dateStr.slice(-2).replace(/^0/, '')}
                    </span>
                    <div className="flex items-center gap-1 text-[10px] font-medium">
                      {summary?.daycloseStatus && (
                        <span className="text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-md">
                          {t('dayClosedTag')}
                        </span>
                      )}
                      {isClosed && (
                        <span className="text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-md">
                          {t('closedDay')}
                        </span>
                      )}
                    </div>
                  </div>

                  {itemCount > 0 ? (
                    <div className="flex-1 flex flex-col gap-1.5 mt-1 px-1">
                      <div className="text-lg font-bold text-slate-800 tabular-nums leading-none">
                        {itemCount}
                        <span className="text-[11px] font-medium text-slate-500 ml-1">{t('itemsCount')}</span>
                      </div>
                      {/* 密度条：以当月单日最大项目数为基准，用于一眼看出忙闲分布 */}
                      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-teal-500 rounded-full transition-[width] duration-500"
                          style={{ width: `${Math.min(100, (itemCount / Math.max(1, maxMonthItems)) * 100)}%` }}
                        />
                      </div>
                      {summary && summary.staffOnDuty > 0 && (
                        <div className="text-[10px] text-slate-400 font-medium">
                          {summary.staffOnDuty} {t('staffOnDuty')}
                        </div>
                      )}
                      {hoursUnset && (
                        <div className="text-[10px] text-amber-600 font-medium">{t('hoursNotSet')}</div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <span className="text-[11px] text-slate-300 font-medium">
                        {isClosed ? t('closedDay') : t('noAppts')}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (() => {
          const isWeek = view === 'week';
          const isStoreView = view === 'overview' && !showStaffColumns;
          const columns: {
            id: string; name: string; roleKey: TranslationKey | null;
            isPool: boolean; type: 'date' | 'store' | 'staff';
          }[] = isWeek
            ? weekDays.map((date, idx) => ({
                id: date,
                name: `${t(WEEKDAY_KEYS[idx]!)} ${date.slice(5)}`,
                roleKey: null, isPool: false, type: 'date' as const,
              }))
            : isStoreView
              ? [{ id: 'all_store', name: t('allStoreSchedule'), roleKey: 'allStoreMerged' as const, isPool: false, type: 'store' as const }]
              : staff
                  .filter(s =>
                    filterRole === 'all'
                    || (filterRole === 'bookable' && s.isBookable)
                    || (filterRole === 'rotation' && s.inRotation))
                  .map(s => ({
                    id: s.membershipId,
                    // 待分配池不是人，它的「名字」是一个系统概念，要翻译
                    name: s.membershipId === UNASSIGNED_STAFF_ID ? t('staffPool') : s.name,
                    roleKey: null,
                    isPool: Boolean(s.membershipId === UNASSIGNED_STAFF_ID),
                    type: 'staff' as const,
                  }));

          const tableMinWidth = Math.max(1000, columns.length * 200 + 80);

          return (
            <div className="flex" style={{ minWidth: `${tableMinWidth}px` }}>
              <div className="w-20 flex-none bg-white border-r border-slate-200 z-50 sticky left-0 flex flex-col">
                <div className="h-[72px] sticky top-0 bg-white border-b border-slate-200 z-50 flex-none" />
                <div className="relative">
                  {timeSlots.map(time => (
                    <div key={time} className="h-[60px] relative border-b border-transparent">
                      <span className="absolute -top-3 right-3 text-xs font-medium text-slate-400">{time}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex-1 flex">
                {columns.map(member => {
                  const memberApts = filteredItems.filter(a => {
                    if (isWeek) {
                      if (a.date !== member.id) return false;
                      if (filterStaffId !== 'all' && a.staffId !== filterStaffId) return false;
                      return true;
                    }
                    if (isStoreView) {
                      if (a.date !== currentDate) return false;
                      if (filterStaffId !== 'all' && a.staffId !== filterStaffId) return false;
                      return true;
                    }
                    return a.staffId === member.id && a.date === currentDate;
                  });
                  const displayApts = memberApts;

                  // Compute Overlaps
                  /*
                    item 自带 startMins / endMins / durationMin（已按门店时区换算），
                    不再从项目表推算Duration —— 已下架项目查不到，且历史单的实际Duration
                    可能与当前项目定义不同（下单时可覆盖）。
                  */
                  const enriched = [...displayApts].sort((a, b) => a.startMins - b.startMins);

                  const groups: typeof enriched[] = [];
                  let currentGroup: typeof enriched = [];
                  let currentGroupEnd = 0;

                  enriched.forEach(apt => {
                    if (currentGroup.length === 0) {
                      currentGroup.push(apt);
                      currentGroupEnd = apt.endMins;
                    } else if (apt.startMins < currentGroupEnd) {
                      currentGroup.push(apt);
                      currentGroupEnd = Math.max(currentGroupEnd, apt.endMins);
                    } else {
                      groups.push(currentGroup);
                      currentGroup = [apt];
                      currentGroupEnd = apt.endMins;
                    }
                  });
                  if (currentGroup.length > 0) groups.push(currentGroup);

                  const layoutApts = groups.flatMap(group => {
                    const cols: typeof group[] = [];
                    group.forEach(apt => {
                      let placed = false;
                      for (let i = 0; i < cols.length; i++) {
                        if (cols[i][cols[i].length - 1].endMins <= apt.startMins) {
                          cols[i].push(apt);
                          (apt as any)._col = i;
                          placed = true;
                          break;
                        }
                      }
                      if (!placed) {
                        (apt as any)._col = cols.length;
                        cols.push([apt]);
                      }
                    });
                    
                    const maxCols = cols.length;
                    
                    return group.map(apt => {
                      const col = (apt as any)._col;
                      let span = 1;
                      
                      for (let i = col + 1; i < maxCols; i++) {
                        const hasOverlap = cols[i].some(otherApt => {
                          return (apt.startMins < otherApt.endMins && apt.endMins > otherApt.startMins);
                        });
                        if (!hasOverlap) {
                          span++;
                        } else {
                          break;
                        }
                      }
                      
                      return { ...apt, col, maxCols, span };
                    });
                  });

                  const isAnyHovered = hoveredColId !== null;
                  const isThisHovered = hoveredColId === member.id;
                  
                  return (
                    <div 
                      key={member.id} 
                      onMouseEnter={() => setHoveredColId(member.id)}
                      onMouseLeave={() => setHoveredColId(null)}
                      className={`group border-r border-slate-200 relative ${member.id === UNASSIGNED_STAFF_ID ? 'bg-teal-50/20' : ''} transition-all duration-300 ease-out ${
                        isThisHovered ? 'flex-[3] min-w-[280px] bg-slate-50/30 shadow-lg z-10' : 
                        isAnyHovered ? 'flex-[1] min-w-[120px] opacity-80' : 
                        'flex-[1] min-w-[200px]'
                      }`}
                    >
                      {(() => {
                        const aptCount = memberApts.length;
                        const rev = memberApts.filter(a => a.status === 'completed').reduce((sum, a) => sum + (a.service?.priceCents ?? 0) / 100, 0);
                        return (
                          <div className="h-[72px] bg-white border-b border-slate-200 sticky top-0 z-40 flex flex-col items-center justify-center backdrop-blur-md bg-white/90 shadow-sm relative">
                            {member.type === 'staff' && currentDate === todayStr && (
                              <div className="absolute top-2 right-2">
                                <div 
                                  className={`w-2.5 h-2.5 rounded-full shadow-sm border-[1.5px] border-white ${
                                    memberApts.some(a => a.date === todayStr && timeToMins(a.startTime) <= currentMins && timeToMins(a.endTime) >= currentMins)
                                      ? 'bg-red-500' 
                                      : 'bg-emerald-500'
                                  }`} 
                                  title={memberApts.some(a => a.date === todayStr && timeToMins(a.startTime) <= currentMins && timeToMins(a.endTime) >= currentMins) ? t('staffBusy') : t('staffIdle')} 
                                />
                              </div>
                            )}
                            {isWeek && member.type === 'date' && member.id === todayStr ? (
                              <div className="flex flex-col items-center gap-1">
                                <span className="bg-teal-600 text-white font-bold text-xs px-2.5 py-1 rounded-full shadow-md whitespace-nowrap">
                                  {member.name} · {t('scheduleToday')}
                                </span>
                              </div>
                            ) : (
                              <span className={`font-semibold text-sm ${member.id === UNASSIGNED_STAFF_ID ? 'text-teal-600' : 'text-slate-800'}`}>
                                {member.name}
                              </span>
                            )}
                            {!isWeek && member.roleKey && (
                              <span className="text-[10px] text-slate-500">{t(member.roleKey)}</span>
                            )}
                            {aptCount > 0 && (
                              <div className="flex items-center justify-center gap-1.5 mt-1 text-[10px] transform scale-90">
                                <span className="bg-teal-50 text-teal-600 px-1.5 py-0.5 rounded-sm font-semibold">{aptCount} {t('apptCount')}</span>
                                {rev > 0 && <span className="bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded-sm font-semibold">¥{rev}</span>}
                              </div>
                            )}
                            {aptCount === 0 && <div className="mt-1 text-[10px] text-slate-300 font-medium">{t('noAppts')}</div>}
                          </div>
                        );
                      })()}
                      
                      <div 
                        className="relative" 
                        style={{ height: `${(DAY_END - DAY_START) * PIXELS_PER_MIN}px` }}
                        onDragOver={(e) => (!isWeek && !isStoreView) ? handleDragOver(e, member.id) : undefined}
                        onDrop={(e) => (!isWeek && !isStoreView) ? handleDrop(e, member.id) : undefined}
                        onDragLeave={() => (!isWeek && !isStoreView) ? setDragTarget(null) : undefined}
                      >
                        {timeSlots.map((time) => {
                          const isHour = time.endsWith(':00');
                          const hourNum = parseInt(time.split(':')[0]);
                          const isAlternate = hourNum % 2 === 0;
                          return (
                          <div 
                            key={time}
                            className={`h-[60px] border-b ${isHour ? 'border-slate-200' : 'border-slate-100'} ${isAlternate ? 'bg-slate-50/30' : 'bg-transparent'} hover:bg-teal-50/50 cursor-pointer transition-colors relative group/cell`}
                            onClick={() => handleSlotClick(
                              isWeek ? (filterStaffId !== 'all' ? filterStaffId : UNASSIGNED_STAFF_ID) : (isStoreView ? UNASSIGNED_STAFF_ID : member.id), 
                              time, 
                              isWeek ? member.id : currentDate
                            )}
                          >
                            <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 text-xs text-teal-400 font-medium opacity-0 group-hover/cell:opacity-100 transition-opacity flex flex-col items-center gap-1">
                              <Plus className="w-4 h-4" />
                            </div>
                          </div>
                        )})}
                        
                        {/* Drag Target Ghost */}
                        {dragTarget && dragTarget.staffId === member.id && (
                          <div 
                            className={`absolute left-1 right-1 border-2 border-dashed rounded-lg z-20 pointer-events-none flex items-center justify-center backdrop-blur-[1px] ${
                              dragTarget.isConflict 
                                ? 'bg-red-100/60 border-red-400' 
                                : 'bg-teal-100/60 border-teal-400'
                            }`}
                            style={{ 
                              top: `${dragTarget.top}px`, 
                              height: `${dragTarget.height}px` 
                            }}
                          >
                            <span className={`font-bold text-sm bg-white/90 px-2 py-0.5 rounded shadow-sm ${
                              dragTarget.isConflict ? 'text-red-600' : 'text-teal-600'
                            }`}>
                              {dragTarget.isConflict ? t('hasConflict') : t('dropToMove')}
                            </span>
                          </div>
                        )}
                        
                        {/* Open/Close Indicators */}
                        <div className="absolute left-0 right-0 h-[2px] bg-emerald-500/30 z-30 pointer-events-none" style={{ top: `${(storeOpenMin - DAY_START) * PIXELS_PER_MIN}px` }} />
                        <div className="absolute left-0 right-0 h-8 bg-gradient-to-b from-emerald-50/50 to-transparent z-20 pointer-events-none flex justify-center pt-1" style={{ top: `${(storeOpenMin - DAY_START) * PIXELS_PER_MIN}px` }}>
                          <span className="text-[10px] text-emerald-600/70 font-bold tracking-widest uppercase bg-white/60 px-2 rounded-full shadow-sm backdrop-blur-sm">{`${minsToTime(storeOpenMin)} ${t('storeOpens')}`}</span>
                        </div>
                        
                        <div className="absolute left-0 right-0 h-[2px] bg-slate-400/30 z-30 pointer-events-none" style={{ top: `${(storeCloseMin - DAY_START) * PIXELS_PER_MIN}px` }} />
                        <div className="absolute left-0 right-0 h-8 bg-gradient-to-t from-slate-200/50 to-transparent z-20 pointer-events-none flex items-end justify-center pb-1" style={{ bottom: `${(DAY_END - storeCloseMin) * PIXELS_PER_MIN}px` }}>
                          <span className="text-[10px] text-slate-500/70 font-bold tracking-widest uppercase bg-white/60 px-2 rounded-full shadow-sm backdrop-blur-sm">{`${minsToTime(storeCloseMin)} ${t('storeCloses')}`}</span>
                        </div>
                        
                        {/* Out of hours blocks overlay */}
                        <div className="absolute left-0 right-0 bg-slate-100/40 pointer-events-none z-10" style={{ top: 0, height: `${(storeOpenMin - DAY_START) * PIXELS_PER_MIN}px` }} />
                        <div className="absolute left-0 right-0 bg-slate-100/40 pointer-events-none z-10" style={{ top: `${(storeCloseMin - DAY_START) * PIXELS_PER_MIN}px`, height: `${(DAY_END - storeCloseMin) * PIXELS_PER_MIN}px` }} />
                        
                        {/* Add Appt Corridor Visual */}
                        <div className="absolute top-0 bottom-0 right-0 w-[32px] border-l-2 border-dashed border-teal-200 bg-teal-50/60 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-10 flex flex-col items-center justify-center backdrop-blur-[1px]">
                          <div className="w-[1px] h-full bg-teal-200/50 absolute left-1/2 -translate-x-1/2" />
                          <div className="sticky top-1/2 -translate-y-1/2 flex flex-col items-center gap-6 text-teal-400">
                             <Plus className="w-4 h-4 animate-pulse" />
                             <span className="text-[12px] font-bold tracking-widest text-teal-500 drop-shadow-sm" style={{ writingMode: 'vertical-lr' }}>{t('newApptInGap')}</span>
                             <Plus className="w-4 h-4 animate-pulse" />
                          </div>
                        </div>

                        {/* Current Time Line */}
                        {(() => {
                          const colDate = member.type === 'date' ? member.id : currentDate;
                          if (colDate === todayStr && currentMins >= DAY_START && currentMins <= DAY_END) {
                            const lineTop = (currentMins - DAY_START) * PIXELS_PER_MIN;
                            return (
                              <div className="absolute left-0 right-0 z-50 pointer-events-none" style={{ top: `${lineTop}px` }}>
                                <div className="absolute left-0 right-0 border-t-[1.5px] border-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]" />
                                <div className="absolute left-0 -top-2.5 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm">
                                  {formatWallTime(currentMins)}
                                </div>
                                <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
                              </div>
                            );
                          }
                          return null;
                        })()}

                        
                        {layoutApts.map(apt => {
                          const top = (apt.startMins - DAY_START) * PIXELS_PER_MIN;
                          const height = apt.durationMin * PIXELS_PER_MIN;
                          const isHovered = hoveredApptId === apt.id;
                          const isCompleted = apt.status === 'completed';
                          const isNoShow = apt.status === 'no_show';
                          const isDragged = draggedApptInfo?.id === apt.id;

                          const widthPos = `calc((${apt.span} / ${apt.maxCols}) * (100% - 32px) - 4px)`;
                          const leftPos = `calc((${apt.col} / ${apt.maxCols}) * (100% - 32px) + 4px)`;
                          
                          const effectiveCols = apt.maxCols / apt.span;
                          
                          const cardPadding = (effectiveCols >= 3 && !isHovered) ? 'p-1.5' : (effectiveCols >= 2 && !isHovered) ? 'p-2' : 'p-3';
                          const titleSize = (effectiveCols >= 3 && !isHovered) ? 'text-[11px] leading-tight' : 'text-sm';
                          const showDetails = isStoreView || (effectiveCols < 3 || isHovered);
                          const tooltipText = `${apt.customerName}\n${apt.startTime} - ${apt.endTime}\n${apt.serviceName}`;
                          
                          return (
                            <div
                              key={apt.id}
                              className="absolute transition-all duration-300"
                              style={{
                                left: leftPos,
                                top: `${top}px`,
                                width: widthPos,
                                height: `${height - 4}px`,
                                zIndex: isHovered ? 60 : 10 + apt.col
                              }}
                              onMouseEnter={() => setHoveredApptId(apt.id)}
                              onMouseLeave={() => setHoveredApptId(null)}
                            >
                              <div
                                title={tooltipText}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEditClick(apt, e);
                                }}
                                draggable={canWriteAppointment && !isWeek && !isStoreView}
                                onDragStart={(e) => (canWriteAppointment && !isWeek && !isStoreView) ? handleDragStart(e, apt) : undefined}
                                onDragEnd={handleDragEnd}
                                className={`w-full h-full rounded-lg border-2 ${cardPadding} cursor-pointer transition-all duration-300 ease-out overflow-hidden ${isDragged ? 'opacity-50 ring-2 ring-teal-500 ring-offset-2' : ''} ${
                                  isCompleted ? 'bg-slate-100/90 border-slate-400 text-slate-600 opacity-80' :
                                  isNoShow ? 'bg-red-50/90 border-red-500 text-red-700 opacity-80' :
                                  serviceColor(apt.serviceId).replace('bg-', 'bg-').concat(isHovered ? '/100' : '/95')
                                } ${isHovered ? 'shadow-2xl ring-1 ring-black/5 ring-offset-1' : 'shadow-sm'}`}
                                style={{
                                  minWidth: isHovered ? 'max(160px, 100%)' : (effectiveCols >= 3 ? '50px' : '100%'),
                                  minHeight: '100%',
                                  width: isHovered ? 'max-content' : '100%',
                                  height: isHovered ? 'max-content' : '100%',
                                  transform: isHovered ? 'scale(1.02)' : 'scale(1)',
                                  transformOrigin: 'top left'
                                }}
                              >
                              <div className="flex justify-between items-start gap-2">
                                <div className={`font-bold ${titleSize} tracking-tight ${!isHovered ? (effectiveCols >= 3 ? 'break-all line-clamp-2' : 'truncate') : 'whitespace-normal'} ${isCompleted || isNoShow ? 'line-through' : ''}`}>
                                  {apt.customerName}
                                </div>
                                {apt.status === 'in_service' && <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />}
                              </div>
                              <div className={`text-xs opacity-90 mt-0.5 ${!isHovered ? 'truncate' : 'whitespace-normal'} flex items-center gap-1`}>
                                <Clock className="w-3 h-3 shrink-0" /> {apt.startTime} {isHovered && `- ${apt.endTime}`}
                              </div>
                              {showDetails && (() => {
                                const aptStaff = staff.find(s => s.membershipId === apt.staffId);
                                return (
                                  <div className="flex items-center gap-1.5 mt-1.5">
                                    {aptStaff && (
                                      <div className={`shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm ${aptStaff.membershipId === UNASSIGNED_STAFF_ID ? 'bg-slate-400' : 'bg-teal-500'}`} title={aptStaff.name}>
                                        {aptStaff.name.charAt(0)}
                                      </div>
                                    )}
                                    <div className={`text-xs opacity-80 ${!isHovered ? 'truncate' : 'whitespace-normal'}`}>{apt.serviceName}</div>
                                  </div>
                                );
                              })()}
                              {!isWeek && <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-8 h-1 bg-black/10 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />}
                              </div>
                            </div>
                          );
                        })}
                        
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Universal Double Confirmation Modal */}
      
      {/* EXPANDED MONTH DATE MODAL */}
      {expandedMonthDate && (
        <Portal>
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-modal p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center px-6 py-4 border-b border-slate-100 bg-slate-50/50">
              <h2 className="text-xl font-bold text-slate-800">
                {expandedMonthDate} · {t('dayDetails')}
              </h2>
              <Button variant="ghost" size="icon" onClick={() => setExpandedMonthDate(null)} className="text-slate-400 hover:text-slate-600 rounded-full h-8 w-8">
                <X className="w-5 h-5" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-3">
              {(() => {
                const dayApts = items
                  .filter(a => a.date === expandedMonthDate && (filterStaffId === 'all' || a.staffId === filterStaffId))
                  .sort((a, b) => a.startTime.localeCompare(b.startTime));
                  
                if (dayApts.length === 0) {
                  return <div className="text-center py-12 text-slate-400">{t('noApptsToday')}</div>;
                }
                
                return dayApts.map(apt => {
                  const staffMember = staff.find(s => s.membershipId === apt.staffId);
                  const isCompleted = apt.status === 'completed';
                  const isNoShow = apt.status === 'no_show';
                  
                  return (
                    <div 
                      key={apt.id} 
                      className={`text-sm px-4 py-3 rounded-xl cursor-pointer transition-all border-l-[4px] flex flex-col gap-2 hover:-translate-y-0.5 hover:shadow-md ${
                        isCompleted ? 'bg-slate-50 border-slate-300 text-slate-500' :
                        isNoShow ? 'bg-red-50/50 border-red-300 text-red-600' :
                        serviceColor(apt.serviceId).replace('border-', 'border-l-').replace('text-', 'bg-').replace('bg-', 'bg-').concat('/10')
                      }`}
                      onClick={(e) => {
                         setExpandedMonthDate(null);
                         handleEditClick(apt, e);
                      }}
                    >
                      <div className="flex justify-between items-start">
                        <span className={`font-bold text-base ${isCompleted || isNoShow ? 'line-through opacity-70' : 'text-slate-800'}`}>
                          {apt.startTime} - {apt.endTime}
                        </span>
                        <div className="flex items-center gap-2">
                           <span className="font-bold text-slate-700">{apt.customerName}</span>
                           {isCompleted && <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />}
                        </div>
                      </div>
                      <div className="flex justify-between items-center opacity-90 font-medium">
                        {/*
                          项目名用 item 自带的快照值，不查当前项目表：
                          已下架的项目查不到，而下单那一刻的名称才是这条单的事实。
                        */}
                        <span className={`px-2 py-0.5 rounded text-xs ${serviceColor(apt.serviceId)}`}>
                          {apt.serviceName}
                        </span>
                        <div className="flex items-center gap-1.5 text-xs text-slate-600">
                          {staffMember && (
                            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm ${staffMember.membershipId === UNASSIGNED_STAFF_ID ? 'bg-slate-400' : 'bg-teal-500'}`}>
                              {staffMember.name.charAt(0)}
                            </div>
                          )}
                          {staffMember?.name}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end">
               <Button 
                 className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md"
                 onClick={() => {
                   const d = expandedMonthDate;
                   setExpandedMonthDate(null);
                   if (d) handleNewAppointment(d);
                 }}
               >
                 <Plus className="w-4 h-4 mr-2" />
                 {t('newAppt')}
               </Button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {confirmModal.isOpen && (
        <Portal>
        <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 transform animate-in zoom-in-95">
            <div className={`flex items-center gap-3 mb-4 ${confirmModal.isDanger ? 'text-red-600' : 'text-teal-600'}`}>
              <div className={`p-2 rounded-full ${confirmModal.isDanger ? 'bg-red-100' : 'bg-teal-100'}`}>
                {confirmModal.isDanger ? <AlertTriangle className="w-6 h-6" /> : <HelpCircle className="w-6 h-6" />}
              </div>
              <h3 className="text-lg font-bold text-slate-800">{confirmModal.title}</h3>
            </div>
            <div className="text-sm text-slate-600 mb-6 leading-relaxed">
              {confirmModal.message}
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}>{t('cancel')}</Button>
              <Button 
                className={`flex-1 text-white rounded-xl shadow-md ${
                  confirmModal.isDanger 
                    ? 'bg-red-500 hover:bg-red-600 shadow-red-200' 
                    : 'bg-teal-600 hover:bg-teal-700 shadow-teal-200'
                }`} 
                onClick={confirmModal.onConfirm}
              >
                {confirmModal.confirmText}
              </Button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* 软容量冲突：确认放行并记录原因 */}
      {conflictModal.isOpen && (
        <Portal>
        <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 transform animate-in zoom-in-95">
            <div className="flex items-center gap-3 mb-4 text-amber-600">
              <div className="p-2 bg-amber-100 rounded-full"><AlertTriangle className="w-6 h-6" /></div>
              <h3 className="text-lg font-bold text-slate-800">{t('conflictTitle')}</h3>
            </div>
            <p className="text-sm text-slate-600 mb-4 leading-relaxed">{t('conflictBody')}</p>

            <label htmlFor="override-reason" className="block text-xs font-semibold text-slate-500 mb-1.5">
              {t('overrideReasonLabel')}
            </label>
            <select
              id="override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value as Override['reason'])}
              className="w-full mb-6 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-4 focus:ring-teal-500/10 focus:border-teal-500 transition-colors"
            >
              {OVERRIDE_REASONS.map((r) => (
                <option key={r} value={r}>{t(OVERRIDE_REASON_LABELS[r])}</option>
              ))}
            </select>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 rounded-xl"
                onClick={() => setConflictModal({ isOpen: false, pendingConflict: null })}
              >
                {t('undo')}
              </Button>
              <Button
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white rounded-xl shadow-md shadow-amber-200"
                onClick={() => {
                  const pending = conflictModal.pendingConflict;
                  if (!pending) return;
                  const override: Override = { reason: overrideReason };
                  if (pending.retry) pending.retry(override);
                }}
              >
                {t('forceSchedule')}
              </Button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* 取消预约：采集标准原因，并强制选择是否保留轮牌 */}
      {cancelModal.isOpen && (
        <Portal>
        <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 transform animate-in zoom-in-95">
            <h3 className="text-lg font-bold text-slate-800 mb-1">{t('cancelAppt')}</h3>
            <p className="text-sm text-slate-500 mb-5">{cancelModal.customerName}</p>

            <label htmlFor="cancel-reason" className="block text-xs font-semibold text-slate-500 mb-1.5">
              {t('cancelReasonLabel')}
            </label>
            <select
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value as CancelReason)}
              className="w-full mb-4 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-4 focus:ring-teal-500/10 focus:border-teal-500 transition-colors"
            >
              {CANCEL_REASONS.map((r) => (
                <option key={r} value={r}>{t(CANCEL_REASON_LABELS[r])}</option>
              ))}
            </select>

            <label className="flex items-start gap-2.5 mb-6 cursor-pointer">
              <input
                type="checkbox"
                checked={keepStaffTurn}
                onChange={(e) => setKeepStaffTurn(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500/20"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-800">{t('keepStaffTurn')}</span>
                <span className="block text-xs text-slate-500 mt-0.5 leading-relaxed">{t('keepStaffTurnHint')}</span>
              </span>
            </label>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 rounded-xl"
                onClick={() => setCancelModal({ isOpen: false, appointmentId: null, customerName: '' })}
              >
                {t('cancel')}
              </Button>
              <GuardedButton
                permission="appointment.cancel"
                variant="danger"
                isPending={cancel.isPending}
                className="flex-1 rounded-xl"
                onClick={() => void confirmCancel()}
              >
                {t('cancelAppt')}
              </GuardedButton>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  );
}

export function Schedule() {
  return (
    <ErrorBoundary fallbackTitleKey="schedule">
      <ScheduleContent />
    </ErrorBoundary>
  );
}
