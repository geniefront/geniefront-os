import { useState, useMemo, useEffect } from 'react';
import { useLanguage } from '@/LanguageContext';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import {
  GripVertical,
  SkipForward,
  Coffee,
  UserCheck,
  RotateCcw,
  Sparkles,
  ChevronDown,
  ChevronUp,
  History,
  AlertCircle,
  Clock,
  ArrowUpDown,
  Send,
  Settings,
  LogIn,
  LogOut,
  Calendar,
  Search,
  AlertTriangle,
  Award,
  Zap,
  Info,
  Sliders,
  ShieldCheck,
  Crown,
  Scissors,
  CheckCircle2,
  XCircle,
  ArrowUpToLine,
  ArrowDownToLine,
  User,
  Activity,
  Layers,
  ChevronRight,
  Filter,
  ShieldAlert,
  Receipt,
  FileText,
  Tag,
  Flame,
  ArrowRight,
  MoveDown,
  ArrowRightLeft,
} from 'lucide-react';
import { toast, Spinner } from '@heroui/react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  useRotationQuery,
  useRotationSkip,
  useRotationReorder,
  useRotationSetBreak,
  useRotationAssign,
  useRotationCheckIn,
  useRotationCheckOut,
  useRotationUpdatePolicy,
} from '@/features/rotation/api';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { useErrorMessage } from '@/lib/errorMessage';
import { useSession } from '@/lib/session';
import { instantToWallDate, shiftDate } from '@/lib/time';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import type {
  RotationEntry,
  RotationOverrideReason,
  RotationPolicy,
  FullRotationEvent,
} from '@/features/rotation/types';
import { useBusinessDay } from '@/lib/time';
import type { TranslationKey } from '@/i18n';

// 常用跳过原因预设
const SKIP_REASONS: Array<{ kind: 'no_skill' | 'off'; labelKey: TranslationKey }> = [
  { kind: 'no_skill', labelKey: 'rotation.rotSkipReasonSkillMismatch' },
  { kind: 'off', labelKey: 'rotation.rotSkipReasonAway' },
  { kind: 'no_skill', labelKey: 'rotation.rotSkipReasonLanguage' },
  { kind: 'off', labelKey: 'rotation.rotSkipReasonUnwell' },
];

interface ConfirmModalState {
  title: string;
  description: string;
  confirmText?: string;
  confirmTone?: 'primary' | 'danger' | 'warning' | 'emerald';
  onConfirm: () => Promise<void> | void;
}

interface DragReorderGraphicState {
  movedEntry: RotationEntry;
  fromIndex: number;
  toIndex: number;
  fromPos: number;
  toPos: number;
  beforeList: RotationEntry[];
  afterList: RotationEntry[];
  reason: RotationOverrideReason;
  note: string;
}

