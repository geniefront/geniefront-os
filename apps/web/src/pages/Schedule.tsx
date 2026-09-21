import { useEntitlements } from '@/features/billing/useEntitlements';
import { useBookingRealtime } from '@/features/schedule/useBookingRealtime';
import { useSession } from '@/lib/session';
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
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
import { formatWallTime, instantToWallDate, instantToWallMinutes, useBusinessDay, wallMinutesToInstant, wallSlotTarget } from '@/lib/time';
import { gridBounds } from '@/features/schedule/gridBounds';
import { useDaysRange } from '@/features/schedule/api';
import { useCanWrite } from '@/lib/permissions';
import { useDialogChrome } from '@/lib/dialogChrome';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { Loader2, Search } from 'lucide-react';
import { toast, Spinner } from '@heroui/react';
import { EmptyState } from '@/components/ui/EmptyState';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { cn, formatI18n } from '@/lib/utils';

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

/** 周一到周日。顺序写死用于月视图表头 */
const WEEKDAY_KEYS: TranslationKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const WEEKDAY_MAP: Record<number, TranslationKey> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

const getWeekdayKey = (dateStr: string): TranslationKey => {
  if (!dateStr) return 'mon';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return WEEKDAY_MAP[dt.getDay()] || 'mon';
};
import {
  Plus,
  ChevronLeft,
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
  const normalized = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

const PIXELS_PER_MIN = 2;


function ScheduleContent() {
  const voiceOnly = useEntitlements().data?.plan === 'voice_booking';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { openAppointment, openCreateAppointment } = useOutletContext<{
    setRightDrawerOpen: (open: boolean) => void;
    openAppointment?: (id?: string | null, status?: 'booked' | 'checked_in' | 'in_service' | 'done') => void;
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
  const bookingLinkSession = useSession();
  useBookingRealtime();
  const {
    services, staff, items, currentDate, setCurrentDate,
    isLoading, isStaleDate, error: dayError, refetch, timezone, openMin: storeOpenMin, closeMin: storeCloseMin,
  } = useSchedule();
  const { create, reschedule, cancel } = useScheduleMutations();

  useEffect(() => {
    const linkedAppointmentId = searchParams.get('appointmentId');
    if (!linkedAppointmentId || !openAppointment) return;
    const linkedLocationId=searchParams.get('locationId');
    if(linkedLocationId && bookingLinkSession.membership?.locationId!==linkedLocationId) {
      const target=bookingLinkSession.locations.find(l=>l.locationId===linkedLocationId);
      if(target) bookingLinkSession.selectMembership(target.membershipId);
      return;
    }
    openAppointment(linkedAppointmentId);
    const next = new URLSearchParams(searchParams);
    next.delete('appointmentId');
    setSearchParams(next, { replace: true });
  }, [openAppointment, searchParams, setSearchParams, bookingLinkSession]);

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

  const parseLocal = (ds: string) => {
    if (!ds) return new Date();
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const getWeekDays = (dateStr: string) => {
    const d = parseLocal(dateStr);
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
  const weekQuery = useWeekItems(view === 'week' ? weekDays : []);
  const weekItemsByDate = weekQuery.itemsByDate;
  const incompleteWeekDays = weekQuery.days.filter(day => day.isLoading || day.error);

  const viewItems = React.useMemo(
    () => (view === 'week' ? [...weekItemsByDate.values()].flat() : items),
    [view, weekItemsByDate, items],
  );

  const { start: DAY_START, end: DAY_END } = React.useMemo(
    () => gridBounds(storeOpenMin, storeCloseMin, viewItems),
    [storeOpenMin, storeCloseMin, viewItems],
  );

  // 预约项目容错模糊搜索过滤（基于当前视图的全部单据：单日视图为当日，周视图为全周7天）
  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return viewItems;
    return fuzzySearch(viewItems, searchQuery, {
      keys: [
        { name: 'customerName', weight: 0.5 },
        { name: 'customerPhone', weight: 0.3 },
        { name: 'serviceName', weight: 0.3 },
      ],
      threshold: 0.45,
    });
  }, [viewItems, searchQuery]);

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
    if (view === 'month') { d.setDate(1); d.setMonth(d.getMonth() - 1); }
    else if (view === 'week') d.setDate(d.getDate() - 7);
    else d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dS = String(d.getDate()).padStart(2,'0');
    setCurrentDate(`${y}-${m}-${dS}`);
  };

  const handleNext = () => {
    const d = parseLocal(currentDate);
    if (view === 'month') { d.setDate(1); d.setMonth(d.getMonth() + 1); }
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

  /*
   * 这三个浮层出于版式需要是手写的 `fixed inset-0`，不走 `components/ui/Modal`。
   * 手写浮层在视觉上是弹窗，在键盘与读屏上什么都不是 —— 读屏用户不知道它打开了，
   * Tab 会走进被遮住的页面，Esc 也关不掉（而这个应用里其他每个弹窗都能）。
   * `useDialogChrome` 补齐 Esc、焦点收进与归还、Tab 循环；ARIA 属性写在容器上。
   */
  const closeConfirmModal = useCallback(
    () => setConfirmModal((prev) => ({ ...prev, isOpen: false })), []);
  const closeConflictModal = useCallback(
    () => setConflictModal({ isOpen: false, pendingConflict: null }), []);
  const closeCancelModal = useCallback(
    () => setCancelModal({ isOpen: false, appointmentId: null, customerName: '' }), []);
  const confirmDialogRef = useDialogChrome(confirmModal.isOpen, closeConfirmModal);
  const conflictDialogRef = useDialogChrome(conflictModal.isOpen, closeConflictModal);
  const cancelDialogRef = useDialogChrome(cancelModal.isOpen, closeCancelModal);
  
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
  /**
   * ⭐ 「今天」是**营业日**的今天（AUD-13）。
   *
   * 日程表本身就是按营业日取数的（`?date=`），所以「今天」这一列、
   * 「今天」按钮、月视图上那个高亮圈必须用同一个口径 ——
   * 否则凌晨打开日程表，高亮的是明天那一格，而数据是昨晚那一天的。
   *
   * 现在线的位置仍然用墙上时间的分钟数：它回答的是「此刻在这一列的哪个高度」，
   * 那是个时刻问题，不是日期问题。
   */
  const { today: todayStr } = useBusinessDay();
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

  /**
   * `rawMins` 是格子相对**营业日 00:00** 的分钟数，跨午夜营业时可 ≥ 1440
   * （例：营业到次日 02:00，凌晨 01:30 的格子 rawMins = 1530）。
   * 这类格子的真实日历日是营业日的次日，钟点是 rawMins − 1440 —— 不能把
   * 归一化后的 "01:30" 直接配营业日，那样 startsAt 会早一整天（计划 §6.2）。
   */
  const handleSlotClick = (staffId: string, rawMins: number, date?: string) => {
    if (!canWriteAppointment) return;
    const { date: realDate, minuteOfDay } = wallSlotTarget(date || currentDate, rawMins);
    const timeString = minsToTime(minuteOfDay);

    const openModal = () => {
      openCreateAppointment?.({
        defaultStaffId: staffId === 't0' ? UNASSIGNED_STAFF_ID : staffId,
        defaultTime: timeString,
        defaultDate: realDate,
      });
    };

    if (rawMins < storeOpenMin || rawMins >= storeCloseMin) {
      setConfirmModal({
        isOpen: true,
        title: t('offHoursTitle'),
        message: `${minsToTime(rawMins)} · ${minsToTime(storeOpenMin)}–${minsToTime(storeCloseMin)}｜${t('offHoursBody')}`,
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
    openAppointment?.(
      item.appointmentId,
      item.status === 'completed'
        ? 'done'
        : item.status === 'in_service'
          ? 'in_service'
          : 'booked',
    );
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

    const appt = viewItems.find(a => a.id === apptId);
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
    return <PageLoading layout="calendar" title={t('schedule.loadingTitle')} description={t('schedule.loadingDesc')} />;
  }

  if (dayError) {
    return <PageError title={t('schedule.loadErrorTitle')} error={dayError} onRetry={refetch} />;
  }

  return (
    <div className="relative h-full flex flex-col bg-slate-50 text-slate-800 rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      {/*
        翻页遮罩。
        为了不闪白屏，新日期的数据到达前屏幕上留的是上一天的日历（见
        `features/schedule/api.ts` 的 placeholderData）。这段时间里屏幕内容与
        标题上的日期并不一致，因此必须：**说明正在切换**，并**挡住这期间的所有
        点击** —— 否则前台会在 9 月 11 日的格子上给 9 月 12 日落单。
      */}
      {isStaleDate && (
        <div
          role="status"
          aria-live="polite"
          /*
            遮罩要足够厚。旧日历上每一列都写着「暂无预约」，而 items 是按
            `currentDate` 过滤的 —— 切换期间新日期还没到，旧数据又对不上号，
            那行字此刻是错的。半透明遮罩挡不住它，用户仍会读到「明天一单都没有」。
          */
          className="absolute inset-0 z-sticky flex items-start justify-center bg-white/80 backdrop-blur-[2px]"
        >
          <span className="mt-24 flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-lg">
            <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
            {t('schedule.loadingTitle')}
          </span>
        </div>
      )}
      <div className="flex-none min-h-16 bg-white border-b border-slate-200 px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 z-10">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          {/*
            触屏下那条 44px 的输入框最小高度落在绝对定位的日期选择器上，它不会
            撑开父容器；父容器只有标题行的高度（约 31px），overflow-hidden 于是
            把可点区域的下缘切掉了 13px。这里给容器补上同样的最小高度，日期
            选择器的整块热区才完整可点。
          */}
          <div className="relative flex min-h-11 items-center group cursor-pointer overflow-hidden rounded-md">
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
              aria-label={t('pickDate')}
            />
          </div>
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
            <Button variant="ghost" size="icon" onClick={handlePrev} className="h-8 w-8 text-slate-500 hover:text-slate-900 cursor-pointer" aria-label={t('schedulePrevDay')}><ChevronLeft className="w-4 h-4" /></Button>
            <button onClick={() => setCurrentDate(todayStr)} className="text-sm font-medium px-2 text-slate-600 hover:text-teal-600 transition-colors">{t('scheduleToday')}</button>
            <Button variant="ghost" size="icon" onClick={handleNext} className="h-8 w-8 text-slate-500 hover:text-slate-900 cursor-pointer" aria-label={t('scheduleNextDay')}><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-end min-w-0">
          {view === 'overview' && (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-600 font-medium bg-white px-3 py-1.5 rounded-lg border border-slate-200 shadow-sm hover:bg-slate-50 transition-colors whitespace-nowrap">
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
                  {!voiceOnly && <option value="rotation">{t('staffFilterRotation')}</option>}
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
          <div className="relative w-32 sm:w-40 lg:w-48 shrink-0">
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
                onClick={() => {
                  if (v === 'week' && view !== 'week' && todayStr) {
                    setCurrentDate(todayStr);
                  }
                  setView(v);
                }}
                className={`px-2.5 sm:px-4 py-1.5 text-sm font-medium rounded-md transition-all whitespace-nowrap ${
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
        {view === 'week' && incompleteWeekDays.length > 0 ? (
          <div className="p-6 space-y-3">{incompleteWeekDays.map(day => <div key={day.date} role={day.error ? 'alert' : 'status'}>
            <p>{day.date} · {t(day.error ? 'schedule.loadErrorTitle' : 'schedule.loadingTitle')}</p>
            {day.error && <Button onClick={() => day.retry()}>{t('retry')}</Button>}
          </div>)}</div>
        ) : view === 'month' && monthSummary.isError ? (
          <PageError title={t('schedule.loadErrorTitle')} error={monthSummary.error} onRetry={() => monthSummary.refetch()} />
        ) : view === 'month' && (monthSummary.isPending || monthSummary.isPlaceholderData) ? (
          <PageLoading layout="calendar" title={t('schedule.loadingTitle')} />
        ) : view === 'month' ? (
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
                  onClick={() => {
                    setCurrentDate(dateStr);
                    setView('overview');
                  }}
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

                  {!summary ? <p>{t('schedule.loadingTitle')}</p> : itemCount > 0 ? (
                    <div className="flex-1 flex flex-col gap-1.5 mt-1 px-1">
                      <div className="text-lg font-bold text-slate-800 tabular-nums leading-none">
                        {summary?.appointments ?? itemCount}
                        <span className="text-[11px] font-medium text-slate-500 ml-1">{t('schedule.monthBookings')}</span>
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
            ? weekDays.map((date) => ({
                id: date,
                name: `${t(getWeekdayKey(date))} ${date.slice(5)}`,
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

          const tableMinWidth = isWeek || isStoreView
            ? '100%'
            : Math.max(1000, columns.length * 200 + 80);

          return (
            <div className="flex w-full" style={{ minWidth: isWeek || isStoreView ? '100%' : `${tableMinWidth}px` }}>
              <div className="w-16 flex-none bg-white border-r border-slate-200 z-50 sticky left-0 flex flex-col">
                <div className="h-[72px] sticky top-0 bg-white border-b border-slate-200 z-50 flex-none" />
                <div className="relative">
                  {/*
                    刻度文字用 `-top-3` 骑在格线上，第一格因此有一半落到上方 ——
                    正好被 sticky 的 72px 表头盖住，平板字号下首个时刻被横着切掉
                    上半截。首行改用 `top-0` 贴在格内：仅此一行与格线的相对位置
                    略有差异，其余刻度的对齐关系不变。
                  */}
                  {timeSlots.map((time, idx) => (
                    <div key={time} className="h-[60px] relative border-b border-transparent">
                      <span className={cn('absolute right-2 text-xs font-medium text-slate-400', idx === 0 ? 'top-0' : '-top-3')}>{time}</span>
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
                      className={`group border-r border-slate-200 relative ${member.id === UNASSIGNED_STAFF_ID ? 'bg-teal-50/20' : ''} transition-all duration-200 ease-out ${
                        isWeek 
                          ? isThisHovered
                            ? 'flex-[3] basis-0 min-w-0 bg-slate-50/30 shadow-lg z-10'
                            : isAnyHovered
                              ? 'flex-[1] basis-0 min-w-0 opacity-80'
                              : 'flex-1 basis-0 min-w-0'
                          : isStoreView
                            ? 'flex-1 min-w-0'
                            : isThisHovered 
                              ? 'flex-[3] min-w-[280px] bg-slate-50/30 shadow-lg z-10' 
                              : isAnyHovered 
                                ? 'flex-[1] min-w-[120px] opacity-80' 
                                : 'flex-[1] min-w-[200px]'
                      }`}
                    >
                      {(() => {
                        const aptCount = memberApts.length;
                        const rev = memberApts.filter(a => a.status === 'completed').reduce((sum, a) => sum + (a.service?.priceCents ?? 0) / 100, 0);
                        return (
                          <div className="h-[72px] bg-white border-b border-slate-200 sticky top-0 z-40 flex flex-col items-center justify-center backdrop-blur-md bg-white/90 shadow-sm relative px-1">
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
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="bg-teal-600 text-white font-bold text-xs px-2 py-0.5 rounded-full shadow-sm whitespace-nowrap">
                                  {member.name}
                                </span>
                                <span className="text-[10px] font-semibold text-teal-600 leading-none">
                                  {t('scheduleToday')}
                                </span>
                              </div>
                            ) : (
                              <span className={`font-semibold text-xs sm:text-sm text-center truncate ${member.id === UNASSIGNED_STAFF_ID ? 'text-teal-600' : 'text-slate-800'}`}>
                                {member.name}
                              </span>
                            )}
                            {!isWeek && member.roleKey && (
                              <span className="text-[10px] text-slate-500">{t(member.roleKey)}</span>
                            )}
                            {aptCount > 0 && (
                              <div className="flex items-center justify-center gap-1.5 mt-1 text-[10px] transform scale-90">
                                <span className="bg-teal-50 text-teal-600 px-1.5 py-0.5 rounded-sm font-semibold">{aptCount} {t('apptCount')}</span>
                                {rev > 0 && <span className="bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded-sm font-semibold">${rev}</span>}
                              </div>
                            )}
                            {aptCount === 0 && <div className="mt-0.5 text-[10px] text-slate-300 font-medium">{t('noAppts')}</div>}
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
                        {timeSlots.map((time, slotIdx) => {
                          const isHour = time.endsWith(':00');
                          const hourNum = parseInt(time.split(':')[0]);
                          const isAlternate = hourNum % 2 === 0;
                          const rawMins = DAY_START + slotIdx * 30;
                          return (
                          <div
                            key={time}
                            className={`h-[60px] border-b ${isHour ? 'border-slate-200' : 'border-slate-100'} ${isAlternate ? 'bg-slate-50/30' : 'bg-transparent'} hover:bg-teal-50/50 cursor-pointer transition-colors relative group/cell`}
                            onClick={() => handleSlotClick(
                              isWeek ? (filterStaffId !== 'all' ? filterStaffId : UNASSIGNED_STAFF_ID) : (isStoreView ? UNASSIGNED_STAFF_ID : member.id),
                              rawMins,
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
                        <div className="absolute left-0 right-0 h-6 z-[15] pointer-events-none flex justify-center" style={{ top: `${Math.max(0, (storeOpenMin - DAY_START) * PIXELS_PER_MIN - 22)}px` }}>
                          <span className="text-[10px] text-emerald-600/70 font-bold tracking-widest uppercase bg-white/80 px-2 rounded-full shadow-sm">{`${minsToTime(storeOpenMin)} ${t('storeOpens')}`}</span>
                        </div>
                        
                        <div className="absolute left-0 right-0 h-[2px] bg-slate-400/30 z-30 pointer-events-none" style={{ top: `${(storeCloseMin - DAY_START) * PIXELS_PER_MIN}px` }} />
                        <div className="absolute left-0 right-0 h-8 bg-gradient-to-t from-slate-200/50 to-transparent z-20 pointer-events-none flex items-end justify-center pb-1" style={{ bottom: `${(DAY_END - storeCloseMin) * PIXELS_PER_MIN}px` }}>
                          <span className="text-[10px] text-slate-500/70 font-bold tracking-widest uppercase bg-white/60 px-2 rounded-full shadow-sm backdrop-blur-sm">{`${minsToTime(storeCloseMin)} ${t('storeCloses')}`}</span>
                        </div>
                        
                        {/* Out of hours blocks overlay */}
                        <div className="absolute left-0 right-0 bg-slate-100/40 pointer-events-none z-10" style={{ top: 0, height: `${(storeOpenMin - DAY_START) * PIXELS_PER_MIN}px` }} />
                        <div className="absolute left-0 right-0 bg-slate-100/40 pointer-events-none z-10" style={{ top: `${(storeCloseMin - DAY_START) * PIXELS_PER_MIN}px`, height: `${(DAY_END - storeCloseMin) * PIXELS_PER_MIN}px` }} />
                        
                        {/* Add Appt Corridor Visual: 仅在员工多列视图展示 */}
                        {!isWeek && !isStoreView && (
                          <div className="absolute top-0 bottom-0 right-0 w-[32px] border-l-2 border-dashed border-teal-200 bg-teal-50/60 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-10 flex flex-col items-center justify-center backdrop-blur-[1px]">
                            <div className="w-[1px] h-full bg-teal-200/50 absolute left-1/2 -translate-x-1/2" />
                            <div className="sticky top-1/2 -translate-y-1/2 flex flex-col items-center gap-6 text-teal-400">
                               <Plus className="w-4 h-4 animate-pulse" />
                               <span className="text-[12px] font-bold tracking-widest text-teal-500 drop-shadow-sm" style={{ writingMode: 'vertical-lr' }}>{t('newApptInGap')}</span>
                               <Plus className="w-4 h-4 animate-pulse" />
                            </div>
                          </div>
                        )}

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

                          const corridorWidth = (!isWeek && !isStoreView) ? 32 : 0;
                          const widthPos = `calc((${apt.span} / ${apt.maxCols}) * (100% - ${corridorWidth}px) - 4px)`;
                          const leftPos = `calc((${apt.col} / ${apt.maxCols}) * (100% - ${corridorWidth}px) + 2px)`;
                          
                          const effectiveCols = apt.maxCols / apt.span;
                          
                          const cardPadding = (effectiveCols >= 3 && !isHovered) ? 'p-1' : (effectiveCols >= 2 && !isHovered) ? 'p-1.5' : 'p-2 sm:p-2.5';
                          const titleSize = (effectiveCols >= 3 && !isHovered) ? 'text-[10px] leading-tight' : 'text-xs sm:text-sm';
                          /*
                           * 疏密此前只看横向重叠列数（effectiveCols），从不看卡片实际有多高。
                           * 时间轴每 30 分钟 60px，因此一单 30 分钟的卡片净高只有 56px，而
                           * 「姓名 + 时间 + 技师与项目」三行连同内边距需要 76px（平板字号下
                           * 接近 97px）—— 项目名被 overflow-hidden 直接裁掉，且因为容器设了
                           * 固定高度，裁掉的部分连滚动都取不回来。
                           *
                           * 这里按卡片净高再分一档：放不下第三行就不渲染第三行。项目名仍可
                           * 通过悬停展开、tooltip 与详情抽屉读到，比渲染出来再被切掉可靠。
                           */
                          const cardHeight = height - 4;
                          const fitsDetailRow = cardHeight >= 88;
                          /*
                           * 再低一档：30 分钟的卡片净高 56px，连「姓名 + 时间」两行都放不下。
                           * 此时把开始时间并进姓名那一行 —— 信息一条不少，只占一行。
                           */
                          const fitsTimeRow = cardHeight >= 68 || isHovered;
                          const showDetails = isStoreView || ((effectiveCols < 3 && fitsDetailRow) || isHovered);
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
                                {!fitsTimeRow && (
                                  <span className="ml-auto shrink-0 text-xs font-medium opacity-90">{apt.startTime}</span>
                                )}
                                {apt.status === 'in_service' && <CheckCircle className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />}
                              </div>
                              {fitsTimeRow && (
                                <div className={`text-xs opacity-90 mt-0.5 ${!isHovered ? 'truncate' : 'whitespace-normal'} flex items-center gap-1`}>
                                  <Clock className="w-3 h-3 shrink-0" /> {apt.startTime} {isHovered && `- ${apt.endTime}`}
                                </div>
                              )}
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

      {confirmModal.isOpen && (
        <Portal>
        <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in">
          <div ref={confirmDialogRef} role="dialog" aria-modal="true" aria-labelledby="sched-confirm-title" tabIndex={-1}>
            <div className={`flex items-center gap-3 mb-4 ${confirmModal.isDanger ? 'text-red-600' : 'text-teal-600'}`}>
              <div className={`p-2 rounded-full ${confirmModal.isDanger ? 'bg-red-100' : 'bg-teal-100'}`}>
                {confirmModal.isDanger ? <AlertTriangle className="w-6 h-6" /> : <HelpCircle className="w-6 h-6" />}
              </div>
              <h3 id="sched-confirm-title" className="text-lg font-bold text-slate-800">{confirmModal.title}</h3>
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
          <div ref={conflictDialogRef} role="dialog" aria-modal="true" aria-labelledby="sched-conflict-title" tabIndex={-1}>
            <div className="flex items-center gap-3 mb-4 text-amber-600">
              <div className="p-2 bg-amber-100 rounded-full"><AlertTriangle className="w-6 h-6" /></div>
              <h3 id="sched-conflict-title" className="text-lg font-bold text-slate-800">{t('conflictTitle')}</h3>
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
              {/* 放行软容量需要 appointment.overbook（AUD-02，服务端字段级判定） */}
              <GuardedButton
                permission="appointment.overbook"
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white rounded-xl shadow-md shadow-amber-200"
                onClick={() => {
                  const pending = conflictModal.pendingConflict;
                  if (!pending) return;
                  const override: Override = { reason: overrideReason };
                  if (pending.retry) pending.retry(override);
                }}
              >
                {t('forceSchedule')}
              </GuardedButton>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* 取消预约：采集标准原因，并强制选择是否保留轮牌 */}
      {cancelModal.isOpen && (
        <Portal>
        <div className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in">
          <div ref={cancelDialogRef} role="dialog" aria-modal="true" aria-labelledby="sched-cancel-title" tabIndex={-1}>
            <h3 id="sched-cancel-title" className="text-lg font-bold text-slate-800 mb-1">{t('cancelAppt')}</h3>
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
