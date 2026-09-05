import { useState, useMemo, useRef } from 'react';
import { asCents } from '@gf/contracts';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { toast, Spinner } from '@heroui/react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CalendarDays,
  Clock,
  UserCheck,
  AlertTriangle,
  FileWarning,
  Users,
  Phone,
  Plus,
  ChevronRight,
  RotateCcw,
  Sparkles,
  CreditCard,
  CheckCircle2,
  Scissors,
  Receipt,
  Search,
  Filter,
  BedDouble,
  ArrowRight,
  Timer,
  CheckCircle,
  FileText,
  ShieldAlert,
  ArrowLeft,
  Coins,
  Wallet,
  Gift,
  Check,
  Award,
  User,
  DollarSign,
  TrendingUp,
  QrCode,
  Tablet,
  Percent,
  RefreshCw,
  Copy,
  ExternalLink,
  Languages,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { UNASSIGNED_STAFF_ID, toScheduleItem } from '@/context/ScheduleContext';
import { useDaySnapshot } from '@/features/schedule/api';
import { useSession } from '@/lib/session';
import { instantToWallDate, nowWallHhMm } from '@/lib/time';
import { cn, formatI18n, formatPhoneDisplay, formatPhoneInput } from '@/lib/utils';
import { customerInitials, walkInShowsNoPhone } from '@/lib/displayName';
import { healthFormHonesty } from '@/features/queue/healthFormStatus';
import type { DayStaff } from '@/features/schedule/types';
import {
  useJoinQueue, useQueue, useRollbackQueueStage, useUpdateQueueEntry,
} from '@/features/queue/api';
import {
  useAddTicketItem, useFinishTicketItem, useOpenTicket, useSaveServiceNote, useStartTicketItem, useTicketsList,
  isOverbookConfirmable, overbookDetail,
} from '@/features/tickets/api';
import { OVERRIDE_REASONS } from '@/features/schedule/api';
import type { Override, OverrideReason } from '@/features/schedule/api';
import { useCloseTicket, useOpenTickets, centsToDollars, dollarsToCents, verifyGiftCard } from '@/features/checkout/api';
import { buildCheckoutStaffList, computeCheckoutTotals, UNRESOLVED_STAFF_KEY } from '@/features/queue/checkoutMath';
import { useBeginCleaning, useRoomsQuery } from '@/features/rooms/api';
import { completeQueueService, resolveQueueRoomId } from '@/features/queue/completeService';
import { inlineGiftCardFields } from '@/features/queue/inlinePayment';
import { useRotationQuery } from '@/features/rotation/api';
import { QUEUE_LEFT_REASONS } from '@/features/queue/types';
import type { QueueEntry, QueueLeftReason, QueueStatus } from '@/features/queue/types';
import type { ScheduleItem } from '@/context/ScheduleContext';
import type { TicketSummary } from '@/features/tickets/types';
import type { RoomItem } from '@/features/rooms/types';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { QRCodeSVG } from 'qrcode.react';
import { QRCodeZoomModal } from '@/components/QRCodeZoomModal';
import { useCanWrite } from '@/lib/permissions';
import { useErrorMessage } from '@/lib/errorMessage';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import type { TranslationKey } from '@/i18n';
import { useShareForm, type FormShareResult } from '@/features/forms/api';
import { generateAiHealthSummary } from '@/features/forms/mockData';
import { inferHealthFormCategory } from '@/features/forms/formExperience';
import {
  useAddAppointmentItem,
  useAppointmentFormsQuery,
  useHealthFormSubmissionQuery,
  useSaveAppointmentServiceBrief,
} from '@/features/schedule/appointmentDetail';
import { useLocationTechPresence } from '@/features/tech/lib/useLocationTechPresence';
import { rankStaffCandidates } from '@/features/queue/assignment';
import { useBusinessDay } from '@/lib/time';

/**
 * 选项标签的统一形态。
 *
 * `id` 是唯一被持久化与比对的值，界面文案一律走词典键 —— 二者分离后，
 * 增加界面语言不会影响既有记录，也不会让判断逻辑因翻译而失效。
 */
export interface TagOption {
  id: string;
  labelKey: TranslationKey;
}

/** 回退反向流转原因映射 */
const ROLLBACK_REASONS: TagOption[] = [
  { id: 'entry_error', labelKey: 'queue.quRollbackReasonEntryError' },
  { id: 'customer_extend', labelKey: 'queue.quRollbackReasonExtend' },
  { id: 'change_staff', labelKey: 'queue.quRollbackReasonChangeStaff' },
  { id: 'staff_emergency', labelKey: 'queue.quRollbackReasonEmergency' },
  { id: 'other', labelKey: 'queue.quRollbackReasonOther' },
];

/** 「无特殊禁忌」的哨兵值，选中它即互斥地清空其余禁忌项。 */
export const CONTRAINDICATION_NONE = 'No specific contraindications';

/** 身体禁忌排查标签 */
export const CONTRAINDICATION_TAGS: TagOption[] = [
  { id: CONTRAINDICATION_NONE, labelKey: 'queue.quContraNone' },
  { id: 'Essential oil allergy', labelKey: 'queue.quContraOilAllergy' },
  { id: 'Hypertension / Heart condition', labelKey: 'queue.quContraHypertension' },
  { id: 'Pregnancy / Nursing', labelKey: 'queue.quContraPregnancy' },
  { id: 'Skin irritation / Wounds', labelKey: 'queue.quContraSkin' },
  { id: 'Spinal / Neck injury history', labelKey: 'queue.quContraSpine' },
  { id: 'Recent cosmetic surgery', labelKey: 'queue.quContraSurgery' },
];

/** 重点加压护理部位 */
export const FOCUS_AREA_TAGS: TagOption[] = [
  { id: 'Head / Temples', labelKey: 'queue.quFocusHead' },
  { id: 'Back of Neck', labelKey: 'queue.quFocusNeck' },
  { id: 'Left Shoulder', labelKey: 'queue.quFocusShoulderL' },
  { id: 'Right Shoulder', labelKey: 'queue.quFocusShoulderR' },
  { id: 'Left Lower Back', labelKey: 'queue.quFocusLowerBackL' },
  { id: 'Right Lower Back', labelKey: 'queue.quFocusLowerBackR' },
  { id: 'Upper & Mid Back', labelKey: 'queue.quFocusUpperBack' },
  { id: 'Left Foot & Arch', labelKey: 'queue.quFocusFootL' },
  { id: 'Right Foot & Arch', labelKey: 'queue.quFocusFootR' },
];

/** 「无需避开部位」的哨兵值，语义与 CONTRAINDICATION_NONE 一致。 */
export const AVOID_AREA_NONE = 'No areas to avoid';

/** 避免触碰敏感部位 */
export const AVOID_AREA_TAGS: TagOption[] = [
  { id: AVOID_AREA_NONE, labelKey: 'queue.quAvoidNone' },
  { id: 'Face', labelKey: 'queue.quAvoidFace' },
  { id: 'Throat / Anterior Neck', labelKey: 'queue.quAvoidThroat' },
  { id: 'Spine Midline', labelKey: 'queue.quAvoidSpine' },
  { id: 'Varicose Veins', labelKey: 'queue.quAvoidVaricose' },
  { id: 'Surgical Scars', labelKey: 'queue.quAvoidScars' },
  { id: 'Left Knee', labelKey: 'queue.quAvoidKneeL' },
  { id: 'Right Knee', labelKey: 'queue.quAvoidKneeR' },
];

/** 芳香精油选项——label/desc 只存词典键，id 是唯一持久化/比对的值 */
export const AROMA_OIL_OPTIONS: Array<{ id: string; labelKey: TranslationKey; descKey: TranslationKey }> = [
  { id: 'none_pref', labelKey: 'queue.quOilNoPref', descKey: 'queue.quOilNoPrefDesc' },
  { id: 'unscented', labelKey: 'queue.quOilUnscented', descKey: 'queue.quOilUnscentedDesc' },
  { id: 'lavender', labelKey: 'queue.quOilLavender', descKey: 'queue.quOilLavenderDesc' },
  { id: 'eucalyptus', labelKey: 'queue.quOilEucalyptus', descKey: 'queue.quOilEucalyptusDesc' },
  { id: 'sweet_orange', labelKey: 'queue.quOilSweetOrange', descKey: 'queue.quOilSweetOrangeDesc' },
  { id: 'ginger', labelKey: 'queue.quOilGinger', descKey: 'queue.quOilGingerDesc' },
];

/** 默认精油偏好。必须是 AROMA_OIL_OPTIONS 中真实存在的 id，否则打开弹窗时无一项高亮。 */
export const AROMA_OIL_DEFAULT = 'none_pref';

/** 按摩力度选项。与精油一致：存 id，渲染走词典。 */
export const STRENGTH_OPTIONS: TagOption[] = [
  { id: 'none', labelKey: 'queue.quStrengthNone' },
  { id: 'light', labelKey: 'queue.quStrengthLight' },
  { id: 'medium', labelKey: 'queue.quStrengthMedium' },
  { id: 'deep', labelKey: 'queue.quStrengthDeep' },
  { id: 'trigger', labelKey: 'queue.quStrengthTrigger' },
];

/** 默认力度。 */
export const STRENGTH_DEFAULT = 'medium';

/**
 * 该单据能否回退到目标阶段。
 *
 * 服务端的 `queue.rollbackStage` 只接受回到 booked / checked_in / waiting / in_service，
 * 且必须有预约号。此前这条规则只写在提交处，前台得把原因和备注都填完才被告知
 * 「不支持」—— 现在拖拽阶段就拦住，弹窗根本不会打开。
 */
export type RollbackTargetStage = Extract<KanbanStage, 'booked' | 'waiting' | 'in_service'>;

export function canRollbackTo(item: KanbanItem, toStage: KanbanStage): toStage is RollbackTargetStage {
  if (!item.appointmentId) return false;
  return toStage !== 'ready_checkout' && toStage !== 'completed';
}

/** 该单据是否还有未签署的健康问卷。看板与两个弹窗判断口径统一在这里。 */
export function hasPendingForms(item: KanbanItem): boolean {
  return Boolean((item.pendingForms && item.pendingForms > 0)
    || (item.rawQueue?.pendingForms && item.rawQueue.pendingForms > 0));
}

/** 弹窗主行动按钮的统一样式。 */
const PRIMARY_ACTION_CLASS = 'gap-1 bg-teal-700 font-semibold text-white hover:bg-teal-800';
/** 不可逆/破坏性动作的主按钮样式。 */
const DANGER_ACTION_CLASS = 'gap-1 bg-rose-700 font-semibold text-white hover:bg-rose-800';

/** 完工弹窗速选加项的展示条数，超出部分收进「更多」。 */
const FINISH_QUICK_PICK_LIMIT = 4;

/** 收款方式的词典键。结算条上的徽章此前直接 toUpperCase 内部枚举值，中文界面下是英文。 */
const PAYMENT_METHOD_LABEL_KEYS: Record<'card' | 'cash' | 'gift_card' | 'apple_pay', TranslationKey> = {
  card: 'queue.quCoPayCard',
  cash: 'queue.quCoPayCash',
  gift_card: 'queue.quCoPayGiftCard',
  apple_pay: 'queue.quCoPayApplePay',
};

export type KanbanStage = 'booked' | 'waiting' | 'in_service' | 'ready_checkout' | 'completed';

export const STAGE_ORDER: KanbanStage[] = ['booked', 'waiting', 'in_service', 'ready_checkout', 'completed'];

/**
 * 泳道名字的词典键。
 *
 * ⚠️ 这里以前是写死的中文字符串常量，切到英文界面时这五个名字
 * （运营看板每天都在盯的那块屏）完全不跟着语言走。改成键之后，
 * 用的地方一律 `t(STAGE_NAME_KEYS[stage])`，不能再直接引用这张表。
 */
export const STAGE_NAME_KEYS: Record<KanbanStage, TranslationKey> = {
  booked: 'queue.quStageNameBooked',
  waiting: 'queue.quStageNameWaiting',
  in_service: 'queue.quStageNameInService',
  ready_checkout: 'queue.quStageNameReadyCheckout',
  completed: 'queue.quStageNameCompleted',
};

export interface AddOnItem {
  idempotencyKey: string;
  serviceId: string;
  name: string;
  priceCents: number;
  durationMin: number;
  staffId: string;
  staffName?: string;
}

export interface KanbanItem {
  id: string;
  stage: KanbanStage;
  appointmentId?: string | null;
  queueId?: string | null;
  ticketId?: string | null;
  ticketNumber?: number | null;
  customerName: string;
  phone?: string | null;
  serviceName: string;
  serviceId?: string | null;
  durationMin: number;
  priceCents: number;
  staffId?: string | null;
  staffName?: string | null;
  staffColor?: string | null;
  roomId?: string | null;
  roomName?: string | null;
  isRequest: boolean; // 点钟
  timeDisplay: string;
  waitedMin?: number;
  overdue?: boolean;
  pendingForms?: number;
  notes?: string;
  addOns?: AddOnItem[];
  healthConfirmed?: boolean;
  massagePreference?: string;
  rawItem?: ScheduleItem;
  rawQueue?: QueueEntry;
  rawTicket?: TicketSummary;
}

interface ColumnConfig {
  id: KanbanStage;
  titleKey: TranslationKey;
  subtitleKey: TranslationKey;
  color: string;
  headerBg: string;
  badgeVariant: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'error' | 'destructive';
  icon: typeof CalendarDays;
  emptyKey: TranslationKey;
}