function RotationContent() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { membershipId } = useSession();
  // 轮牌是按**营业日**存的（turn_events.business_date）。凌晨那几个小时
  // 用日历日的话，前台会看到一块空板，而昨晚的轮牌顺序其实还在（AUD-13）。
  const { ready: dayReady, today: todayStr, yesterday: yesterdayStr } = useBusinessDay();

  const [selectedDate, setSelectedDate] = useState('');
  useEffect(() => {
    if (!dayReady) return;
    setSelectedDate(todayStr);
  }, [dayReady, todayStr, membershipId]);

  const isToday = !selectedDate || selectedDate === todayStr;

  const { data: rotation, isLoading, error, refetch } = useRotationQuery(
    selectedDate || undefined,
  );

  const skipMutation = useRotationSkip();
  const reorderMutation = useRotationReorder();
  const setBreakMutation = useRotationSetBreak();
  const assignMutation = useRotationAssign();
  const checkInMutation = useRotationCheckIn();
  const checkOutMutation = useRotationCheckOut();
  const updatePolicyMutation = useRotationUpdatePolicy();

  // 本地队列
  const [localEntries, setLocalEntries] = useState<RotationEntry[]>([]);

  // 拖拽状态
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // 拖拽/调位图形化前后对比确认弹窗
  const [dragReorderGraphic, setDragReorderGraphic] = useState<DragReorderGraphicState | null>(null);

  // 技能筛选与搜索
  const [selectedSkillKey, setSelectedSkillKey] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // 历史时间线筛选
  const [timelineTypeFilter, setTimelineTypeFilter] = useState<string>('all');
  const [timelineStaffFilter, setTimelineStaffFilter] = useState<string>('all');
  const [timelineSearchQuery, setTimelineSearchQuery] = useState<string>('');

  // 通用二次防误触确认弹窗
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  // 弹窗状态管理
  const [skipTarget, setSkipTarget] = useState<RotationEntry | null>(null);
  const [skipKind, setSkipKind] = useState<'no_skill' | 'off'>('no_skill');
  const [skipNote, setSkipNote] = useState('');

  const [assignTarget, setAssignTarget] = useState<RotationEntry | null>(null);
  const [assignCustomer, setAssignCustomer] = useState('');
  const [assignServiceName, setAssignServiceName] = useState('');
  const [assignIsRequest, setAssignIsRequest] = useState(false);

  // 考勤打卡弹窗
  const [checkInTarget, setCheckInTarget] = useState<RotationEntry | null>(null);
  const [checkInNote, setCheckInNote] = useState('');
  const [checkOutTarget, setCheckOutTarget] = useState<RotationEntry | null>(null);
  const [checkOutNote, setCheckOutNote] = useState('');

  // 轮牌规则配置弹窗
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);
  const [policyForm, setPolicyForm] = useState<Partial<RotationPolicy>>({});

  // 完整历史流水抽屉
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);

  // 同步服务端数据到本地
  useEffect(() => {
    if (rotation?.entries) {
      setLocalEntries(rotation.entries);
    }
  }, [rotation?.entries]);

  // 全部可用技能集合
  const allSkills = useMemo(() => {
    const map = new Map<string, { key: string; name: string; count: number }>();
    if (rotation?.entries) {
      for (const entry of rotation.entries) {
        for (const sk of entry.skills ?? []) {
          const cur = map.get(sk.key) || { key: sk.key, name: sk.name, count: 0 };
          cur.count++;
          map.set(sk.key, cur);
        }
      }
    }
    return Array.from(map.values());
  }, [rotation?.entries]);

  // 过滤后的技师条目 (支持错别字容错模糊搜索)
  const filteredEntries = useMemo(() => {
    let list = localEntries;
    if (selectedSkillKey !== 'all') {
      list = list.filter((entry) => entry.skills?.some((s) => s.key === selectedSkillKey));
    }
    if (searchQuery.trim()) {
      list = fuzzySearch(list, searchQuery, {
        keys: [
          { name: 'name', weight: 0.6 },
          { name: 'skills.name', weight: 0.25 },
          { name: 'levelName', weight: 0.15 },
        ],
        threshold: 0.45,
      });
    }
    return list;
  }, [localEntries, selectedSkillKey, searchQuery]);

  // 头牌技师
  const nextUpStaff = useMemo(() => {
    if (!rotation?.entries) return null;
    return (
      rotation.entries.find((e) => e.membershipId === rotation.nextUpMembershipId) ||
      rotation.entries.find((e) => (e.position === 0 || e.position === 1) && e.state === 'available') ||
      rotation.entries.find((e) => e.state === 'available') ||
      null
    );
  }, [rotation]);

  // 历史事件与订单数据
  const historicalEvents: FullRotationEvent[] = useMemo(() => {
    if (!rotation?.fullEvents) return [];
    return rotation.fullEvents;
  }, [rotation?.fullEvents]);

  // 历史全天概览指标
  //
  // ⚠️ `e.reason` 是服务端 `packages/rotation/src/engine.ts` 的 `RotationReason`
  // 枚举（'served' / 'request_not_counted' / 'skipped_no_skill' / … 英文
  // snake_case），从来不是中文短语。这里以前拿 '派单'/'点客'/'插队' 这类中文
  // 子串去 `.includes()` 匹配，没有一条枚举值真的包含这些字——四项指标里
  // 三项（派单数、调整数、到店数）一直在计数「零」，只是「skip」恰好和
  // `skipped_*` 沾边、「request」恰好和 `request_not_counted` 沾边才蒙对。
  // 枚举值本身很稳定（是记账口径，不是展示文案），改成精确匹配。
  const historyMetrics = useMemo(() => {
    const totalDispatches = historicalEvents.filter((e) => e.reason === 'served').length;
    const clientRequests = historicalEvents.filter((e) => e.reason === 'request_not_counted').length;
    const totalSkips = historicalEvents.filter((e) => e.reason === 'skipped_no_skill' || e.reason === 'skipped_off').length;
    const totalReorders = historicalEvents.filter((e) => e.reason === 'manual_override').length;
    const totalCheckIns = historicalEvents.filter((e) => e.reason === 'check_in').length;

    return {
      totalEvents: historicalEvents.length,
      totalDispatches,
      clientRequests,
      totalSkips,
      totalReorders,
      totalCheckIns,
    };
  }, [historicalEvents]);

  // 过滤后的时间线事件（分类判据同上：匹配真实的英文枚举值，不是中文子串）
  const filteredTimelineEvents = useMemo(() => {
    return historicalEvents.filter((evt) => {
      if (timelineTypeFilter === 'dispatches' && evt.reason !== 'served') {
        return false;
      }
      if (timelineTypeFilter === 'requests' && evt.reason !== 'request_not_counted') {
        return false;
      }
      if (timelineTypeFilter === 'skips' && evt.reason !== 'skipped_no_skill' && evt.reason !== 'skipped_off') {
        return false;
      }
      if (timelineTypeFilter === 'attendance' && evt.reason !== 'check_in' && evt.reason !== 'check_out') {
        return false;
      }
      if (timelineStaffFilter !== 'all' && evt.staffName !== timelineStaffFilter) {
        return false;
      }
      if (timelineSearchQuery.trim()) {
        const q = timelineSearchQuery.toLowerCase().trim();
        const matchStaff = evt.staffName.toLowerCase().includes(q);
        const matchReason = evt.reason.toLowerCase().includes(q);
        const matchNote = evt.note && evt.note.toLowerCase().includes(q);
        if (!matchStaff && !matchReason && !matchNote) return false;
      }
      return true;
    });
  }, [historicalEvents, timelineTypeFilter, timelineStaffFilter, timelineSearchQuery]);

  // 状态徽章渲染
  const getStatusBadge = (state: RotationEntry['state']) => {
    switch (state) {
      case 'available':
        return (
          <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300 font-bold px-2 py-0.5 text-xs">
            
            {t('rotation.rotStatusIdle')}
          </Badge>
        );
      case 'in_service':
        return (
          <Badge className="bg-amber-100 text-amber-900 border-amber-300 font-bold px-2 py-0.5 text-xs">
            
            {t('rotation.rotStatusBusy')}
          </Badge>
        );
      case 'on_break':
        return (
          <Badge className="bg-blue-100 text-blue-900 border-blue-300 font-bold px-2 py-0.5 text-xs">
            
            {t('rotation.rotStatusBreak')}
          </Badge>
        );
      case 'not_arrived':
        return (
          <Badge className="bg-purple-100 text-purple-900 border-purple-300 font-bold px-2 py-0.5 text-xs">
            
            {t('rotation.rotStatusPendingClockIn')}
          </Badge>
        );
      case 'off':
        return (
          <Badge className="bg-slate-100 text-slate-600 border-slate-300 font-medium px-2 py-0.5 text-xs">
            
            {t('rotation.rotStatusOff')}
          </Badge>
        );
      default:
        return null;
    }
  };

  // ──────────────────────────────────────────────────────────── 拖拽事件与图解确认

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    // 离开时保留指示
  };

  // 拖拽释放时触发图形化二次确认弹窗
  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const movedEntry = localEntries[draggedIndex];
    if (!movedEntry) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    // 构造变动前与变动后的数组用于图解对比
    const beforeList = [...localEntries];
    const afterList = [...localEntries];
    const [item] = afterList.splice(draggedIndex, 1);
    if (item) afterList.splice(targetIndex, 0, item);

    const reorderedAfterList = afterList.map((entry, idx) => ({
      ...entry,
      position: entry.state === 'off' || entry.state === 'not_arrived' ? null : idx + 1,
    }));

    setDraggedIndex(null);
    setDragOverIndex(null);

    // 弹出图解确认弹窗
    setDragReorderGraphic({
      movedEntry,
      fromIndex: draggedIndex,
      toIndex: targetIndex,
      fromPos: draggedIndex + 1,
      toPos: targetIndex + 1,
      beforeList,
      afterList: reorderedAfterList,
      reason: 'desk_coordination',
      note: '',
    });
  };

  // 确认执行图形化排位变动
  const handleConfirmDragReorder = async () => {
    if (!dragReorderGraphic) return;
    const { movedEntry, toPos, afterList, reason, note } = dragReorderGraphic;

    setLocalEntries(afterList);
    setDragReorderGraphic(null);

    try {
      await reorderMutation.mutateAsync({
        membershipId: movedEntry.membershipId,
        toPosition: toPos,
        reason,
        note: note.trim() || undefined,
      });
      toast.success(t('rotation.rotReordered', { p0: movedEntry.name, p1: toPos }));
    } catch (err: any) {
      toast.danger(errorMessage(err));
      if (rotation?.entries) setLocalEntries(rotation.entries);
    }
  };

  // 快捷微调上移 / 下移 / 置顶 / 置底（触发图解确认弹窗）
  const handleQuickShiftWithGraphic = (
    entry: RotationEntry,
    action: 'up' | 'down' | 'top' | 'bottom',
  ) => {
    const currentIndex = localEntries.findIndex((e) => e.membershipId === entry.membershipId);
    if (currentIndex === -1) return;

    let targetIndex = currentIndex;
    if (action === 'up') targetIndex = Math.max(0, currentIndex - 1);
    if (action === 'down') targetIndex = Math.min(localEntries.length - 1, currentIndex + 1);
    if (action === 'top') targetIndex = 0;
    if (action === 'bottom') targetIndex = localEntries.length - 1;

    if (targetIndex === currentIndex) return;

    const beforeList = [...localEntries];
    const afterList = [...localEntries];
    const [movedItem] = afterList.splice(currentIndex, 1);
    if (movedItem) afterList.splice(targetIndex, 0, movedItem);

    const reorderedAfterList = afterList.map((item, idx) => ({
      ...item,
      position: item.state === 'off' || item.state === 'not_arrived' ? null : idx + 1,
    }));

    setDragReorderGraphic({
      movedEntry: entry,
      fromIndex: currentIndex,
      toIndex: targetIndex,
      fromPos: currentIndex + 1,
      toPos: targetIndex + 1,
      beforeList,
      afterList: reorderedAfterList,
      reason: 'desk_coordination',
      note: action === 'top' ? t('rotation.rotQuickTop') : action === 'bottom' ? t('rotation.rotQuickBottom') : t('rotation.rotQuickAdjust'),
    });
  };

  // ──────────────────────────────────────────────────────────── 业务动作

  // 1. 快速派单
  const handleConfirmAssign = async () => {
    if (!assignTarget) return;
    try {
      await assignMutation.mutateAsync({
        membershipId: assignTarget.membershipId,
        isRequest: assignIsRequest,
        customerName: assignCustomer.trim() || undefined,
        note: assignServiceName.trim() ? t('rotation.rotAssignServiceNote', { p0: assignServiceName.trim() }) : undefined,
      });
      toast.success(
        t('rotation.rotAssigned', { p0: assignTarget.name, p1: t(assignIsRequest ? 'rotation.rotRequestedTurnSuffix' : 'rotation.rotRegularTurnSuffix') }),
      );
      setAssignTarget(null);
      setAssignCustomer('');
      setAssignServiceName('');
      setAssignIsRequest(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 2. Pass Turn跳过
  const handleConfirmSkip = async () => {
    if (!skipTarget) return;
    try {
      await skipMutation.mutateAsync({
        membershipId: skipTarget.membershipId,
        kind: skipKind,
        note: skipNote.trim() || t('rotation.rotSkipNoteDefault'),
      });
      toast.success(t('rotation.rotSkipped', { p0: skipTarget.name }));
      setSkipTarget(null);
      setSkipNote('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 3. 申请/结束小休
  const handleToggleBreakWithConfirm = (entry: RotationEntry) => {
    const isCurrentlyOnBreak = entry.state === 'on_break';
    setConfirmModal({
      title: isCurrentlyOnBreak ? t('rotation.rotBreakEndConfirmTitle', { p0: entry.name }) : t('rotation.rotBreakStartConfirmTitle', { p0: entry.name }),
      description: isCurrentlyOnBreak
        ? t('rotation.rotBreakEndConfirmDesc', { p0: entry.name })
        : t('rotation.rotBreakStartConfirmDesc', { p0: entry.name }),
      confirmText: isCurrentlyOnBreak ? t('rotation.rotBreakEndConfirmButton') : t('rotation.rotBreakStartConfirmButton'),
      confirmTone: isCurrentlyOnBreak ? 'emerald' : 'warning',
      onConfirm: async () => {
        try {
          await setBreakMutation.mutateAsync({
            membershipId: entry.membershipId,
            onBreak: !isCurrentlyOnBreak,
            note: !isCurrentlyOnBreak ? t('rotation.rotBreakStartNote') : t('rotation.rotBreakEndNote'),
          });
          toast.success(
            !isCurrentlyOnBreak
              ? t('rotation.rotBreakStart', { p0: entry.name })
              : t('rotation.rotBreakEnd', { p0: entry.name }),
          );
        } catch (err: any) {
          toast.danger(errorMessage(err));
        }
      },
    });
  };

  // 4. 到店签到
  const handleConfirmCheckIn = async () => {
    if (!checkInTarget) return;
    try {
      await checkInMutation.mutateAsync({
        membershipId: checkInTarget.membershipId,
        note: checkInNote.trim() || t('rotation.rotCheckInNoteDefault'),
      });
      toast.success(t('rotation.rotClockedIn', { p0: checkInTarget.name }));
      setCheckInTarget(null);
      setCheckInNote('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 5. 离店打卡
  const handleConfirmCheckOut = async () => {
    if (!checkOutTarget) return;
    try {
      await checkOutMutation.mutateAsync({
        membershipId: checkOutTarget.membershipId,
        note: checkOutNote.trim() || t('rotation.rotCheckOutNoteDefault'),
      });
      toast.success(t('rotation.rotClockedOut', { p0: checkOutTarget.name }));
      setCheckOutTarget(null);
      setCheckOutNote('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 6. 保存轮牌策略
  const handleSavePolicy = async () => {
    try {
      await updatePolicyMutation.mutateAsync(policyForm);
      toast.success(t('rotation.rotPolicySaved'));
      setIsPolicyModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 7. 快捷切换轮牌开启/关闭
  const handleQuickToggleEnabledWithConfirm = () => {
    if (!rotation?.policy) return;
    const nextState = !rotation.policy.enabled;

    setConfirmModal({
      title: nextState ? t('rotation.rotEnableConfirmTitle') : t('rotation.rotDisableConfirmTitle'),
      description: nextState
        ? t('rotation.rotEnableConfirmDesc')
        : t('rotation.rotDisableConfirmDesc'),
      confirmText: nextState ? t('rotation.rotEnableConfirmButton') : t('rotation.rotDisableConfirmButton'),
      confirmTone: nextState ? 'emerald' : 'warning',
      onConfirm: async () => {
        try {
          await updatePolicyMutation.mutateAsync({ enabled: nextState });
          toast.success(nextState ? t('rotation.rotSystemOn') : t('rotation.rotSystemOff'));
        } catch (err: any) {
          toast.danger(errorMessage(err));
        }
      },
    });
  };

  // 执行通用二次确认
  const handleExecuteConfirmModal = async () => {
    if (!confirmModal) return;
    setConfirmPending(true);
    try {
      await confirmModal.onConfirm();
      setConfirmModal(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    } finally {
      setConfirmPending(false);
    }
  };

  if (isLoading && !rotation) {
    return <PageLoading layout="cards" title={t('rotation.rotLoading')} description={t('rotation.rotLoadingDesc')} />;
  }

  if (error && !rotation) {
    return <PageError title={t('rotation.rotLoadError')} error={error} onRetry={refetch} />;
  }

  const isEnabled = rotation?.policy?.enabled ?? true;

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full pb-16">
      {/* 1. Page Header */}
      <PageHeader
        title={t('rotation.rotTitle')}
        description={
          isToday
            ? t('rotation.rotTodayDesc')
            : t('rotation.rotHistoryDesc', { p0: selectedDate })
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsHistoryDrawerOpen(true)}
              className="gap-1.5 text-xs font-semibold"
            >
              <History className="w-3.5 h-3.5 text-slate-600" />
              <span>{t('rotation.rotFullLog')}</span>
            </Button>
            {isToday && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (rotation?.policy) setPolicyForm({ ...rotation.policy });
                  setIsPolicyModalOpen(true);
                }}
                className="gap-1.5 text-xs font-semibold"
              >
                <Settings className="w-3.5 h-3.5 text-slate-600" />
                <span>{t('rotation.rotPolicyConfig')}</span>
              </Button>
            )}
            {isToday && (
              <Button
                className={`${
                  isEnabled
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : 'bg-slate-800 hover:bg-slate-900 text-white'
                } font-bold text-xs shadow-sm gap-1.5`}
                size="sm"
                onClick={handleQuickToggleEnabledWithConfirm}
              >
                <Zap className="w-3.5 h-3.5" />
                <span>{isEnabled ? t('rotation.rotRunning') : t('rotation.rotEnable')}</span>
              </Button>
            )}
          </div>
        }
      />

      {/* 2. Top System Status & Date Navigation Toolbar */}
      <div
        className={`p-4 rounded-2xl border flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-xs transition-all ${
          isToday
            ? isEnabled
              ? 'bg-gradient-to-r from-emerald-50 via-teal-50/50 to-white border-emerald-200'
              : 'bg-gradient-to-r from-slate-100 to-slate-50 border-slate-300'
            : 'bg-gradient-to-r from-indigo-50/80 via-purple-50/40 to-white border-indigo-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold shrink-0 ${
              isToday
                ? isEnabled
                  ? 'bg-emerald-500 text-white shadow-xs'
                  : 'bg-slate-400 text-white'
                : 'bg-indigo-600 text-white shadow-xs'
            }`}
          >
            {isToday ? (
              isEnabled ? (
                <Crown className="w-5 h-5" />
              ) : (
                <RotateCcw className="w-5 h-5" />
              )
            ) : (
              <History className="w-5 h-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-extrabold text-slate-900 text-sm">
                {isToday
                  ? isEnabled
                    ? t('rotation.rotTodayLive')
                    : t('rotation.rotPausedBanner')
                  : t('rotation.rotHistoryBanner', { p0: selectedDate })}
              </h3>
              {isToday && (
                <>
                  <Badge className="bg-white/80 text-slate-700 border-slate-200 text-[11px]">
                    {rotation?.policy?.carryOverNextDay ? t('rotation.rotCarryOverOn') : t('rotation.rotCarryOverOff')}
                  </Badge>
                  <Badge className="bg-white/80 text-slate-700 border-slate-200 text-[11px]">
                    {rotation?.policy?.requestCountsAsTurn ? t('rotation.rotRequestCounts') : t('rotation.rotRequestFree')}
                  </Badge>
                </>
              )}
              {!isToday && (
                <Badge className="bg-indigo-100 text-indigo-900 border-indigo-300 text-[11px] font-bold">
                  
                  {t('rotation.rotArchiveMode')}
                </Badge>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {isToday
                ? t('rotation.rotDragHint')
                : t('rotation.rotTimelineHint')}
            </p>
          </div>
        </div>

        {/* Date Selector with Quick Buttons */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <button
            onClick={() => setSelectedDate(todayStr)}
            className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all ${
              isToday
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            
            {t('rotation.rotTodayTab')}
          </button>
          <button
            onClick={() => setSelectedDate(yesterdayStr)}
            className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all ${
              selectedDate === yesterdayStr
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            
            {t('rotation.rotYesterdayTab')}
          </button>
          <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded-xl border border-slate-200">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="h-7 text-xs font-semibold text-slate-700 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 模式 1: 今日实时轮牌看板 (Today's Live Draggable Rotation)           */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {isToday ? (
        <div className="space-y-4">
          {/* Next-Up Staff Spotlight Hero Card (High Density) */}
          {nextUpStaff && (
            <Card className="border-2 border-emerald-400 bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-white shadow-xs overflow-hidden rounded-2xl">
              <CardContent className="p-3.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center font-black text-xl shadow-xs">
                      {nextUpStaff.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-amber-400 text-amber-950 flex items-center justify-center shadow-xs border border-white">
                      <Crown className="w-3 h-3 fill-amber-950" />
                    </div>
                  </div>

                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-black uppercase tracking-wider bg-emerald-600 text-white px-1.5 py-0.2 rounded shadow-2xs">
                        
                        {t('rotation.rotLeadSlot')}
                      </span>
                      <h3 className="text-base font-black text-slate-900">{nextUpStaff.name}</h3>
                      {nextUpStaff.levelName && (
                        <Badge className="bg-slate-100 text-slate-700 border-slate-200 text-[11px] px-1.5 py-0">
                          {nextUpStaff.levelName}
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs text-slate-600 flex-wrap">
                      <span className="font-semibold text-emerald-900 bg-emerald-100 px-1.5 py-0.2 rounded text-[11px]">
                        
                        {t('rotation.rotTodayTaken')} {nextUpStaff.turns}  {t('rotation.rotOrderUnit')}
                      </span>
                      {nextUpStaff.owed > 0 && (
                        <span className="font-semibold text-amber-900 bg-amber-100 px-1.5 py-0.2 rounded text-[11px]">
                          
                          {t('rotation.rotOwedTurns')} {nextUpStaff.owed}
                        </span>
                      )}
                      <span className="text-slate-400">|</span>
                      <div className="flex items-center gap-1 flex-wrap">
                        {nextUpStaff.skills?.map((sk) => (
                          <span
                            key={sk.key}
                            className="bg-white border border-slate-200 text-slate-700 text-[10px] font-bold px-1.5 py-0 rounded"
                          >
                            {sk.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full md:w-auto justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="text-xs font-bold text-slate-700 hover:bg-slate-100 h-8"
                    onClick={() => {
                      setSkipTarget(nextUpStaff);
                      setSkipKind('no_skill');
                      setSkipNote('');
                    }}
                  >
                    <SkipForward className="w-3.5 h-3.5 text-slate-500 mr-1" />
                    <span>{t('rotation.rotPassTurn')}</span>
                  </Button>

                  <Button
                    variant="secondary"
                    size="sm"
                    className="text-xs font-bold text-blue-700 border-blue-200 hover:bg-blue-50 h-8"
                    onClick={() => handleToggleBreakWithConfirm(nextUpStaff)}
                  >
                    <Coffee className="w-3.5 h-3.5 text-blue-600 mr-1" />
                    <span>{t('rotation.rotTakeBreak')}</span>
                  </Button>

                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs shadow-xs gap-1 px-3 h-8"
                    onClick={() => {
                      setAssignTarget(nextUpStaff);
                      setAssignCustomer('');
                      setAssignServiceName('');
                      setAssignIsRequest(false);
                    }}
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{t('rotation.rotDispatchNow')}</span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Skill Filter Chips & Search Bar */}
          <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
              <button
                onClick={() => setSelectedSkillKey('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                  selectedSkillKey === 'all'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <span>{t('rotation.rotAllStaff')}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    selectedSkillKey === 'all'
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {localEntries.length}
                </span>
              </button>

              {allSkills.map((sk) => (
                <button
                  key={sk.key}
                  onClick={() => setSelectedSkillKey(sk.key)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                    selectedSkillKey === sk.key
                      ? 'bg-teal-600 text-white shadow-xs'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <span>{sk.name}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                      selectedSkillKey === sk.key
                        ? 'bg-teal-700 text-white'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {sk.count}
                  </span>
                </button>
              ))}
            </div>

            <div className="relative w-full sm:w-60">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('rotation.rotSearchPlaceholder')}
                className="w-full h-8.5 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:bg-white transition-all"
              />
            </div>
          </div>

          {/* HTML5 Drag-and-Drop Rotation Queue List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1 text-xs text-slate-500 font-bold">
              <span>
                
                {t('rotation.rotQueueTitlePrefix')} {filteredEntries.length}  {t('rotation.rotQueueTitleSuffix')}
              </span>
              <span className="text-[11px] text-teal-700 font-semibold">
                
                {t('rotation.rotQueueHint')}
              </span>
            </div>

            {filteredEntries.length === 0 ? (
              <div className="p-12 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
                
                {t('rotation.rotNoStaffMatch')}
              </div>
            ) : (
              <div className="space-y-3">
                {filteredEntries.map((entry, index) => {
                  const isFirst = index === 0 && entry.state === 'available';
                  const isDragging = draggedIndex === index;
                  const isOver = dragOverIndex === index;

                  return (
                    <div
                      key={entry.membershipId}
                      draggable
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, index)}
                      className={`group rounded-2xl border transition-all duration-200 relative ${
                        isDragging
                          ? 'opacity-40 scale-95 border-dashed border-teal-500 bg-teal-50'
                          : isOver
                            ? 'border-t-4 border-t-teal-500 bg-teal-50/40 shadow-sm'
                            : isFirst
                              ? 'border-emerald-300 bg-emerald-50/20 shadow-xs'
                              : entry.state === 'available'
                                ? 'border-slate-200 hover:border-slate-300 bg-white shadow-2xs hover:shadow-xs'
                                : 'border-slate-200/80 bg-slate-50/70 opacity-85'
                      }`}
                    >
                      <div className="flex items-stretch">
                        {/* Left: Grip Handle & Shift */}
                        <div className="w-11 bg-slate-50/90 border-r border-slate-200/70 rounded-l-2xl flex flex-col items-center justify-between py-2 text-slate-400 shrink-0 select-none">
                          <button
                            onClick={() => handleQuickShiftWithGraphic(entry, 'up')}
                            disabled={index === 0}
                            className="p-1 hover:text-slate-900 disabled:opacity-20 transition-colors"
                            title={t('rotation.rotMoveUp')}
                          >
                            <ChevronUp className="w-4 h-4" />
                          </button>

                          <div
                            className="p-1.5 rounded cursor-grab active:cursor-grabbing hover:bg-slate-200/60 transition-colors"
                            title={t('rotation.rotDragHandle')}
                          >
                            <GripVertical className="w-4 h-4 text-slate-400 group-hover:text-teal-600 transition-colors" />
                          </div>

                          <button
                            onClick={() => handleQuickShiftWithGraphic(entry, 'down')}
                            disabled={index === filteredEntries.length - 1}
                            className="p-1 hover:text-slate-900 disabled:opacity-20 transition-colors"
                            title={t('rotation.rotMoveDown')}
                          >
                            <ChevronDown className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Main Info */}
                        <div className="flex-1 p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                          <div className="flex items-center gap-4 min-w-0">
                            <div className="relative shrink-0">
                              <div
                                className={`w-11 h-11 rounded-2xl flex items-center justify-center text-base font-black border shadow-2xs ${
                                  isFirst
                                    ? 'bg-emerald-600 text-white border-emerald-700'
                                    : entry.position !== null
                                      ? 'bg-slate-100 text-slate-800 border-slate-200'
                                      : 'bg-slate-100 text-slate-400 border-dashed border-slate-300'
                                }`}
                              >
                                {entry.position !== null ? entry.position + 1 : '—'}
                              </div>
                            </div>

                            <div className="space-y-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h4 className="font-extrabold text-slate-900 text-base leading-tight truncate">
                                  {entry.name}
                                </h4>
                                {entry.levelName && (
                                  <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded border border-slate-200">
                                    {entry.levelName}
                                  </span>
                                )}
                                {getStatusBadge(entry.state)}
                              </div>

                              <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                                <span className="font-semibold text-slate-700">
                                  
                                  {t('rotation.rotDoneToday')} <strong>{entry.turns}</strong>  {t('rotation.rotOrderUnit2')}
                                </span>
                                {entry.owed > 0 && (
                                  <span className="font-bold text-amber-700 bg-amber-50 px-1.5 py-0.2 rounded">
                                    
                                    {t('rotation.rotOwedShort')} {entry.owed}
                                  </span>
                                )}
                                <span>·</span>
                                <span className="text-slate-400">
                                  {entry.arrivedAt
                                    ? t('rotation.rotArrivedAt', { p0: entry.arrivedAt.slice(11, 16) })
                                    : t('rotation.rotPendingClockIn')}
                                </span>
                                <span>·</span>
                                <div className="flex items-center gap-1 flex-wrap">
                                  {entry.skills?.map((sk) => (
                                    <span
                                      key={sk.key}
                                      className="bg-slate-100 text-slate-600 text-[10px] font-medium px-1.5 py-0.2 rounded"
                                    >
                                      {sk.name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Toolbar */}
                          <div className="flex items-center gap-1.5 justify-end shrink-0 flex-wrap">
                            <button
                              onClick={() => handleQuickShiftWithGraphic(entry, 'top')}
                              disabled={index === 0}
                              className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-25"
                              title={t('rotation.rotMoveToTop')}
                            >
                              <ArrowUpToLine className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleQuickShiftWithGraphic(entry, 'bottom')}
                              disabled={index === filteredEntries.length - 1}
                              className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-25"
                              title={t('rotation.rotMoveToBottom')}
                            >
                              <ArrowDownToLine className="w-3.5 h-3.5" />
                            </button>

                            {entry.state === 'not_arrived' && (
                              <Button
                                size="sm"
                                className="bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs"
                                onClick={() => {
                                  setCheckInTarget(entry);
                                  setCheckInNote('');
                                }}
                              >
                                <LogIn className="w-3.5 h-3.5 mr-1" />
                                <span>{t('rotation.rotClockInAction')}</span>
                              </Button>
                            )}

                            {entry.state === 'available' && (
                              <>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="text-xs font-semibold text-slate-700"
                                  onClick={() => {
                                    setSkipTarget(entry);
                                    setSkipKind('no_skill');
                                    setSkipNote('');
                                  }}
                                >
                                  <SkipForward className="w-3.5 h-3.5 mr-1 text-slate-400" />
                                  <span>{t('rotation.rotPassTurn')}</span>
                                </Button>

                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="text-xs font-semibold text-blue-700 border-blue-200 hover:bg-blue-50"
                                  onClick={() => handleToggleBreakWithConfirm(entry)}
                                >
                                  <Coffee className="w-3.5 h-3.5 mr-1 text-blue-600" />
                                  <span>{t('rotation.rotBreakAction')}</span>
                                </Button>

                                <Button
                                  size="sm"
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs"
                                  onClick={() => {
                                    setAssignTarget(entry);
                                    setAssignCustomer('');
                                    setAssignServiceName('');
                                    setAssignIsRequest(false);
                                  }}
                                >
                                  <Send className="w-3.5 h-3.5 mr-1" />
                                  <span>{t('rotation.rotDispatchAction')}</span>
                                </Button>
                              </>
                            )}

                            {entry.state === 'on_break' && (
                              <Button
                                size="sm"
                                className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs"
                                onClick={() => handleToggleBreakWithConfirm(entry)}
                              >
                                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                                <span>{t('rotation.rotEndBreak')}</span>
                              </Button>
                            )}

                            <ActionMenu
                              label={t('rotation.rotStaffActions', { p0: entry.name })}
                              items={[
                                {
                                  id: 'check-in',
                                  label: t('rotation.rotClockIn'),
                                  icon: <LogIn className="w-3.5 h-3.5 text-purple-600" />,
                                  onSelect: () => {
                                    setCheckInTarget(entry);
                                    setCheckInNote('');
                                  },
                                },
                                {
                                  id: 'check-out',
                                  label: t('rotation.rotClockOut'),
                                  icon: <LogOut className="w-3.5 h-3.5 text-slate-600" />,
                                  onSelect: () => {
                                    setCheckOutTarget(entry);
                                    setCheckOutNote('');
                                  },
                                },
                              ]}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─────────────────────────────────────────────────────────────────── */
        /* 模式 2: 历史全天订单与轮牌履历时间线 (Resume-Style Event Timeline) */
        /* ─────────────────────────────────────────────────────────────────── */
        <div className="space-y-6">
          {/* Day Metrics Overview */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Card className="border-indigo-200 bg-indigo-50/40 shadow-xs">
              <CardContent className="p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-900">
                    
                    {t('rotation.rotTotalDispatched')}
                  </p>
                  <h4 className="text-2xl font-black text-indigo-950 mt-0.5">
                    {historyMetrics.totalDispatches}  {t('rotation.rotOrderUnit3')}
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700">
                  <Receipt className="w-5 h-5" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-amber-200 bg-amber-50/40 shadow-xs">
              <CardContent className="p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-amber-900">
                    
                    {t('rotation.rotTotalRequested')}
                  </p>
                  <h4 className="text-2xl font-black text-amber-950 mt-0.5">
                    {historyMetrics.clientRequests}  {t('rotation.rotOrderUnit4')}
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-700">
                  <Flame className="w-5 h-5" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-purple-200 bg-purple-50/40 shadow-xs">
              <CardContent className="p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-purple-900">
                    
                    {t('rotation.rotAttendedStaff')}
                  </p>
                  <h4 className="text-2xl font-black text-purple-950 mt-0.5">
                    {historyMetrics.totalCheckIns || rotation?.entries.length || 0}  {t('rotation.rotPeopleUnit')}
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center text-purple-700">
                  <UserCheck className="w-5 h-5" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white shadow-xs">
              <CardContent className="p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    
                    {t('rotation.rotSkipCount')}
                  </p>
                  <h4 className="text-2xl font-black text-slate-900 mt-0.5">
                    {historyMetrics.totalSkips}  {t('rotation.rotTimesUnit')}
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700">
                  <SkipForward className="w-5 h-5" />
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white shadow-xs">
              <CardContent className="p-3.5 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    
                    {t('rotation.rotReorderCount')}
                  </p>
                  <h4 className="text-2xl font-black text-slate-900 mt-0.5">
                    {historyMetrics.totalReorders}  {t('rotation.rotTimesUnit2')}
                  </h4>
                </div>
                <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-700">
                  <ArrowUpDown className="w-5 h-5" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Timeline Filter Toolbar */}
          <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
              <button
                onClick={() => setTimelineTypeFilter('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                  timelineTypeFilter === 'all'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                
                {t('rotation.rotTabAll')}{historicalEvents.length})
              </button>
              <button
                onClick={() => setTimelineTypeFilter('dispatches')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                  timelineTypeFilter === 'dispatches'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                
                {t('rotation.rotTabDispatch')}{historyMetrics.totalDispatches})
              </button>
              <button
                onClick={() => setTimelineTypeFilter('requests')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                  timelineTypeFilter === 'requests'
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                
                {t('rotation.rotTabRequested')}{historyMetrics.clientRequests})
              </button>
              <button
                onClick={() => setTimelineTypeFilter('skips')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                  timelineTypeFilter === 'skips'
                    ? 'bg-purple-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                
                {t('rotation.rotTabSkips')}{historyMetrics.totalSkips + historyMetrics.totalReorders})
              </button>
              <button
                onClick={() => setTimelineTypeFilter('attendance')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                  timelineTypeFilter === 'attendance'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                
                {t('rotation.rotTabAttendance')}{historyMetrics.totalCheckIns})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={timelineStaffFilter}
                onChange={(e) => setTimelineStaffFilter(e.target.value)}
                className="h-8.5 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700"
              >
                <option value="all">{t('rotation.rotAllStaff2')}</option>
                {rotation?.entries.map((e) => (
                  <option key={e.membershipId} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>

              <div className="relative w-full sm:w-48">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={timelineSearchQuery}
                  onChange={(e) => setTimelineSearchQuery(e.target.value)}
                  placeholder={t('rotation.rotLogSearch')}
                  className="w-full h-8.5 pl-8 pr-2 rounded-xl border border-slate-200 text-xs bg-slate-50 focus:bg-white focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Resume & Event Vertical Timeline Track */}
          {filteredTimelineEvents.length === 0 ? (
            <div className="p-16 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
              <History className="w-10 h-10 mx-auto text-slate-300 mb-2" />
              <p className="font-bold text-slate-700">{t('rotation.rotNoHistory')}</p>
              <p className="text-xs text-slate-400 mt-1">{t('rotation.rotNoHistoryHint')}</p>
            </div>
          ) : (
            <div className="relative pl-6 sm:pl-10 space-y-6 before:absolute before:left-3 sm:before:left-5 before:top-3 before:bottom-3 before:w-0.5 before:bg-slate-200">
              {filteredTimelineEvents.map((evt, idx) => {
                const isDispatch = evt.reason.includes(t('rotation.rotFilterDispatch')) || evt.reason.includes(t('rotation.rotFilterAccepted')) || evt.reason.includes('assigned');
                const isRequest = evt.reason.includes(t('rotation.rotFilterRequested')) || evt.reason.includes('request');
                const isSkip = evt.reason.includes('Pass Turn') || evt.reason.includes('skip');
                const isReorder = evt.reason.includes(t('rotation.rotFilterAdjust')) || evt.reason.includes(t('rotation.rotFilterJump')) || evt.reason.includes('reorder');
                const isCheckIn = evt.reason.includes(t('rotation.rotFilterArrival')) || evt.reason.includes('check_in');
                const isCheckOut = evt.reason.includes(t('rotation.rotFilterDeparture')) || evt.reason.includes('check_out');

                let nodeBg = 'bg-slate-400';
                let cardBorder = 'border-slate-200';
                let badgeStyle = 'bg-slate-100 text-slate-700';

                if (isRequest) {
                  nodeBg = 'bg-amber-500 ring-4 ring-amber-100';
                  cardBorder = 'border-amber-300 bg-amber-50/15';
                  badgeStyle = 'bg-amber-100 text-amber-900 border-amber-300 font-bold';
                } else if (isDispatch) {
                  nodeBg = 'bg-emerald-500 ring-4 ring-emerald-100';
                  cardBorder = 'border-emerald-300 bg-emerald-50/15';
                  badgeStyle = 'bg-emerald-100 text-emerald-900 border-emerald-300 font-bold';
                } else if (isSkip) {
                  nodeBg = 'bg-purple-500 ring-4 ring-purple-100';
                  cardBorder = 'border-purple-200 bg-purple-50/15';
                  badgeStyle = 'bg-purple-100 text-purple-900 border-purple-300 font-bold';
                } else if (isReorder) {
                  nodeBg = 'bg-indigo-500 ring-4 ring-indigo-100';
                  cardBorder = 'border-indigo-200 bg-indigo-50/15';
                  badgeStyle = 'bg-indigo-100 text-indigo-900 border-indigo-300 font-bold';
                } else if (isCheckIn) {
                  nodeBg = 'bg-blue-500 ring-4 ring-blue-100';
                  cardBorder = 'border-blue-200 bg-blue-50/15';
                  badgeStyle = 'bg-blue-100 text-blue-900 border-blue-300 font-bold';
                }

                return (
                  <div key={evt.id || idx} className="relative group">
                    <div
                      className={`absolute -left-6 sm:-left-10 top-4 w-6 h-6 rounded-full ${nodeBg} text-white flex items-center justify-center shadow-xs text-[10px] font-bold z-10 transition-transform group-hover:scale-110`}
                    >
                      {idx + 1}
                    </div>

                    <Card className={`rounded-2xl border-2 transition-all shadow-xs hover:shadow-md ${cardBorder}`}>
                      <CardContent className="p-4.5 space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-lg flex items-center gap-1">
                              <Clock className="w-3 h-3 text-slate-400" />
                              {evt.at.slice(11, 19)}
                            </span>

                            <Badge className={`text-xs px-2 py-0.5 ${badgeStyle}`}>
                              {isRequest
                                ? t('rotation.rotEventRequested')
                                : isDispatch
                                  ? t('rotation.rotEventDispatched')
                                  : isSkip
                                    ? t('rotation.rotEventSkipped')
                                    : isReorder
                                      ? t('rotation.rotEventReordered')
                                      : isCheckIn
                                        ? t('rotation.rotEventClockIn')
                                        : isCheckOut
                                          ? t('rotation.rotEventClockOut')
                                          : t('rotation.rotEventStatus')}
                            </Badge>

                            <div className="flex items-center gap-1.5 font-extrabold text-slate-900 text-sm">
                              <div className="w-5 h-5 rounded-full bg-teal-600 text-white flex items-center justify-center text-[10px]">
                                {evt.staffName.slice(0, 1)}
                              </div>
                              <span>{t('rotation.rotStaffPrefix')}{evt.staffName}】</span>
                            </div>
                          </div>

                          <span className="text-[11px] text-slate-400 font-mono">
                            
                            {t('rotation.rotTurnChange')} {evt.deltaTurns > 0 ? `+${evt.deltaTurns}` : evt.deltaTurns}
                          </span>
                        </div>

                        <div className="text-xs text-slate-700 space-y-1.5">
                          <p className="font-semibold text-slate-900 flex items-center gap-1.5">
                            <span>{t('rotation.rotSituationNote')}</span>
                            <span className="text-slate-800">{evt.reason}</span>
                          </p>

                          {evt.note && (
                            <div className="p-2.5 rounded-xl bg-white border border-slate-200 text-slate-700 space-y-1">
                              <p className="font-medium text-[11px] text-slate-500">
                                
                                {t('rotation.rotFrontDeskNote')}
                              </p>
                              <p className="font-medium">{evt.note}</p>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 弹窗部分 (Modals)                                                  */}
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* 0. 拖拽与排位变动前后顺序图解二次确认 Modal */}
      <Modal
        isOpen={Boolean(dragReorderGraphic)}
        onOpenChange={(open) => {
          if (!open) setDragReorderGraphic(null);
        }}
        size="lg"
        title={t('rotation.rotReorderModalTitle', { p0: dragReorderGraphic?.movedEntry.name ?? '' })}
        footer={
          <div className="flex justify-between items-center w-full">
            <Button
              variant="secondary"
              onClick={() => {
                setDragReorderGraphic(null);
                if (rotation?.entries) setLocalEntries(rotation.entries);
              }}
            >
              
              {t('rotation.rotReorderCancel')}
            </Button>
            <Button
              isPending={reorderMutation.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1"
              onClick={handleConfirmDragReorder}
              disabled={reorderMutation.isPending}
            >
              {reorderMutation.isPending ? t('rotation.rotReorderSubmitting') : t('rotation.rotReorderConfirm')}
            </Button>
          </div>
        }
      >
        {dragReorderGraphic && (
          <div className="space-y-4 py-1 text-xs">
            {/* Diff Summary Callout */}
            <div className="p-3 bg-teal-50 border border-teal-200 rounded-xl text-teal-950 flex items-center justify-between">
              <div>
                <p className="font-extrabold text-sm">
                  
                  {t('rotation.rotStaffPrefix2')}{dragReorderGraphic.movedEntry.name}{t('rotation.rotPositionChange')}
                </p>
                <p className="text-[11px] text-teal-800 mt-0.5">
                  
                  {t('rotation.rotFrom')} <strong>{t('rotation.rotPosPrefix')} {dragReorderGraphic.fromPos}  {t('rotation.rotPosSuffix')}</strong>  {t('rotation.rotTo')}{' '}
                  <strong>{t('rotation.rotPosPrefix2')} {dragReorderGraphic.toPos}  {t('rotation.rotPosSuffix2')}</strong> (
                  {dragReorderGraphic.toPos > dragReorderGraphic.fromPos
                    ? t('rotation.rotMovedBack', { p0: dragReorderGraphic.toPos - dragReorderGraphic.fromPos })
                    : t('rotation.rotMovedForward', { p0: dragReorderGraphic.fromPos - dragReorderGraphic.toPos })}
                  )
                </p>
              </div>
              <div className="w-9 h-9 rounded-xl bg-teal-600 text-white flex items-center justify-center font-bold">
                <ArrowRightLeft className="w-5 h-5" />
              </div>
            </div>

            {/* 1. 图解对比看板 (Before vs After Visual Flow) */}
            <div className="space-y-3 p-3.5 bg-slate-50 border border-slate-200 rounded-2xl">
              {/* 变动前原顺位 */}
              <div>
                <span className="block font-bold text-slate-500 uppercase text-[11px] mb-1.5">
                  
                  {t('rotation.rotBeforeQueue')}
                </span>
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                  {dragReorderGraphic.beforeList.map((entry, idx) => {
                    const isTarget = entry.membershipId === dragReorderGraphic.movedEntry.membershipId;
                    return (
                      <div
                        key={entry.membershipId}
                        className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold shrink-0 flex items-center gap-1.5 ${
                          isTarget
                            ? 'bg-amber-100 border-amber-300 text-amber-950 font-bold ring-2 ring-amber-400'
                            : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      >
                        <span className="w-4 h-4 rounded-full bg-slate-200 text-slate-700 text-[10px] flex items-center justify-center font-mono">
                          {idx + 1}
                        </span>
                        <span>{entry.name}</span>
                        {isTarget && <span className="text-[10px] text-amber-800 font-bold">{t('rotation.rotDragging')}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 调度箭头 */}
              <div className="flex items-center justify-center py-0.5 text-teal-600 font-bold text-xs gap-1">
                <MoveDown className="w-4 h-4 animate-bounce" />
                <span>{t('rotation.rotPredicted')}</span>
              </div>

              {/* 变动后预测顺位 */}
              <div>
                <span className="block font-bold text-teal-800 uppercase text-[11px] mb-1.5">
                  
                  {t('rotation.rotAfterQueue')}
                </span>
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                  {dragReorderGraphic.afterList.map((entry, idx) => {
                    const isTarget = entry.membershipId === dragReorderGraphic.movedEntry.membershipId;
                    return (
                      <div
                        key={entry.membershipId}
                        className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold shrink-0 flex items-center gap-1.5 ${
                          isTarget
                            ? 'bg-emerald-600 border-emerald-700 text-white font-black shadow-sm ring-2 ring-emerald-300'
                            : 'bg-white border-slate-200 text-slate-700'
                        }`}
                      >
                        <span
                          className={`w-4 h-4 rounded-full text-[10px] flex items-center justify-center font-mono ${
                            isTarget ? 'bg-white text-emerald-900 font-bold' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <span>{entry.name}</span>
                        {isTarget && (
                          <span className="text-[10px] bg-emerald-700 px-1 rounded text-white font-bold">
                            
                            {t('rotation.rotNewPosition')}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 原因选择与备注 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">
                  
                  {t('rotation.rotReasonLabel')}
                </label>
                <select
                  value={dragReorderGraphic.reason}
                  onChange={(e) =>
                    setDragReorderGraphic({
                      ...dragReorderGraphic,
                      reason: e.target.value as any,
                    })
                  }
                  className="w-full h-9 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-500"
                >
                  <option value="desk_coordination">{t('rotation.rotReasonDrag')}</option>
                  <option value="guest_requested">{t('rotation.rotReasonRequested')}</option>
                  <option value="owed_makeup">{t('rotation.rotReasonOwed')}</option>
                  <option value="skill_mismatch">{t('rotation.rotReasonSkill')}</option>
                  <option value="other">{t('rotation.rotReasonOther')}</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">
                  
                  {t('rotation.rotReorderNote')}
                </label>
                <Input
                  value={dragReorderGraphic.note}
                  onChange={(e) =>
                    setDragReorderGraphic({
                      ...dragReorderGraphic,
                      note: e.target.value,
                    })
                  }
                  placeholder={t('rotation.rotReasonPlaceholder')}
                />
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* 0.1 通用二次防误触确认 Modal */}
      <Modal
        isOpen={Boolean(confirmModal)}
        onOpenChange={(open) => {
          if (!open) setConfirmModal(null);
        }}
        size="sm"
        title={confirmModal?.title || t('rotation.rotConfirmTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setConfirmModal(null)}>
              {t('cancel') || t('rotation.rotConfirmCancel')}
            </Button>
            <Button
              className={
                confirmModal?.confirmTone === 'danger'
                  ? 'bg-red-600 hover:bg-red-700 text-white font-bold'
                  : confirmModal?.confirmTone === 'emerald'
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white font-bold'
                    : confirmModal?.confirmTone === 'warning'
                      ? 'bg-amber-600 hover:bg-amber-700 text-white font-bold'
                      : 'bg-teal-600 hover:bg-teal-700 text-white font-bold'
              }
              onClick={handleExecuteConfirmModal}
              disabled={confirmPending}
            >
              {confirmPending ? t('rotation.rotProcessing') : confirmModal?.confirmText || t('rotation.rotConfirm')}
            </Button>
          </div>
        }
      >
        <div className="py-2 text-xs text-slate-700 space-y-2">
          <p className="leading-relaxed font-medium">{confirmModal?.description}</p>
        </div>
      </Modal>

      {/* 1. 派单接待 Modal */}
      <Modal
        isOpen={Boolean(assignTarget)}
        onOpenChange={(open) => {
          if (!open) setAssignTarget(null);
        }}
        size="sm"
        title={t('rotation.rotDispatchModalTitle', { p0: assignTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setAssignTarget(null)}>
              {t('cancel') || t('rotation.rotDispatchCancel')}
            </Button>
            <Button
              isPending={assignMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
              onClick={handleConfirmAssign}
              disabled={assignMutation.isPending}
            >
              {assignMutation.isPending ? t('rotation.rotDispatching') : t('rotation.rotDispatchConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-950">
            <p className="font-bold">{t('rotation.rotCurrentPosition')} {assignTarget?.position !== null && assignTarget?.position !== undefined ? assignTarget.position + 1 : '—'}  {t('rotation.rotPosSuffix3')}</p>
            <p className="text-[11px] text-emerald-800 mt-0.5">
              
              {t('rotation.rotDispatchEffect')}
            </p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('rotation.rotGuestNameLabel')}
            </label>
            <Input
              value={assignCustomer}
              onChange={(e) => setAssignCustomer(e.target.value)}
              placeholder={t('rotation.rotGuestNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('rotation.rotServiceLabel')}
            </label>
            <Input
              value={assignServiceName}
              onChange={(e) => setAssignServiceName(e.target.value)}
              placeholder={t('rotation.rotServicePlaceholder')}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="is-request-chk"
              checked={assignIsRequest}
              onChange={(e) => setAssignIsRequest(e.target.checked)}
              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
            />
            <label
              htmlFor="is-request-chk"
              className="text-xs font-semibold text-slate-800 cursor-pointer"
            >
              
              {t('rotation.rotRequestedFlag')}
            </label>
          </div>
        </div>
      </Modal>

      {/* 2. Pass Turn跳过 Modal */}
      <Modal
        isOpen={Boolean(skipTarget)}
        onOpenChange={(open) => {
          if (!open) setSkipTarget(null);
        }}
        size="sm"
        title={t('rotation.rotSkipModalTitle', { p0: skipTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setSkipTarget(null)}>
              {t('cancel') || t('rotation.rotSkipCancel')}
            </Button>
            <Button
              isPending={skipMutation.isPending}
              className="bg-amber-600 hover:bg-amber-700 text-white font-bold"
              onClick={handleConfirmSkip}
              disabled={skipMutation.isPending}
            >
              {skipMutation.isPending ? t('rotation.rotSkipSubmitting') : t('rotation.rotSkipConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-950">
            <p className="font-bold">{t('rotation.rotSkipEffect')}</p>
          </div>

          <div>
            <span className="block font-bold text-slate-700 uppercase mb-1.5">
              
              {t('rotation.rotSkipReasonLabel')}
            </span>
            <div className="space-y-1.5">
              {SKIP_REASONS.map((r) => {
                const label = t(r.labelKey);
                return (
                  <button
                    key={r.labelKey}
                    type="button"
                    onClick={() => {
                      setSkipKind(r.kind);
                      setSkipNote(label);
                    }}
                    className={`w-full text-left p-2 rounded-xl border text-xs font-medium transition-all ${
                      skipNote === label
                        ? 'bg-amber-500 text-white border-amber-600 font-bold'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('rotation.rotSkipNoteLabel')}
            </label>
            <Input
              value={skipNote}
              onChange={(e) => setSkipNote(e.target.value)}
              placeholder={t('rotation.rotSkipNotePlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 3. 到店签到打卡 Modal */}
      <Modal
        isOpen={Boolean(checkInTarget)}
        onOpenChange={(open) => {
          if (!open) setCheckInTarget(null);
        }}
        size="sm"
        title={t('rotation.rotClockInModalTitle', { p0: checkInTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setCheckInTarget(null)}>
              {t('cancel') || t('rotation.rotClockInCancel')}
            </Button>
            <Button
              isPending={checkInMutation.isPending}
              className="bg-purple-600 hover:bg-purple-700 text-white font-bold"
              onClick={handleConfirmCheckIn}
              disabled={checkInMutation.isPending}
            >
              
              {t('rotation.rotClockInConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl text-purple-950">
            <p className="font-bold">{t('rotation.rotClockInUse')}</p>
            <p className="text-[11px] text-purple-800 mt-0.5">
              
              {t('rotation.rotClockInEffect')}
            </p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('rotation.rotClockInNoteLabel')}
            </label>
            <Input
              value={checkInNote}
              onChange={(e) => setCheckInNote(e.target.value)}
              placeholder={t('rotation.rotClockInNotePlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 4. 离店打卡下班 Modal */}
      <Modal
        isOpen={Boolean(checkOutTarget)}
        onOpenChange={(open) => {
          if (!open) setCheckOutTarget(null);
        }}
        size="sm"
        title={t('rotation.rotClockOutModalTitle', { p0: checkOutTarget?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setCheckOutTarget(null)}>
              {t('cancel') || t('rotation.rotClockOutCancel')}
            </Button>
            <Button
              isPending={checkOutMutation.isPending}
              className="bg-slate-800 hover:bg-slate-900 text-white font-bold"
              onClick={handleConfirmCheckOut}
              disabled={checkOutMutation.isPending}
            >
              
              {t('rotation.rotClockOutConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="p-3 bg-slate-100 border border-slate-200 rounded-xl text-slate-800">
            <p className="font-bold">{t('rotation.rotClockOutEffect')}</p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('rotation.rotHandoverNoteLabel')}
            </label>
            <Input
              value={checkOutNote}
              onChange={(e) => setCheckOutNote(e.target.value)}
              placeholder={t('rotation.rotHandoverNotePlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 5. 轮牌策略配置 Modal */}
      <Modal
        isOpen={isPolicyModalOpen}
        onOpenChange={setIsPolicyModalOpen}
        size="md"
        title={t('rotation.rotPolicyModalTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setIsPolicyModalOpen(false)}>
              {t('cancel') || t('rotation.rotPolicyCancel')}
            </Button>
            <Button
              isPending={updatePolicyMutation.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleSavePolicy}
              disabled={updatePolicyMutation.isPending}
            >
              {updatePolicyMutation.isPending ? t('rotation.rotPolicySaving') : t('rotation.rotPolicySave')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
            <div>
              <p className="font-bold text-slate-900">{t('rotation.rotPolicyEnable')}</p>
              <p className="text-[11px] text-slate-500">{t('rotation.rotPolicyEnableDesc')}</p>
            </div>
            <input
              type="checkbox"
              checked={policyForm.enabled ?? true}
              onChange={(e) => setPolicyForm({ ...policyForm, enabled: e.target.checked })}
              className="w-5 h-5 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
            <div>
              <p className="font-bold text-slate-900">{t('rotation.rotPolicyCarryOver')}</p>
              <p className="text-[11px] text-slate-500">
                
                {t('rotation.rotPolicyCarryOverDesc')}
              </p>
            </div>
            <input
              type="checkbox"
              checked={policyForm.carryOverNextDay ?? true}
              onChange={(e) =>
                setPolicyForm({ ...policyForm, carryOverNextDay: e.target.checked })
              }
              className="w-5 h-5 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
            <div>
              <p className="font-bold text-slate-900">{t('rotation.rotPolicyRequestCounts')}</p>
              <p className="text-[11px] text-slate-500">
                
                {t('rotation.rotPolicyRequestCountsDesc')}
              </p>
            </div>
            <input
              type="checkbox"
              checked={policyForm.requestCountsAsTurn ?? false}
              onChange={(e) =>
                setPolicyForm({ ...policyForm, requestCountsAsTurn: e.target.checked })
              }
              className="w-5 h-5 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
            <div>
              <p className="font-bold text-slate-900">{t('rotation.rotPolicyOwedPriority')}</p>
              <p className="text-[11px] text-slate-500">
                
                {t('rotation.rotPolicyOwedPriorityDesc')}
              </p>
            </div>
            <input
              type="checkbox"
              checked={policyForm.owedTurnPriority ?? true}
              onChange={(e) =>
                setPolicyForm({ ...policyForm, owedTurnPriority: e.target.checked })
              }
              className="w-5 h-5 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
            />
          </div>
        </div>
      </Modal>

      {/* 6. 全量变动日志抽屉 */}
      <Modal
        isOpen={isHistoryDrawerOpen}
        onOpenChange={setIsHistoryDrawerOpen}
        size="lg"
        title={t('rotation.rotLogModalTitle')}
        footer={
          <div className="flex justify-end w-full">
            <Button variant="secondary" onClick={() => setIsHistoryDrawerOpen(false)}>
              
              {t('rotation.rotLogClose')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-2xl">
            {historicalEvents.length > 0 ? (
              historicalEvents.map((evt) => (
                <div key={evt.id} className="p-3 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center justify-between">
                    <strong className="text-slate-900 text-xs">{evt.staffName}</strong>
                    <span className="text-[11px] font-mono text-slate-400">
                      {evt.at.slice(11, 19)}
                    </span>
                  </div>
                  <p className="text-slate-700 font-medium mt-0.5">{evt.reason}</p>
                  {evt.note && <p className="text-[11px] text-slate-400 mt-0.5">{evt.note}</p>}
                </div>
              ))
            ) : (
              <div className="p-8 text-center text-slate-400">{t('rotation.rotNoLogs')}</div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function Rotation() {
  return (
    <ErrorBoundary fallbackTitleKey="rotation">
      <RotationContent />
    </ErrorBoundary>
  );
}
