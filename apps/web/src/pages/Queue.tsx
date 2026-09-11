import { useState, useMemo, useRef, useEffect } from 'react';
import { asCents } from '@gf/contracts';
import { useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import { useOpenInternalRoute } from '@/lib/navigation';
import { toast, Spinner } from '@heroui/react';
import { CalendarDays, Clock, UserCheck, AlertTriangle, FileWarning, Plus, RotateCcw, Sparkles, CreditCard, Scissors, Search, Filter, BedDouble, CheckCircle, Check, User, DollarSign, QrCode, Copy } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { UNASSIGNED_STAFF_ID, toScheduleItem } from '@/context/ScheduleContext';
import { useDaySnapshot } from '@/features/schedule/api';
import { useSession } from '@/lib/session';
import { nowWallHhMm, formatIsoWallClock } from '@/lib/time';
import { queueTicketItems } from '@/features/queue/ticketItems';
import { completedCardClock } from '@/features/queue/completedClock';
import { cn, formatI18n, formatPhoneDisplay } from '@/lib/utils';
import type { DayStaff } from '@/features/schedule/types';
import { useJoinQueue, useQueue, useRollbackQueueStage, useUpdateQueueEntry } from '@/features/queue/api';
import { useAddTicketItem, useFinishTicketItem, useMoveTicketItemResource, useMoveTicketItemStaff, useOpenTicket, useSaveServiceNote, useStartTicketItem, useTicketsList, useVoidTicket, isOverbookConfirmable, overbookDetail } from '@/features/tickets/api';
import { OVERRIDE_REASONS } from '@/features/schedule/api';
import type { Override, OverrideReason } from '@/features/schedule/api';
import { useCloseTicket, useOpenTickets, centsToDollars, dollarsToCents } from '@/features/checkout/api';
import { paymentStageFor } from '@/features/checkout/types';
import type { PaymentStage } from '@/features/checkout/types';
import { queueNextAction } from '@/features/queue/nextAction';
import { rotationRank } from '@/features/queue/rotationRank';
import type { QueueNextAction } from '@/features/queue/nextAction';
import { buildCheckoutStaffList, computeCheckoutTotals, UNRESOLVED_STAFF_KEY } from '@/features/queue/checkoutMath';
import { useBeginCleaning, useCompleteCleaning, useRoomsQuery } from '@/features/rooms/api';
import { useDayCloseQuery } from '@/features/dayclose/api';
import { settledRevenueCents } from '@/features/queue/kanbanMetrics';
import { completeQueueService, resolveQueueRoomId } from '@/features/queue/completeService';
import { pickDefaultRoomId, roomSeatability } from '@/features/queue/roomAvailability';
import { inlineGiftCardFields } from '@/features/queue/inlinePayment';
import { useRotationQuery, useRotationCheckIn, useRotationCheckOut, useRotationSetBreak } from '@/features/rotation/api';
import type { RotationEntryState } from '@/features/rotation/types';
import type { QueueEntry } from '@/features/queue/types';
import type { ScheduleItem } from '@/context/ScheduleContext';
import type { VoidReason } from '@/features/tickets/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { useSplitBundleInstance } from '@/features/bundles/api';
import { WalkInBundleModal, type WalkInBundleSubmit } from './queue/modals/WalkInBundleModal';
import type { TicketBundle } from '@/features/tickets/types';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { QRCodeZoomModal } from '@/components/QRCodeZoomModal';
import { useCanWrite } from '@/lib/permissions';
import { useErrorMessage } from '@/lib/errorMessage';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import type { TranslationKey } from '@/i18n';
import type { FormShareResult } from '@/features/forms/api';
import { useShareForm } from '@/features/forms/api';
import { generateAiHealthSummary } from '@/features/forms/mockData';
import { useAddAppointmentItem, useAppointmentFormsQuery, useHealthFormSubmissionQuery, useSaveAppointmentServiceBrief } from '@/features/schedule/appointmentDetail';
import { useLocationTechPresence } from '@/features/tech/lib/useLocationTechPresence';
import { rankStaffCandidates } from '@/features/queue/assignment';
import { useBusinessDay } from '@/lib/time';


/*
 * 看板的静态模型已搬到 ./queue/model —— 泳道配置、标签选项、卡片形态与
 * 几个纯判定与 React 状态无关，不该混在页面文件里。
 * 下面这组 re-export 保持既有的对外签名不变（`canRollbackTo` 等已被其它
 * 模块与文档引用）。
 */
export type { TagOption, KanbanStage, RollbackTargetStage, AddOnItem, KanbanItem } from './queue/model';
export {
  CONTRAINDICATION_NONE, CONTRAINDICATION_TAGS, FOCUS_AREA_TAGS,
  AVOID_AREA_NONE, AVOID_AREA_TAGS, AROMA_OIL_OPTIONS, AROMA_OIL_DEFAULT,
  STRENGTH_OPTIONS, STRENGTH_DEFAULT, STAGE_ORDER, STAGE_NAME_KEYS,
  canRollbackTo, hasPendingForms,
} from './queue/model';

import { ROLLBACK_REASONS, PAYMENT_METHOD_LABEL_KEYS, CONTRAINDICATION_NONE, CONTRAINDICATION_TAGS, FOCUS_AREA_TAGS, AVOID_AREA_NONE, AVOID_AREA_TAGS, AROMA_OIL_OPTIONS, AROMA_OIL_DEFAULT, STRENGTH_OPTIONS, STRENGTH_DEFAULT, STAGE_ORDER, STAGE_NAME_KEYS, canRollbackTo, hasPendingForms } from './queue/model';
import type { TagOption, KanbanStage, KanbanItem, AddOnItem } from './queue/model';
import { AttendanceModal } from './queue/AttendanceModal';
import { KanbanBoard } from './queue/KanbanBoard';
import { RoomsQuickModal, roomNeedsCleaning } from './queue/RoomsQuickModal';
import { CheckInModal } from './queue/modals/CheckInModal';
import { CheckoutModal } from './queue/modals/CheckoutModal';
import { StartServiceModal } from './queue/modals/StartServiceModal';
import { CompleteServiceModal } from './queue/modals/CompleteServiceModal';
import { RollbackStageModal } from './queue/modals/RollbackStageModal';
import { VoidTicketModal } from './queue/modals/VoidTicketModal';
import { TicketItemActionModal } from './queue/modals/TicketItemActionModal';

function QueueContent() {
  const errorMessage = useErrorMessage();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const openInternalRoute = useOpenInternalRoute();
  const [searchParams, setSearchParams] = useSearchParams();
  // 预约详情抽屉「在看板处理」深链过来时带 ?focus=<appointmentId>，
  // 用它把对应卡片滚进视野并高亮；高亮约 4s 后自行淡出（清掉 query）。
  const focusApptId = searchParams.get('focus');
  useEffect(() => {
    if (!focusApptId) return;
    const timer = window.setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('focus');
        return next;
      }, { replace: true });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [focusApptId, setSearchParams]);
  const { openAppointment, openCreateAppointment } = useOutletContext<{
    setRightDrawerOpen: (open: boolean) => void;
    openAppointment?: (id?: string | null, status?: 'booked' | 'checked_in' | 'in_service' | 'done') => void;
    openCreateAppointment?: (options?: any) => void;
  }>();

  const { context } = useSession();
  const timezone = context?.timezone || 'America/New_York';
  // 排队/操作板锁定「今天」= 营业日的今天（AUD-13）。
  const { today: todayDate } = useBusinessDay();
  const checkInBriefByAppointment = useRef(new Map<string, string>());
  const { data: todaySnapshot, isLoading: scheduleLoading, refetch: refetchSchedule } = useDaySnapshot(todayDate);

  const services = useMemo(() => todaySnapshot?.services ?? [], [todaySnapshot]);

  const staff = useMemo<DayStaff[]>(() => {
    const real = (todaySnapshot?.staff ?? []).filter((s) => s.isBookable);
    return [
      {
        membershipId: UNASSIGNED_STAFF_ID,
        name: '',
        isBookable: true,
        inRotation: false,
        maxConcurrent: Number.MAX_SAFE_INTEGER,
        color: null,
        levelName: null,
        skills: [],
      },
      ...real,
    ];
  }, [todaySnapshot]);

  const items = useMemo<ScheduleItem[]>(() => {
    if (!todaySnapshot) return [];
    const servicesById = new Map(todaySnapshot.services.map((sv) => [sv.id, sv]));
    return todaySnapshot.items.map((item) => toScheduleItem(item, todaySnapshot, servicesById, { service: t('service'), customer: t('customer') }));
  }, [todaySnapshot, t]);
  const { data: queue, isLoading: queueLoading, isError: queueError, error: queueErr, isFetching: queueFetching, refetch: refetchQueue } = useQueue();
  const { data: ticketsData, isLoading: ticketsLoading, refetch: refetchTickets } = useTicketsList();
  const { data: dayCloseData } = useDayCloseQuery(todayDate);
  const { data: roomsData, isLoading: roomsLoading, refetch: refetchRooms } = useRoomsQuery();
  const { data: rotationData, isLoading: rotationLoading, refetch: refetchRotation } = useRotationQuery();
  const onlineTechIds = useLocationTechPresence();
  const closeTicketMutation = useCloseTicket();
  const voidTicketMutation = useVoidTicket();
  const moveItemStaffMutation = useMoveTicketItemStaff();
  const moveItemResourceMutation = useMoveTicketItemResource();
  const openTicketMutation = useOpenTicket();
  const addTicketItemMutation = useAddTicketItem();
  const startTicketItemMutation = useStartTicketItem();
  const finishTicketItemMutation = useFinishTicketItem();
  const saveServiceNoteMutation = useSaveServiceNote();
  const splitBundleMutation = useSplitBundleInstance();
  const [splitTarget, setSplitTarget] = useState<{ ticketId: string; bundle: TicketBundle } | null>(null);
  const beginCleaningMutation = useBeginCleaning();
  const completeCleaningMutation = useCompleteCleaning();
  /* 看板上的房间快捷清理。cleaningRoomId 只用于逐行 spinner，不锁死整个面板。 */
  const [isRoomsPanelOpen, setIsRoomsPanelOpen] = useState(false);
  const [cleaningRoomId, setCleaningRoomId] = useState<string | null>(null);
  const shareFormMutation = useShareForm();
  const [formShares, setFormShares] = useState<Record<string, FormShareResult>>({});

  const checkInRotationMutation = useRotationCheckIn();
  const checkOutRotationMutation = useRotationCheckOut();
  const setBreakRotationMutation = useRotationSetBreak();
  const [isStaffAttendanceModalOpen, setIsStaffAttendanceModalOpen] = useState(false);
  const [staffAttendanceSearch, setStaffAttendanceSearch] = useState('');
  const [actingAttendanceStaffId, setActingAttendanceStaffId] = useState<string | null>(null);

  const handleStaffAttendanceCheckIn = async (staffMember: { membershipId: string; name: string }) => {
    try {
      setActingAttendanceStaffId(staffMember.membershipId);
      await checkInRotationMutation.mutateAsync({
        membershipId: staffMember.membershipId,
        note: '前台代签到',
      });
      toast.success(t('queue.quStaffClockInSuccess', { p0: staffMember.name }));
      void refetchRotation();
    } catch (err: any) {
      toast.danger(errorMessage(err));
    } finally {
      setActingAttendanceStaffId(null);
    }
  };

  const handleStaffAttendanceCheckOut = async (staffMember: { membershipId: string; name: string }) => {
    try {
      setActingAttendanceStaffId(staffMember.membershipId);
      await checkOutRotationMutation.mutateAsync({
        membershipId: staffMember.membershipId,
        note: '前台代打卡',
      });
      toast.success(t('queue.quStaffClockOutSuccess', { p0: staffMember.name }));
      void refetchRotation();
    } catch (err: any) {
      toast.danger(errorMessage(err));
    } finally {
      setActingAttendanceStaffId(null);
    }
  };

  const handleStaffAttendanceBreak = async (
    staffMember: { membershipId: string; name: string },
    onBreak: boolean,
  ) => {
    try {
      setActingAttendanceStaffId(staffMember.membershipId);
      await setBreakRotationMutation.mutateAsync({
        membershipId: staffMember.membershipId,
        onBreak,
        note: onBreak ? '临时小休' : '结束休息',
      });
      toast.success(
        onBreak
          ? t('queue.quStaffStartBreakSuccess', { p0: staffMember.name })
          : t('queue.quStaffEndBreakSuccess', { p0: staffMember.name }),
      );
      void refetchRotation();
    } catch (err: any) {
      toast.danger(errorMessage(err));
    } finally {
      setActingAttendanceStaffId(null);
    }
  };

  const isInitialLoading = (queueLoading && scheduleLoading) && !queue;

  const join = useJoinQueue();
  const update = useUpdateQueueEntry();
  const rollbackStageMutation = useRollbackQueueStage();
  const canManage = useCanWrite('queue.manage');
  /*
   * 作废是管理动作，前台默认没有该权限。按权限决定「画不画」——
   * 亮着却点出 403 的按钮，在门店里会被当成系统故障。
   */
  const canVoidTicket = useCanWrite('ticket.void');
  const canOpenTicket = useCanWrite('ticket.write');
  /**
   * walk-in 直接开单（组合套餐）弹窗（U10 / 计划 §7）。
   *
   * 打开时生成一次 `attemptKey`，作为本次开单幂等键的一部分 —— 见
   * `handleOpenWalkInBundle`。
   */
  const [walkInBundle, setWalkInBundle] = useState<{ isOpen: boolean; attemptKey: string }>(
    { isOpen: false, attemptKey: '' },
  );

  const [isRefreshing, setIsRefreshing] = useState(false);

  const getFormShare = async (item: KanbanItem) => {
    const existing = formShares[item.id];
    if (existing) return existing;
    const created = await shareFormMutation.mutateAsync({
      customerId: null,
      appointmentId: item.appointmentId ?? null,
      locale: language,
    });
    setFormShares((current) => ({ ...current, [item.id]: created }));
    return created;
  };

  const openFormQr = async (item: KanbanItem) => {
    try {
      const created = await getFormShare(item);
      setQrZoomModal({
        isOpen: true,
        url: created.url,
        customerName: item.customerName,
        phone: item.phone || undefined,
        serviceName: item.serviceName,
      });
    } catch (error) { toast.danger(errorMessage(error)); }
  };

  const copyFormLink = async (item: KanbanItem) => {
    try {
      const created = await getFormShare(item);
      await navigator.clipboard.writeText(created.url);
      toast.success(t('queue.quFormLinkCopied'));
    } catch (error) { toast.danger(errorMessage(error)); }
  };

  const rooms = roomsData?.rooms ?? [];
  const roomsNeedingCleaning = rooms.filter(roomNeedsCleaning).length;
  const rotationEntries = rotationData?.entries ?? [];

  // Top 3 On-Duty Technicians in Rotation
  const top3Rotation = useMemo(() => {
    return [...rotationEntries]
      .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 3);
  }, [rotationEntries]);
  const orderedRotationEntries = useMemo(() => (
    [...rotationEntries].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER))
  ), [rotationEntries]);

  // 运营看板技师考勤打卡与轮牌队列（严格按轮牌顺位排序）
  const allStaffAttendance = useMemo(() => {
    const entriesMap = new Map<string, (typeof rotationEntries)[number]>();
    for (const entry of rotationEntries) {
      entriesMap.set(entry.membershipId, entry);
    }

    const list: Array<{
      membershipId: string;
      name: string;
      state: RotationEntryState;
      position: number | null;
      turns: number;
      owed: number;
      arrivedAt: string | null;
      leftAt: string | null;
      levelName?: string | null;
    }> = [];

    for (const entry of rotationEntries) {
      list.push({
        membershipId: entry.membershipId,
        name: entry.name,
        state: entry.state,
        position: entry.position,
        turns: entry.turns ?? 0,
        owed: entry.owed ?? 0,
        arrivedAt: entry.arrivedAt,
        leftAt: entry.leftAt,
        levelName: entry.levelName,
      });
    }

    for (const s of staff) {
      if (s.membershipId === UNASSIGNED_STAFF_ID) continue;
      if (!entriesMap.has(s.membershipId)) {
        list.push({
          membershipId: s.membershipId,
          name: s.name,
          state: 'not_arrived',
          position: null,
          turns: 0,
          owed: 0,
          arrivedAt: null,
          leftAt: null,
          levelName: s.levelName,
        });
      }
    }

    // 轮牌顺位排序：在岗轮牌中的技师严格按 position (1, 2, 3...) 排在前面；未到店/已下班排在后面
    list.sort((a, b) => {
      const aOnDuty = a.state === 'available' || a.state === 'in_service' || a.state === 'on_break';
      const bOnDuty = b.state === 'available' || b.state === 'in_service' || b.state === 'on_break';
      if (aOnDuty && !bOnDuty) return -1;
      if (!aOnDuty && bOnDuty) return 1;

      if (aOnDuty && bOnDuty) {
        const posA = a.position ?? 9999;
        const posB = b.position ?? 9999;
        if (posA !== posB) return posA - posB;
      }
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [rotationEntries, staff]);

  const filteredStaffAttendance = useMemo(() => {
    if (!staffAttendanceSearch.trim()) return allStaffAttendance;
    const q = staffAttendanceSearch.trim().toLowerCase();
    return allStaffAttendance.filter((s) => s.name.toLowerCase().includes(q));
  }, [allStaffAttendance, staffAttendanceSearch]);

  const onDutyStaff = useMemo(() => (
    filteredStaffAttendance.filter((s) => s.state === 'available' || s.state === 'in_service' || s.state === 'on_break')
  ), [filteredStaffAttendance]);

  const offDutyStaff = useMemo(() => (
    filteredStaffAttendance.filter((s) => s.state === 'off' || s.state === 'not_arrived')
  ), [filteredStaffAttendance]);

  const nextUpStaff = useMemo(() => {
    if (onDutyStaff.length === 0) return null;
    if (rotationData?.nextUpMembershipId) {
      const found = onDutyStaff.find((s) => s.membershipId === rotationData.nextUpMembershipId);
      if (found && found.state === 'available') return found;
    }
    return onDutyStaff.find((s) => s.state === 'available') ?? null;
  }, [onDutyStaff, rotationData?.nextUpMembershipId]);

  const attendanceMetrics = useMemo(() => {
    const total = allStaffAttendance.length;
    const onDuty = allStaffAttendance.filter(
      (s) => s.state === 'available' || s.state === 'in_service' || s.state === 'on_break',
    ).length;
    const available = allStaffAttendance.filter((s) => s.state === 'available').length;
    const onBreak = allStaffAttendance.filter((s) => s.state === 'on_break').length;
    const inService = allStaffAttendance.filter((s) => s.state === 'in_service').length;
    const off = allStaffAttendance.filter((s) => s.state === 'off' || s.state === 'not_arrived').length;
    return { total, onDuty, available, onBreak, inService, off };
  }, [allStaffAttendance]);

  /*
   * 顶部的「空位 X/Y」。口径必须与入座弹窗里那个工位下拉框完全一致 ——
   * 只看 `status === 'available'` 会把还挂着待清洁占用、或并发已满的工位
   * 也算进空位，前台照着这个数去安排客人，到确认那一步才被服务端拒绝。
   */
  const availableRooms = useMemo(
    () => rooms.filter((room) => roomSeatability(room) === 'seatable'),
    [rooms],
  );
  const availableRoomsCount = availableRooms.length;
  const totalRoomsCount = rooms.length;

  // Search and Filter State
  const [searchTerm, setSearchTerm] = useState('');
  const [staffFilter, setStaffFilter] = useState('all');

  // Drag and Drop Active Tracking
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<KanbanStage | null>(null);

  // 1. Check-In Modal (Step 1 -> Step 2: Booked -> Waiting)
  const [checkInModal, setCheckInModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    qrScanned: boolean;
    contraindications: string[];
    massageStrength: string;
    aromaOil: string;
    focusAreas: string[];
    avoidAreas: string[];
    selectedAddOnId: string;
    addOnStaffId: string;
    notes: string;
    /**
     * 本次签到尝试的幂等键前缀。理由同入座弹窗的 `attemptKey`：现场加项的键
     * 此前是 `queue-checkin-addon-<预约号>-<服务>`，永久固定 —— 客人真要同一
     * 个加项来两份时，第二份会被服务端判为重放而静默吞掉，前台完全看不出来。
     */
    attemptKey: string;
  }>({
    isOpen: false,
    item: null,
    qrScanned: false,
    contraindications: [CONTRAINDICATION_NONE],
    massageStrength: STRENGTH_DEFAULT,
    aromaOil: AROMA_OIL_DEFAULT,
    focusAreas: [],
    avoidAreas: [AVOID_AREA_NONE],
    selectedAddOnId: '',
    addOnStaffId: '',
    notes: '',
    attemptKey: '',
  });
  const checkInFormsQ = useAppointmentFormsQuery(checkInModal.item?.appointmentId ?? null);
  /*
   * 签到时录入的接待要点写入预约的「服务前须知」——技师端与入座弹窗读的都是这一份，
   * 因此不需要新增存储，前台填的东西也能真正传到做服务的人手里。
   */
  const saveCheckInBriefMutation = useSaveAppointmentServiceBrief(checkInModal.item?.appointmentId ?? null);
  const addAppointmentItemMutation = useAddAppointmentItem();
  const completedCheckInForms = checkInFormsQ.data?.forms.filter((form) => form.isLatest) ?? [];
  const [aiSummarySubmissionId, setAiSummarySubmissionId] = useState<string | null>(null);
  const [checkInError, setCheckInError] = useState<string | null>(null);
  /*
   * 门店结账配置。看板收银此前完全没有读取它，税率、附加费档位、小费档位
   * 全是写死的常量 —— 同一家店从看板结账和从收银台结账会算出两笔不同的账。
   */
  const openTicketsQ = useOpenTickets();
  const checkoutSettings = openTicketsQ.data?.checkoutSettings;
  const allowTipSplitOverride = checkoutSettings?.allowTipSplitOverride !== false;

  const aiSummaryForm = completedCheckInForms.find((form) => form.submissionId === aiSummarySubmissionId) ?? null;
  const aiSummaryQ = useHealthFormSubmissionQuery(aiSummarySubmissionId, Boolean(aiSummarySubmissionId));
  const checkInAiSummary = useMemo(() => {
    if (!aiSummaryForm || !aiSummaryQ.data?.answers) return null;
    const answers = aiSummaryQ.data.answers;
    return generateAiHealthSummary({
      templateKey: aiSummaryForm.templateKey,
      answers,
      avoidAreas: Array.isArray(answers.bodyMapAvoid) ? answers.bodyMapAvoid as string[] : [],
    });
  }, [aiSummaryForm, aiSummaryQ.data?.answers]);

  /*
   * 放行原因 → 词条 key 的**显式**映射。
   * 不写成运行期拼接：拼出来的 key 对字典瘦身脚本不可见，会被当成未引用词条
   * 删掉，而删掉不产生任何编译错误（同 lib/errorMessage.ts 的理由）。
   */
  const OVERRIDE_REASON_LABELS: Record<OverrideReason, TranslationKey> = {
    guest_requested: 'overrideGuestRequested',
    staff_on_break: 'overrideStaffOnBreak',
    desk_coordination: 'overrideDeskCoordination',
    walk_in_stacking: 'overrideWalkInStacking',
    other: 'overrideOther',
  };

  /*
   * 「技师已满，仍要开始」的确认框。
   *
   * 服务端在 `ticket.startItem` 上拦技师并发，并把这个错误标成可放行；
   * 没有这个入口的话前台只剩改派技师一条路 —— 而「客人就要 Amy，宁可等」
   * 恰恰是门店天天要处理的情况。
   */
  const [overbookConfirm, setOverbookConfirm] = useState<{ message: string } | null>(null);
  const [overbookReason, setOverbookReason] = useState<OverrideReason>('desk_coordination');

  // 2. Start Service Modal (Step 2 -> Step 3: Waiting -> In Service)
  const [startServiceModal, setStartServiceModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    staffId: string;
    assignments: Array<{
      serviceId: string;
      serviceName: string;
      durationMin: number;
      staffCount: number;
      staffIds: string[];
      roomId: string;
    }>;
    extraAddOnServiceId: string;
    extraAddOnStaffId: string;
    addedAddOns: AddOnItem[];
    roomId: string;
    startTime: string;
    serviceDurationMin: number;
    requireBriefingAck: boolean;
    serviceBrief: string;
    /**
     * 本次入座尝试的幂等键前缀。打开弹窗时生成一次，关掉才作废。
     *
     * 此前开单的幂等键是 `queue-start-<预约号>` —— 永久固定。而
     * `command_idempotency` 是长期表，于是一张单作废之后再给同一个预约安排
     * 入座，服务端会原样把那张**已作废**的单回放回来，后续每一条命令都撞
     * TICKET_ALREADY_CLOSED，前台再也开不出新单。
     *
     * 加上这一段之后：同一次尝试（含超排放行的重试）重放仍然是同一个键，
     * 不会开出第二张单；重新打开弹窗则是一次新的意图，理应能开出新单。
     */
    attemptKey: string;
  }>({
    isOpen: false,
    item: null,
    staffId: '',
    assignments: [],
    extraAddOnServiceId: '',
    extraAddOnStaffId: '',
    addedAddOns: [],
    roomId: '',
    startTime: '',
    serviceDurationMin: 60,
    requireBriefingAck: true,
    serviceBrief: '',
    attemptKey: '',
  });
  const saveServiceBriefMutation = useSaveAppointmentServiceBrief(startServiceModal.item?.appointmentId ?? null);
  /*
   * 各弹窗的「处理中」标志。
   * 确认按钮此前没有任何忙碌态，双击就是两次不可逆的命令 ——
   * 收银那一下尤其致命，两次 ticket.pay 会带着不同的幂等键各扣一次款。
   */
  const checkInPending = join.isPending
    || saveCheckInBriefMutation.isPending
    || addAppointmentItemMutation.isPending;
  const startServicePending = openTicketMutation.isPending
    || startTicketItemMutation.isPending
    || saveServiceBriefMutation.isPending
    || addTicketItemMutation.isPending
    || update.isPending;
  const completeServicePending = finishTicketItemMutation.isPending
    || saveServiceNoteMutation.isPending
    || beginCleaningMutation.isPending
    || addTicketItemMutation.isPending;

  // 3. Complete Service Modal (Step 3 -> Step 4: In Service -> Ready Checkout)
  const [completeServiceModal, setCompleteServiceModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    extraAddOnServiceId: string;
    extraAddOnStaffId: string;
    addedAddOns: AddOnItem[];
    markRoomCleaning: boolean;
    technicianNotes: string;
    roomId: string | null;
  }>({
    isOpen: false,
    item: null,
    extraAddOnServiceId: '',
    extraAddOnStaffId: '',
    addedAddOns: [],
    markRoomCleaning: false,
    technicianNotes: '',
    roomId: null,
  });

  // 4. Checkout Tender Modal (Step 4 -> Step 5: Ready Checkout -> Completed)
  const [checkoutModal, setCheckoutModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    discountDollars: string;
    // 税费与信用卡手续费
    enableTax: boolean;
    taxRatePercent: string;
    enableCardSurcharge: boolean;
    cardSurchargePercent: string;
    // 小费与多技师分账
    tipMode: 'total_split' | 'custom_per_staff';
    tipPercentage: number;
    totalTipDollars: string;
    splitStrategy: 'proportional' | 'equal';
    customStaffTips: Record<string, string>;
    // 支付通道与Gift Card
    paymentMethod: 'card' | 'cash' | 'gift_card' | 'apple_pay';
    /**
     * 本次收款的阶段。
     *
     * 看板此前一律按 `combined` 发起收款，门店只要把结账时机设为
     * 先服务后小费，收银必然被服务端拒绝。阶段由工单事实推导，
     * 决定金额口径、可用支付方式与幂等键。
     */
    paymentStage: PaymentStage;
    tenderedDollars: string;
    keepChange: boolean;
    giftCardCode: string;
    giftCardId: string;
    giftCardVerified: boolean;
    giftCardBalanceCents: number;
    isVerifyingGiftCard: boolean;
  }>({
    isOpen: false,
    item: null,
    discountDollars: '0',
    enableTax: false,
    taxRatePercent: '0',
    enableCardSurcharge: false,
    cardSurchargePercent: '3.0',
    tipMode: 'total_split',
    tipPercentage: 15,
    totalTipDollars: '',
    splitStrategy: 'proportional',
    customStaffTips: {},
    paymentMethod: 'card',
    paymentStage: 'combined',
    tenderedDollars: '',
    keepChange: false,
    giftCardCode: '',
    giftCardId: '',
    giftCardVerified: false,
    giftCardBalanceCents: 0,
    isVerifyingGiftCard: false,
  });

  // 5. Reverse Rollback Warning Modal (Backward Stage Move)
  /**
   * 作废工单。
   *
   * 已开工的单子只能回退到「服务中」，要把客人退回候客区必须先作废 ——
   * 此前看板上没有作废入口，前台被告知「不支持」之后无路可走，只能改去
   * 订单记录页找这张单。作废的两种后果差别很大（退回候客区可重开 /
   * 连预约一起取消），因此弹窗按所选原因如实说明会发生什么。
   */
  /**
   * 服务中的三个局部改动：加项、换技师、换工位。
   *
   * 三者共用一个弹窗：它们的形状是一样的 —— 选一项服务（单项目单自动选中）、
   * 选一个新的目标、给一句理由。拆成三个弹窗只会让同一段选择逻辑抄三遍。
   */
  const [itemActionModal, setItemActionModal] = useState<{
    isOpen: boolean;
    mode: 'add' | 'staff' | 'room';
    item: KanbanItem | null;
    ticketItemId: string;
    serviceId: string;
    staffId: string;
    resourceId: string;
    reason: string;
  }>({ isOpen: false, mode: 'add', item: null, ticketItemId: '', serviceId: '', staffId: '', resourceId: '', reason: '' });

  const [voidModal, setVoidModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    reason: VoidReason;
    notes: string;
  }>({ isOpen: false, item: null, reason: 'input_error', notes: '' });

  const [rollbackModal, setRollbackModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    fromStage: KanbanStage | null;
    toStage: KanbanStage | null;
    reason: string;
    notes: string;
  }>({
    isOpen: false,
    item: null,
    fromStage: null,
    toStage: null,
    reason: 'entry_error',
    notes: '',
  });

  // 6. QR Code Enlarge Modal State
  const [qrZoomModal, setQrZoomModal] = useState<{
    isOpen: boolean;
    url: string;
    customerName?: string;
    phone?: string;
    serviceName?: string;
  } | null>(null);

  // 看板各阶段与抽屉生命周期状态映射
  const stageToDrawerStatus: Record<KanbanStage, 'booked' | 'checked_in' | 'in_service' | 'done'> = {
    booked: 'booked',
    waiting: 'checked_in',
    in_service: 'in_service',
    ready_checkout: 'done',
    completed: 'done',
  };

  // 通用查看详情入口 (全看板 5 列统一呼出右侧全生命周期大抽屉)
  const handleViewDetails = (item: KanbanItem) => {
    const drawerStatus = stageToDrawerStatus[item.stage] || 'booked';
    // 新数据一定有 appointmentId；queueId 仅用于兼容尚未跑回填迁移的旧 Walk-in。
    openAppointment?.(item.appointmentId ?? item.queueId ?? null, drawerStatus);
  };

  // Compile Unified Kanban Items
  const kanbanItems = useMemo<KanbanItem[]>(() => {
    const list: KanbanItem[] = [];
    const queuedApptIds = new Set<string>();
    const ticketApptIds = new Set(
      (ticketsData?.tickets ?? [])
        .map((ticket) => ticket.appointmentId)
        .filter((id): id is string => Boolean(id)),
    );

    // 1. Queue entries (waiting, called, seated)
    if (queue) {
      const serviceFacts = (entry: QueueEntry) => ({
        durationMin: entry.items?.length
          ? entry.items.reduce((total, service) => total + service.durationMin, 0)
          : entry.serviceDurationMin ?? 45,
        priceCents: entry.items?.length
          ? entry.items.reduce((total, service) => total + service.basePriceCents, 0)
          : entry.servicePriceCents ?? 0,
      });
      queue.waiting.forEach((q) => {
        if (q.appointmentId && ticketApptIds.has(q.appointmentId)) return;
        if (q.appointmentId) queuedApptIds.add(q.appointmentId);
        list.push({
          id: `queue-${q.queueId}`,
          stage: 'waiting',
          queueId: q.queueId,
          appointmentId: q.appointmentId,
          ticketNumber: q.ticketNumber,
          customerName: q.displayName,
          phone: formatPhoneDisplay(q.phoneDisplay),
          serviceName: q.serviceName || t('queue.quGeneralService'),
          serviceId: q.serviceId,
          ...serviceFacts(q),
          staffName: q.staffName,
          staffId: q.staffId,
          isRequest: false,
          timeDisplay: t('queue.quWaitedFor', { p0: q.waitedMin }),
          waitedMin: q.waitedMin,
          overdue: q.overdue,
          pendingForms: q.pendingForms,
          intakeSigned: q.intakeSigned,
          rawQueue: q,
        });
      });

      queue.called.forEach((q) => {
        if (q.appointmentId && ticketApptIds.has(q.appointmentId)) return;
        if (q.appointmentId) queuedApptIds.add(q.appointmentId);
        list.push({
          id: `queue-called-${q.queueId}`,
          stage: 'waiting',
          queueId: q.queueId,
          appointmentId: q.appointmentId,
          ticketNumber: q.ticketNumber,
          customerName: q.displayName,
          phone: formatPhoneDisplay(q.phoneDisplay),
          serviceName: q.serviceName || t('queue.quGeneralService'),
          serviceId: q.serviceId,
          ...serviceFacts(q),
          staffName: q.staffName,
          staffId: q.staffId,
          isRequest: false,
          timeDisplay: t('queue.quCalledFor', { p0: q.waitedMin }),
          waitedMin: q.waitedMin,
          overdue: q.overdue,
          pendingForms: q.pendingForms,
          intakeSigned: q.intakeSigned,
          rawQueue: q,
        });
      });

      queue.seated.forEach((q) => {
        if (q.appointmentId && ticketApptIds.has(q.appointmentId)) return;
        if (q.appointmentId) queuedApptIds.add(q.appointmentId);
        list.push({
          id: `queue-seated-${q.queueId}`,
          stage: 'in_service',
          queueId: q.queueId,
          appointmentId: q.appointmentId,
          ticketNumber: q.ticketNumber,
          customerName: q.displayName,
          phone: formatPhoneDisplay(q.phoneDisplay),
          serviceName: q.serviceName || t('queue.quInServiceItem'),
          serviceId: q.serviceId,
          ...serviceFacts(q),
          staffName: q.staffName,
          staffId: q.staffId,
          isRequest: false,
          timeDisplay: t('queue.quInServiceStatus'),
          rawQueue: q,
        });
      });
    }

    // 2. Schedule Items (booked, in_service, completed)
    // 未到店的预约按「一位客人一张卡」聚合：同一预约的多个项目合并成一张卡，
    // 而不是每个项目一张（签到本身也是按预约走的，拆开会出现重复卡）。
    const bookedByAppt = new Map<string, ScheduleItem[]>();

    (items || []).forEach((it) => {
      if (queuedApptIds.has(it.appointmentId) || ticketApptIds.has(it.appointmentId)) return;

      const matchedStaff = staff.find((s) => s.membershipId === it.staffId);
      const staffName =
        matchedStaff && matchedStaff.membershipId !== UNASSIGNED_STAFF_ID
          ? matchedStaff.name
          : t('queue.quStaffUnassignedLong');

      if (it.status === 'booked') {
        const key = it.appointmentId || `item-${it.id}`;
        const bucket = bookedByAppt.get(key) ?? [];
        bucket.push(it);
        bookedByAppt.set(key, bucket);
      } else if (it.status === 'in_service') {
        list.push({
          id: `appt-insvc-${it.id}`,
          stage: 'in_service',
          appointmentId: it.appointmentId,
          customerName: it.customerName,
          phone: it.customerPhone ?? null,
          serviceName: it.serviceName,
          serviceId: it.serviceId,
          durationMin: it.durationMin,
          priceCents: it.service?.priceCents || 0,
          staffId: it.staffId,
          staffName,
          staffColor: matchedStaff?.color ?? null,
          roomId: it.resourceId,
          isRequest: it.isRequest,
          timeDisplay: `${it.startTime} (${it.durationMin}m)`,
          rawItem: it,
        });
      } else if (it.status === 'completed') {
        list.push({
          id: `appt-done-${it.id}`,
          stage: 'completed',
          appointmentId: it.appointmentId,
          customerName: it.customerName,
          phone: it.customerPhone ?? null,
          serviceName: it.serviceName,
          serviceId: it.serviceId,
          durationMin: it.durationMin,
          priceCents: it.service?.priceCents || 0,
          staffId: it.staffId,
          staffName: matchedStaff?.name || t('therapistLabel'),
          staffColor: matchedStaff?.color ?? null,
          isRequest: it.isRequest,
          timeDisplay: t('queue.quCompletedFor', {
            p0: completedCardClock({
              completedAt: it.completedAt,
              endTime: it.endTime,
              timezone,
            }),
          }),
          rawItem: it,
        });
      }
    });

    // 2b. 把聚合后的未到店预约转成卡片（一预约一张）
    for (const [key, apptItems] of bookedByAppt) {
      const sorted = [...apptItems].sort((a, b) => a.startMins - b.startMins);
      const primary = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const staffIds = new Set(
        sorted.map((i) => i.staffId).filter((id) => id && id !== UNASSIGNED_STAFF_ID),
      );
      const singleStaffId = staffIds.size === 1 ? [...staffIds][0]! : null;
      const matchedStaff = singleStaffId ? staff.find((s) => s.membershipId === singleStaffId) : undefined;
      const nameOfStaff = (id: string | null) => {
        if (!id || id === UNASSIGNED_STAFF_ID) return null;
        return staff.find((s) => s.membershipId === id)?.name ?? null;
      };
      const staffName = staffIds.size === 0
        ? t('queue.quStaffUnassignedLong')
        : staffIds.size === 1
          ? (nameOfStaff(singleStaffId) ?? t('queue.quStaffUnassignedLong'))
          : t('queue.quMultipleStaff');
      list.push({
        id: `appt-${key}`,
        stage: 'booked',
        appointmentId: primary.appointmentId,
        customerName: primary.customerName,
        phone: primary.customerPhone ?? null,
        serviceName: sorted.length === 1
          ? primary.serviceName
          : t('queue.quServiceItemsSummary', { p0: primary.serviceName, p1: String(sorted.length - 1) }),
        serviceId: sorted.length === 1 ? primary.serviceId : null,
        durationMin: sorted.reduce((sum, i) => sum + i.durationMin, 0),
        priceCents: sorted.reduce((sum, i) => sum + (i.service?.priceCents || 0), 0),
        staffId: singleStaffId,
        staffName,
        staffColor: matchedStaff?.color ?? null,
        roomId: primary.resourceId,
        isRequest: sorted.some((i) => i.isRequest),
        timeDisplay: sorted.length === 1
          ? `${primary.startTime} - ${primary.endTime}`
          : `${primary.startTime} - ${last.endTime}`,
        rawItem: primary,
        bookedItems: sorted.map((i) => ({
          itemId: i.id,
          serviceName: i.serviceName,
          durationMin: i.durationMin,
          priceCents: i.service?.priceCents || 0,
          staffName: nameOfStaff(i.staffId),
          startTime: i.startTime,
        })),
      });
    }

    // 3. Open Tickets (ready for checkout)
    if (ticketsData?.tickets) {
      ticketsData.tickets.forEach((tk: any) => {
        const tkItems = queueTicketItems(Array.isArray(tk.items) ? tk.items : []);
        const starts = tkItems.flatMap((entry) => entry.startedAt ? [Date.parse(entry.startedAt)] : []);
        const ends = tkItems.flatMap((entry) => entry.startedAt
          ? [entry.finishedAt ? Date.parse(entry.finishedAt) : Date.parse(entry.startedAt) + entry.durationMin * 60_000] : []);
        const clock = (ms: number) => formatIsoWallClock(new Date(ms).toISOString(), timezone);
        list.push({
          id: `ticket-${tk.ticketId}`,
          stage: tk.status === 'ready_to_pay' ? 'ready_checkout' : 'in_service',
          ticketId: tk.ticketId,
          appointmentId: tk.appointmentId,
          customerName: formatI18n(tk.customerName, language) || t('queue.quCheckedInGuest'),
          serviceName: tkItems.map((i: any) => formatI18n(i.name, language)).join(', ') || t('queue.quMixedService'),
          durationMin: tkItems.reduce((acc: number, i: any) => acc + (i.durationMin || 0), 0),
          priceCents: asCents(tk.subtotalCents ?? 0),
          staffName: [...new Set(tkItems.map((entry) => entry.staffName).filter(Boolean))].join(' / '),
          roomName: [...new Set(tkItems.map((entry) => entry.roomName).filter(Boolean))].join(' / ') || null,
          isRequest: false,
          timeDisplay: starts.length ? `${clock(Math.min(...starts))} – ${clock(Math.max(...ends))}` : t('queue.quElapsedNotStarted'),
          rawTicket: tk,
        });
      });
    }

    return list;
  }, [queue, items, staff, ticketsData, language, timezone, t]);

  // Filtered items (支持错别字容错模糊搜索)
  const filteredItems = useMemo(() => {
    let list = kanbanItems;
    if (staffFilter !== 'all') {
      list = list.filter((item) => {
        if (item.rawTicket) {
          return staffFilter === UNASSIGNED_STAFF_ID
            ? item.rawTicket.items.every((entry) => !entry.membershipId || entry.membershipId === UNASSIGNED_STAFF_ID)
            : item.rawTicket.items.some((entry) => entry.membershipId === staffFilter || entry.staffName === staffFilter);
        }
        return staffFilter === UNASSIGNED_STAFF_ID
          ? !item.staffId || item.staffId === UNASSIGNED_STAFF_ID
          : item.staffId === staffFilter || item.staffName === staffFilter;
      });
    }
    if (searchTerm.trim()) {
      list = fuzzySearch(list, searchTerm, {
        keys: [
          { name: 'customerName', weight: 0.5 },
          { name: 'serviceName', weight: 0.3 },
          { name: 'staffName', weight: 0.25 },
          { name: 'phone', weight: 0.2 },
          { name: 'ticketNumber', weight: 0.2 },
        ],
        threshold: 0.45,
      });
    }
    return list;
  }, [kanbanItems, searchTerm, staffFilter]);

  // Operational metrics
  const metrics = useMemo(() => {
    const totalBookings = kanbanItems.length;
    const waiting = kanbanItems.filter((x) => x.stage === 'waiting').length;
    const inService = kanbanItems.filter((x) => x.stage === 'in_service').length;
    const readyCheckout = kanbanItems.filter((x) => x.stage === 'ready_checkout').length;
    const completed = kanbanItems.filter((x) => x.stage === 'completed').length;
    const fallbackServiceCents = kanbanItems
      .filter((x) => x.stage === 'completed')
      .reduce((sum, x) => sum + x.priceCents, 0);
    const revenueCents = settledRevenueCents({
      netCents: dayCloseData?.money?.netCents,
      tipCashCents: dayCloseData?.money?.tipCashCents,
      tipCardCents: dayCloseData?.money?.tipCardCents,
      fallbackServiceCents,
    });

    return {
      totalBookings,
      waiting,
      inService,
      readyCheckout,
      completed,
      revenueCents,
    };
  }, [kanbanItems, dayCloseData]);

  /** 标题旁那枚小转圈：任何写命令在跑都转，纯指示性，不参与禁用。 */
  const isSyncing = join.isPending || update.isPending || closeTicketMutation.isPending
    || openTicketMutation.isPending || addTicketItemMutation.isPending
    || startTicketItemMutation.isPending
    || finishTicketItemMutation.isPending
    || rollbackStageMutation.isPending || isRefreshing;

  /*
   * 看板上正在直接执行命令的那一张卡 / 那一行。
   *
   * 此前禁用态是全局的：任意一次开始或完工进行中，**整块看板**十几张卡的
   * 所有按钮一起变灰。门店里前台本来就是一边接这位、一边给那位点完工，
   * 全屏冻结把并行的活儿强行串了起来。现在只锁住正在动的那一个目标 ——
   * 重复提交的真正防线在服务端的幂等与 `coalesce(started_at, now())` 上。
   */
  const [busyTarget, setBusyTarget] = useState<{ itemId: string; ticketItemId: string | null } | null>(null);

  // Refresh All Operations Data
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([refetchQueue(), refetchSchedule(), refetchTickets(), refetchRooms(), refetchRotation()]);
      toast.success(t('queue.quRefreshed'));
    } finally {
      setIsRefreshing(false);
    }
  };

  /**
   * 核心阶段流转拦截器（严格顺序单向流转 + 弹窗确认 + 反向回退审计）
   */
  const initiateStageTransition = (item: KanbanItem, targetStage: KanbanStage) => {
    if (item.stage === targetStage) return;

    const sourceIndex = STAGE_ORDER.indexOf(item.stage);
    const targetIndex = STAGE_ORDER.indexOf(targetStage);

    // 1. 反向回退 (Backward Rollback)
    if (targetIndex < sourceIndex) {
      if (!canRollbackTo(item, targetStage)) {
        toast.danger(t('queue.quRollbackNotSupported', { p0: t(STAGE_NAME_KEYS[targetStage]) }));
        return;
      }
      setRollbackModal({
        isOpen: true,
        item,
        fromStage: item.stage,
        toStage: targetStage,
        reason: 'entry_error',
        notes: '',
      });
      return;
    }

    // 2. 跨阶段跳步拦截 (Cannot skip steps)
    if (targetIndex > sourceIndex + 1) {
      toast.danger(t('queue.quNoStageSkip'), {
        description: t('queue.quStageOrder', { p0: t(STAGE_NAME_KEYS[item.stage]), p1: t(STAGE_NAME_KEYS[STAGE_ORDER[sourceIndex + 1]]) }),
      });
      return;
    }

    // 3. 正向单步流转 (Forward Step 1 -> 2 -> 3 -> 4 -> 5)
    if (item.stage === 'booked' && targetStage === 'waiting') {
      // 预约 ➔ 到店：弹窗确认用户信息、健康问卷二维码、现场加项与按摩偏好
      setAiSummarySubmissionId(null);
      setCheckInError(null);
      setCheckInModal({
        isOpen: true,
        item,
        qrScanned: false,
        contraindications: [CONTRAINDICATION_NONE],
        massageStrength: STRENGTH_DEFAULT,
        aromaOil: AROMA_OIL_DEFAULT,
        focusAreas: [],
        avoidAreas: [AVOID_AREA_NONE],
        selectedAddOnId: '',
        addOnStaffId: item.staffId || '',
        notes: item.notes || '',
        attemptKey: crypto.randomUUID(),
      });
    } else if (item.stage === 'waiting' && targetStage === 'in_service') {
      // 到店 ➔ 服务：弹窗指定技师与房间/工位
      const requestedItems = item.rawQueue?.items?.length
        ? item.rawQueue.items
        : item.serviceId ? [{
            serviceId: item.serviceId,
            serviceName: item.serviceName,
            staffId: item.staffId ?? null,
            staffName: item.staffName ?? null,
            durationMin: item.durationMin,
            addonIds: [],
          }] : [];
      /*
       * 同一张单的多个项目占的是同一个位置，因此默认工位对本单内部不去重；
       * `assignedRooms` 只用来避免把已经分给本单前一项的工位重复推荐给
       * **没有**位置可继承的后续项目 —— 真正的容量判定在 `roomSeatability()` 里。
       */
      const ownTicketId = item.ticketId ?? item.rawTicket?.ticketId ?? null;
      const defaultRoom = pickDefaultRoomId(rooms, new Set(), { ticketId: ownTicketId });
      const assignments = requestedItems.map((requested) => {
        const service = services.find((entry) => entry.id === requested.serviceId) ?? {
          id: requested.serviceId,
          name: requested.serviceName,
          durationMin: requested.durationMin,
          priceCents: 0,
          staffCount: 1,
          requiredSkills: [],
        };
        const candidates = rankStaffCandidates({
          staff: staff.filter((member) => member.membershipId !== UNASSIGNED_STAFF_ID),
          service,
          rotationEntries: rotationData?.entries ?? [],
          scheduledItems: todaySnapshot?.items ?? [],
          onlineIds: onlineTechIds,
          requestedStaffId: requested.staffId,
          // 卡片级的点钟标记。队列项本身不带 isRequest，这是现有最准的信号。
          isRequest: item.isRequest,
          nowMs: Date.now(),
        });
        return {
          serviceId: service.id,
          serviceName: service.name,
          durationMin: requested.durationMin,
          staffCount: service.staffCount,
          roomId: defaultRoom,
          staffIds: candidates.filter((candidate) => candidate.eligible)
            .slice(0, service.staffCount).map((candidate) => candidate.staff.membershipId),
        };
      });
      const defaultStaff = assignments[0]?.staffIds[0] ?? '';
      
      const timeStr = nowWallHhMm(timezone);

      setStartServiceModal({
        isOpen: true,
        item,
        staffId: defaultStaff,
        assignments,
        extraAddOnServiceId: '',
        extraAddOnStaffId: defaultStaff,
        addedAddOns: [],
        attemptKey: crypto.randomUUID(),
        roomId: defaultRoom,
        startTime: timeStr,
        serviceDurationMin: item.durationMin || 60,
        /* 问卷尚未签署时默认不勾选：这一勾是入座的前置门禁，必须由人主动确认。 */
        requireBriefingAck: !hasPendingForms(item),
        serviceBrief: (item.appointmentId && checkInBriefByAppointment.current.get(item.appointmentId))
          || item.notes
          || '',
      });
    } else if (item.stage === 'in_service' && targetStage === 'ready_checkout') {
      // 服务 ➔ 结账：弹窗核对服务项目明细与中途加项记录
      const defaultAddOnStaffId = item.rawTicket?.items.find((ticketItem) => ticketItem.membershipId && ticketItem.membershipId !== UNASSIGNED_STAFF_ID)?.membershipId
        ?? (item.staffId && item.staffId !== UNASSIGNED_STAFF_ID ? item.staffId : null)
        ?? staff.find((member) => member.membershipId !== UNASSIGNED_STAFF_ID && member.isBookable)?.membershipId
        ?? '';
      setCompleteServiceModal({
        isOpen: true,
        item,
        extraAddOnServiceId: '',
        extraAddOnStaffId: defaultAddOnStaffId,
        addedAddOns: [],
        markRoomCleaning: false,
        technicianNotes: '',
        roomId: resolveQueueRoomId(item, rooms),
      });
    } else if (item.stage === 'ready_checkout' && targetStage === 'completed') {
      // 结账 ➔ 收银：弹窗录入支付方式、小费与Amount结算
      openCheckoutModal(item, resolvePaymentStage(item));
    }
  };

  /**
   * 执行卡片主按钮判定出的下一步。
   *
   * 主按钮此前直接绑在看板列上，「服务中」列一定发完工、「待收银」列一定发合并收款，
   * 与门店的结账时机设置和工单的实际进度都无关。现改为由 `queueNextAction()` 判定，
   * 这里只负责把判定结果接到既有的弹窗与命令上。
   */
  const runNextAction = async (item: KanbanItem, action: QueueNextAction) => {
    switch (action.kind) {
      case 'check_in':
        initiateStageTransition(item, 'waiting');
        return;
      case 'seat':
        initiateStageTransition(item, 'in_service');
        return;
      case 'pay_service':
      case 'pay_tip':
      case 'pay_combined':
        openCheckoutModal(item, action.kind === 'pay_service' ? 'service' : action.kind === 'pay_tip' ? 'tip' : 'combined');
        return;
      case 'start_item': {
        const entry = queueTicketItems(item.rawTicket?.items ?? [])
          .find((candidate) => candidate.ticketItemId === action.ticketItemId);
        setBusyTarget({ itemId: item.id, ticketItemId: action.ticketItemId });
        try {
          await startTicketItemMutation.mutateAsync({
            ticketItemId: action.ticketItemId,
            membershipId: entry?.membershipId,
          });
          await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
        } catch (error) {
          toast.danger(errorMessage(error));
        } finally {
          setBusyTarget(null);
        }
        return;
      }
      case 'finish_item': {
        /*
         * 「服务中」列的完工要走核算弹窗：那里还要处理中途加项、工位清洁与
         * 技师备注，直接发命令会把这些一并跳过。其余情形（例如回退后仍留在
         * 待收银列的单）没有弹窗可依托，按项目直接完工。
         */
        if (item.stage === 'in_service') {
          initiateStageTransition(item, 'ready_checkout');
          return;
        }
        const entry = queueTicketItems(item.rawTicket?.items ?? [])
          .find((candidate) => candidate.ticketItemId === action.ticketItemId);
        setBusyTarget({ itemId: item.id, ticketItemId: action.ticketItemId });
        try {
          await finishTicketItemMutation.mutateAsync({
            ticketItemId: action.ticketItemId,
            membershipId: entry?.membershipId,
          });
          await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
        } catch (error) {
          toast.danger(errorMessage(error));
        } finally {
          setBusyTarget(null);
        }
        return;
      }
      case 'blocked':
        toast.info(t(action.reasonKey));
    }
  };

  /**
   * 卡片上的显式回退入口。
   *
   * 此前回退只能靠拖拽触发，而前台用的是 iPad —— HTML5 拖拽在触屏上根本不会
   * 触发，于是这条路径在真实门店里等同于不存在。规则与服务端保持一致：
   * 已开单的单子只能回到「服务中」，其余情形必须先作废。不满足条件时给出
   * 下一步怎么做，绝不允许点了没有任何反应。
   */
  const handleSplitBundleConfirm = async () => {
    if (!splitTarget) return;
    try {
      await splitBundleMutation.mutateAsync({
        ticketId: splitTarget.ticketId,
        bundleInstanceId: splitTarget.bundle.instanceId,
      });
      toast.success(t('bundle.splitDone'));
      setSplitTarget(null);
    } catch (err: unknown) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason;
      if (reason === 'bundle_split_with_extras_unsupported') {
        toast.danger(t('bundle.splitUnsupportedExtras'));
      } else {
        toast.danger(errorMessage(err));
      }
      throw err;
    }
  };

  const requestRollback = (item: KanbanItem) => {
    if (item.stage === 'booked') {
      toast.info(t('queue.quRollbackAtStart'));
      return;
    }
    if (!item.appointmentId) {
      toast.danger(t('queue.quRollbackWalkInHint'));
      return;
    }
    const target: KanbanStage = (item.ticketId || item.rawTicket)
      ? 'in_service'
      : STAGE_ORDER[Math.max(0, STAGE_ORDER.indexOf(item.stage) - 1)]!;
    if (item.stage === target) {
      toast.info(t('queue.quRollbackAtStart'));
      return;
    }
    if (!canRollbackTo(item, target)) {
      // 已开工的单子回不到候客区，但作废是一条真实可走的路 —— 直接把它摆出来。
      requestVoid(item);
      return;
    }
    initiateStageTransition(item, target);
  };

  /**
   * 打开局部改动弹窗。
   *
   * 三种模式都要求已经开单 —— 加项、换技师、换工位改的都是工单条目，
   * 尚未开单时没有可改的对象，此时给出的是「先安排工位入座」，
   * 而不是一个打开后无从选择的空弹窗。
   */
  const openItemAction = (item: KanbanItem, mode: 'add' | 'staff' | 'room') => {
    const entries = queueTicketItems(item.rawTicket?.items ?? []);
    if (!item.rawTicket || entries.length === 0) {
      toast.info(t('queue.quItemActionNeedsTicket'));
      return;
    }
    if (mode === 'room' && !entries.some((entry) => entry.startedAt && !entry.finishedAt)) {
      toast.info(t('errorReasonServiceNotStarted'));
      return;
    }
    /*
     * 换技师对未完工的项目成立；换工位还要求已经开工 —— 服务端搬的是
     * 「正在占用的那个位置」，没开工就没有位置可搬（service_not_started）。
     * 与其让前台选完再吃一个校验失败，不如一开始就不列出来。
     */
    const editable = mode === 'add'
      ? entries
      : entries.filter((entry) => !entry.finishedAt && (mode === 'staff' || entry.startedAt));
    const preset = editable.length === 1 ? editable[0]! : undefined;
    setItemActionModal({
      isOpen: true,
      mode,
      item,
      ticketItemId: preset?.ticketItemId ?? '',
      serviceId: '',
      staffId: '',
      resourceId: '',
      reason: '',
    });
  };

  const handleConfirmItemAction = async () => {
    const { mode, item, ticketItemId, serviceId, staffId, resourceId, reason } = itemActionModal;
    if (!item?.rawTicket) return;
    const close = () => setItemActionModal((prev) => ({ ...prev, isOpen: false, item: null }));
    /*
     * 校验不通过时必须出声。确认按钮的 `ready` 判定通常已经挡住了这些情形，
     * 但目录在弹窗打开期间被改动、或状态与按钮判定漂开时，这里的裸 return
     * 会让按钮变成「点了什么都不发生」—— 前台唯一能做的就是反复点它。
     */
    try {
      if (mode === 'add') {
        const service = services.find((entry) => entry.id === serviceId);
        if (!service || !staffId) {
          toast.danger(t('queue.quAddOnStaffRequired'));
          return;
        }
        await addTicketItemMutation.mutateAsync({
          ticketId: item.rawTicket.ticketId,
          serviceId: service.id,
          membershipId: staffId,
          kind: 'addon',
          minutes: service.durationMin,
          ...(resourceId ? { resourceId } : {}),
          idempotencyKey: crypto.randomUUID(),
        });
        close();
        toast.success(t('queue.quAddItemDone', { p0: service.name }));
      } else if (mode === 'staff') {
        if (!ticketItemId || !staffId || reason.trim().length < 2) {
          toast.danger(t('queue.quMoveNeedsReason'));
          return;
        }
        const entry = queueTicketItems(item.rawTicket.items).find((e) => e.ticketItemId === ticketItemId);
        await moveItemStaffMutation.mutateAsync({
          ticketItemId,
          membershipId: staffId,
          ...(entry?.membershipId ? { replacesMembershipId: entry.membershipId } : {}),
          reason: reason.trim(),
          idempotencyKey: crypto.randomUUID(),
        });
        close();
        toast.success(t('queue.quMoveStaffDone', {
          p0: entry?.name ?? item.serviceName,
          p1: staff.find((member) => member.membershipId === staffId)?.name ?? '',
        }));
      } else {
        if (!ticketItemId || !resourceId || reason.trim().length < 2) {
          toast.danger(t('queue.quMoveNeedsReason'));
          return;
        }
        const entry = queueTicketItems(item.rawTicket.items).find((e) => e.ticketItemId === ticketItemId);
        await moveItemResourceMutation.mutateAsync({
          ticketItemId,
          resourceId,
          reason: reason.trim(),
          idempotencyKey: crypto.randomUUID(),
        });
        close();
        toast.success(t('queue.quMoveRoomDone', {
          p0: entry?.name ?? item.serviceName,
          p1: rooms.find((room) => room.id === resourceId)?.name ?? '',
        }));
      }
      await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
    } catch (err) {
      toast.danger(`${t('queue.quMoveFailed')} ${errorMessage(err)}`);
    }
  };

  /**
   * 打开服务单一页纸。
   *
   * 浏览器标签页环境下新开一个标签页而不是当前页跳转：前台打完这张纸要回到
   * 看板继续排下一位，把她从看板上带走再让她自己找回来，是这类操作最常见的
   * 抱怨来源。独立窗口（添加到主屏幕的 iPad）没有标签页，改为压入历史栈后
   * 由服务单页自带的返回控件回到看板 —— 详见 `@/lib/navigation`。
   */
  const openServiceBrief = (item: KanbanItem) => {
    const ticketId = item.ticketId ?? item.rawTicket?.ticketId;
    if (!ticketId) {
      toast.info(t('queue.quItemActionNeedsTicket'));
      return;
    }
    openInternalRoute(`/print/service-brief/${ticketId}`);
  };

  /**
   * 「打扫完毕」—— 一下把位子放回可接客。
   *
   * 服务端分两步：`cleaning_required`（刚做完，还没人动手）要先 begin 再
   * complete。前台心里只有「我扫完了」这一个动作，因此这里替她把两步接上，
   * 而不是在界面上要求她先点「开始打扫」。
   */
  const handleRoomCleanDone = async (room: { id: string; name: string; status: string; rawStatus?: string }) => {
    if (cleaningRoomId) return;
    setCleaningRoomId(room.id);
    try {
      if (room.rawStatus === 'cleaning_required') {
        await beginCleaningMutation.mutateAsync({ resourceId: room.id });
      }
      await completeCleaningMutation.mutateAsync({ resourceId: room.id });
      toast.success(t('queue.quRoomCleaned', { p0: room.name }));
      await refetchRooms();
    } catch (err) {
      toast.danger(errorMessage(err));
    } finally {
      setCleaningRoomId(null);
    }
  };

  /** 打开作废弹窗。默认原因为「录入错误」——它是唯一会把客人退回候客区的分支。 */
  const requestVoid = (item: KanbanItem, reason: VoidReason = 'input_error') => {
    if (!canVoidTicket) {
      toast.danger(t('queue.quVoidNoPermission'));
      return;
    }
    if (!item.ticketId && !item.rawTicket) {
      toast.info(t('queue.quVoidNoTicket'));
      return;
    }
    setRollbackModal({ isOpen: false, item: null, fromStage: null, toStage: null, reason: 'entry_error', notes: '' });
    setVoidModal({ isOpen: true, item, reason, notes: '' });
  };

  const handleConfirmVoid = async () => {
    const { item, reason, notes } = voidModal;
    const ticketId = item?.ticketId ?? item?.rawTicket?.ticketId;
    if (!item || !ticketId || voidTicketMutation.isPending) return;
    try {
      await voidTicketMutation.mutateAsync({
        ticketId,
        reason,
        ...(notes ? { note: notes } : {}),
      });
      setVoidModal({ isOpen: false, item: null, reason: 'input_error', notes: '' });
      toast.warning(t('queue.quVoided', { p0: item.customerName }));
      await Promise.all([refetchQueue(), refetchSchedule(), refetchTickets(), refetchRooms()]);
    } catch (err) {
      toast.danger(`${t('queue.quVoidFailed')} ${errorMessage(err)}`);
    }
  };

  /**
   * 判定这张卡片当前该收哪一笔。
   *
   * 一律以工单事实为准并复用收银页的 `paymentStageFor()`；工单尚未读到时
   * 退回 `combined`，与改造前的行为一致，不至于让老单子失去收款入口。
   */
  const resolvePaymentStage = (item: KanbanItem): PaymentStage => {
    const ticket = item.rawTicket;
    return (ticket ? paymentStageFor(ticket) : null) ?? 'combined';
  };

  /**
   * 打开收银弹窗。
   *
   * 小费阶段的服务款已经收过，本次应收基数为零，因此现金实收默认值也必须清零 ——
   * 沿用整单金额会让前台照着一个已经收过的数字再收一遍。
   */
  const openCheckoutModal = (item: KanbanItem, stage: PaymentStage) => {
    const isTipOnly = stage === 'tip';
    setCheckoutModal({
      isOpen: true,
      item,
      discountDollars: '0',
      enableTax: !isTipOnly && Number.parseFloat(checkoutSettings?.salesTaxRatePercent || '0') > 0,
      taxRatePercent: checkoutSettings?.salesTaxRatePercent || '0',
      enableCardSurcharge: false,
      cardSurchargePercent: '3.0',
      tipMode: 'total_split',
      tipPercentage: 15,
      totalTipDollars: '',
      splitStrategy: 'proportional',
      customStaffTips: {},
      paymentMethod: 'card',
      paymentStage: stage,
      tenderedDollars: isTipOnly ? '' : centsToDollars(item.priceCents),
      keepChange: false,
      giftCardCode: '',
      giftCardId: '',
      giftCardVerified: false,
      giftCardBalanceCents: 0,
      isVerifyingGiftCard: false,
    });
  };

  /**
   * 把签到时勾选的接待要点整理成一段人读的文字。
   *
   * 之所以落成自由文本而不是结构化字段：预约的「服务前须知」是技师端已经在读的
   * 唯一一处交接说明，写在这里不需要新增存储，技师也不必再去别的地方找。
   * 文案按当前界面语言渲染 —— 写给人看的东西，语言应当与录入者一致。
   */
  const composeCheckInBrief = (input: {
    contraindications: string[];
    massageStrength: string;
    aromaOil: string;
    focusAreas: string[];
    avoidAreas: string[];
    notes: string;
  }): string => {
    const labelOf = (options: TagOption[], id: string) => {
      const option = options.find((entry) => entry.id === id);
      return option ? t(option.labelKey) : id;
    };
    const lines: string[] = [];

    const contraindications = input.contraindications.filter((id) => id !== CONTRAINDICATION_NONE);
    if (contraindications.length > 0) {
      lines.push(`${t('queue.quIntakeBriefContra')}: ${contraindications.map((id) => labelOf(CONTRAINDICATION_TAGS, id)).join(' / ')}`);
    }
    const avoidAreas = input.avoidAreas.filter((id) => id !== AVOID_AREA_NONE);
    if (avoidAreas.length > 0) {
      lines.push(`${t('queue.quIntakeBriefAvoid')}: ${avoidAreas.map((id) => labelOf(AVOID_AREA_TAGS, id)).join(' / ')}`);
    }
    if (input.massageStrength && input.massageStrength !== STRENGTH_DEFAULT) {
      lines.push(`${t('queue.quIntakeBriefStrength')}: ${labelOf(STRENGTH_OPTIONS, input.massageStrength)}`);
    }
    if (input.aromaOil && input.aromaOil !== AROMA_OIL_DEFAULT) {
      const oil = AROMA_OIL_OPTIONS.find((entry) => entry.id === input.aromaOil);
      lines.push(`${t('queue.quIntakeBriefOil')}: ${oil ? t(oil.labelKey) : input.aromaOil}`);
    }
    if (input.focusAreas.length > 0) {
      lines.push(`${t('queue.quIntakeBriefFocus')}: ${input.focusAreas.map((id) => labelOf(FOCUS_AREA_TAGS, id)).join(' / ')}`);
    }
    const note = input.notes.trim();
    if (note) lines.push(`${t('queue.quIntakeBriefNote')}: ${note}`);

    if (lines.length === 0) return '';
    return [`【${t('queue.quIntakeBriefHeading')}】`, ...lines].join('\n');
  };

  // 1. Check-In Confirm Submit
  const handleConfirmCheckIn = async () => {
    const {
      item,
      selectedAddOnId,
      addOnStaffId,
      qrScanned,
      contraindications,
      massageStrength,
      aromaOil,
      focusAreas,
      avoidAreas,
      notes,
      attemptKey,
    } = checkInModal;
    if (!item) return;
    if (checkInPending) return;
    setCheckInError(null);

    const addOnService = services.find((s) => s.id === selectedAddOnId);
    const brief = composeCheckInBrief({ contraindications, massageStrength, aromaOil, focusAreas, avoidAreas, notes });
    const hasIntakeDetails = Boolean(brief || addOnService);

    /*
     * 免责协议门禁：单据上确实挂着未签署的问卷，既没有电子签署记录，
     * 前台又没确认收到纸质件，就不放行。这条勾选此前完全没有被读取过。
     * 判定条件用 pendingForms 而非「没有已签问卷」—— 未配置问卷模板的门店
     * 不应该因此被拦住。
     */
    if (hasPendingForms(item) && completedCheckInForms.length === 0 && !qrScanned) {
      setCheckInError(`${t('queue.quWaiverGateTitle')} — ${t('queue.quWaiverGateHint')}`);
      return;
    }

    /* 接待要点与现场加项都要挂到预约上；没有预约可挂时如实告知，而不是静默丢弃。 */
    if (hasIntakeDetails && !item.appointmentId) {
      setCheckInError(t('queue.quIntakeNeedsAppointment'));
      return;
    }

    try {
      if (item.stage === 'booked' && item.appointmentId) {
        await join.mutateAsync({
          appointmentId: item.appointmentId,
          walkInName: item.customerName,
          requestedServiceId: item.serviceId || null,
          requestedStaffId: item.staffId === UNASSIGNED_STAFF_ID ? null : item.staffId || null,
        });
      }

      /*
       * 签到本身已经成功，后续两步即便失败也不能把顾客退回未到店 ——
       * 因此各自单独兜错，并明确告诉前台「人已进来了，缺的是这一项」。
       */
      if (brief && item.appointmentId) {
        try {
          await saveCheckInBriefMutation.mutateAsync(brief);
          checkInBriefByAppointment.current.set(item.appointmentId, brief);
        } catch {
          toast.warning(t('queue.quIntakeSaveFailed'), { timeout: 8_000 });
        }
      }

      if (addOnService && item.appointmentId) {
        try {
          await addAppointmentItemMutation.mutateAsync({
            appointmentId: item.appointmentId,
            serviceId: addOnService.id,
            membershipId: addOnStaffId && addOnStaffId !== UNASSIGNED_STAFF_ID
              ? addOnStaffId
              : item.staffId && item.staffId !== UNASSIGNED_STAFF_ID ? item.staffId : null,
            durationMin: addOnService.durationMin,
            idempotencyKey: `queue-checkin-addon-${item.appointmentId}-${addOnService.id}-${attemptKey}`,
          });
        } catch {
          toast.warning(t('queue.quAddOnAddFailed'), { timeout: 8_000 });
        }
      }

      setCheckInModal((prev) => ({ ...prev, isOpen: false, item: null }));
      setAiSummarySubmissionId(null);
      setCheckInError(null);
      toast.success(t('queue.quCheckedIn', { p0: item.customerName }), brief
        ? { description: t('queue.quIntakeSaved') }
        : undefined);
      await Promise.all([refetchQueue(), refetchSchedule()]);
    } catch (err: any) {
      const message = `${t('queue.quCheckInFailed')} ${errorMessage(err) || t('queue.quNetworkError')}`;
      setCheckInError(message);
      toast.danger(message, { timeout: 8_000 });
    }
  };

  const addStartServiceAddOn = () => {
    const selectedService = services.find((service) => service.id === startServiceModal.extraAddOnServiceId);
    const requestedStaffId = startServiceModal.extraAddOnStaffId
      && startServiceModal.extraAddOnStaffId !== UNASSIGNED_STAFF_ID
      ? startServiceModal.extraAddOnStaffId
      : startServiceModal.staffId
        || startServiceModal.assignments[0]?.staffIds[0]
        || staff.find((member) => member.membershipId !== UNASSIGNED_STAFF_ID && member.isBookable)?.membershipId
        || '';
    const selectedStaff = staff.find((member) => member.membershipId === requestedStaffId && member.membershipId !== UNASSIGNED_STAFF_ID);
    if (!selectedService || !selectedStaff) {
      toast.danger(t('queue.quAddOnStaffRequired'));
      return;
    }

    setStartServiceModal((prev) => ({
      ...prev,
      extraAddOnServiceId: '',
      extraAddOnStaffId: selectedStaff.membershipId,
      addedAddOns: [
        ...prev.addedAddOns,
        {
          idempotencyKey: crypto.randomUUID(),
          roomId: prev.assignments[0]?.roomId ?? '',
          serviceId: selectedService.id,
          name: selectedService.name,
          priceCents: selectedService.priceCents,
          durationMin: selectedService.durationMin,
          staffId: selectedStaff.membershipId,
          staffName: selectedStaff.name,
        },
      ],
    }));
  };

  const overbookMessageOf = (err: unknown): string => {
    const detail = overbookDetail(err);
    return detail
      ? t('queue.quOverbookDetail', { p0: detail.wouldBe, p1: detail.limit })
      : t('queue.quOverbookGeneric');
  };

  /**
   * 一次入座尝试已经产生了不可回滚的写入之后，如何收场。
   *
   * 关键在于：`startServiceModal.item` 是打开弹窗那一刻的快照。`ticket.open`
   * 一旦成功，这张卡的身份就从「候客条目」变成了「工单」，快照里的
   * `ticketId` 永远是空的。此时把弹窗留在屏幕上，前台再点一次确认，走的
   * 依然是「这单还没开」那条分支 —— 于是同一间已经被自己占掉的房会被反复
   * 申请，服务端每次都如实回一句 RESOURCE_CONFLICT，看上去就是「弹窗不消失，
   * 越点越错」。因此这里一律收起弹窗并强制刷新，让前台面对的是卡片的真实状态。
   */
  const abortStartServiceAttempt = async () => {
    setStartServiceModal((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
    await Promise.all([refetchQueue(), refetchTickets(), refetchSchedule(), refetchRooms()]);
    toast.warning(t('queue.quSeatAborted'), { timeout: 10_000 });
  };

  /**
   * 放弃超排放行。
   *
   * 走到这个确认框时工单已经开出来了，可能还有若干项目已经开工 —— 只把
   * 确认框关掉等于把这半张单留在看板上而不告诉任何人。因此按「入座中止」
   * 同一条路径收场：清弹窗、刷新、如实提示。
   */
  const declineOverbook = async () => {
    setOverbookConfirm(null);
    await abortStartServiceAttempt();
  };

  /*
   * 2. Start Service Confirm Submit
   *
   * `override` 由「技师已满，仍要开始」确认框回传。**同一次尝试**可以安全
   * 重放：开单的幂等键含本次的 `attemptKey`，加项的幂等键在弹窗状态里，
   * 超排放行重试会被服务端判为同一次意图，不会开出第二张单。
   *
   * 但「重放」只对超排这条**保留弹窗状态**的路径成立。其余任何失败一旦已经
   * 写过数据，`item` 这份快照就与服务端不符了，必须走 `abortStartServiceAttempt()`
   * 收场，而不是让前台对着过期的快照再点一次 —— 见那个函数上的说明。
   */
  const handleConfirmStartService = async (override?: Override) => {
    const {
      item,
      staffId,
      assignments,
      addedAddOns,
      roomId,
      startTime,
      serviceDurationMin,
      requireBriefingAck,
      serviceBrief,
      attemptKey,
    } = startServiceModal;
    if (!item) return;
    if (startServicePending) return;

    const assignedStaff = staff.find((s) => s.membershipId === staffId);
    const assignedRoom = rooms.find((r) => r.id === roomId);
    /*
     * 本次尝试是否已经动过服务端数据。校验不通过时它一直是 false，弹窗原样
     * 留着让前台改；只要写过一笔，失败就必须走 `abortStartServiceAttempt()`。
     */
    let committed = false;

    try {
      /*
       * 校验失败必须说清楚是哪一项不满足。这四种情况此前共用一句「入座失败」，
       * 前台看到的是一个点下去没有任何变化的按钮 —— 尤其是多项目预约聚合卡
       * 缺 `serviceId` 那一种，怎么改都过不去，而界面上没有任何线索。
       */
      if (assignments.length === 0 || (!item.serviceId && (item.rawQueue?.items?.length ?? 0) === 0)) {
        toast.danger(t('queue.quSeatNeedService'));
        return;
      }
      if (assignments.some((assignment) => assignment.staffIds.length !== assignment.staffCount)) {
        toast.danger(t('queue.quSeatNeedStaff'));
        return;
      }
      if (addedAddOns.some((addOn) => !addOn.staffId || addOn.staffId === UNASSIGNED_STAFF_ID)) {
        toast.danger(t('queue.quAddOnStaffRequired'));
        return;
      }
      if (hasPendingForms(item) && !requireBriefingAck) {
        toast.danger(t('queue.quSeatBriefingRequired'));
        return;
      }

      if (item.appointmentId && serviceBrief.trim() !== (item.notes || '').trim()) {
        await saveServiceBriefMutation.mutateAsync(serviceBrief.trim());
        committed = true;
      }

      let ticketId = item.ticketId ?? item.rawTicket?.ticketId;
      let ticketItemIds = item.rawTicket ? queueTicketItems(item.rawTicket.items)
        .filter((ticketItem) => !ticketItem.startedAt)
        .map((ticketItem) => ticketItem.ticketItemId) : [];
      if (!ticketId) {
        const appointmentItems = item.rawQueue?.items ?? [];
        const soleServiceId = item.serviceId;
        if (appointmentItems.length === 0 && !soleServiceId) {
          toast.danger(t('queue.quSeatNeedService'));
          return;
        }
        const itemsToOpen = appointmentItems.length > 0
          ? appointmentItems.map((appointmentItem, index) => {
              const assignment = assignments[index];
              return {
                serviceId: appointmentItem.serviceId,
                staffAssignments: (assignment?.staffIds ?? []).map((membershipId, staffIndex) => ({
                  membershipId,
                  role: staffIndex === 0 ? 'primary' as const : 'assistant' as const,
                  minutes: appointmentItem.durationMin,
                })),
                minutes: appointmentItem.durationMin,
                ...(assignment?.roomId ? { resourceId: assignment.roomId } : {}),
              };
            })
          : [{
              serviceId: soleServiceId!,
              staffAssignments: assignments[0]!.staffIds.map((membershipId, staffIndex) => ({
                membershipId,
                role: staffIndex === 0 ? 'primary' as const : 'assistant' as const,
                minutes: serviceDurationMin,
              })),
              minutes: serviceDurationMin,
              ...(assignments[0]?.roomId ? { resourceId: assignments[0].roomId } : {}),
            }];
        const opened = await openTicketMutation.mutateAsync({
          customerId: item.rawQueue?.customerId ?? null,
          ...(item.rawQueue?.customerId ? {} : { walkInName: item.customerName }),
          ...(item.appointmentId ? { appointmentId: item.appointmentId } : {}),
          items: itemsToOpen,
          idempotencyKey: `queue-start-${item.appointmentId ?? item.queueId ?? item.id}-${attemptKey}`,
        });
        committed = true;
        ticketId = opened.ticketId;
        ticketItemIds = opened.ticketItemIds;
      }

      const itemsToStart = ticketItemIds.map((ticketItemId, index) => ({
        ticketItemId,
        membershipId: item.rawTicket?.items.find((entry) => entry.ticketItemId === ticketItemId)?.membershipId
          ?? assignments[index]?.staffIds[0],
      }));
      if (ticketId) {
        for (const addOn of addedAddOns) {
          /*
           * 已经落库的加项不再重发。超排放行是唯一一条会保留弹窗状态重试的
           * 路径，这一行就是为它写的 —— 幂等键虽然也挡得住重发，但把「已进单」
           * 记在状态里，界面才能把这一条锁成不可删改，前台也就没有机会删掉它
           * 重选出一个新的幂等键来。
           */
          if (addOn.sentTicketItemId) {
            itemsToStart.push({ ticketItemId: addOn.sentTicketItemId, membershipId: addOn.staffId });
            continue;
          }
          const added = await addTicketItemMutation.mutateAsync({
            ticketId, serviceId: addOn.serviceId, membershipId: addOn.staffId,
            kind: 'addon', minutes: addOn.durationMin, idempotencyKey: addOn.idempotencyKey,
            ...(addOn.roomId ? { resourceId: addOn.roomId } : {}),
          });
          committed = true;
          setStartServiceModal((prev) => ({
            ...prev,
            addedAddOns: prev.addedAddOns.map((entry) => entry.idempotencyKey === addOn.idempotencyKey
              ? { ...entry, sentTicketItemId: added.ticketItemId } : entry),
          }));
          itemsToStart.push({ ticketItemId: added.ticketItemId, membershipId: addOn.staffId });
        }
      }

      // Open/add keys survive retries; startItem preserves the original start timestamp.
      for (const target of itemsToStart) {
        if (!target.membershipId) throw new Error(t('queue.quAddOnStaffRequired'));
        try {
          await startTicketItemMutation.mutateAsync({
            ticketItemId: target.ticketItemId, membershipId: target.membershipId,
            ...(override ? { override } : {}),
          });
          committed = true;
        } catch (startErr) {
          if (!override && isOverbookConfirmable(startErr)) {
            /*
             * 只收起入座弹窗，不清空它的状态 —— 放行重试要原样重放这一次意图
             * （开单与加项的幂等键都在这份状态里）。此前两个弹窗同时挂在
             * z-[300] 上，前台看到的就是「点了没消失」，然后去点下面那个已经
             * 失效的确认按钮。放行或取消之后，由各自的收尾逻辑清状态。
             */
            setStartServiceModal((prev) => ({ ...prev, isOpen: false }));
            setOverbookConfirm({ message: overbookMessageOf(startErr) });
            return;
          }
          throw startErr;
        }
      }
      if (item.queueId) {
        await update.mutateAsync({ queueId: item.queueId, status: 'seated' });
      }
      setStartServiceModal((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
      toast.success(t('queue.quSeated', { p0: item.customerName }), {
        description: t('queue.quSeatedDetail', { p0: assignedStaff?.name || t('queue.quAssignedFallback'), p1: assignedRoom?.name || t('queue.quDesignatedRoomFallback'), p2: startTime, p3: serviceDurationMin }),
      });
      await Promise.all([refetchQueue(), refetchTickets(), refetchSchedule(), refetchRooms()]);
    } catch (err: unknown) {
      /*
       * `ApiError.message` 就是错误码本身（`super(code)`），直接拼进 toast 等于
       * 让前台读「入座失败RESOURCE_CONFLICT」。本文件其余每一处 catch 走的都是
       * `errorMessage()`，只有这里漏了。
       */
      toast.danger(`${t('queue.quSeatFailed')} ${errorMessage(err) || t('queue.quNetworkError2')}`);
      if (committed) await abortStartServiceAttempt();
    }
  };

  // 3. Complete Service Confirm Submit
  const handleConfirmCompleteService = async () => {
    const { item, addedAddOns, technicianNotes, markRoomCleaning, roomId } = completeServiceModal;
    if (!item) return;
    if (completeServicePending) return;

    const result = await completeQueueService(
      {
        rawTicket: item.rawTicket,
        technicianNotes,
        markRoomCleaning,
        roomId,
        addedAddOns,
      },
      {
        addItem: (input) => addTicketItemMutation.mutateAsync(input),
        saveNote: (input) => saveServiceNoteMutation.mutateAsync(input),
        startItem: (input) => startTicketItemMutation.mutateAsync(input),
        finishItem: (input) => finishTicketItemMutation.mutateAsync(input),
        beginCleaning: (input) => beginCleaningMutation.mutateAsync(input),
        onAddOnSent: (idempotencyKey, ticketItemId) => setCompleteServiceModal((prev) => ({
          ...prev,
          addedAddOns: prev.addedAddOns.map((entry) => entry.idempotencyKey === idempotencyKey
            ? { ...entry, sentTicketItemId: ticketItemId } : entry),
        })),
      },
    );

    if (!result.ok) {
      /*
       * 只要这一轮已经有命令落库，弹窗里的 `rawTicket` 快照就已经过期 ——
       * 最常见的是加项已经记进单据、完工那一步才失败。此时把弹窗原样留着，
       * 前台看到的是「失败了，加项还列在这儿」，于是删掉重选再点一次；而
       * 重选会生成新的幂等键，同一个加项就在单据上出现第二遍。因此一律收起
       * 弹窗并刷新，让前台面对单据的真实内容。
       */
      const settle = async (messageKey: TranslationKey, detail?: string) => {
        toast.danger(detail ? `${t(messageKey)} ${detail}` : t(messageKey));
        if (result.committed) {
          setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
          await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms()]);
          toast.warning(t('queue.quFinishAborted'), { timeout: 10_000 });
        }
      };
      if (result.reason === 'no_active_service') {
        await settle('queue.quNoActiveService');
        return;
      }
      if (result.reason === 'missing_ticket' || result.reason === 'missing_room') {
        await settle('queue.quFinishFailed');
        return;
      }
      if (result.finished) {
        setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
        toast.danger(t('queue.quFinishRoomFailed'));
        await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms()]);
        return;
      }
      await settle('queue.quFinishFailed', errorMessage(result.cause) || t('queue.quNetworkError2'));
      return;
    }

    setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
    toast.success(t(result.ticketDone ? 'queue.quServiceDone' : 'queue.quServiceStageDone', { p0: item.customerName }), {
      description: t(result.ticketDone ? 'queue.quServiceDoneDetail' : 'queue.quServiceStageDoneDetail', {
        p0: result.actualMinutes,
        p1: centsToDollars(result.subtotalCents),
      }),
    });
    await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms()]);
  };

  // 4. Checkout Tender Confirm Submit
  const handleConfirmCheckout = async () => {
    const { item, paymentMethod, paymentStage, tenderedDollars, keepChange, giftCardCode, giftCardId, giftCardVerified, giftCardBalanceCents } = checkoutModal;
    if (!item) return;
    if (closeTicketMutation.isPending) return;

    /*
     * 服务端拒绝以礼品卡或客户储值支付小费。在这里提前拦下，
     * 前台就不必先填完整个弹窗再去读一条校验失败。
     */
    if (paymentStage === 'tip' && paymentMethod === 'gift_card') {
      toast.danger(t('queue.quCoStageTipNoStoredValue'));
      return;
    }

    if (!item.ticketId) {
      toast.danger(t('queue.quCoNoTicket'));
      return;
    }

    const baseCents = item.priceCents || 0;
    /*
     * 与弹窗渲染共用同一份计算。分账明细、税额、手续费一律取自这里 ——
     * 前台屏幕上看到的数字就是发往服务端的数字。
     */
    const staffList = buildCheckoutStaffList(
      {
        serviceName: item.serviceName,
        priceCents: baseCents,
        staffId: item.staffId,
        staffName: item.staffName,
        rawTicket: item.rawTicket,
        addOns: item.addOns,
      },
      t('queue.quLeadTherapist'),
      (name) => t('queue.quAddOnPrefix', { p0: name }),
    );
    const totals = computeCheckoutTotals({
      staffList,
      baseCents,
      discountDollars: checkoutModal.discountDollars,
      enableTax: checkoutModal.enableTax,
      taxRatePercent: checkoutModal.taxRatePercent,
      enableCardSurcharge: checkoutModal.enableCardSurcharge,
      cardSurchargePercent: checkoutModal.cardSurchargePercent,
      paymentMethod,
      tipMode: checkoutModal.tipMode,
      tipPercentage: checkoutModal.tipPercentage,
      totalTipDollars: checkoutModal.totalTipDollars,
      splitStrategy: checkoutModal.splitStrategy,
      customStaffTips: checkoutModal.customStaffTips,
      paymentStage,
      tipBaseCents: baseCents,
    });

    let tipCents = totals.totalTipCents;
    let finalTotalCents = totals.chargedTotalCents;

    if (checkoutModal.tipMode === 'custom_per_staff' && tipCents > 0
      && totals.tipAllocations.every((allocation) => allocation.allocatedTipCents === 0)) {
      toast.danger(t('queue.quCoTipSplitEmpty'));
      return;
    }

    const isCash = paymentMethod === 'cash';
    const tenderedCents = isCash ? dollarsToCents(tenderedDollars || '0') : undefined;
    if (tenderedCents !== undefined && tenderedCents < finalTotalCents) {
      toast.danger(t('queue.quCoInsufficientCash', {
        p0: centsToDollars(tenderedCents),
        p1: centsToDollars(finalTotalCents),
      }));
      return;
    }

    /*
     * 「不用找了」必须落成小费，且计入实收金额 ——
     * 不记录的话打烊点钞会平白多出这笔钱，而账面上无法解释。
     */
    const cashRemainder = tenderedCents === undefined ? 0 : tenderedCents - finalTotalCents;
    const keepChangeCents = isCash && keepChange && cashRemainder > 0 ? cashRemainder : 0;
    tipCents += keepChangeCents;
    finalTotalCents += keepChangeCents;

    /*
     * 小费分账按 membershipId 上报。
     * 此前这里把技师姓名当成 membershipId 发了出去，重名还会被并成一个人。
     * 归属不明的占位行不发送，其余尾差补到第一位，保证各行之和等于小费总额。
     */
    const tipSplits = allowTipSplitOverride
      ? totals.tipAllocations
          .filter((allocation) => allocation.membershipId !== UNRESOLVED_STAFF_KEY && allocation.allocatedTipCents > 0)
          .map((allocation) => ({
            staffMembershipId: allocation.membershipId,
            staffName: allocation.name,
            amountCents: allocation.allocatedTipCents,
          }))
      : [];
    if (tipSplits.length > 0) {
      const assigned = tipSplits.reduce((sum, split) => sum + split.amountCents, 0);
      const remainder = tipCents - assigned;
      if (remainder < 0) {
        toast.danger(t('queue.quCoTipSplitOverflow'));
        return;
      }
      if (remainder > 0) tipSplits[0]!.amountCents += remainder;
    }

    const giftCard = inlineGiftCardFields(
      paymentMethod,
      { giftCardCode, giftCardId, giftCardVerified, giftCardBalanceCents },
      finalTotalCents,
    );
    if (!giftCard.ok) {
      toast.danger(
        giftCard.reason === 'overspend'
          ? t('checkout.giftCardOverspend', {
            p0: centsToDollars(finalTotalCents),
            p1: centsToDollars(giftCardBalanceCents),
          })
          : t('queue.quGiftCardRequired'),
      );
      return;
    }

    try {
      const receipt = await closeTicketMutation.mutateAsync({
        ticketId: item.ticketId,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        taxRateBp: Math.round(parseFloat(checkoutModal.taxRatePercent || '0') * 100),
        taxCalculationMode: checkoutSettings?.taxCalculationMode || 'exclusive',
        surchargeCents: totals.cardSurchargeCents,
        surchargeRateBp: Math.round(parseFloat(checkoutModal.cardSurchargePercent || '0') * 100),
        tipTotalCents: tipCents,
        ...(tipSplits.length > 0 ? { tipSplits } : {}),
        /*
         * ⚠️ 幂等键必须稳定。超时重试若换了键，客人会被扣两次款，
         * 而这类错误往往要到对账时才被发现。此前这里没有传，
         * 每次重试都会拿到一个新的随机键，幂等保护形同虚设。
         */
        paymentStage,
        /*
         * ⚠️ 幂等键必须稳定，且必须包含收款阶段。超时重试若换了键，
         * 客人会被扣两次款；而两个阶段共用一个键，第二笔会被判为重放 ——
         * 小费收不进来，且服务端不会报错，只有对账时才发现。
         */
        idempotencyKey: `queue-pay-${item.ticketId}-${paymentStage}`,
        payments: [
          {
            method: paymentMethod === 'apple_pay' ? 'card' : paymentMethod,
            amountCents: finalTotalCents,
            tipCents,
            ...(tenderedCents !== undefined ? { tenderedCents } : {}),
            changeCents: isCash && !keepChange ? cashRemainder : 0,
            keepChange: Boolean(keepChangeCents),
            ...(giftCard.giftCardId ? { giftCardId: giftCard.giftCardId } : {}),
            ...(giftCard.giftCardCode ? { giftCardCode: giftCard.giftCardCode } : {}),
          },
        ],
      });

      setCheckoutModal((prev) => ({ ...prev, isOpen: false, item: null }));

      const successKey = paymentStage === 'service'
        ? 'queue.quCoStageServiceDone'
        : paymentStage === 'tip'
          ? 'queue.quCoStageTipDone'
          : 'queue.quCheckoutDone';
      toast.success(t(successKey, { p0: item.customerName }), {
        description: t('queue.quCheckoutDetail', {
          p0: centsToDollars(finalTotalCents),
          p1: t(PAYMENT_METHOD_LABEL_KEYS[paymentMethod]),
        }),
      });

      if (checkoutSettings?.autoPrintReceipt !== false) navigate(`/print/receipt/${receipt.ticketId}`);
      await Promise.allSettled([refetchTickets(), refetchSchedule(), refetchRooms(), refetchQueue(), openTicketsQ.refetch()]);
    } catch (err: any) {
      toast.danger(`${t('queue.quCheckoutFailed')} ${errorMessage(err) || t('queue.quNetworkError3')}`);
    }
  };

  // 5. Reverse Rollback Confirm Submit
  const handleConfirmRollback = async () => {
    const { item, toStage, reason, notes } = rollbackModal;
    if (!item || !toStage) return;
    if (rollbackStageMutation.isPending) return;
    const appointmentId = item.appointmentId;
    if (!appointmentId || !canRollbackTo(item, toStage)) {
      toast.danger(t('queue.quRollbackNotSupported', { p0: t(STAGE_NAME_KEYS[toStage]) }));
      return;
    }
    const fromStage = item.stage === 'ready_checkout' ? 'ready_to_pay'
      : item.stage === 'completed' ? 'completed'
      : item.stage;
    try {
      await rollbackStageMutation.mutateAsync({
        appointmentId,
        ...(item.queueId ? { queueId: item.queueId } : {}),
        fromStage: fromStage === 'booked' ? 'checked_in' : fromStage,
        targetStage: toStage,
        reason: reason === 'customer_extend' ? 'customer_delayed'
          : reason === 'staff_emergency' ? 'service_restart'
          : reason === 'entry_error' ? 'wrong_drag' : 'other',
        ...(notes ? { notes } : {}),
      });
      setRollbackModal({ isOpen: false, item: null, fromStage: null, toStage: null, reason: 'entry_error', notes: '' });
      const reasonOption = ROLLBACK_REASONS.find((entry) => entry.id === reason);
      toast.warning(t('queue.quRolledBack', { p0: item.customerName, p1: t(STAGE_NAME_KEYS[toStage]) }), {
        description: t('queue.quRollbackReason', { p0: reasonOption ? t(reasonOption.labelKey) : '' }),
      });
      await Promise.all([refetchQueue(), refetchSchedule(), refetchTickets(), refetchRooms()]);
    } catch (err: any) {
      toast.danger(`${t('queue.quRollbackFailed')} ${errorMessage(err) || t('queue.quNetworkError2')}`);
    }
  };

  /**
   * walk-in 直接开单（组合套餐，U10 / 计划 §7）。
   *
   * 无预约到店客：`ticket.open` 带 `bundleSelections`、不带 `appointmentId`，
   * 每个执行单元恰好一位技师。展开 / 排程 / 分摊 / 计价全部服务端完成。
   *
   * 幂等键按「客人 + 套餐 + 本次打开弹窗」固定：同一次提交重试不会开出第二
   * 张单，而同名客人同一天再买一份同样的套餐（门店里就是两位都叫 Lisa 的
   * walk-in）也不会被服务端当成重放静默吞掉。
   */
  const handleOpenWalkInBundle = async (input: WalkInBundleSubmit) => {
    await openTicketMutation.mutateAsync({
      customerId: null,
      walkInName: input.walkInName,
      items: [],
      bundleSelections: [{
        bundleId: input.bundleId,
        expectedVersion: input.expectedVersion,
        unitOverrides: input.unitStaffIds.map((membershipId) => ({ membershipId })),
        ...(input.extraAddons.length ? { extraAddons: input.extraAddons } : {}),
      }],
      idempotencyKey: `queue-walkin-bundle-${input.walkInName}-${input.bundleId}-${walkInBundle.attemptKey}`,
    });
    setWalkInBundle({ isOpen: false, attemptKey: '' });
    toast.success(t('bundle.walkInSuccess', { name: input.walkInName }));
    await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms(), refetchQueue()]);
  };

  /**
   * 逐项目的开始 / 完成。
   *
   * 卡片上每一行都自带这个动作 —— 多项目单的第二项此前在看板上没有任何
   * 入口，工单会永久卡在服务中。
   */
  const handleToggleTicketItem = async (
    item: KanbanItem,
    service: { ticketItemId: string; membershipId: string; startedAt: string | null },
  ) => {
    setBusyTarget({ itemId: item.id, ticketItemId: service.ticketItemId });
    try {
      const command = service.startedAt ? finishTicketItemMutation : startTicketItemMutation;
      await command.mutateAsync({ ticketItemId: service.ticketItemId, membershipId: service.membershipId });
      await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusyTarget(null);
    }
  };

  // Drag & Drop Handlers
  const handleDragStart = (e: React.DragEvent, item: KanbanItem) => {
    e.dataTransfer.setData('text/plain', item.id);
    setDraggingItemId(item.id);
  };

  const handleDragOver = (e: React.DragEvent, stage: KanbanStage) => {
    e.preventDefault();
    setDragOverColumn(stage);
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
  };

  const handleDrop = (e: React.DragEvent, targetStage: KanbanStage) => {
    e.preventDefault();
    setDragOverColumn(null);
    const itemId = e.dataTransfer.getData('text/plain') || draggingItemId;
    setDraggingItemId(null);

    if (!itemId) return;
    const targetItem = kanbanItems.find((x) => x.id === itemId);
    if (targetItem) {
      initiateStageTransition(targetItem, targetStage);
    }
  };

  if (isInitialLoading) {
    return <PageLoading title={t('queue.quLoading')} description={t('queue.quLoadingDesc')} />;
  }

  if (queueError && !queue) {
    return <PageError title={t('queue.quLoadError')} error={queueErr} onRetry={refetchQueue} />;
  }

  return (
    <div className="flex flex-col h-full space-y-3.5">
      {/* 顶部标题与运营全局统计仪表 */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2.5 min-w-0">
            <Sparkles className="w-6 h-6 text-teal-600 shrink-0" />
            <span className="whitespace-nowrap">{t('queue.quTitle')}</span>
          </h1>
          {isSyncing && <Spinner size="sm" className="w-4 h-4 text-teal-600 ml-1" />}
        </div>

        {/* 顶部核心指标与状态药丸卡片组（同高整齐排布） */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* 轮牌前三技师卡片 */}
          <div
            onClick={() => setIsStaffAttendanceModalOpen(true)}
            className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5 cursor-pointer hover:border-teal-400 hover:shadow-sm transition-all group"
            title={t('queue.quStaffPunchBtn')}
          >
            <Clock className="w-4 h-4 text-teal-600 shrink-0 group-hover:scale-110 transition-transform" />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quRotationTop3')}</span>
              {top3Rotation.length === 0 ? (
                <span className="font-medium text-slate-400 font-mono text-xs">{t('queue.quNoRotation')}</span>
              ) : (
                <div className="flex items-center gap-1.5 font-mono">
                        {top3Rotation.map((entry, idx) => (
                          <span key={entry.membershipId} className="flex items-center gap-0.5 font-bold text-slate-800">
                      <span className={cn(
                        "w-3.5 h-3.5 rounded text-xs flex items-center justify-center font-bold",
                        idx === 0 ? "bg-amber-100 text-amber-900" : idx === 1 ? "bg-slate-200 text-slate-700" : "bg-orange-100 text-orange-900"
                      )}>
                        {/* 引擎的 position 是 0 基，第一位要显示 #1 —— 与入座弹窗、考勤面板同一份规则。 */}
                        {rotationRank(entry.position, idx)}
                      </span>
                      <span>{entry.name}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/*
            房间空位卡片。可点开 —— 前台在看板上最常问「哪个位子扫好了没有」，
            此前答案只在房间状态页里，扫完一个位子要离开看板、切页、再切回来，
            而这中间客人就站在台前等位。
          */}
          <button
            type="button"
            aria-label={t('queue.quRoomsOpenPanel')}
            onClick={() => setIsRoomsPanelOpen(true)}
            className={cn(
              'px-3.5 py-2 rounded-xl border shadow-sm flex items-center gap-2.5 text-left transition-colors',
              roomsNeedingCleaning > 0
                ? 'bg-amber-50/80 border-amber-200 hover:bg-amber-100'
                : 'bg-white border-slate-200 hover:bg-slate-50',
            )}
          >
            <BedDouble className={cn('w-4 h-4 shrink-0', roomsNeedingCleaning > 0 ? 'text-amber-600' : 'text-indigo-600')} />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quRoomsFree')}</span>
              <span className="font-bold text-emerald-700 font-mono">
                {availableRoomsCount} / {totalRoomsCount}  {t('queue.quRoomsAvailableUnit')}
              </span>
              {/* 待清洁数量直接摆在这里：它是唯一挡着下一位客人的状态。 */}
              {roomsNeedingCleaning > 0 && (
                <span className="block font-bold text-amber-800">
                  {t('queue.quRoomsNeedCleaning', { p0: roomsNeedingCleaning })}
                </span>
              )}
            </div>
          </button>

          {/* 今日总单 */}
          <div className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5">
            <CalendarDays className="w-4 h-4 text-sky-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quTodayOrders')}</span>
              <span className="font-bold text-slate-900 font-mono">{metrics.totalBookings}  {t('queue.quOrderUnit')}</span>
            </div>
          </div>

          {/* 候客中 */}
          <div
            className={cn(
              'px-3.5 py-2 rounded-xl border shadow-sm flex items-center gap-2.5 transition-colors',
              metrics.waiting > 0
                ? 'bg-amber-50/80 border-amber-200 text-amber-900'
                : 'bg-white border-slate-200 text-slate-700',
            )}
          >
            <Clock className="w-4 h-4 text-amber-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quWaiting')}</span>
              <span className="font-bold font-mono">{metrics.waiting}  {t('queue.quPeopleUnit')}</span>
            </div>
          </div>

          {/* 服务中 */}
          <div className="px-3.5 py-2 rounded-xl bg-teal-50/80 border border-teal-200 shadow-sm flex items-center gap-2.5 text-teal-900">
            <Scissors className="w-4 h-4 text-teal-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quInService')}</span>
              <span className="font-bold font-mono">{metrics.inService}  {t('queue.quStaffUnit')}</span>
            </div>
          </div>

          {/* Open / Unpaid */}
          <div className="px-3.5 py-2 rounded-xl bg-violet-50/80 border border-violet-200 shadow-sm flex items-center gap-2.5 text-violet-900">
            <CreditCard className="w-4 h-4 text-violet-600 shrink-0" />
            <div className="text-xs">
              <span className="block text-xs text-slate-500">{t('queue.quMetricOpenUnpaid')}</span>
              <span className="font-bold font-mono">{metrics.readyCheckout}  {t('queue.quOrderUnit2')}</span>
            </div>
          </div>

          {/* 今日已结营收 */}
          <div className="px-3.5 py-2 rounded-xl bg-emerald-50/80 border border-emerald-200 shadow-sm flex items-center gap-2.5 text-emerald-900">
            <DollarSign className="w-4 h-4 text-emerald-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quRevenueToday')}</span>
              <span className="font-bold font-mono text-emerald-700">
                ${centsToDollars(metrics.revenueCents)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 前台工具与筛选栏 */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white p-2.5 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
          {/* 实时检索 */}
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder={t('queue.quSearchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/20 font-medium"
            />
          </div>

          {/* 技师筛选 */}
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-slate-50/50 focus:bg-white focus:outline-none font-medium text-slate-700"
            >
              <option value="all">{t('queue.quAllStaff')}</option>
              <option value={UNASSIGNED_STAFF_ID}>{t('queue.quUnassignedPool')}</option>
              {staff
                .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID)
                .map((s) => (
                  <option key={s.membershipId} value={s.membershipId}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
        </div>

        {/* 快捷动作按钮组 */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <Button
            size="sm"
            variant="secondary"
            className="text-xs font-semibold text-slate-700 gap-1.5 h-9 bg-white border-slate-200 hover:bg-slate-50 hover:text-teal-700 hover:border-teal-300 shadow-2xs"
            onClick={() => setIsStaffAttendanceModalOpen(true)}
          >
            <UserCheck className="w-3.5 h-3.5 text-teal-600" />
            <span>{t('queue.quStaffPunchBtn')}</span>
          </Button>

          <Button
            size="sm"
            variant="secondary"
            className="text-xs font-semibold text-slate-600 gap-1.5 h-9"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RotateCcw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin text-teal-600")} />
            <span>{t('queue.quRefresh')}</span>
          </Button>

          {canOpenTicket && (
            <Button
              size="sm"
              variant="secondary"
              className="text-xs font-semibold text-slate-700 gap-1.5 h-9 bg-white border-slate-200 hover:bg-slate-50 hover:text-teal-700 hover:border-teal-300 shadow-2xs"
              onClick={() => setWalkInBundle({ isOpen: true, attemptKey: crypto.randomUUID() })}
            >
              <Plus className="w-3.5 h-3.5 text-teal-600" />
              <span>{t('bundle.walkInButton')}</span>
            </Button>
          )}

          <Button
            size="sm"
            className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1.5 h-9"
            onClick={() => openCreateAppointment?.()}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('queue.quNewAppointment')}</span>
          </Button>
        </div>
      </div>

      <KanbanBoard
        items={filteredItems}
        focusItemId={focusApptId}
        timezone={timezone}
        draggingItemId={draggingItemId}
        dragOverColumn={dragOverColumn}
        isRefreshing={isRefreshing}
        busyTarget={busyTarget}
        canVoidTicket={canVoidTicket}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onViewDetails={handleViewDetails}
        onOpenFormQr={openFormQr}
        onRunNextAction={runNextAction}
        onItemAction={openItemAction}
        onRequestRollback={requestRollback}
        onRequestVoid={requestVoid}
        onPrintBrief={openServiceBrief}
        onToggleItem={handleToggleTicketItem}
        onSplitBundle={(ticketId, bundle) => setSplitTarget({ ticketId, bundle })}
      />

      <ConfirmDialog
        isOpen={splitTarget !== null}
        onOpenChange={(o) => { if (!o) setSplitTarget(null); }}
        title={t('bundle.splitConfirmTitle')}
        description={t('bundle.splitConfirmBody')}
        confirmLabel={t('bundle.split')}
        onConfirm={handleSplitBundleConfirm}
      />

      <WalkInBundleModal
        isOpen={walkInBundle.isOpen}
        onClose={() => setWalkInBundle({ isOpen: false, attemptKey: '' })}
        staff={staff}
        canWrite={canOpenTicket}
        isPending={openTicketMutation.isPending}
        onSubmit={handleOpenWalkInBundle}
      />


      <CheckInModal
        state={checkInModal}
        services={services}
        staff={staff}
        completedForms={completedCheckInForms}
        aiSummary={checkInAiSummary}
        aiSummarySubmissionId={aiSummarySubmissionId}
        isSummaryLoading={aiSummaryQ.isLoading}
        isSummaryFailed={aiSummaryQ.isError}
        language={language}
        formShare={checkInModal.item ? formShares[checkInModal.item.id] : undefined}
        errorText={checkInError}
        isPending={checkInPending}
        onChange={setCheckInModal}
        onConfirm={handleConfirmCheckIn}
        onOpenFormQr={openFormQr}
        onCopyFormLink={copyFormLink}
        onPickSummary={setAiSummarySubmissionId}
        onClearError={() => setCheckInError(null)}
      />

      <StartServiceModal
        state={startServiceModal}
        staff={staff}
        rooms={rooms}
        services={services}
        onlineTechIds={onlineTechIds}
        rotationEntries={orderedRotationEntries}
        scheduledItems={todaySnapshot?.items ?? []}
        isPending={startServicePending}
        onChange={setStartServiceModal}
        onConfirm={handleConfirmStartService}
        onAddAddOn={addStartServiceAddOn}
        onOpenFormQr={openFormQr}
        onCopyFormLink={copyFormLink}
      />


      <CompleteServiceModal
        state={completeServiceModal}
        services={services}
        staff={staff}
        rooms={rooms}
        isPending={completeServicePending}
        onChange={setCompleteServiceModal}
        onConfirm={handleConfirmCompleteService}
      />


      <CheckoutModal
        state={checkoutModal}
        checkoutSettings={checkoutSettings}
        allowTipSplitOverride={allowTipSplitOverride}
        isPending={closeTicketMutation.isPending}
        onChange={setCheckoutModal}
        onConfirm={handleConfirmCheckout}
      />


      <RollbackStageModal
        state={rollbackModal}
        isPending={rollbackStageMutation.isPending}
        canVoidTicket={canVoidTicket}
        onChange={setRollbackModal}
        onConfirm={handleConfirmRollback}
        onRequestVoid={requestVoid}
      />


      <VoidTicketModal
        state={voidModal}
        isPending={voidTicketMutation.isPending}
        onChange={setVoidModal}
        onConfirm={handleConfirmVoid}
      />

      <TicketItemActionModal
        state={itemActionModal}
        services={services}
        staff={staff}
        rooms={rooms}
        isPending={addTicketItemMutation.isPending
          || moveItemStaffMutation.isPending || moveItemResourceMutation.isPending}
        onChange={setItemActionModal}
        onConfirm={handleConfirmItemAction}
      />

      {/* 技师并发放行确认：服务端把这个错误标成可放行时才出现 */}
      {overbookConfirm && (
        <Modal
          isOpen={Boolean(overbookConfirm)}
          onOpenChange={(open) => { if (!open) void declineOverbook(); }}
          isDismissDisabled={startServicePending}
          title={
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              <span>{t('queue.quOverbookTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" isDisabled={startServicePending} onClick={() => { void declineOverbook(); }}>
                {t('cancel')}
              </Button>
              <Button
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold"
                disabled={startServicePending}
                onClick={() => {
                  setOverbookConfirm(null);
                  void handleConfirmStartService({ reason: overbookReason });
                }}
              >
                {t('queue.quOverbookForce')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-sm text-slate-700 py-2">
            <p className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium">
              {overbookConfirm.message}
            </p>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                {t('overrideReasonLabel')}
              </label>
              <select
                value={overbookReason}
                onChange={(e) => setOverbookReason(e.target.value as OverrideReason)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white"
              >
                {OVERRIDE_REASONS.map((reason) => (
                  <option key={reason} value={reason}>{t(OVERRIDE_REASON_LABELS[reason])}</option>
                ))}
              </select>
            </div>
          </div>
        </Modal>
      )}

      {/* 扫码放大模态框 */}
      {qrZoomModal && (
        <QRCodeZoomModal
          isOpen={qrZoomModal.isOpen}
          onClose={() => setQrZoomModal(null)}
          url={qrZoomModal.url}
          customerName={qrZoomModal.customerName}
          phone={qrZoomModal.phone}
          serviceName={qrZoomModal.serviceName}
        />
      )}

      <RoomsQuickModal
        isOpen={isRoomsPanelOpen}
        rooms={rooms}
        cleaningRoomId={cleaningRoomId}
        onOpenChange={setIsRoomsPanelOpen}
        onCleanDone={handleRoomCleanDone}
      />

      <AttendanceModal
        isOpen={isStaffAttendanceModalOpen}
        onOpenChange={setIsStaffAttendanceModalOpen}
        search={staffAttendanceSearch}
        onSearchChange={setStaffAttendanceSearch}
        filteredStaffAttendance={filteredStaffAttendance}
        onDutyStaff={onDutyStaff}
        offDutyStaff={offDutyStaff}
        nextUpStaff={nextUpStaff}
        attendanceMetrics={attendanceMetrics}
        onCheckIn={handleStaffAttendanceCheckIn}
        onCheckOut={handleStaffAttendanceCheckOut}
        onBreak={handleStaffAttendanceBreak}
        actingStaffId={actingAttendanceStaffId}
      />
    </div>
  );
}

export function Queue() {
  return (
    <ErrorBoundary fallbackTitleKey="queue">
      <QueueContent />
    </ErrorBoundary>
  );
}