/**
 * 五个泳道的静态配置（颜色 / 图标）+ 词典键。
 *
 * ⚠️ 标题、副标题、空态文案都只存**键**，不存字符串 —— 之前这里是写死的
 * 中文，英文界面下这块每天都在盯的屏完全不跟着语言走；空态那一句
 * 更曾经是「前缀 + 未翻译的中文片段 + 后缀」三段拼接，在非中文语言下
 * 拼出 "No待到店tickets" 这类损坏文案。渲染时统一 `t(col.titleKey)`。
 */
const COLUMNS: ColumnConfig[] = [
  {
    id: 'booked',
    titleKey: 'queue.quColBookedTitle',
    subtitleKey: 'queue.quColBookedSubtitle',
    color: 'border-sky-300 text-sky-700 bg-sky-50/50',
    headerBg: 'bg-sky-50 text-sky-800 border-sky-200',
    badgeVariant: 'secondary',
    icon: CalendarDays,
    emptyKey: 'queue.quEmptyBooked',
  },
  {
    id: 'waiting',
    titleKey: 'queue.quColWaitingTitle',
    subtitleKey: 'queue.quColWaitingSubtitle',
    color: 'border-amber-300 text-amber-700 bg-amber-50/50',
    headerBg: 'bg-amber-50 text-amber-800 border-amber-200',
    badgeVariant: 'warning',
    icon: Clock,
    emptyKey: 'queue.quEmptyWaiting',
  },
  {
    id: 'in_service',
    titleKey: 'queue.quColInServiceTitle',
    subtitleKey: 'queue.quColInServiceSubtitle',
    color: 'border-teal-300 text-teal-700 bg-teal-50/50',
    headerBg: 'bg-teal-50 text-teal-800 border-teal-200',
    badgeVariant: 'success',
    icon: Scissors,
    emptyKey: 'queue.quEmptyInService',
  },
  {
    id: 'ready_checkout',
    titleKey: 'queue.quColReadyCheckoutTitle',
    subtitleKey: 'queue.quColReadyCheckoutSubtitle',
    color: 'border-violet-300 text-violet-700 bg-violet-50/50',
    headerBg: 'bg-violet-50 text-violet-800 border-violet-200',
    badgeVariant: 'default',
    icon: CreditCard,
    emptyKey: 'queue.quEmptyReadyCheckout',
  },
  {
    id: 'completed',
    titleKey: 'queue.quColCompletedTitle',
    subtitleKey: 'queue.quColCompletedSubtitle',
    color: 'border-slate-300 text-slate-700 bg-slate-50/50',
    headerBg: 'bg-slate-100 text-slate-800 border-slate-200',
    badgeVariant: 'outline',
    icon: CheckCircle2,
    emptyKey: 'queue.quEmptyCompleted',
  },
];

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
  const { data: roomsData, isLoading: roomsLoading, refetch: refetchRooms } = useRoomsQuery();
  const { data: rotationData, isLoading: rotationLoading, refetch: refetchRotation } = useRotationQuery();
  const onlineTechIds = useLocationTechPresence();
  const closeTicketMutation = useCloseTicket();
  const openTicketMutation = useOpenTicket();
  const addTicketItemMutation = useAddTicketItem();
  const startTicketItemMutation = useStartTicketItem();
  const finishTicketItemMutation = useFinishTicketItem();
  const saveServiceNoteMutation = useSaveServiceNote();
  const beginCleaningMutation = useBeginCleaning();
  const shareFormMutation = useShareForm();
  const [formShares, setFormShares] = useState<Record<string, FormShareResult>>({});

  const isInitialLoading = (queueLoading && scheduleLoading) && !queue;

  const join = useJoinQueue();
  const update = useUpdateQueueEntry();
  const rollbackStageMutation = useRollbackQueueStage();
  const canManage = useCanWrite('queue.manage');

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
  const [showAllFinishAddOns, setShowAllFinishAddOns] = useState(false);
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
    taxRatePercent: '8.875',
    enableCardSurcharge: false,
    cardSurchargePercent: '3.0',
    tipMode: 'total_split',
    tipPercentage: 15,
    totalTipDollars: '',
    splitStrategy: 'proportional',
    customStaffTips: {},
    paymentMethod: 'card',
    tenderedDollars: '',
    keepChange: false,
    giftCardCode: '',
    giftCardId: '',
    giftCardVerified: false,
    giftCardBalanceCents: 0,
    isVerifyingGiftCard: false,
  });

  // 5. Reverse Rollback Warning Modal (Backward Stage Move)
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
    (items || []).forEach((it) => {
      if (queuedApptIds.has(it.appointmentId) || ticketApptIds.has(it.appointmentId)) return;

      const matchedStaff = staff.find((s) => s.membershipId === it.staffId);
      const staffName =
        matchedStaff && matchedStaff.membershipId !== UNASSIGNED_STAFF_ID
          ? matchedStaff.name
          : t('queue.quStaffUnassignedLong');

      if (it.status === 'booked') {
        const override = localOverrides[`appt-${it.id}`];
        list.push({
          id: `appt-${it.id}`,
          stage: override?.stage || 'booked',
          appointmentId: it.appointmentId,
          customerName: it.customerName,
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
          timeDisplay: `${it.startTime} - ${it.endTime}`,
          notes: override?.notes,
          addOns: override?.addOns,
          rawItem: it,
        });
      } else if (it.status === 'in_service') {
        const override = localOverrides[`appt-insvc-${it.id}`];
        list.push({
          id: `appt-insvc-${it.id}`,
          stage: override?.stage || 'in_service',
          appointmentId: it.appointmentId,
          customerName: it.customerName,
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
          serviceName: it.serviceName,
          serviceId: it.serviceId,
          durationMin: it.durationMin,
          priceCents: it.service?.priceCents || 0,
          staffId: it.staffId,
          staffName: matchedStaff?.name || t('therapistLabel'),
          staffColor: matchedStaff?.color ?? null,
          isRequest: it.isRequest,
          timeDisplay: t('queue.quCompletedFor', { p0: it.endTime }),
          rawItem: it,
        });
      }
    });

    // 3. Open Tickets (ready for checkout)
    if (ticketsData?.tickets) {
      ticketsData.tickets.forEach((tk: any) => {
        const override = localOverrides[`ticket-${tk.ticketId}`];
        const tkItems = Array.isArray(tk.items) ? tk.items : [];
        list.push({
          id: `ticket-${tk.ticketId}`,
          stage: override?.stage || (tk.status === 'ready_to_pay' ? 'ready_checkout' : 'in_service'),
          ticketId: tk.ticketId,
          appointmentId: tk.appointmentId,
          customerName: formatI18n(tk.customerName, language) || t('queue.quCheckedInGuest'),
          serviceName: tkItems.map((i: any) => formatI18n(i.name, language)).join(', ') || t('queue.quMixedService'),
          durationMin: tkItems.reduce((acc: number, i: any) => acc + (i.durationMin || 0), 0),
          priceCents: asCents(tk.subtotalCents ?? 0),
          staffName: formatI18n(tkItems[0]?.staffName, language),
          roomName: tkItems[0]?.roomName || override?.roomName,
          roomId: override?.roomId,
          isRequest: false,
          timeDisplay: `$${centsToDollars(tk.subtotalCents)}`,
          rawTicket: tk,
        });
      });
    }

    return list;
  }, [queue, items, staff, ticketsData, localOverrides, language]);

  // Filtered items (支持错别字容错模糊搜索)
  const filteredItems = useMemo(() => {
    let list = kanbanItems;
    if (staffFilter !== 'all') {
      list = list.filter((item) =>
        staffFilter === UNASSIGNED_STAFF_ID
          ? !item.staffId || item.staffId === UNASSIGNED_STAFF_ID
          : item.staffId === staffFilter || (item.staffName && item.staffName === staffFilter),
      );
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
    const revenueCents = kanbanItems
      .filter((x) => x.stage === 'completed')
      .reduce((sum, x) => sum + x.priceCents, 0);

    return {
      totalBookings,
      waiting,
      inService,
      readyCheckout,
      completed,
      revenueCents,
    };
  }, [kanbanItems]);

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
          nowMs: Date.now(),
        });
        return {
          serviceId: service.id,
          serviceName: service.name,
          durationMin: requested.durationMin,
          staffCount: service.staffCount,
          staffIds: candidates.filter((candidate) => candidate.eligible)
            .slice(0, service.staffCount).map((candidate) => candidate.staff.membershipId),
        };
      });
      const defaultStaff = assignments[0]?.staffIds[0] ?? '';
      
      const availableRoom = rooms.find((r) => r.status === 'available')?.id || rooms[0]?.id || '';
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
      setCheckoutModal({
        isOpen: true,
        item,
        discountDollars: '0',
        enableTax: Number.parseFloat(checkoutSettings?.salesTaxRatePercent || '0') > 0,
        taxRatePercent: checkoutSettings?.salesTaxRatePercent || '0',
        enableCardSurcharge: false,
        cardSurchargePercent: '3.0',
        tipMode: 'total_split',
        tipPercentage: 15,
        totalTipDollars: '',
        splitStrategy: 'proportional',
        customStaffTips: {},
        paymentMethod: 'card',
        tenderedDollars: centsToDollars(item.priceCents),
        keepChange: false,
        giftCardCode: '',
        giftCardId: '',
        giftCardVerified: false,
        giftCardBalanceCents: 0,
        isVerifyingGiftCard: false,
      });
    }
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
      let ticketItemIds = item.rawTicket?.items
        .filter((ticketItem) => !ticketItem.startedAt)
        .map((ticketItem) => ticketItem.ticketItemId) ?? [];
      if (!item.ticketId) {
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
                ...(index === 0 && roomId ? { resourceId: roomId } : {}),
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
              ...(roomId ? { resourceId: roomId } : {}),
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

      // 启动弹窗里的加项先挂到已开的服务单；这样预约本身仍保持原预约项目，
      // 同时前台可以在安排入座时一次性把临时增补项目记入当前账单。
      if (ticketId) {
        for (const addOn of addedAddOns) {
          await addTicketItemMutation.mutateAsync({
            ticketId,
            serviceId: addOn.serviceId,
            membershipId: addOn.staffId,
            kind: 'addon',
            minutes: addOn.durationMin,
            idempotencyKey: addOn.idempotencyKey,
          });
        }
      }

      const firstTicketItemId = ticketItemIds[0];
      const firstStaffId = assignments[0]?.staffIds[0];
      if (firstTicketItemId && firstStaffId) {
        // 多项目按顺序流转：入座时只启动第一项，其余保留为 waiting，
        // 完成前一项后由下一位已指派技师从技师端启动。
        //
        // ⚠️ 技师并发的闸门在这一步（不在开单）。撞上上限时服务端返回
        // STAFF_OVER_CAPACITY，门店允许超排的话前台确认后带 reason 重试。
        try {
          await startTicketItemMutation.mutateAsync({
            ticketItemId: firstTicketItemId,
            membershipId: firstStaffId,
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
    const { item, paymentMethod, tenderedDollars, keepChange, giftCardCode, giftCardId, giftCardVerified, giftCardBalanceCents } = checkoutModal;
    if (!item) return;
    if (closeTicketMutation.isPending) return;

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
        idempotencyKey: `queue-checkout-${item.ticketId}`,
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

      toast.success(t('queue.quCheckoutDone', { p0: item.customerName }), {
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
      await Promise.all([refetchQueue(), refetchSchedule(), refetchTickets()]);
    } catch (err: any) {
      toast.danger(`${t('queue.quRollbackFailed')} ${errorMessage(err) || t('queue.quNetworkError2')}`);
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
          <div className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5">
            <Clock className="w-4 h-4 text-teal-600 shrink-0" />
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

      {/* 5 列看板主体 (支持横向滚动与列拖拽) */}
      <div className="custom-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto pb-2">
        {/*
          断点与 min-width 此前互相矛盾：min-w-[1100px] 让容器在任何视口下都不低于
          1100px，grid-cols-1 / md:grid-cols-3 因此永远不会生效，窄屏只会横向滚动。
          现改为窄屏单列纵向排布，宽屏才进入 5 列并横向滚动。
        */}
        <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-3 lg:grid-cols-5 lg:min-w-[1100px]">
          {COLUMNS.map((col) => {
            const colItems = filteredItems.filter((it) => it.stage === col.id);
            const isDropTarget = dragOverColumn === col.id;

            return (
              <div
                key={col.id}
                onDragOver={(e) => handleDragOver(e, col.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, col.id)}
                className={cn(
                  /*
                    列高此前是硬编码的 calc(100vh-270px)，顶部指标栏一换行就溢出。
                    改为跟随可用高度：窄屏按内容展开并限高，宽屏撑满看板容器。
                  */
                  'flex max-h-[70vh] flex-col rounded-2xl border transition-colors duration-200 lg:h-full lg:max-h-none',
                  col.color,
                  isDropTarget
                    ? 'border-teal-400 bg-teal-50/40 ring-2 ring-teal-500'
                    : 'bg-slate-50/70',
                )}
              >
                {/* Column Header */}
                <div
                  className={cn(
                    'p-3 rounded-t-2xl border-b flex items-center justify-between shrink-0 select-none',
                    col.headerBg,
                  )}
                >
                  <div className="flex items-center gap-2">
                    <col.icon className="w-4 h-4 shrink-0" />
                    <div>
                      <h3 className="font-bold text-xs leading-none">{t(col.titleKey)}</h3>
                      <p className="text-xs text-slate-500 mt-0.5 opacity-80">{t(col.subtitleKey)}</p>
                    </div>
                  </div>
                  <Badge variant={col.badgeVariant} className="font-mono text-xs px-2 py-0.5 font-bold">
                    {colItems.length}
                  </Badge>
                </div>

                {/* Column Body / Card List */}
                <div className="flex-1 p-2.5 overflow-y-auto space-y-2.5 custom-scrollbar min-h-0">
                  <AnimatePresence mode="popLayout">
                    {colItems.length === 0 ? (
                      <div className="h-40 border-2 border-dashed border-slate-200/80 rounded-xl flex flex-col items-center justify-center text-center p-3">
                        <col.icon className="w-6 h-6 text-slate-300 mb-1" />
                        <span className="text-xs text-slate-400 font-medium">{t(col.emptyKey)}</span>
                        <span className="text-xs text-slate-400 mt-0.5">{t('queue.quDragInOrder')}</span>
                      </div>
                    ) : (
                      colItems.map((item) => {
                        const isDragging = draggingItemId === item.id;

                        return (
                          <motion.div
                            key={item.id}
                            layout
                            initial={{ opacity: 0, y: 8, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.18 }}
                            draggable
                            onDragStart={(e: any) => handleDragStart(e, item)}
                            className={cn(
                              'p-3 bg-white rounded-xl border border-slate-200/90 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing group relative select-none',
                              isDragging && 'opacity-40 scale-95 border-teal-400',
                            )}
                          >
                            {/* Card Top: Customer & Tags */}
                            <div className="flex items-start justify-between gap-1 mb-1.5">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <div className="w-6 h-6 rounded-full bg-teal-50 text-teal-700 font-bold text-xs flex items-center justify-center shrink-0 border border-teal-200">
                                  {item.customerName.charAt(0)}
                                </div>
                                <div className="min-w-0">
                                  <span
                                    className="font-bold text-xs text-slate-900 truncate block hover:text-teal-600 cursor-pointer"
                                    onClick={() => handleViewDetails(item)}
                                  >
                                    {item.customerName}
                                  </span>
                                  {item.phone && (
                                    <span className="text-xs text-slate-400 block font-mono">
                                      {formatPhoneDisplay(item.phone)}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {item.ticketNumber && (
                                <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded-lg bg-amber-100 text-amber-800 shrink-0">
                                  #{item.ticketNumber}
                                </span>
                              )}
                            </div>

                            {/* Service Info, Room & Staff */}
                            <div className="text-xs space-y-1 my-2 bg-slate-50/70 p-2 rounded-lg border border-slate-100">
                              <div className="flex items-center justify-between text-slate-700 font-medium">
                                <span className="truncate flex items-center gap-1">
                                  <Scissors className="w-3 h-3 text-teal-600 shrink-0" />
                                  {item.serviceName}
                                </span>
                                {item.priceCents > 0 && (
                                  <span className="font-mono font-bold text-slate-900 shrink-0 ml-1">
                                    ${centsToDollars(item.priceCents)}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center justify-between text-xs text-slate-500 pt-1 border-t border-slate-100/80">
                                <span className="truncate flex items-center gap-1">
                                  <User className="w-3 h-3 text-slate-400 shrink-0" />
                                  <span className={item.staffName ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                                    {item.staffName || t('queue.quUnassignedStaff')}
                                  </span>
                                </span>
                                {item.roomName && (
                                  <span className="truncate text-xs text-teal-700 font-medium flex items-center gap-0.5">
                                    <BedDouble className="w-2.5 h-2.5" />
                                    {item.roomName}
                                  </span>
                                )}
                                {item.isRequest && (
                                  <span className="text-xs font-bold px-1.5 py-0.2 rounded bg-violet-100 text-violet-700 shrink-0">
                                    {t('queue.quRequested')}
                                  </span>
                                )}
                              </div>

                              {item.notes && (
                                <p className="text-xs text-amber-700 bg-amber-50/60 p-1 rounded font-medium truncate">
                                  📝 {item.notes}
                                </p>
                              )}
                            </div>

                            {/* Time Status / Alerts Bar */}
                            <div className="flex items-center justify-between text-xs text-slate-500 pt-1 mb-2">
                              <div className="flex items-center gap-1 font-mono font-medium">
                                <Timer className="w-3 h-3 text-slate-400" />
                                <span>{item.timeDisplay}</span>
                              </div>

                              {item.overdue && (
                                <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold text-xs flex items-center gap-0.5">
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  {t('queue.quOverdueWait')}
                                </span>
                              )}

                              {item.pendingForms && item.pendingForms > 0 ? (
                                <button
                                  type="button"
                                  className="flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200"
                                  onClick={(event) => { event.stopPropagation(); void openFormQr(item); }}
                                >
                                  <FileWarning className="h-3 w-3" />
                                  {t('queue.quWiFormPendingBadge')}
                                </button>
                              ) : null}
                            </div>

                            {/* 显眼放大版 详情按钮 与 快捷流转动作 */}
                            <div className="space-y-1.5 pt-2 border-t border-slate-100">
                              {/* 放大版 详情按钮 */}
                              <Button
                                size="sm"
                                variant="secondary"
                                className="w-full h-8 text-xs font-semibold text-slate-700 hover:text-teal-700 hover:bg-slate-100 gap-1"
                                onClick={() => handleViewDetails(item)}
                              >
                                <FileText className="w-3.5 h-3.5 text-slate-500" />
                                <span>{t('queue.quViewDetail')}</span>
                              </Button>

                              {/* 右侧正向推进主动作按钮 */}
                              {col.id === 'booked' && (
                                <Button
                                  size="sm"
                                  className="w-full h-8 text-xs font-bold bg-amber-500 hover:bg-amber-600 text-white rounded-xl gap-1 shadow-sm"
                                  onClick={() => initiateStageTransition(item, 'waiting')}
                                >
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>{t('queue.quCheckInGuest')}</span>
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </Button>
                              )}

                              {col.id === 'waiting' && (
                                <Button
                                  size="sm"
                                  className="w-full h-8 text-xs font-bold bg-teal-600 hover:bg-teal-700 text-white rounded-xl gap-1 shadow-sm"
                                  onClick={() => initiateStageTransition(item, 'in_service')}
                                >
                                  <Scissors className="w-3.5 h-3.5" />
                                  <span>{t('queue.quWiAssignSeat')}</span>
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </Button>
                              )}

                              {col.id === 'in_service' && (
                                <Button
                                  size="sm"
                                  className="w-full h-8 text-xs font-bold bg-violet-600 hover:bg-violet-700 text-white rounded-xl gap-1 shadow-sm"
                                  onClick={() => initiateStageTransition(item, 'ready_checkout')}
                                >
                                  <CheckCircle className="w-3.5 h-3.5" />
                                  <span>{t('queue.quFinishAndBill')}</span>
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </Button>
                              )}

                              {col.id === 'ready_checkout' && (
                                <Button
                                  size="sm"
                                  className="w-full h-8 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-1 shadow-sm"
                                  onClick={() => initiateStageTransition(item, 'completed')}
                                >
                                  <CreditCard className="w-3.5 h-3.5" />
                                  <span>{t('queue.quSettleAndPrint')}</span>
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </Button>
                              )}

                              {col.id === 'completed' && (
                                <div className="text-center py-1 text-xs text-emerald-700 font-mono font-medium flex items-center justify-center gap-1 bg-emerald-50 rounded-lg">
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>{t('queue.quArchived')}</span>
                                </div>
                              )}
                            </div>
                          </motion.div>
                        );
                      })
                    )}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 弹窗 1: [预约 ➔ 到店] 顾客到店签到确认 (健康排查 · 偏好设置 · 现场加项) */}
      {checkInModal.isOpen && checkInModal.item && (() => {
        const item = checkInModal.item;
        const addOnService = services.find((s) => s.id === checkInModal.selectedAddOnId);
        const addOnPriceCents = addOnService ? addOnService.priceCents : 0;
        const totalEstCents = (item.priceCents || 0) + addOnPriceCents;
        const usesMassageIntake = !completedCheckInForms[0]
          || inferHealthFormCategory(completedCheckInForms[0].templateKey) === 'massage';

        return (
          <Modal
            isOpen={checkInModal.isOpen}
            onOpenChange={(open) => {
              if (!open) {
                setCheckInModal((prev) => ({ ...prev, isOpen: false, item: null }));
                setAiSummarySubmissionId(null);
                setCheckInError(null);
              }
            }}
            title={
              <div className="flex items-center gap-2 text-amber-800 font-bold">
                <UserCheck className="w-5 h-5 text-amber-600" />
                <span>{t('queue.quCheckInTitle')}</span>
              </div>
            }
            size="lg"
            footer={
              <div className="flex justify-end gap-2 w-full">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setCheckInModal((prev) => ({ ...prev, isOpen: false, item: null }));
                    setAiSummarySubmissionId(null);
                    setCheckInError(null);
                  }}
                >
                  {t('queue.quCheckInCancel')}
                </Button>
                <Button
                  className={PRIMARY_ACTION_CLASS}
                  isDisabled={checkInPending}
                  onPress={handleConfirmCheckIn}
                >
                  {checkInPending
                    ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
                    : <><Check className="h-4 w-4" />{t('queue.quCheckInConfirmAmount', { p0: centsToDollars(totalEstCents) })}</>}
                </Button>
              </div>
            }
          >
            {/* 高度与滚动交给 Modal.Body 统一管理；此处再套一层会出现双滚动条。 */}
            <div className="space-y-3 py-1 text-sm text-slate-700">
              {/* 1. 顾客基本信息与预约项目概览 */}
              <div className="p-3 bg-amber-50/70 rounded-2xl border border-amber-200 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                    {customerInitials(item.customerName)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                      {item.phone ? (
                        <Badge variant="warning" className="text-xs font-bold px-1.5 py-0">
                          {formatPhoneDisplay(item.phone)}
                        </Badge>
                      ) : walkInShowsNoPhone({ phone: item.phone, customerName: item.customerName }) ? (
                        <Badge variant="warning" className="text-xs font-bold px-1.5 py-0">
                          {t('queue.quWalkInNoPhone')}
                        </Badge>
                      ) : null}
                      <Badge variant="secondary" className="text-xs font-bold px-1.5 py-0 bg-amber-100 text-amber-900 border-amber-300">
                        {t('queue.quWaitingArea')}
                      </Badge>
                    </div>
                    <span className="text-xs text-slate-600 flex items-center gap-1.5 mt-0.5">
                      <span>{t('queue.quCheckInBookedLine', {
                        p0: item.serviceName,
                        p1: item.durationMin,
                        p2: item.staffName || t('queue.quUnspecified'),
                      })}</span>
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-xs font-medium text-slate-400 block">{t('queue.quEstimatedAmount')}</span>
                  <span className="font-mono font-bold text-amber-900 text-base">
                    ${centsToDollars(item.priceCents)}
                  </span>
                </div>
              </div>

              {/* 2. 电子健康问卷与身体禁忌排查 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-sky-600" />
                    <span>{t('queue.quIntakeFormTitle')}</span>
                  </h4>
                  <Badge variant="secondary" className="text-xs bg-sky-50 text-sky-800 border-sky-200">
                    {t('queue.quComplianceWaiver')}
                  </Badge>
                </div>

                {completedCheckInForms.length > 0 && (
                  <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        <div>
                          <p className="text-xs font-bold text-emerald-950">{t('queue.quHealthFormReceived')}</p>
                          <p className="text-xs text-emerald-700">
                            {completedCheckInForms.map((form) => form.templateTitle[language] ?? form.templateTitle.en ?? t('queue.quHealthForm')).join(', ')}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="h-8 bg-teal-900 px-3 text-xs font-bold text-white"
                          onPress={() => setAiSummarySubmissionId((current) => (
                            current === completedCheckInForms[0]?.submissionId ? null : completedCheckInForms[0]?.submissionId ?? null
                          ))}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          {t('queue.quAiHealthSummary')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 border-emerald-300 bg-white px-3 text-xs font-bold text-emerald-800"
                          onPress={() => {
                            const submissionId = completedCheckInForms[0]?.submissionId;
                            if (submissionId) window.open(`/forms/submissions/${encodeURIComponent(submissionId)}`, '_blank', 'noopener,noreferrer');
                          }}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('queue.quViewCompletedForm')}
                        </Button>
                      </div>
                    </div>
                    {aiSummarySubmissionId && (
                      <div className="rounded-xl border border-teal-700 bg-teal-950 p-3 text-white">
                        <div className="flex items-center gap-2 text-xs font-bold text-teal-100">
                          <Sparkles className="h-3.5 w-3.5 text-teal-300" />
                          {t('schedule.adAiHealthSummary')}
                          <Languages className="ml-auto h-3.5 w-3.5 text-teal-300" />
                        </div>
                        {aiSummaryQ.isLoading && <div className="mt-3 flex items-center gap-2 text-xs text-teal-100"><Spinner size="sm" />{t('queue.quAiSummaryLoading')}</div>}
                        {aiSummaryQ.isError && <p className="mt-3 text-xs text-rose-200">{t('queue.quAiSummaryFailed')}</p>}
                        {checkInAiSummary && (
                          <div className="mt-3 space-y-2">
                            <p className="text-sm font-semibold text-teal-50">{checkInAiSummary.headline[language] ?? checkInAiSummary.headline.en}</p>
                            {(checkInAiSummary.keyAlerts[language] ?? checkInAiSummary.keyAlerts.en ?? []).length > 0 && (
                              <ul className="list-disc space-y-1 pl-5 text-xs text-teal-100">
                                {(checkInAiSummary.keyAlerts[language] ?? checkInAiSummary.keyAlerts.en).map((alert) => <li key={alert}>{alert}</li>)}
                              </ul>
                            )}
                            <p className="text-xs leading-relaxed text-teal-100">{checkInAiSummary.technicianAdvice[language] ?? checkInAiSummary.technicianAdvice.en}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {completedCheckInForms.length === 0 && <div className="p-3.5 bg-sky-50/70 border border-sky-200 rounded-2xl flex flex-col sm:flex-row items-center gap-3.5">
                  {/* 可点击放大的真实二维码卡片 */}
                  {(() => {
                    const intakeUrl = formShares[item.id]?.url;
                    return (
                      <>
                        {/* 原为 div + onClick：键盘用户完全够不到，改成真正的按钮。 */}
                        <button
                          type="button"
                          onClick={() => void openFormQr(item)}
                          className="group flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-2xl border border-sky-300 bg-white p-1.5 transition-colors hover:border-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                          title={t('queue.quZoomQr')}
                          aria-label={t('queue.quZoomQr')}
                        >
                          {intakeUrl ? <QRCodeSVG value={intakeUrl} size={52} level="M" /> : <QrCode className="h-10 w-10 text-sky-600" />}
                          <span className="mt-0.5 text-xs font-medium text-sky-800 transition-colors group-hover:text-sky-600">
                            {t('queue.quZoomQrHint')}
                          </span>
                        </button>

                        <div className="text-xs space-y-1.5 flex-1 w-full">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 font-bold text-sky-950">
                              <Tablet className="w-3.5 h-3.5 text-sky-600" />
                              <span>{t('queue.quSignOnDevice')}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                              void copyFormLink(item);
                              }}
                              className="text-xs text-sky-700 hover:text-sky-900 font-bold underline cursor-pointer"
                            >
                              {t('queue.quCopyLink')}
                            </button>
                          </div>
                          <p className="text-slate-600 text-xs leading-relaxed">
                            {t('queue.quIntakeGuide')}
                          </p>
                          <div className="flex items-center justify-between pt-0.5">
                            <label className="flex items-center gap-2 cursor-pointer font-bold text-sky-950 text-xs">
                              <input
                                type="checkbox"
                                checked={checkInModal.qrScanned}
                                onChange={(e) => setCheckInModal((prev) => ({ ...prev, qrScanned: e.target.checked }))}
                                className="w-3.5 h-3.5 rounded text-sky-600 focus:ring-sky-500/20"
                              />
                              <span>{t('queue.quPaperFormChecked')}</span>
                            </label>
                            <button
                              type="button"
                                onClick={() => void openFormQr(item)}
                              className="text-xs text-sky-700 bg-white hover:bg-sky-50 px-2 py-0.5 border border-sky-300 rounded-lg font-bold shadow-xs"
                            >
                              {t('queue.quFullScreenQr')}
                            </button>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>}

                {/* 禁忌快速排查标签 */}
                <div className={cn(!usesMassageIntake && 'hidden')}>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    {t('queue.quContraindicationsHint')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {CONTRAINDICATION_TAGS.map((option) => {
                      const isSelected = checkInModal.contraindications.includes(option.id);
                      const isSafe = option.id === CONTRAINDICATION_NONE;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => {
                            setCheckInModal((prev) => {
                              if (isSafe) {
                                return { ...prev, contraindications: [CONTRAINDICATION_NONE] };
                              }
                              const listWithoutSafe = prev.contraindications.filter((c) => c !== CONTRAINDICATION_NONE);
                              const next = listWithoutSafe.includes(option.id)
                                ? listWithoutSafe.filter((c) => c !== option.id)
                                : [...listWithoutSafe, option.id];
                              return {
                                ...prev,
                                contraindications: next.length === 0 ? [CONTRAINDICATION_NONE] : next,
                              };
                            });
                          }}
                          className={cn(
                            'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                            isSelected
                              ? isSafe
                                ? 'border-emerald-500 bg-emerald-50 font-semibold text-emerald-900'
                                : 'border-rose-500 bg-rose-50 font-semibold text-rose-900'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {isSelected && !isSafe && '⚠️ '}
                          {t(option.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 3. 护理偏好与身体部位偏好 */}
              <div className={cn('bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm', !usesMassageIntake && 'hidden')}>
                <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('queue.quPreferencesTitle')}</span>
                </h4>

                {/* 力度选择 */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t('queue.quPressurePref')}
                  </label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {STRENGTH_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={checkInModal.massageStrength === option.id}
                        onClick={() => setCheckInModal((prev) => ({ ...prev, massageStrength: option.id }))}
                        className={cn(
                          'rounded-lg border py-1.5 text-center text-xs font-medium transition-colors',
                          checkInModal.massageStrength === option.id
                            ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                        )}
                      >
                        {t(option.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 芳香精油 */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t('queue.quOilPref')}
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {AROMA_OIL_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setCheckInModal((prev) => ({ ...prev, aromaOil: opt.id }))}
                        aria-pressed={checkInModal.aromaOil === opt.id}
                        className={cn(
                          'rounded-lg border p-2 text-left transition-colors',
                          checkInModal.aromaOil === opt.id
                            ? 'border-teal-500 bg-teal-50 text-teal-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                        )}
                      >
                        <span className="block text-xs font-semibold">{t(opt.labelKey)}</span>
                        <span className="block text-xs text-slate-500">{t(opt.descKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 重点部位 (分左右，可多选) */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t('queue.quFocusAreas')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {FOCUS_AREA_TAGS.map((option) => {
                      const isSelected = checkInModal.focusAreas.includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => {
                            setCheckInModal((prev) => ({
                              ...prev,
                              focusAreas: isSelected
                                ? prev.focusAreas.filter((f) => f !== option.id)
                                : [...prev.focusAreas, option.id],
                            }));
                          }}
                          className={cn(
                            'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                            isSelected
                              ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {isSelected ? '✓ ' : '+ '}
                          {t(option.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 避免触碰敏感部位 */}
                <div>
                  <label className="block text-xs font-bold text-rose-900 mb-1 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
                    <span>{t('queue.quAvoidAreas')}</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {AVOID_AREA_TAGS.map((option) => {
                      const isSelected = checkInModal.avoidAreas.includes(option.id);
                      const isNone = option.id === AVOID_AREA_NONE;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => {
                            setCheckInModal((prev) => {
                              if (isNone) {
                                return { ...prev, avoidAreas: [AVOID_AREA_NONE] };
                              }
                              const listWithoutNone = prev.avoidAreas.filter((a) => a !== AVOID_AREA_NONE);
                              const next = listWithoutNone.includes(option.id)
                                ? listWithoutNone.filter((a) => a !== option.id)
                                : [...listWithoutNone, option.id];
                              return {
                                ...prev,
                                avoidAreas: next.length === 0 ? [AVOID_AREA_NONE] : next,
                              };
                            });
                          }}
                          className={cn(
                            'rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                            isSelected
                              ? isNone
                                ? 'border-slate-400 bg-slate-100 font-semibold text-slate-800'
                                : 'border-rose-500 bg-rose-50 font-semibold text-rose-900'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {isSelected && !isNone && '⛔ '}
                          {t(option.labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 4. 现场附加加项与指定技师 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2.5 shadow-sm">
                <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('queue.quAddOnTitle')}</span>
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">{t('queue.quSelectAddOn')}</label>
                    <select
                      value={checkInModal.selectedAddOnId}
                      onChange={(e) => setCheckInModal((prev) => ({ ...prev, selectedAddOnId: e.target.value }))}
                      className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900"
                    >
                      <option value="">{t('queue.quNoAddOn')}</option>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          + {s.categoryName ? `${s.categoryName} · ` : ''}{s.name} (${centsToDollars(s.priceCents)} · {s.durationMin}m)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">{t('queue.quAddOnStaff')}</label>
                    <select
                      value={checkInModal.addOnStaffId}
                      onChange={(e) => setCheckInModal((prev) => ({ ...prev, addOnStaffId: e.target.value }))}
                      className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900"
                    >
                      <option value="">{t('queue.quFollowLeadStaffOf', { p0: item.staffName || t('queue.quStaffUnassignedShort') })}</option>
                      {staff
                        .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                        .map((s) => (
                          <option key={s.membershipId} value={s.membershipId}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* 5. 前台特别叮嘱备注 */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('queue.quGuestNotes')}
                </label>
                <Input
                  value={checkInModal.notes}
                  onChange={(e) => setCheckInModal((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder={t('queue.quGuestNotePlaceholder')}
                  className="text-xs"
                />
              </div>

              {checkInError && (
                <div role="alert" className="sticky bottom-0 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-xs font-semibold leading-relaxed text-rose-800 shadow-sm">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{checkInError}</span>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        );
      })()}

      {/* 弹窗 2: [到店 ➔ 服务中] 安排入座与工位启动 (技师指派 · 包厢分配 · 禁忌提示) */}
      {startServiceModal.isOpen && startServiceModal.item && (() => {
        const item = startServiceModal.item;
        const assignedStaff = staff.find((s) => s.membershipId === startServiceModal.staffId);
        const assignedRoom = rooms.find((r) => r.id === startServiceModal.roomId);
        const assignmentCandidates = startServiceModal.assignments.map((assignment) => {
          const service = services.find((entry) => entry.id === assignment.serviceId) ?? {
            id: assignment.serviceId, name: assignment.serviceName,
            durationMin: assignment.durationMin, priceCents: 0,
            staffCount: assignment.staffCount, requiredSkills: [],
          };
          return {
            assignment,
            service,
            candidates: rankStaffCandidates({
              staff: staff.filter((member) => member.membershipId !== UNASSIGNED_STAFF_ID),
              service,
              rotationEntries: rotationData?.entries ?? [],
              scheduledItems: todaySnapshot?.items ?? [],
              onlineIds: onlineTechIds,
              requestedStaffId: item.staffId,
              nowMs: Date.now(),
            }),
          };
        });
        const addOnStaffOptions = staff.filter((member) => member.membershipId !== UNASSIGNED_STAFF_ID && member.isBookable);
        const rotationStateLabel = (state: string) => {
          if (state === 'available') return t('queue.quCandidate_available');
          if (state === 'in_service') return t('queue.quRotationStatusInService');
          if (state === 'on_break') return t('queue.quCandidate_on_break');
          if (state === 'off') return t('queue.quRotationStatusOff');
          return t('queue.quCandidate_off_duty');
        };

        return (
          <Modal
            isOpen={startServiceModal.isOpen}
            onOpenChange={(open) => {
              if (!open) setStartServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
            }}
            title={
              <div className="flex items-center gap-2 text-teal-800 font-bold">
                <Scissors className="w-5 h-5 text-teal-600" />
                <span>{t('queue.quSeatModalTitle')}</span>
              </div>
            }
            size="lg"
            footer={
              <div className="flex justify-end gap-2 w-full">
                <Button
                  variant="secondary"
                  onClick={() => setStartServiceModal((prev) => ({ ...prev, isOpen: false, item: null }))}
                >
                  {t('queue.quSeatCancel')}
                </Button>
                <Button
                  className={PRIMARY_ACTION_CLASS}
                  onPress={() => { void handleConfirmStartService(); }}
                  isDisabled={startServicePending
                    || startServiceModal.assignments.some((assignment) => assignment.staffIds.length !== assignment.staffCount)}
                >
                  {startServicePending
                    ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
                    : <><Check className="h-4 w-4" />{t('queue.quSeatConfirmAt', { p0: assignedRoom?.name || t('queue.quRoomUnassigned') })}</>}
                </Button>
              </div>
            }
          >
            {/* 高度与滚动交给 Modal.Body 统一管理；此处再套一层会出现双滚动条。 */}
            <div className="space-y-3 py-1 text-sm text-slate-700">
              {/* 顾客与服务概要 */}
              <div className="p-3 bg-teal-50/70 rounded-2xl border border-teal-200 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                    <Badge variant="secondary" className="text-xs font-bold px-1.5 py-0 bg-teal-100 text-teal-900 border-teal-300">
                      {item.serviceName}
                    </Badge>
                    {item.isRequest && (
                      <Badge variant="secondary" className="text-xs font-bold px-1.5 py-0 bg-violet-100 text-violet-700 border-violet-200">
                        {t('queue.quRequestedStar')}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-teal-900 block mt-0.5">
                    {t('queue.quApprovedDuration')} <strong>{startServiceModal.serviceDurationMin}  {t('queue.quMinutes')}</strong>  {t('queue.quBaseFee')}{centsToDollars(item.priceCents)}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs font-bold text-teal-600 block">{t('queue.quStartTime')}</span>
                  <span className="font-mono font-bold text-teal-900 text-base">{startServiceModal.startTime || t('queue.quNow')}</span>
                </div>
              </div>

              {/* 技师与工位分配 */}
              <div className="grid grid-cols-1 gap-3">
                {/* 技师指派 */}
                <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-2xs">
                  <label className="block text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-teal-600" />
                      <span>{t('queue.quQualifiedStaffAssignments')}</span>
                    </span>
                    <span className="text-xs text-teal-600 font-normal">{t('queue.quRotationPriority')}</span>
                  </label>
                  <div className="rounded-2xl border-2 border-indigo-200 bg-indigo-50/70 p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid h-7 w-7 place-items-center rounded-xl bg-indigo-600 text-white shadow-sm">
                          <Clock className="h-4 w-4" />
                        </span>
                        <div>
                          <div className="text-sm font-bold text-indigo-950">{t('queue.quFullRotation')}</div>
                          <div className="text-xs font-medium text-indigo-800">{t('queue.quRotationLegend')}</div>
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-white px-2 py-1 font-mono text-xs font-bold text-indigo-800 ring-1 ring-indigo-200">
                        {orderedRotationEntries.length}
                      </span>
                    </div>
                    {orderedRotationEntries.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-indigo-200 bg-white/80 px-3 py-2 text-xs font-semibold text-slate-500">
                        {t('queue.quNoRotation')}
                      </div>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {orderedRotationEntries.map((entry, index) => {
                          const recommended = assignmentCandidates.some(({ candidates }) => candidates.find((candidate) => candidate.eligible)?.staff.membershipId === entry.membershipId);
                          const position = entry.position ?? index + 1;
                          const statusClass = entry.state === 'available'
                            ? 'border-slate-300 bg-white'
                            : entry.state === 'in_service'
                              ? 'border-orange-300 bg-orange-50'
                              : entry.state === 'on_break'
                                ? 'border-violet-300 bg-violet-50'
                                : 'border-slate-300 bg-slate-100';
                          return (
                            <div
                              key={entry.membershipId}
                              className={cn(
                                'min-w-0 rounded-xl border-2 px-2.5 py-2 shadow-sm',
                                recommended ? 'border-emerald-600 bg-emerald-50 ring-2 ring-emerald-200' : statusClass,
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <span className={cn(
                                  'grid h-7 min-w-7 place-items-center rounded-lg px-1 font-mono text-xs font-bold',
                                  recommended ? 'bg-emerald-700 text-white' : 'bg-slate-800 text-white',
                                )}>
                                  #{position}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-950">{entry.name}</span>
                                <span className={cn(
                                  'h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white',
                                  entry.state === 'available' ? 'bg-emerald-500' : entry.state === 'in_service' ? 'bg-orange-500' : entry.state === 'on_break' ? 'bg-violet-500' : 'bg-slate-400',
                                )} />
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2 text-xs font-bold">
                                <span className={cn(recommended ? 'text-emerald-800' : 'text-slate-600')}>{rotationStateLabel(entry.state)}</span>
                                {recommended && <span className="truncate text-emerald-800">✓ {t('queue.quRotationRecommended')}</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    {assignmentCandidates.map(({ assignment, service, candidates }, assignmentIndex) => (
                      <div key={`${assignment.serviceId}-${assignmentIndex}`} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                        {assignment.staffIds.some((staffId) => candidates.find((candidate) => candidate.staff.membershipId === staffId && !candidate.eligible)) && (
                          <div role="alert" className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-bold leading-relaxed text-amber-900">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                            <span>{t('queue.quSelectedStaffWarning')}</span>
                          </div>
                        )}
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-bold text-slate-900">{assignmentIndex + 1}. {assignment.serviceName}</div>
                            <div className="text-xs text-slate-500">
                              {t('queue.quNeedsStaffCount', { p0: assignment.staffCount })}
                              {service.requiredSkills.length > 0 && ` · ${service.requiredSkills.map((skill) => skill.name).join(' / ')}`}
                            </div>
                          </div>
                          <Badge variant={assignment.staffIds.length === assignment.staffCount ? 'success' : 'warning'} className="text-xs">
                            {assignment.staffIds.length}/{assignment.staffCount}
                          </Badge>
                        </div>
                        <div className="grid gap-1.5 sm:grid-cols-2">
                          {candidates.map((candidate) => {
                            const selected = assignment.staffIds.includes(candidate.staff.membershipId);
                            const rotationEntry = rotationData?.entries.find((entry) => entry.membershipId === candidate.staff.membershipId);
                            const rotationPosition = rotationEntry?.position;
                            const recommended = candidates.find((entry) => entry.eligible)?.staff.membershipId === candidate.staff.membershipId;
                            const warning = !candidate.eligible;
                            return (
                              <button
                                key={candidate.staff.membershipId}
                                type="button"
                                onClick={() => setStartServiceModal((prev) => {
                                  const nextAssignments = [...prev.assignments];
                                  const current = nextAssignments[assignmentIndex]!;
                                  const staffIds = selected
                                    ? current.staffIds.filter((id) => id !== candidate.staff.membershipId)
                                    : current.staffIds.length < current.staffCount
                                      ? [...current.staffIds, candidate.staff.membershipId]
                                      : [candidate.staff.membershipId, ...current.staffIds.slice(1)];
                                  nextAssignments[assignmentIndex] = { ...current, staffIds };
                                  return { ...prev, assignments: nextAssignments, staffId: nextAssignments[0]?.staffIds[0] ?? '' };
                                })}
                                className={cn(
                                  'min-h-[96px] rounded-2xl border-2 p-3 text-left shadow-sm transition hover:-translate-y-px hover:shadow-md',
                                  selected
                                    ? warning
                                      ? 'border-amber-600 bg-amber-50 ring-2 ring-amber-200'
                                      : recommended
                                        ? 'border-emerald-700 bg-emerald-50 ring-2 ring-emerald-200'
                                        : 'border-sky-600 bg-sky-50 ring-2 ring-sky-200'
                                    : recommended
                                      ? 'border-emerald-500 bg-emerald-50 hover:border-emerald-700'
                                      : warning
                                        ? 'border-amber-300 bg-amber-50 hover:border-amber-500'
                                        : 'border-slate-300 bg-white hover:border-sky-500',
                                )}
                                aria-pressed={selected}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <span className={cn('grid h-7 min-w-7 place-items-center rounded-lg px-1 font-mono text-xs font-bold', recommended ? 'bg-emerald-700 text-white' : warning ? 'bg-amber-600 text-white' : selected ? 'bg-sky-700 text-white' : 'bg-slate-800 text-white')}>
                                      {rotationPosition ? `#${rotationPosition}` : '—'}
                                    </span>
                                    <span className="truncate text-sm font-bold text-slate-950">{candidate.staff.name}</span>
                                  </span>
                                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white', candidate.online ? 'bg-emerald-500' : 'bg-slate-400')} />
                                </div>
                                <div className="mt-1 truncate text-xs font-semibold text-slate-600">
                                  {candidate.staff.levelName || t('queue.quLevelUnspecified')} · {candidate.reasons.map((reason) => t(`queue.quCandidate_${reason}`)).join(' · ')}
                                </div>
                                <div className={cn('mt-1.5 flex items-center gap-1 text-xs font-bold', warning ? 'text-amber-900' : recommended ? 'text-emerald-800' : selected ? 'text-sky-800' : 'text-slate-500')}>
                                  {selected ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : warning ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : recommended ? <Award className="h-3.5 w-3.5 shrink-0" /> : null}
                                  <span>{selected ? t('queue.quSelected') : recommended ? t('queue.quRecommendedForService') : warning ? t('queue.quSelectionWarning') : t('queue.quCandidate_available')}</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 入座前加项目 */}
                <div className="rounded-2xl border-2 border-violet-200 bg-violet-50/70 p-3.5 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-7 w-7 place-items-center rounded-xl bg-violet-600 text-white shadow-sm">
                        <Plus className="h-4 w-4" />
                      </span>
                      <div>
                        <h4 className="text-sm font-bold text-violet-950">{t('queue.quSeatAddOnsTitle')}</h4>
                        <p className="mt-0.5 text-xs font-medium leading-relaxed text-violet-800">{t('queue.quSeatAddOnsHint')}</p>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-white px-2 py-1 font-mono text-xs font-bold text-violet-800 ring-1 ring-violet-200">
                      +{centsToDollars(startServiceModal.addedAddOns.reduce((sum, addOn) => sum + addOn.priceCents, 0))}
                    </span>
                  </div>

                  {startServiceModal.addedAddOns.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {startServiceModal.addedAddOns.map((addOn) => (
                        <div key={addOn.idempotencyKey} className="flex items-center justify-between gap-2 rounded-xl border border-violet-200 bg-white px-2.5 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-bold text-slate-900">{addOn.name}</div>
                            <div className="text-xs font-semibold text-slate-500">{addOn.durationMin}m · {addOn.staffName || t('queue.quAssigned')}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="font-mono text-xs font-bold text-violet-800">${centsToDollars(addOn.priceCents)}</span>
                            <button
                              type="button"
                              className="rounded-lg px-1.5 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50"
                              onClick={() => setStartServiceModal((prev) => ({
                                ...prev,
                                addedAddOns: prev.addedAddOns.filter((item) => item.idempotencyKey !== addOn.idempotencyKey),
                              }))}
                            >
                              {t('queue.quRemoveAddOn')}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_auto]">
                    <select
                      aria-label={t('queue.quSelectAddOn')}
                      value={startServiceModal.extraAddOnServiceId}
                      onChange={(event) => setStartServiceModal((prev) => ({
                        ...prev,
                        extraAddOnServiceId: event.target.value,
                        extraAddOnStaffId: prev.extraAddOnStaffId
                          || prev.staffId
                          || prev.assignments[0]?.staffIds[0]
                          || addOnStaffOptions[0]?.membershipId
                          || '',
                      }))}
                      className="w-full rounded-xl border-2 border-violet-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200"
                    >
                      <option value="">{t('queue.quSelectAddOn')}</option>
                      {services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.categoryName ? `${service.categoryName} · ` : ''}{service.name} · ${centsToDollars(service.priceCents)} · {service.durationMin}m
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t('queue.quAddOnStaff')}
                      value={startServiceModal.extraAddOnStaffId}
                      onChange={(event) => setStartServiceModal((prev) => ({ ...prev, extraAddOnStaffId: event.target.value }))}
                      className="w-full rounded-xl border-2 border-violet-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200"
                    >
                      <option value="">{t('queue.quAddOnStaff')}</option>
                      {addOnStaffOptions.map((member) => (
                        <option key={member.membershipId} value={member.membershipId}>{member.name}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-full min-h-10 border-violet-300 bg-white px-3 text-xs font-bold text-violet-800 hover:bg-violet-100"
                      onClick={addStartServiceAddOn}
                      isDisabled={!startServiceModal.extraAddOnServiceId}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t('queue.quAddItem')}
                    </Button>
                  </div>
                </div>

                {/* 房间/工位分配 */}
                <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-2xs">
                  <label className="block text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <BedDouble className="w-3.5 h-3.5 text-teal-600" />
                      <span>{t('queue.quAssignRoomRequired')}</span>
                    </span>
                    <span className="text-xs text-slate-400">{t('queue.quAutoRecommended')}</span>
                  </label>
                  <select
                    value={startServiceModal.roomId}
                    onChange={(e) => setStartServiceModal((prev) => ({ ...prev, roomId: e.target.value }))}
                    className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 truncate"
                  >
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.type === 'room' ? t('queue.quRoomTypeRoom') : t('queue.quRoomTypeStation')} ({r.status === 'available' ? t('queue.quRoomFree') : r.status === 'cleaning' ? t('queue.quRoomCleaning') : t('queue.quRoomOccupied')})
                      </option>
                    ))}
                  </select>
                  {assignedRoom && (
                    <div className="p-2 bg-slate-50 rounded-xl text-xs text-slate-600 flex justify-between items-center gap-1.5">
                      <span className="truncate">{t('queue.quTypeLabel')} {assignedRoom.type === 'room' ? t('queue.quPrivateRoom') : t('queue.quOpenStation')}  {t('queue.quCapacityPrefix')} {assignedRoom.capacity}{t('queue.quCapacitySuffix')}</span>
                      <Badge
                        variant={assignedRoom.status === 'available' ? 'success' : 'warning'}
                        className="text-xs px-1.5 py-0.5 font-bold shrink-0 whitespace-nowrap"
                      >
                        {assignedRoom.status === 'available' ? t('queue.quSanitised') : t('queue.quInUse')}
                      </Badge>
                    </div>
                  )}
                </div>
              </div>

              {/* 健康问卷与免责知情同意书签署状态 (未填时醒目提示与扫码入口) */}
              {(() => {
                const honesty = healthFormHonesty(item);

                if (honesty === 'pending') {
                  return (
                    <div className="bg-rose-50/90 border-2 border-rose-200 rounded-2xl p-3.5 space-y-2.5 shadow-2xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className="w-7 h-7 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center font-bold shrink-0 mt-0.5 shadow-2xs">
                            <FileWarning className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <h4 className="font-bold text-rose-950 text-xs">{t('queue.quNoFormWarning')}</h4>
                            <p className="text-xs text-rose-800/90 leading-tight mt-0.5">
                              {t('queue.quNoFormWarningDesc')}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => void copyFormLink(item)}
                            className="px-2 py-1 text-xs font-bold bg-white text-rose-800 border border-rose-300 rounded-xl hover:bg-rose-100 flex items-center gap-1 shadow-2xs cursor-pointer transition-colors"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{t('queue.quCopyLink2')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void openFormQr(item)}
                            className="px-2.5 py-1 text-xs font-bold bg-rose-600 text-white rounded-xl hover:bg-rose-700 flex items-center gap-1 shadow-2xs cursor-pointer transition-colors"
                          >
                            <QrCode className="w-3 h-3" />
                            <span>{t('queue.quScanToFill')}</span>
                          </button>
                        </div>
                      </div>
                      <div className="p-2 bg-white/90 rounded-xl border border-rose-200/80 flex items-center justify-between text-xs">
                        <label className="flex items-center gap-2 cursor-pointer font-bold text-rose-950">
                          <input
                            type="checkbox"
                            checked={startServiceModal.requireBriefingAck}
                            onChange={(e) => setStartServiceModal((prev) => ({ ...prev, requireBriefingAck: e.target.checked }))}
                            className="w-3.5 h-3.5 rounded text-rose-600 focus:ring-rose-500/20"
                          />
                          <span>{t('queue.quVerbalConfirm')}</span>
                        </label>
                      </div>
                    </div>
                  );
                }

                if (honesty === 'signed') {
                  return (
                    <div className="bg-emerald-50/80 border border-emerald-200 rounded-2xl p-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                          <CheckCircle className="w-3.5 h-3.5" />
                        </div>
                        <div>
                          <span className="font-bold text-emerald-950 text-xs">{t('queue.quFormSigned')}</span>
                          <span className="text-xs text-emerald-700 block">{t('queue.quNoSevereContraindications')}</span>
                        </div>
                      </div>
                      <Badge variant="success" className="text-xs px-1.5 py-0.5 font-bold">{t('queue.quCompliantSigned')}</Badge>
                    </div>
                  );
                }

                return (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center font-bold">
                        <FileText className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <span className="font-bold text-slate-800 text-xs">{t('queue.quFormNotConfigured')}</span>
                        <span className="text-xs text-slate-500 block">{t('queue.quFormNotConfiguredDesc')}</span>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-xs px-1.5 py-0.5 font-bold">{t('queue.quFormNotConfiguredBadge')}</Badge>
                  </div>
                );
              })()}

              {/* 技师服务前重要提示板 (禁忌与偏好同步) */}
              <div className="bg-amber-50/80 p-3.5 rounded-2xl border border-amber-200 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-amber-950 uppercase tracking-wider flex items-center gap-1.5 text-xs">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    <span>{t('queue.quPreServiceNotes')}</span>
                  </h4>
                  <Badge variant="warning" className="text-xs font-bold shrink-0">{t('queue.quHandoverVerbally')}</Badge>
                </div>
                <textarea
                  value={startServiceModal.serviceBrief}
                  onChange={(event) => setStartServiceModal((prev) => ({ ...prev, serviceBrief: event.target.value }))}
                  maxLength={2000}
                  rows={3}
                  aria-label={t('queue.quPreServiceNotes')}
                  placeholder={t('queue.quNoContraindications')}
                  className="w-full resize-none rounded-xl border border-amber-200/80 bg-white/90 p-2.5 text-xs font-medium leading-relaxed text-slate-700 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-200/60"
                />
                <p className="text-xs leading-relaxed text-amber-800">{t('queue.quPreServiceNotesHelp')}</p>
                {!hasPendingForms(item) && (
                  <label className="flex items-center gap-2 cursor-pointer pt-0.5 text-amber-950 font-bold text-xs">
                    <input
                      type="checkbox"
                      checked={startServiceModal.requireBriefingAck}
                      onChange={(e) => setStartServiceModal((prev) => ({ ...prev, requireBriefingAck: e.target.checked }))}
                      className="w-3.5 h-3.5 rounded text-amber-600 focus:ring-amber-500/20"
                    />
                    <span>{t('queue.quHandoverDone')}</span>
                  </label>
                )}
              </div>

              {/* 服务Duration与完工预估 */}
              <div className="bg-white p-3 rounded-2xl border border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Timer className="w-4 h-4 text-teal-600" />
                  <div>
                    <span className="font-bold text-slate-800 text-xs block">{t('queue.quTimerApproved')}</span>
                    <span className="text-xs text-slate-500">
                      {t('queue.quStartsAt')} {startServiceModal.startTime || t('queue.quCurrent')}  {t('queue.quExpectedFinish')} {(() => {
                        const [h, m] = (startServiceModal.startTime || '14:00').split(':').map(Number);
                        const endMin = (m || 0) + (startServiceModal.serviceDurationMin || 60);
                        const endH = (h || 14) + Math.floor(endMin / 60);
                        const remM = endMin % 60;
                        return `${String(endH % 24).padStart(2, '0')}:${String(remM).padStart(2, '0')}`;
                      })()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {[30, 45, 60, 90].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setStartServiceModal((prev) => ({ ...prev, serviceDurationMin: d }))}
                      className={cn(
                        'px-2 py-1 text-xs rounded-lg border font-bold font-mono transition-all',
                        startServiceModal.serviceDurationMin === d
                          ? 'border-teal-500 bg-teal-50 text-teal-900 ring-1 ring-teal-400'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {d}m
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* 弹窗 3: [服务中 ➔ Open / Unpaid] 服务完工与中途加项核对 (加项核算 · 技师提成 · 翻台清洁) */}
      {completeServiceModal.isOpen && completeServiceModal.item && (() => {
        const item = completeServiceModal.item;
        const addOnsTotalCents = completeServiceModal.addedAddOns.reduce((sum, a) => sum + a.priceCents, 0);
        const finalCalculatedCents = (item.priceCents || 0) + addOnsTotalCents;
        /*
         * 已计时的工时：取本单最早一次 startedAt 到现在的分钟数。
         * 与服务端 finishItem 的口径一致（同一批时间戳），因此前台看到的数字
         * 不会与完工提示里的数字互相打架。
         */
        const startedAtList = (item.rawTicket?.items ?? [])
          .map((ticketItem) => ticketItem.startedAt)
          .filter((value): value is string => Boolean(value))
          .map((value) => new Date(value).getTime())
          .filter((value) => Number.isFinite(value));
        const elapsedMinutes = startedAtList.length > 0
          ? Math.max(0, Math.round((Date.now() - Math.min(...startedAtList)) / 60_000))
          : null;

        return (
          <Modal
            isOpen={completeServiceModal.isOpen}
            onOpenChange={(open) => {
              if (!open) setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
            }}
            title={
              <div className="flex items-center gap-2 text-violet-800 font-bold">
                <CheckCircle className="w-5 h-5 text-violet-600" />
                <span>{t('queue.quFinishModalTitle')}</span>
              </div>
            }
            size="lg"
            footer={
              <div className="flex justify-end gap-2 w-full">
                <Button
                  variant="secondary"
                  onClick={() => setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null }))}
                >
                  {t('queue.quFinishCancel')}
                </Button>
                <Button
                  className={PRIMARY_ACTION_CLASS}
                  isDisabled={completeServicePending}
                  onPress={handleConfirmCompleteService}
                >
                  {completeServicePending
                    ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
                    : <><Check className="h-4 w-4" />{t('queue.quFinishConfirmAmount', { p0: centsToDollars(finalCalculatedCents) })}</>}
                </Button>
              </div>
            }
          >
            {/* 高度与滚动交给 Modal.Body 统一管理；此处再套一层会出现双滚动条。 */}
            <div className="space-y-3 py-1 text-sm text-slate-700">
              {/* 服务概要卡片 */}
              <div className="p-3 bg-violet-50/70 rounded-2xl border border-violet-200 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                    <Badge variant="secondary" className="text-xs font-bold px-1.5 py-0 bg-violet-100 text-violet-900 border-violet-300">
                      {item.serviceName}
                    </Badge>
                  </div>
                  <span className="text-xs text-violet-950 block mt-0.5">
                    {t('queue.quFinishLeadLine', {
                      p0: item.staffName || t('queue.quStaffUnassignedShort'),
                      p1: item.roomName || t('queue.quRoomUnassigned'),
                    })}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs font-bold text-violet-600 block">{t('queue.quBaseServiceFee')}</span>
                  <span className="font-mono font-bold text-violet-900 text-base">
                    ${centsToDollars(item.priceCents)}
                  </span>
                </div>
              </div>

              {/*
                实际执行工时。
                收单时由服务端按 startedAt/finishedAt 结算，前台改不了 ——
                此前这里是一组可点击的时长按钮，选完却不会提交任何东西，
                现改为如实展示系统已记录的用时，差异写进下方的跟进备注。
              */}
              <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                    <Clock className="h-4 w-4 text-slate-400" />
                    <span>{t('queue.quElapsedTitle')}</span>
                  </span>
                  <span className="font-mono text-sm font-bold text-slate-900">
                    {elapsedMinutes === null
                      ? t('queue.quElapsedNotStarted')
                      : `${elapsedMinutes} ${t('queue.quMinutes2')}`}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <p className="text-xs leading-relaxed text-slate-500">{t('queue.quElapsedHint')}</p>
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {t('queue.quElapsedPlanned', { p0: item.durationMin || 0 })}
                  </Badge>
                </div>
              </div>

              {/* 服务中途加项与提成技师归属 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Coins className="w-3.5 h-3.5 text-violet-600" />
                    <span>{t('queue.quAddOnsTitle')}</span>
                  </h4>
                  <span className="text-xs font-semibold text-slate-600">
                    {t('queue.quAddOnSubtotalAmount', { p0: centsToDollars(addOnsTotalCents) })}
                  </span>
                </div>

                {/*
                  常用加项速选。
                  此前这里平铺了整份服务目录，且点击只是「选中」而不入列表，
                  与下方的下拉框构成两个外观完全不同的入口 —— 现收敛为
                  前四项速选 + 「更多」展开，选中后仍由下方统一确认提成技师并添加。
                */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-600">{t('queue.quAddOnQuickPick')}</label>
                    {services.length > FINISH_QUICK_PICK_LIMIT && (
                      <button
                        type="button"
                        onClick={() => setShowAllFinishAddOns((prev) => !prev)}
                        className="text-xs font-semibold text-teal-700 underline-offset-2 hover:underline"
                      >
                        {showAllFinishAddOns
                          ? t('queue.quAddOnShowLess')
                          : t('queue.quAddOnShowMore', { p0: services.length - FINISH_QUICK_PICK_LIMIT })}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(showAllFinishAddOns ? services : services.slice(0, FINISH_QUICK_PICK_LIMIT)).map((service) => (
                      <button
                        key={service.id}
                        type="button"
                        aria-pressed={completeServiceModal.extraAddOnServiceId === service.id}
                        onClick={() => setCompleteServiceModal((prev) => ({
                          ...prev,
                          extraAddOnServiceId: prev.extraAddOnServiceId === service.id ? '' : service.id,
                        }))}
                        className={cn(
                          'flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                          completeServiceModal.extraAddOnServiceId === service.id
                            ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                        )}
                      >
                        <Plus className="h-3 w-3 text-slate-400" />
                        <span>{service.name}</span>
                        <span className="font-mono text-slate-500">${centsToDollars(service.priceCents)}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{t('queue.quAddOnQuickPickHint')}</p>
                </div>

                {/* 已录入加项列表 */}
                {completeServiceModal.addedAddOns.length === 0 ? (
                  <div className="text-xs text-slate-400 p-2.5 border border-dashed rounded-xl text-center bg-slate-50/50">
                    {t('queue.quNoAddOns')}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {completeServiceModal.addedAddOns.map((addon, idx) => (
                      <div key={idx} className="flex items-center justify-between p-2 bg-slate-50 rounded-xl border border-slate-100 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800">{addon.name}</span>
                          <span className="text-xs text-slate-400 font-mono">({addon.durationMin}m)</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-slate-500">{t('queue.quCommissionTo')}</span>
                            <select
                              value={addon.staffId}
                              onChange={(e) => {
                                const newStaff = staff.find((candidate) => candidate.membershipId === e.target.value);
                                setCompleteServiceModal((prev) => ({
                                  ...prev,
                                  addedAddOns: prev.addedAddOns.map((a, i) =>
                                    i === idx
                                      ? { ...a, staffId: e.target.value, staffName: newStaff?.name }
                                      : a,
                                  ),
                                }));
                              }}
                              className="px-2 py-0.5 text-xs rounded-lg border border-slate-200 bg-white font-medium text-slate-800"
                            >
                              {staff
                                .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                                .map((s) => (
                                  <option key={s.membershipId} value={s.membershipId}>
                                    {s.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                          <span className="font-mono font-bold text-violet-800">${centsToDollars(addon.priceCents)}</span>
                          <button
                            type="button"
                            className="text-rose-500 hover:text-rose-700 text-xs font-bold px-1"
                            onClick={() => {
                              setCompleteServiceModal((prev) => ({
                                ...prev,
                                addedAddOns: prev.addedAddOns.filter((_, i) => i !== idx),
                              }));
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 从目录确认加项与执行技师 */}
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
                  <select
                    value={completeServiceModal.extraAddOnServiceId}
                    onChange={(e) => setCompleteServiceModal((prev) => ({
                      ...prev,
                      extraAddOnServiceId: e.target.value,
                    }))}
                    className="col-span-1 px-2 py-1 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
                  >
                    <option value="">{t('queue.quSelectAddOn')}</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name} · ${centsToDollars(service.priceCents)} · {service.durationMin}m
                      </option>
                    ))}
                  </select>
                  <select
                    value={completeServiceModal.extraAddOnStaffId}
                    onChange={(e) => setCompleteServiceModal((prev) => ({
                      ...prev,
                      extraAddOnStaffId: e.target.value,
                    }))}
                    className="px-2 py-1 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
                  >
                    <option value="">{t('queue.quAddOnStaff')}</option>
                    {staff
                      .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                      .map((s) => (
                        <option key={s.membershipId} value={s.membershipId}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-xs font-bold text-violet-700 border-violet-200 bg-violet-50 hover:bg-violet-100"
                    onClick={() => {
                      const selectedService = services.find(
                        (service) => service.id === completeServiceModal.extraAddOnServiceId,
                      );
                      const selectedStaff = staff.find(
                        (candidate) => candidate.membershipId === completeServiceModal.extraAddOnStaffId,
                      );
                      if (!selectedService || !selectedStaff || selectedStaff.membershipId === UNASSIGNED_STAFF_ID) {
                        toast.danger(t('queue.quAddOnStaffRequired'));
                        return;
                      }
                      setCompleteServiceModal((prev) => ({
                        ...prev,
                        extraAddOnServiceId: '',
                        addedAddOns: [
                          ...prev.addedAddOns,
                          {
                            idempotencyKey: crypto.randomUUID(),
                            serviceId: selectedService.id,
                            name: selectedService.name,
                            priceCents: selectedService.priceCents,
                            durationMin: selectedService.durationMin,
                            staffId: selectedStaff.membershipId,
                            staffName: selectedStaff.name,
                          },
                        ],
                      }));
                    }}
                    isDisabled={!completeServiceModal.extraAddOnServiceId || !completeServiceModal.extraAddOnStaffId}
                  >
                    {t('queue.quAddItem')}
                  </Button>
                </div>
              </div>

              {/* 包厢工位翻台清洁与技师跟进备注 */}
              <div className={completeServiceModal.roomId ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
                {completeServiceModal.roomId && (
                <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
                  <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={completeServiceModal.markRoomCleaning}
                      onChange={(e) => setCompleteServiceModal((prev) => ({ ...prev, markRoomCleaning: e.target.checked }))}
                      className="w-3.5 h-3.5 rounded text-violet-600"
                    />
                    <span>{t('queue.quReleaseStation')}</span>
                  </label>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {t('queue.quReleaseStationDesc')}
                  </p>
                </div>
                )}

                <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
                  <label className="block text-xs font-bold text-slate-800">
                    {t('queue.quSoapTitle')}
                  </label>
                  <Input
                    value={completeServiceModal.technicianNotes}
                    onChange={(e) => setCompleteServiceModal((prev) => ({ ...prev, technicianNotes: e.target.value }))}
                    placeholder={t('queue.quSoapPlaceholder')}
                    className="text-xs"
                  />
                </div>
              </div>

              {/* 账单应收总额合计 Bar */}
              <div className="flex items-center justify-between rounded-2xl bg-slate-900 p-3.5 text-white">
                <div>
                  <span className="block text-xs text-slate-400">
                    {t('queue.quFinishTotalBreakdown', {
                      p0: centsToDollars(item.priceCents),
                      p1: centsToDollars(addOnsTotalCents),
                    })}
                  </span>
                  <span className="font-mono text-xl font-bold text-teal-300">
                    ${centsToDollars(finalCalculatedCents)}
                  </span>
                </div>
                <Badge variant="secondary" className="bg-white/10 font-semibold text-teal-200">
                  {t('queue.quAwaitingPayment')}
                </Badge>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* 弹窗 4: [Open / Unpaid ➔ 收银完成] 前台收银结算 (多技师分工、包厢明细、加项提成、税费与手续费、小费拆分) */}
      {checkoutModal.isOpen && checkoutModal.item && (() => {
        const item = checkoutModal.item;
        const baseCents = item.priceCents || 0;

        /*
         * 渲染与提交共用同一份计算结果。
         * 此前两处各算各的，界面上的小费分账明细没有出口，前台看到的分配
         * 与技师实际拿到的提成对不上 —— 现在看到什么就发送什么。
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
          paymentMethod: checkoutModal.paymentMethod,
          tipMode: checkoutModal.tipMode,
          tipPercentage: checkoutModal.tipPercentage,
          totalTipDollars: checkoutModal.totalTipDollars,
          splitStrategy: checkoutModal.splitStrategy,
          customStaffTips: checkoutModal.customStaffTips,
        });
        const hasCard = checkoutModal.paymentMethod === 'card' || checkoutModal.paymentMethod === 'apple_pay';
        const tenderedCents = dollarsToCents(checkoutModal.tenderedDollars || '0');
        const rawChangeDue = Math.max(0, tenderedCents - totals.chargedTotalCents);
        const tipPresets = checkoutSettings?.suggestedTipPercentages?.length
          ? [0, ...checkoutSettings.suggestedTipPercentages]
          : [0, 15, 18, 20, 25];

        return (
          <Modal
            isOpen={checkoutModal.isOpen}
            onOpenChange={(open) => {
              if (!open) setCheckoutModal((prev) => ({ ...prev, isOpen: false, item: null }));
            }}
            title={
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <CreditCard className="h-5 w-5 text-emerald-600" />
                <span>{t('queue.quCoTitle')}</span>
              </div>
            }
            size="lg"
            footer={
              <div className="flex w-full justify-end gap-2">
                <Button
                  variant="secondary"
                  isDisabled={closeTicketMutation.isPending}
                  onPress={() => setCheckoutModal((prev) => ({ ...prev, isOpen: false, item: null }))}
                >
                  {t('queue.quCheckoutCancel')}
                </Button>
                <Button
                  className="gap-1 bg-teal-700 font-semibold text-white hover:bg-teal-800"
                  isDisabled={closeTicketMutation.isPending}
                  onPress={handleConfirmCheckout}
                >
                  {closeTicketMutation.isPending
                    ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
                    : <><Check className="h-4 w-4" />{t('queue.quCoConfirm', { p0: centsToDollars(totals.chargedTotalCents) })}</>}
                </Button>
              </div>
            }
          >
            <div className="space-y-3 py-1 text-sm text-slate-700">
              {/* 1. 客户与服务场地概览 */}
              <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-teal-700 text-sm font-semibold text-white">
                    {customerInitials(item.customerName)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-900">{item.customerName}</span>
                      <Badge variant="secondary">{item.serviceName}</Badge>
                    </div>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                      <BedDouble className="h-3.5 w-3.5 text-slate-400" />
                      <span>{item.roomName || t('queue.quCoUnassignedRoom')}</span>
                      <span aria-hidden>·</span>
                      <span>{t('queue.quCoTechCount', { p0: staffList.length })}</span>
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="block text-xs text-slate-500">{t('queue.quCoBaseSubtotal')}</span>
                  <span className="font-mono text-base font-bold text-slate-900">${centsToDollars(baseCents)}</span>
                </div>
              </div>

              {/* 2. 项目明细与多技师执行归属 */}
              <section className="rounded-2xl border border-slate-200 bg-white p-3">
                <h4 className="flex items-center justify-between font-semibold text-slate-800">
                  <span className="flex items-center gap-1.5">
                    <Scissors className="h-4 w-4 text-slate-400" />
                    <span>{t('queue.quCoExecTitle')}</span>
                  </span>
                  <span className="text-xs font-normal text-slate-500">
                    {t('queue.quCoItemCount', { p0: staffList.reduce((sum, staffShare) => sum + staffShare.items.length, 0) })}
                  </span>
                </h4>

                <div className="mt-2 space-y-2">
                  {staffList.map((staffShare) => (
                    <div key={staffShare.membershipId} className="rounded-xl border border-slate-100 bg-slate-50 p-2.5">
                      <div className="flex items-center gap-1.5 border-b border-slate-200/70 pb-1">
                        <User className="h-3.5 w-3.5 text-slate-400" />
                        <span className="font-semibold text-slate-800">{staffShare.name}</span>
                      </div>
                      <div className="mt-1 space-y-1">
                        {staffShare.items.map((lineItem, index) => (
                          <div key={`${staffShare.membershipId}-${index}`} className="flex items-center justify-between">
                            <span className="text-slate-700">{lineItem.name}</span>
                            <span className="font-mono font-semibold text-slate-900">${centsToDollars(lineItem.priceCents)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* 3. 小费分账 */}
              <section className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <h4 className="flex items-center gap-1.5 font-semibold text-slate-800">
                    <Award className="h-4 w-4 text-slate-400" />
                    <span>{t('queue.quCoTipTitle')}</span>
                  </h4>
                  {allowTipSplitOverride && (
                    <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
                      <button
                        type="button"
                        aria-pressed={checkoutModal.tipMode === 'total_split'}
                        onClick={() => setCheckoutModal((prev) => ({ ...prev, tipMode: 'total_split' }))}
                        className={cn(
                          'rounded-lg px-2 py-1 transition-colors',
                          checkoutModal.tipMode === 'total_split' ? 'bg-white font-semibold text-teal-800 shadow-sm' : 'text-slate-500',
                        )}
                      >
                        {t('queue.quCoTipModeSmart')}
                      </button>
                      <button
                        type="button"
                        aria-pressed={checkoutModal.tipMode === 'custom_per_staff'}
                        onClick={() => setCheckoutModal((prev) => ({ ...prev, tipMode: 'custom_per_staff' }))}
                        className={cn(
                          'rounded-lg px-2 py-1 transition-colors',
                          checkoutModal.tipMode === 'custom_per_staff' ? 'bg-white font-semibold text-teal-800 shadow-sm' : 'text-slate-500',
                        )}
                      >
                        {t('queue.quCoTipModeManual')}
                      </button>
                    </div>
                  )}
                </div>

                {!allowTipSplitOverride && (
                  <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                    {t('queue.quCoTipSplitLocked')}
                  </p>
                )}

                {checkoutModal.tipMode === 'total_split' ? (
                  <div className="mt-2 space-y-2">
                    <div className="grid grid-cols-5 gap-1.5">
                      {tipPresets.map((percent) => {
                        const tipAmount = centsToDollars(Math.round((totals.afterDiscountCents * percent) / 100));
                        const isSelected = checkoutModal.tipPercentage === percent && checkoutModal.totalTipDollars === '';
                        return (
                          <button
                            key={percent}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => setCheckoutModal((prev) => ({ ...prev, tipPercentage: percent, totalTipDollars: '' }))}
                            className={cn(
                              'rounded-lg border p-2 text-center transition-colors',
                              isSelected
                                ? 'border-teal-500 bg-teal-50 text-teal-900'
                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                            )}
                          >
                            <span className="block text-xs font-semibold">
                              {percent === 0 ? t('queue.quCoNoTip') : `${percent}%`}
                            </span>
                            <span className="block font-mono text-xs text-slate-500">${tipAmount}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label htmlFor="checkout-custom-tip" className="mb-1 block text-xs font-medium text-slate-600">
                          {t('queue.quCoCustomTip')}
                        </label>
                        <Input
                          id="checkout-custom-tip"
                          inputMode="decimal"
                          value={checkoutModal.totalTipDollars}
                          onChange={(e) => setCheckoutModal((prev) => ({ ...prev, totalTipDollars: e.target.value }))}
                          placeholder="0.00"
                          className="font-mono text-sm"
                        />
                      </div>
                      <div>
                        <label htmlFor="checkout-split-strategy" className="mb-1 block text-xs font-medium text-slate-600">
                          {t('queue.quCoSplitStrategy')}
                        </label>
                        <select
                          id="checkout-split-strategy"
                          value={checkoutModal.splitStrategy}
                          onChange={(e) => setCheckoutModal((prev) => ({ ...prev, splitStrategy: e.target.value as 'proportional' | 'equal' }))}
                          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                        >
                          <option value="proportional">{t('queue.quCoSplitProportional')}</option>
                          <option value="equal">{t('queue.quCoSplitEqual')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {staffList.map((staffShare) => (
                      <div key={staffShare.membershipId} className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <label htmlFor={`tip-${staffShare.membershipId}`} className="block text-xs font-semibold text-slate-800">
                          {staffShare.name}
                        </label>
                        <Input
                          id={`tip-${staffShare.membershipId}`}
                          inputMode="decimal"
                          value={checkoutModal.customStaffTips[staffShare.membershipId] || ''}
                          onChange={(e) => setCheckoutModal((prev) => ({
                            ...prev,
                            customStaffTips: { ...prev.customStaffTips, [staffShare.membershipId]: e.target.value },
                          }))}
                          placeholder="0.00"
                          className="h-8 font-mono text-sm"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* 分账预览 —— 与提交内容完全一致 */}
                <div className="mt-2 space-y-1 rounded-xl border border-teal-100 bg-teal-50/60 p-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-teal-900">
                    <span>{t('queue.quCoTipAllocation')}</span>
                    <span className="font-mono">{t('queue.quCoTotalTips', { p0: centsToDollars(totals.totalTipCents) })}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {totals.tipAllocations.map((allocation) => (
                      <div key={allocation.membershipId} className="flex items-center justify-between rounded-lg border border-teal-200 bg-white p-1.5 text-xs">
                        <span className="font-medium text-slate-800">{allocation.name}</span>
                        <span className="font-mono font-semibold text-teal-800">
                          +${centsToDollars(allocation.allocatedTipCents)} ({allocation.percent}%)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* 4. 税费与刷卡附加费 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5 rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={checkoutModal.enableTax}
                        onChange={(e) => setCheckoutModal((prev) => ({ ...prev, enableTax: e.target.checked }))}
                        className="h-4 w-4 rounded text-teal-600"
                      />
                      <span>{t('queue.quCoSalesTax')}</span>
                    </label>
                    <span className="font-mono font-semibold text-slate-700">+${centsToDollars(totals.taxCents)}</span>
                  </div>
                  {checkoutModal.enableTax && (
                    <div className="flex items-center gap-1.5 pt-1">
                      <label htmlFor="checkout-tax-rate" className="text-xs text-slate-500">{t('queue.quCoTaxRate')}</label>
                      <Input
                        id="checkout-tax-rate"
                        inputMode="decimal"
                        value={checkoutModal.taxRatePercent}
                        onChange={(e) => setCheckoutModal((prev) => ({ ...prev, taxRatePercent: e.target.value }))}
                        className="h-7 w-20 font-mono text-sm"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between">
                    <label className="flex cursor-pointer items-center gap-1.5 font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={checkoutModal.enableCardSurcharge}
                        onChange={(e) => setCheckoutModal((prev) => ({ ...prev, enableCardSurcharge: e.target.checked }))}
                        className="h-4 w-4 rounded text-teal-600"
                      />
                      <span>{t('queue.quCoCardSurcharge')}</span>
                    </label>
                    <span className="font-mono font-semibold text-slate-700">+${centsToDollars(totals.cardSurchargeCents)}</span>
                  </div>
                  {checkoutModal.enableCardSurcharge && (
                    <>
                      <div className="flex items-center gap-1 pt-1">
                        {['3.0', '3.5', '4.0'].map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            aria-pressed={checkoutModal.cardSurchargePercent === rate}
                            onClick={() => setCheckoutModal((prev) => ({ ...prev, cardSurchargePercent: rate }))}
                            className={cn(
                              'rounded-lg border px-2 py-0.5 text-xs font-medium transition-colors',
                              checkoutModal.cardSurchargePercent === rate
                                ? 'border-teal-600 bg-teal-600 text-white'
                                : 'border-slate-200 bg-white text-slate-600',
                            )}
                          >
                            {rate}%
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-slate-400">{t('queue.quCoSurchargeTipNotice')}</p>
                    </>
                  )}
                </div>
              </div>

              {/* 5. 费用核算汇总 */}
              <div className="space-y-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex justify-between text-slate-600">
                  <span>{t('queue.quCoSubtotalLine')}</span>
                  <span className="font-mono font-semibold text-slate-800">${centsToDollars(baseCents)}</span>
                </div>
                <div className="flex items-center justify-between text-slate-600">
                  <label htmlFor="checkout-discount">{t('queue.quCoDiscountLine')}</label>
                  <Input
                    id="checkout-discount"
                    inputMode="decimal"
                    value={checkoutModal.discountDollars}
                    onChange={(e) => setCheckoutModal((prev) => ({ ...prev, discountDollars: e.target.value }))}
                    className="h-7 w-24 text-right font-mono text-sm"
                    placeholder="0"
                  />
                </div>
                {checkoutModal.enableTax && (
                  <div className="flex justify-between text-slate-600">
                    <span>{t('queue.quCoTaxLine', { p0: checkoutModal.taxRatePercent })}</span>
                    <span className="font-mono font-semibold text-slate-800">+${centsToDollars(totals.taxCents)}</span>
                  </div>
                )}
                {checkoutModal.enableCardSurcharge && hasCard && (
                  <div className="flex justify-between text-slate-600">
                    <span>{t('queue.quCoSurchargeLine', { p0: checkoutModal.cardSurchargePercent })}</span>
                    <span className="font-mono font-semibold text-slate-800">+${centsToDollars(totals.cardSurchargeCents)}</span>
                  </div>
                )}
                <div className="flex items-end justify-between border-t border-slate-200 pt-1.5">
                  <span className="font-semibold text-slate-800">{t('queue.quCoTotalDue')}</span>
                  <span className="font-mono text-base font-bold text-slate-900">${centsToDollars(totals.totalDueCents)}</span>
                </div>
              </div>

              {/* 6. 收款方式 */}
              <div>
                <span className="mb-1.5 block font-medium text-slate-700">{t('queue.quCoPaymentMethod')}</span>
                <div className="grid grid-cols-4 gap-2">
                  {([
                    { id: 'card', labelKey: 'queue.quCoPayCard', icon: CreditCard },
                    { id: 'cash', labelKey: 'queue.quCoPayCash', icon: Coins },
                    { id: 'gift_card', labelKey: 'queue.quCoPayGiftCard', icon: Gift },
                    { id: 'apple_pay', labelKey: 'queue.quCoPayApplePay', icon: Wallet },
                  ] as const).map((method) => (
                    <button
                      key={method.id}
                      type="button"
                      aria-pressed={checkoutModal.paymentMethod === method.id}
                      onClick={() => setCheckoutModal((prev) => ({ ...prev, paymentMethod: method.id }))}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-lg border p-2 text-xs font-medium transition-colors',
                        checkoutModal.paymentMethod === method.id
                          ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      <method.icon className="h-4 w-4" />
                      <span>{t(method.labelKey)}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 现金找零与「不用找了」 */}
              {checkoutModal.paymentMethod === 'cash' && (
                <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="checkout-tendered" className="mb-1 block text-xs font-medium text-slate-600">
                        {t('queue.quCashReceived')}
                      </label>
                      <Input
                        id="checkout-tendered"
                        inputMode="decimal"
                        value={checkoutModal.tenderedDollars}
                        onChange={(e) => setCheckoutModal((prev) => ({ ...prev, tenderedDollars: e.target.value }))}
                        placeholder={t('queue.quAmountPlaceholder')}
                        className="font-mono text-sm"
                      />
                    </div>
                    <div>
                      <span className="mb-1 block text-xs font-medium text-slate-600">{t('queue.quCoChangeDue')}</span>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-sm font-semibold text-slate-900">
                        ${centsToDollars(checkoutModal.keepChange ? 0 : rawChangeDue)}
                      </div>
                    </div>
                  </div>
                  {rawChangeDue > 0 && (
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <input
                        type="checkbox"
                        checked={checkoutModal.keepChange}
                        onChange={(e) => setCheckoutModal((prev) => ({ ...prev, keepChange: e.target.checked }))}
                        className="h-4 w-4 rounded text-teal-600"
                      />
                      <span className="text-xs font-medium text-slate-800">
                        {t('queue.quCoKeepChange', { p0: centsToDollars(rawChangeDue) })}
                      </span>
                    </label>
                  )}
                </div>
              )}

              {/* Gift Card 核验 */}
              {checkoutModal.paymentMethod === 'gift_card' && (
                <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
                  <label htmlFor="checkout-gift-card" className="block text-xs font-medium text-slate-600">
                    {t('queue.quEnterGiftCard')}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="checkout-gift-card"
                      value={checkoutModal.giftCardCode}
                      onChange={(e) => setCheckoutModal((prev) => ({
                        ...prev,
                        giftCardCode: e.target.value,
                        giftCardId: '',
                        giftCardVerified: false,
                      }))}
                      placeholder="GF-GC-XXXX"
                      className="font-mono text-sm"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={!checkoutModal.giftCardCode.trim() || checkoutModal.isVerifyingGiftCard}
                      onPress={async () => {
                        setCheckoutModal((prev) => ({ ...prev, isVerifyingGiftCard: true }));
                        try {
                          const res = await verifyGiftCard(checkoutModal.giftCardCode.trim());
                          if (res.valid) {
                            setCheckoutModal((prev) => ({
                              ...prev,
                              giftCardVerified: true,
                              giftCardId: res.giftCardId,
                              giftCardCode: res.code,
                              giftCardBalanceCents: res.balanceCents,
                            }));
                            toast.success(t('queue.quGiftCardValid', { p0: centsToDollars(res.balanceCents) }));
                          } else {
                            toast.danger(t('queue.quGiftCardInvalid'));
                          }
                        } catch (err: any) {
                          toast.danger(errorMessage(err));
                        } finally {
                          setCheckoutModal((prev) => ({ ...prev, isVerifyingGiftCard: false }));
                        }
                      }}
                      className="shrink-0 text-sm font-semibold"
                    >
                      {checkoutModal.isVerifyingGiftCard ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('queue.quVerifyCard')}
                    </Button>
                  </div>
                  {checkoutModal.giftCardVerified && (
                    <div className="flex justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs font-medium text-emerald-800">
                      <span>{t('queue.quGiftCardVerified')}</span>
                      <span className="font-mono">{t('queue.quCoGiftCardBalance', { p0: centsToDollars(checkoutModal.giftCardBalanceCents) })}</span>
                    </div>
                  )}
                </div>
              )}

              {/* 最终结算总额 */}
              <div className="flex items-center justify-between rounded-2xl bg-slate-900 p-3.5 text-white">
                <div>
                  <span className="block text-xs text-slate-400">
                    {t('queue.quCoChargedBreakdown', {
                      p0: centsToDollars(totals.totalDueCents),
                      p1: centsToDollars(totals.totalTipCents),
                    })}
                  </span>
                  <span className="font-mono text-xl font-bold text-emerald-400">
                    ${centsToDollars(totals.chargedTotalCents)}
                  </span>
                </div>
                <Badge variant="secondary" className="bg-white/10 font-semibold text-emerald-300">
                  {t(PAYMENT_METHOD_LABEL_KEYS[checkoutModal.paymentMethod])}
                </Badge>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* 弹窗 5: [反向回退] 风险警告与原因备注登记 */}
      {rollbackModal.isOpen && rollbackModal.item && rollbackModal.fromStage && rollbackModal.toStage && (
        <Modal
          isOpen={rollbackModal.isOpen}
          onOpenChange={(open) => {
            if (!open) setRollbackModal((prev) => ({ ...prev, isOpen: false, item: null, fromStage: null, toStage: null }));
          }}
          title={
            <div className="flex items-center gap-2 text-rose-600 font-bold">
              <ShieldAlert className="w-5 h-5" />
              <span>{t('queue.quRollbackTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button
                variant="secondary"
                onClick={() => setRollbackModal((prev) => ({ ...prev, isOpen: false, item: null, fromStage: null, toStage: null }))}
              >
                {t('queue.quRollbackCancel')}
              </Button>
              <Button
                className={DANGER_ACTION_CLASS}
                isDisabled={rollbackStageMutation.isPending}
                onPress={handleConfirmRollback}
              >
                {rollbackStageMutation.isPending
                  ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
                  : <><ArrowLeft className="h-4 w-4" />{t('queue.quRollbackConfirmTo', { p0: t(STAGE_NAME_KEYS[rollbackModal.toStage]) })}</>}
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 py-2 text-xs text-slate-700">
            {/* 顾客与回退流转路径 */}
            <div className="p-3 bg-rose-50 rounded-2xl border border-rose-200 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-rose-950 text-sm">{rollbackModal.item.customerName}</span>
                <Badge variant="error" className="text-xs font-bold">{t('queue.quRollbackOperationBadge')}</Badge>
              </div>
              <div className="flex items-center gap-2 font-mono text-xs font-bold text-rose-800">
                <span className="p-1 bg-white rounded-lg border border-rose-200">{t(STAGE_NAME_KEYS[rollbackModal.fromStage])}</span>
                <ArrowLeft className="w-3.5 h-3.5 text-rose-600" />
                <span className="p-1 bg-rose-100 rounded-lg border border-rose-300 text-rose-950">{t(STAGE_NAME_KEYS[rollbackModal.toStage])}</span>
              </div>
              <p className="text-xs text-rose-700 leading-relaxed pt-1">
                {rollbackModal.fromStage === 'ready_checkout' && rollbackModal.toStage === 'in_service' && (
                  <span>{t('queue.quRollbackWarnService')}</span>
                )}
                {rollbackModal.fromStage === 'in_service' && rollbackModal.toStage === 'waiting' && (
                  <span>{t('queue.quRollbackWarnWaiting')}</span>
                )}
                {rollbackModal.fromStage === 'waiting' && rollbackModal.toStage === 'booked' && (
                  <span>{t('queue.quRollbackWarnBooked')}</span>
                )}
                {!['ready_checkout->in_service', 'in_service->waiting', 'waiting->booked'].includes(`${rollbackModal.fromStage}->${rollbackModal.toStage}`) && (
                  <span>{t('queue.quRollbackAudit')}</span>
                )}
              </p>
            </div>

            {/* 回退原因单选 */}
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-800">{t('queue.quRollbackReasonLabel')}</label>
              <div className="space-y-1.5">
                {ROLLBACK_REASONS.map((r) => (
                  <label
                    key={r.id}
                    className={cn(
                      'flex items-center gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all text-xs font-medium',
                      rollbackModal.reason === r.id
                        ? 'border-rose-400 bg-rose-50/60 text-rose-950 font-bold ring-1 ring-rose-300'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700',
                    )}
                  >
                    <input
                      type="radio"
                      name="rollbackReason"
                      value={r.id}
                      checked={rollbackModal.reason === r.id}
                      onChange={() => setRollbackModal((prev) => ({ ...prev, reason: r.id }))}
                      className="text-rose-600 focus:ring-rose-500/20"
                    />
                    <span>{t(r.labelKey)}</span>
                  </label>
                ))}
              </div>
            </div>

            {/*
              资源释放由服务端在回退时一并处理，前台没有开关可选 ——
              此前这里是一个复选框，勾与不勾结果完全相同，现改为如实说明。
            */}
            <p className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">
              {t('queue.quRollbackResourceNotice')}
            </p>

            {/* 具体备注说明 */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1">{t('queue.quRollbackNoteLabel')}</label>
              <Input
                value={rollbackModal.notes}
                onChange={(e) => setRollbackModal((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder={t('queue.quRollbackNotePlaceholder')}
                className="text-xs"
              />
            </div>
          </div>
        </Modal>
      )}

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
