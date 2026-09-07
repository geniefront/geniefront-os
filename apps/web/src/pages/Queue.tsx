import { useState, useMemo, useRef } from 'react';
import { asCents } from '@gf/contracts';
import { useOutletContext, useNavigate } from 'react-router-dom';
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
import type { QueueNextAction } from '@/features/queue/nextAction';
import { buildCheckoutStaffList, computeCheckoutTotals, UNRESOLVED_STAFF_KEY } from '@/features/queue/checkoutMath';
import { useBeginCleaning, useRoomsQuery } from '@/features/rooms/api';
import { useDayCloseQuery } from '@/features/dayclose/api';
import { settledRevenueCents } from '@/features/queue/kanbanMetrics';
import { completeQueueService, resolveQueueRoomId } from '@/features/queue/completeService';
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
import { Modal } from '@/components/ui/Modal';
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
  const beginCleaningMutation = useBeginCleaning();
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

  // Room Vacancy Metrics
  const availableRooms = useMemo(() => rooms.filter((r) => r.status === 'available'), [rooms]);
  const availableRoomsCount = availableRooms.length;
  const totalRoomsCount = rooms.length;

  // Search and Filter State
  const [searchTerm, setSearchTerm] = useState('');
  const [staffFilter, setStaffFilter] = useState('all');

  // Manual fast-moved overrides cache for instant optimistic UI
  const [localOverrides, setLocalOverrides] = useState<Record<string, Partial<KanbanItem>>>({});

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

  // 7. Walk-in / Queue Item Detail Modal State
  const [viewingQueueModal, setViewingQueueModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
  }>({
    isOpen: false,
    item: null,
  });

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
        const override = localOverrides[`queue-${q.queueId}`];
        list.push({
          id: `queue-${q.queueId}`,
          stage: override?.stage || 'waiting',
          queueId: q.queueId,
          appointmentId: q.appointmentId,
          ticketNumber: q.ticketNumber,
          customerName: q.displayName,
          phone: formatPhoneDisplay(q.phoneDisplay),
          serviceName: q.serviceName || t('queue.quGeneralService'),
          serviceId: q.serviceId,
          ...serviceFacts(q),
          staffName: override?.staffName || q.staffName,
          staffId: override?.staffId || q.staffId,
          roomId: override?.roomId,
          roomName: override?.roomName,
          isRequest: false,
          timeDisplay: t('queue.quWaitedFor', { p0: q.waitedMin }),
          waitedMin: q.waitedMin,
          overdue: q.overdue,
          pendingForms: q.pendingForms,
          intakeSigned: q.intakeSigned,
          notes: override?.notes,
          addOns: override?.addOns,
          rawQueue: q,
        });
      });

      queue.called.forEach((q) => {
        if (q.appointmentId && ticketApptIds.has(q.appointmentId)) return;
        if (q.appointmentId) queuedApptIds.add(q.appointmentId);
        const override = localOverrides[`queue-called-${q.queueId}`];
        list.push({
          id: `queue-called-${q.queueId}`,
          stage: override?.stage || 'waiting',
          queueId: q.queueId,
          appointmentId: q.appointmentId,
          ticketNumber: q.ticketNumber,
          customerName: q.displayName,
          phone: formatPhoneDisplay(q.phoneDisplay),
          serviceName: q.serviceName || t('queue.quGeneralService'),
          serviceId: q.serviceId,
          ...serviceFacts(q),
          staffName: override?.staffName || q.staffName,
          staffId: override?.staffId || q.staffId,
          roomId: override?.roomId,
          roomName: override?.roomName,
          isRequest: false,
          timeDisplay: t('queue.quCalledFor', { p0: q.waitedMin }),
          waitedMin: q.waitedMin,
          overdue: q.overdue,
          pendingForms: q.pendingForms,
          intakeSigned: q.intakeSigned,
          notes: override?.notes,
          addOns: override?.addOns,
          rawQueue: q,
        });
      });

      queue.seated.forEach((q) => {
        if (q.appointmentId && ticketApptIds.has(q.appointmentId)) return;
        if (q.appointmentId) queuedApptIds.add(q.appointmentId);
        const override = localOverrides[`queue-seated-${q.queueId}`];
        list.push({
          id: `queue-seated-${q.queueId}`,
          stage: override?.stage || 'in_service',
          queueId: q.queueId,
          appointmentId: q.appointmentId,
          ticketNumber: q.ticketNumber,
          customerName: q.displayName,
          phone: formatPhoneDisplay(q.phoneDisplay),
          serviceName: q.serviceName || t('queue.quInServiceItem'),
          serviceId: q.serviceId,
          ...serviceFacts(q),
          staffName: override?.staffName || q.staffName,
          staffId: override?.staffId || q.staffId,
          roomId: override?.roomId,
          roomName: override?.roomName,
          isRequest: false,
          timeDisplay: t('queue.quInServiceStatus'),
          notes: override?.notes,
          addOns: override?.addOns,
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
        const override = localOverrides[`appt-insvc-${it.id}`];
        list.push({
          id: `appt-insvc-${it.id}`,
          stage: override?.stage || 'in_service',
          appointmentId: it.appointmentId,
          customerName: it.customerName,
          phone: it.customerPhone ?? null,
          serviceName: it.serviceName,
          serviceId: it.serviceId,
          durationMin: it.durationMin,
          priceCents: it.service?.priceCents || 0,
          staffId: override?.staffId || it.staffId,
          staffName: override?.staffName || staffName,
          staffColor: matchedStaff?.color ?? null,
          roomId: override?.roomId || it.resourceId,
          roomName: override?.roomName,
          isRequest: it.isRequest,
          timeDisplay: `${it.startTime} (${it.durationMin}m)`,
          notes: override?.notes,
          addOns: override?.addOns,
          rawItem: it,
        });
      } else if (it.status === 'completed') {
        const override = localOverrides[`appt-done-${it.id}`];
        list.push({
          id: `appt-done-${it.id}`,
          stage: override?.stage || 'completed',
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
      const override = localOverrides[`appt-${key}`];
      const staffIds = new Set(
        sorted.map((i) => i.staffId).filter((id) => id && id !== UNASSIGNED_STAFF_ID),
      );
      const singleStaffId = staffIds.size === 1 ? [...staffIds][0]! : null;
      const matchedStaff = singleStaffId ? staff.find((s) => s.membershipId === singleStaffId) : undefined;
      const nameOfStaff = (id: string | null) => {
        if (!id || id === UNASSIGNED_STAFF_ID) return null;
        return staff.find((s) => s.membershipId === id)?.name ?? null;
      };
      const staffName = override?.staffName
        ?? (staffIds.size === 0
          ? t('queue.quStaffUnassignedLong')
          : staffIds.size === 1
            ? (nameOfStaff(singleStaffId) ?? t('queue.quStaffUnassignedLong'))
            : t('queue.quMultipleStaff'));
      list.push({
        id: `appt-${key}`,
        stage: override?.stage || 'booked',
        appointmentId: primary.appointmentId,
        customerName: primary.customerName,
        phone: primary.customerPhone ?? null,
        serviceName: sorted.length === 1
          ? primary.serviceName
          : t('queue.quServiceItemsSummary', { p0: primary.serviceName, p1: String(sorted.length - 1) }),
        serviceId: sorted.length === 1 ? primary.serviceId : null,
        durationMin: sorted.reduce((sum, i) => sum + i.durationMin, 0),
        priceCents: sorted.reduce((sum, i) => sum + (i.service?.priceCents || 0), 0),
        staffId: override?.staffId || singleStaffId,
        staffName,
        staffColor: matchedStaff?.color ?? null,
        roomId: override?.roomId || primary.resourceId,
        roomName: override?.roomName,
        isRequest: sorted.some((i) => i.isRequest),
        timeDisplay: sorted.length === 1
          ? `${primary.startTime} - ${primary.endTime}`
          : `${primary.startTime} - ${last.endTime}`,
        notes: override?.notes,
        addOns: override?.addOns,
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
        const override = localOverrides[`ticket-${tk.ticketId}`];
        const tkItems = queueTicketItems(Array.isArray(tk.items) ? tk.items : []);
        const starts = tkItems.flatMap((entry) => entry.startedAt ? [Date.parse(entry.startedAt)] : []);
        const ends = tkItems.flatMap((entry) => entry.startedAt
          ? [entry.finishedAt ? Date.parse(entry.finishedAt) : Date.parse(entry.startedAt) + entry.durationMin * 60_000] : []);
        const clock = (ms: number) => formatIsoWallClock(new Date(ms).toISOString(), timezone);
        list.push({
          id: `ticket-${tk.ticketId}`,
          stage: override?.stage || (tk.status === 'ready_to_pay' ? 'ready_checkout' : 'in_service'),
          ticketId: tk.ticketId,
          appointmentId: tk.appointmentId,
          customerName: formatI18n(tk.customerName, language) || t('queue.quCheckedInGuest'),
          serviceName: tkItems.map((i: any) => formatI18n(i.name, language)).join(', ') || t('queue.quMixedService'),
          durationMin: tkItems.reduce((acc: number, i: any) => acc + (i.durationMin || 0), 0),
          priceCents: asCents(tk.subtotalCents ?? 0),
          staffName: [...new Set(tkItems.map((entry) => entry.staffName).filter(Boolean))].join(' / '),
          roomName: [...new Set(tkItems.map((entry) => entry.roomName).filter(Boolean))].join(' / ') || override?.roomName,
          roomId: override?.roomId,
          isRequest: false,
          timeDisplay: starts.length ? `${clock(Math.min(...starts))} – ${clock(Math.max(...ends))}` : t('queue.quElapsedNotStarted'),
          rawTicket: tk,
        });
      });
    }

    return list;
  }, [queue, items, staff, ticketsData, localOverrides, language, timezone, t]);

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

  const isSyncing = join.isPending || update.isPending || closeTicketMutation.isPending
    || openTicketMutation.isPending || addTicketItemMutation.isPending
    || startTicketItemMutation.isPending
    || finishTicketItemMutation.isPending
    || rollbackStageMutation.isPending || isRefreshing;

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
      const availableRoom = rooms.find((r) => r.status === 'available')?.id || '';
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
          roomId: availableRoom,
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
        roomId: availableRoom,
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
        try {
          await startTicketItemMutation.mutateAsync({
            ticketItemId: action.ticketItemId,
            membershipId: entry?.membershipId,
          });
          await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
        } catch (error) {
          toast.danger(errorMessage(error));
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
        try {
          await finishTicketItemMutation.mutateAsync({
            ticketItemId: action.ticketItemId,
            membershipId: entry?.membershipId,
          });
          await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
        } catch (error) {
          toast.danger(errorMessage(error));
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
    try {
      if (mode === 'add') {
        const service = services.find((entry) => entry.id === serviceId);
        if (!service || !staffId) return;
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
        if (!ticketItemId || !staffId || reason.trim().length < 2) return;
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
        if (!ticketItemId || !resourceId || reason.trim().length < 2) return;
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
   * 新开一个标签页而不是当前页跳转：前台打完这张纸要回到看板继续排下一位，
   * 把她从看板上带走再让她自己找回来，是这类操作最常见的抱怨来源。
   */
  const openServiceBrief = (item: KanbanItem) => {
    const ticketId = item.ticketId ?? item.rawTicket?.ticketId;
    if (!ticketId) {
      toast.info(t('queue.quItemActionNeedsTicket'));
      return;
    }
    window.open(`/print/service-brief/${ticketId}`, '_blank', 'noopener');
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
            idempotencyKey: `queue-checkin-addon-${item.appointmentId}-${addOnService.id}`,
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

  /*
   * 2. Start Service Confirm Submit
   *
   * `override` 由「技师已满，仍要开始」确认框回传。整个函数可以安全重放：
   * 开单的幂等键按 item 固定，加项的幂等键在弹窗状态里，重试都会被服务端
   * 判为同一次意图，不会开出第二张单。
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
    } = startServiceModal;
    if (!item) return;
    if (startServicePending) return;

    const assignedStaff = staff.find((s) => s.membershipId === staffId);
    const assignedRoom = rooms.find((r) => r.id === roomId);

    try {
      if (!item.serviceId || assignments.length === 0
        || assignments.some((assignment) => assignment.staffIds.length !== assignment.staffCount)
        || addedAddOns.some((addOn) => !addOn.staffId || addOn.staffId === UNASSIGNED_STAFF_ID)) {
        toast.danger(t('queue.quSeatFailed'));
        return;
      }
      if (hasPendingForms(item) && !requireBriefingAck) {
        toast.danger(t('queue.quSeatBriefingRequired'));
        return;
      }

      if (item.appointmentId && serviceBrief.trim() !== (item.notes || '').trim()) {
        await saveServiceBriefMutation.mutateAsync(serviceBrief.trim());
      }

      let ticketId = item.ticketId ?? item.rawTicket?.ticketId;
      let ticketItemIds = item.rawTicket ? queueTicketItems(item.rawTicket.items)
        .filter((ticketItem) => !ticketItem.startedAt)
        .map((ticketItem) => ticketItem.ticketItemId) : [];
      if (!ticketId) {
        const appointmentItems = item.rawQueue?.items ?? [];
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
              serviceId: item.serviceId,
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
          idempotencyKey: `queue-start-${item.appointmentId ?? item.queueId ?? item.id}`,
        });
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
          const added = await addTicketItemMutation.mutateAsync({
            ticketId, serviceId: addOn.serviceId, membershipId: addOn.staffId,
            kind: 'addon', minutes: addOn.durationMin, idempotencyKey: addOn.idempotencyKey,
            ...(addOn.roomId ? { resourceId: addOn.roomId } : {}),
          });
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
        } catch (startErr) {
          if (!override && isOverbookConfirmable(startErr)) {
            setOverbookConfirm({ message: overbookMessageOf(startErr) });
            return;
          }
          throw startErr;
        }
      }
      if (item.queueId) {
        await update.mutateAsync({ queueId: item.queueId, status: 'seated' });
      }
      setStartServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
      toast.success(t('queue.quSeated', { p0: item.customerName }), {
        description: t('queue.quSeatedDetail', { p0: assignedStaff?.name || t('queue.quAssignedFallback'), p1: assignedRoom?.name || t('queue.quDesignatedRoomFallback'), p2: startTime, p3: serviceDurationMin }),
      });
      await Promise.all([refetchQueue(), refetchTickets(), refetchSchedule(), refetchRooms()]);
    } catch (err: any) {
      toast.danger(t('queue.quSeatFailed') + (err?.message || t('queue.quNetworkError2')));
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
      },
    );

    if (!result.ok) {
      if (result.reason === 'no_active_service') {
        toast.danger(t('queue.quNoActiveService'));
        return;
      }
      if (result.reason === 'missing_ticket' || result.reason === 'missing_room') {
        toast.danger(t('queue.quFinishFailed'));
        return;
      }
      if (result.finished) {
        setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
        toast.danger(t('queue.quFinishRoomFailed'));
        await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms()]);
        return;
      }
      const cause = result.cause;
      const message = cause instanceof Error ? cause.message : t('queue.quNetworkError2');
      toast.danger(t('queue.quFinishFailed') + message);
      return;
    }

    setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
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
      await closeTicketMutation.mutateAsync({
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

      await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms(), refetchQueue(), openTicketsQ.refetch()]);
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
   * 逐项目的开始 / 完成。
   *
   * 卡片上每一行都自带这个动作 —— 多项目单的第二项此前在看板上没有任何
   * 入口，工单会永久卡在服务中。
   */
  const handleToggleTicketItem = async (service: { ticketItemId: string; membershipId: string; startedAt: string | null }) => {
    try {
      const command = service.startedAt ? finishTicketItemMutation : startTicketItemMutation;
      await command.mutateAsync({ ticketItemId: service.ticketItemId, membershipId: service.membershipId });
      await Promise.all([refetchTickets(), refetchRooms(), refetchSchedule()]);
    } catch (error) {
      toast.danger(errorMessage(error));
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
                        {entry.position ?? idx + 1}
                      </span>
                      <span>{entry.name}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 房间空位卡片 */}
          <div className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5">
            <BedDouble className="w-4 h-4 text-indigo-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-xs">{t('queue.quRoomsFree')}</span>
              <span className="font-bold text-emerald-700 font-mono">
                {availableRoomsCount} / {totalRoomsCount}  {t('queue.quRoomsAvailableUnit')}
              </span>
            </div>
          </div>

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
        timezone={timezone}
        draggingItemId={draggingItemId}
        dragOverColumn={dragOverColumn}
        isSyncing={isSyncing}
        isItemMutating={startTicketItemMutation.isPending || finishTicketItemMutation.isPending}
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
          onOpenChange={(open) => { if (!open) setOverbookConfirm(null); }}
          title={
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              <span>{t('queue.quOverbookTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setOverbookConfirm(null)}>
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

      {/* 现场候客/Walk-in Guest详情弹窗 (Walk-in / Queue Item Detail) */}
      {viewingQueueModal.isOpen && viewingQueueModal.item && (
        <Modal
          isOpen={viewingQueueModal.isOpen}
          onOpenChange={(open) => {
            if (!open) setViewingQueueModal({ isOpen: false, item: null });
          }}
          title={
            <div className="flex items-center gap-2 text-teal-800 font-bold">
              <User className="w-5 h-5 text-teal-600" />
              <span>{t('queue.quWiTitle', { p0: viewingQueueModal.item.customerName })}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button
                variant="secondary"
                onClick={() => setViewingQueueModal({ isOpen: false, item: null })}
              >
                {t('queue.quQrClose')}
              </Button>
              {viewingQueueModal.item.stage === 'waiting' && (
                <Button
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1 shadow-sm"
                  onClick={() => {
                    const it = viewingQueueModal.item!;
                    setViewingQueueModal({ isOpen: false, item: null });
                    initiateStageTransition(it, 'in_service');
                  }}
                >
                  <Scissors className="w-4 h-4" />
                  <span>{t('queue.quWiAssignSeat')}</span>
                </Button>
              )}
            </div>
          }
        >
          <div className="space-y-4 py-1 text-xs text-slate-700">
            {/* 头部信息 */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-teal-100 text-teal-800 flex items-center justify-center font-bold text-sm border border-teal-200">
                  {viewingQueueModal.item.customerName.charAt(0)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">{viewingQueueModal.item.customerName}</span>
                    {viewingQueueModal.item.ticketNumber && (
                      <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
                        #{viewingQueueModal.item.ticketNumber}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500 font-mono">
                    {viewingQueueModal.item.phone ? formatPhoneDisplay(viewingQueueModal.item.phone) : t('queue.quWiNoPhone')}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="block text-xs text-slate-500">{t('queue.quWiCurrentStatus')}</span>
                <Badge variant="secondary" className="text-xs font-bold bg-amber-100 text-amber-800">
                  {viewingQueueModal.item.timeDisplay}
                </Badge>
              </div>
            </div>

            {/* 服务与排号信息 */}
            <div className="p-3.5 bg-white border border-slate-200 rounded-2xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('queue.quWiRequestedService')}</span>
                <span className="font-bold text-slate-900">{viewingQueueModal.item.serviceName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('queue.quWiAssignedStaff')}</span>
                <span className="font-semibold text-slate-900">{viewingQueueModal.item.staffName || t('queue.quWiRotationPending')}</span>
              </div>
              {viewingQueueModal.item.roomName && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">{t('queue.quWiReservedRoom')}</span>
                  <span className="font-bold text-teal-700">{viewingQueueModal.item.roomName}</span>
                </div>
              )}
            </div>

            {/* 健康问卷情况 */}
            {(() => {
              const it = viewingQueueModal.item;
              const hasPending = Boolean((it.pendingForms && it.pendingForms > 0) || (it.rawQueue?.pendingForms && it.rawQueue.pendingForms > 0));

              if (hasPending) {
                return (
                  <div className="p-3.5 bg-rose-50 border-2 border-rose-200 rounded-2xl space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-rose-950 text-xs flex items-center gap-1.5">
                        <FileWarning className="w-4 h-4 text-rose-600" />
                        <span>{t('queue.quWiFormPendingTitle')}</span>
                      </span>
                      <Badge variant="error" className="shrink-0 text-xs">{t('queue.quWiFormPendingBadge')}</Badge>
                    </div>
                    <p className="text-xs text-rose-800">
                      {t('queue.quWiFormPendingHint')}
                    </p>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setViewingQueueModal({ isOpen: false, item: null });
                          void openFormQr(it);
                        }}
                        className="flex-1 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl flex items-center justify-center gap-1 text-xs shadow-xs cursor-pointer"
                      >
                        <QrCode className="w-3.5 h-3.5" />
                        <span>{t('queue.quWiScanQr')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void copyFormLink(it);
                        }}
                        className="px-3 py-1.5 bg-white border border-rose-300 text-rose-800 font-bold rounded-xl flex items-center justify-center gap-1 text-xs shadow-2xs hover:bg-rose-50 cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>{t('queue.quQrCopyLink')}</span>
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center justify-between">
                  <span className="font-bold text-emerald-950 text-xs flex items-center gap-1.5">
                    <CheckCircle className="w-4 h-4 text-emerald-600" />
                    <span>{t('queue.quWiSignedTitle')}</span>
                  </span>
                  <Badge variant="success" className="shrink-0 text-xs">{t('queue.quWiSignedBadge')}</Badge>
                </div>
              );
            })()}
          </div>
        </Modal>
      )}

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
