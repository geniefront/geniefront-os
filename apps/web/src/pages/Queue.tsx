import { useState, useMemo } from 'react';
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
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { useSchedule, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import {
  useJoinQueue, useQueue, useRollbackQueueStage, useUpdateQueueEntry,
} from '@/features/queue/api';
import {
  useAddTicketItem, useFinishTicketItem, useOpenTicket, useStartTicketItem, useTicketsList,
} from '@/features/tickets/api';
import { useCloseTicket, centsToDollars, dollarsToCents, verifyGiftCard } from '@/features/checkout/api';
import { useRoomsQuery, useSetResourceStatus } from '@/features/rooms/api';
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
import { cn, formatI18n } from '@/lib/utils';
import type { TranslationKey } from '@/i18n';
import { useShareForm, type FormShareResult } from '@/features/forms/api';

/** 回退反向流转原因映射 */
const ROLLBACK_REASONS = [
  { id: 'entry_error', label: 'Front desk error / Wrong item' },
  { id: 'customer_extend', label: 'Guest added service / Extended time' },
  { id: 'change_staff', label: 'Guest requested change of staff/room' },
  { id: 'staff_emergency', label: 'Staff emergency / Reassignment' },
  { id: 'other', label: 'Other reason' },
] as const;

/** 身体禁忌排查标签 */
export const CONTRAINDICATION_TAGS = [
  'No specific contraindications',
  'Essential oil allergy',
  'Hypertension / Heart condition',
  'Pregnancy / Nursing',
  'Skin irritation / Wounds',
  'Spinal / Neck injury history',
  'Recent cosmetic surgery',
];

/** 重点加压护理部位 */
export const FOCUS_AREA_TAGS = [
  'Head / Temples',
  'Back of Neck',
  'Left Shoulder',
  'Right Shoulder',
  'Left Lower Back',
  'Right Lower Back',
  'Upper & Mid Back',
  'Left Foot & Arch',
  'Right Foot & Arch',
];

/** 避免触碰敏感部位 */
export const AVOID_AREA_TAGS = [
  'No areas to avoid',
  'Face',
  'Throat / Anterior Neck',
  'Spine Midline',
  'Varicose Veins',
  'Surgical Scars',
  'Left Knee',
  'Right Knee',
];

/** 芳香精油选项 */
export const AROMA_OIL_OPTIONS = [
  { id: 'none_pref', label: 'No Preference', desc: '技师推荐' },
  { id: 'unscented', label: 'Unscented Carrier Oil', desc: '天然温和' },
  { id: 'lavender', label: '薰衣草', desc: '助眠安神' },
  { id: 'eucalyptus', label: '尤加利', desc: '畅通呼吸' },
  { id: 'sweet_orange', label: '甜橙活力', desc: '愉悦抗疲' },
  { id: 'ginger', label: '生姜暖体', desc: '祛湿温经' },
];

/** 按摩力度选项 */
export const STRENGTH_OPTIONS = [
  { id: 'none', label: 'No Preference' },
  { id: 'light', label: 'Gentle & Relaxing' },
  { id: 'medium', label: 'Medium Pressure' },
  { id: 'deep', label: 'Deep Tissue' },
  { id: 'trigger', label: 'Trigger Point' },
];

export type KanbanStage = 'booked' | 'waiting' | 'in_service' | 'ready_checkout' | 'completed';

export const STAGE_ORDER: KanbanStage[] = ['booked', 'waiting', 'in_service', 'ready_checkout', 'completed'];

export const STAGE_NAMES: Record<KanbanStage, string> = {
  booked: '待到店 (预约)',
  waiting: '候客区 (已到店)',
  in_service: '服务中 (进行中)',
  ready_checkout: 'Open / Unpaid (待收银)',
  completed: 'Completed (已收银)',
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
  title: string;
  subtitle: string;
  color: string;
  headerBg: string;
  badgeVariant: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'error' | 'destructive';
  icon: typeof CalendarDays;
  dropEffectTitle: string;
}

const COLUMNS: ColumnConfig[] = [
  {
    id: 'booked',
    title: '今日预约 / 待到店',
    subtitle: '今日已排期，等待到店签到',
    color: 'border-sky-300 text-sky-700 bg-sky-50/50',
    headerBg: 'bg-sky-50 text-sky-800 border-sky-200',
    badgeVariant: 'secondary',
    icon: CalendarDays,
    dropEffectTitle: '待到店',
  },
  {
    id: 'waiting',
    title: '已到店 / 候客区',
    subtitle: '现场等候安排技师与工位',
    color: 'border-amber-300 text-amber-700 bg-amber-50/50',
    headerBg: 'bg-amber-50 text-amber-800 border-amber-200',
    badgeVariant: 'warning',
    icon: Clock,
    dropEffectTitle: '候客区',
  },
  {
    id: 'in_service',
    title: '服务中 / 进行中',
    subtitle: '技师正在服务中',
    color: 'border-teal-300 text-teal-700 bg-teal-50/50',
    headerBg: 'bg-teal-50 text-teal-800 border-teal-200',
    badgeVariant: 'success',
    icon: Scissors,
    dropEffectTitle: '服务中',
  },
  {
    id: 'ready_checkout',
    title: 'Open / Unpaid / 待收银',
    subtitle: '服务完成，等Open / Unpaid出票',
    color: 'border-purple-300 text-purple-700 bg-purple-50/50',
    headerBg: 'bg-purple-50 text-purple-800 border-purple-200',
    badgeVariant: 'default',
    icon: CreditCard,
    dropEffectTitle: 'Open / Unpaid',
  },
  {
    id: 'completed',
    title: '今日已结 / Completed',
    subtitle: '今日Completed结账单据',
    color: 'border-slate-300 text-slate-700 bg-slate-50/50',
    headerBg: 'bg-slate-100 text-slate-800 border-slate-200',
    badgeVariant: 'outline',
    icon: CheckCircle2,
    dropEffectTitle: 'Completed',
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

  const { services, staff, items, currentDate, isLoading: scheduleLoading, refetch: refetchSchedule } = useSchedule();
  const { data: queue, isLoading: queueLoading, isError: queueError, error: queueErr, isFetching: queueFetching, refetch: refetchQueue } = useQueue();
  const { data: ticketsData, isLoading: ticketsLoading, refetch: refetchTickets } = useTicketsList();
  const { data: roomsData, isLoading: roomsLoading, refetch: refetchRooms } = useRoomsQuery();
  const { data: rotationData, isLoading: rotationLoading, refetch: refetchRotation } = useRotationQuery();
  const closeTicketMutation = useCloseTicket();
  const openTicketMutation = useOpenTicket();
  const addTicketItemMutation = useAddTicketItem();
  const startTicketItemMutation = useStartTicketItem();
  const finishTicketItemMutation = useFinishTicketItem();
  const setResourceStatusMutation = useSetResourceStatus();
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
    return rotationEntries.slice(0, 3);
  }, [rotationEntries]);

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
    contraindications: ['No specific contraindications'],
    massageStrength: 'Medium Pressure',
    aromaOil: 'No Preference',
    focusAreas: [],
    avoidAreas: ['No areas to avoid'],
    selectedAddOnId: '',
    addOnStaffId: '',
    notes: '',
  });

  // 2. Start Service Modal (Step 2 -> Step 3: Waiting -> In Service)
  const [startServiceModal, setStartServiceModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    staffId: string;
    roomId: string;
    startTime: string;
    serviceDurationMin: number;
    requireBriefingAck: boolean;
  }>({
    isOpen: false,
    item: null,
    staffId: '',
    roomId: '',
    startTime: '',
    serviceDurationMin: 60,
    requireBriefingAck: true,
  });

  // 3. Complete Service Modal (Step 3 -> Step 4: In Service -> Ready Checkout)
  const [completeServiceModal, setCompleteServiceModal] = useState<{
    isOpen: boolean;
    item: KanbanItem | null;
    actualDurationMin: number;
    extraAddOnServiceId: string;
    extraAddOnStaffId: string;
    addedAddOns: AddOnItem[];
    markRoomCleaning: boolean;
    technicianNotes: string;
  }>({
    isOpen: false,
    item: null,
    actualDurationMin: 60,
    extraAddOnServiceId: '',
    extraAddOnStaffId: '',
    addedAddOns: [],
    markRoomCleaning: false,
    technicianNotes: '',
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
    releaseResources: boolean;
    notes: string;
  }>({
    isOpen: false,
    item: null,
    fromStage: null,
    toStage: null,
    reason: 'entry_error',
    releaseResources: true,
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
    openAppointment?.(item.appointmentId || item.id, drawerStatus);
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
          phone: q.phoneDisplay,
          serviceName: q.serviceName || '常规服务',
          serviceId: q.serviceId,
          durationMin: 45,
          priceCents: 0,
          staffName: override?.staffName || q.staffName,
          staffId: override?.staffId || q.staffId,
          roomId: override?.roomId,
          roomName: override?.roomName,
          isRequest: false,
          timeDisplay: `已等候 ${q.waitedMin}m`,
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
          phone: q.phoneDisplay,
          serviceName: q.serviceName || '常规服务',
          serviceId: q.serviceId,
          durationMin: 45,
          priceCents: 0,
          staffName: override?.staffName || q.staffName,
          staffId: override?.staffId || q.staffId,
          roomId: override?.roomId,
          roomName: override?.roomName,
          isRequest: false,
          timeDisplay: `已叫号 (${q.waitedMin}m)`,
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
          phone: q.phoneDisplay,
          serviceName: q.serviceName || '服务中项目',
          serviceId: q.serviceId,
          durationMin: 60,
          priceCents: 0,
          staffName: override?.staffName || q.staffName,
          staffId: override?.staffId || q.staffId,
          roomId: override?.roomId,
          roomName: override?.roomName,
          isRequest: false,
          timeDisplay: '服务中',
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
          : '待分配技师';

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
          roomId: override?.roomId,
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
          roomId: override?.roomId,
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
          staffName: matchedStaff?.name || '技师',
          staffColor: matchedStaff?.color ?? null,
          isRequest: it.isRequest,
          timeDisplay: `已完工 (${it.endTime})`,
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
          customerName: formatI18n(tk.customerName, language) || '到店顾客',
          serviceName: tkItems.map((i: any) => formatI18n(i.name, language)).join(', ') || '综合消费',
          durationMin: tkItems.reduce((acc: number, i: any) => acc + (i.durationMin || 0), 0),
          priceCents: asCents(tk.subtotalCents ?? 0),
          staffName: formatI18n(tkItems[0]?.staffName, language),
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
    || finishTicketItemMutation.isPending || setResourceStatusMutation.isPending
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
      setRollbackModal({
        isOpen: true,
        item,
        fromStage: item.stage,
        toStage: targetStage,
        reason: 'entry_error',
        releaseResources: true,
        notes: '',
      });
      return;
    }

    // 2. 跨阶段跳步拦截 (Cannot skip steps)
    if (targetIndex > sourceIndex + 1) {
      toast.danger(t('queue.quNoStageSkip'), {
        description: t('queue.quStageOrder', { p0: STAGE_NAMES[item.stage], p1: STAGE_NAMES[STAGE_ORDER[sourceIndex + 1]] }),
      });
      return;
    }

    // 3. 正向单步流转 (Forward Step 1 -> 2 -> 3 -> 4 -> 5)
    if (item.stage === 'booked' && targetStage === 'waiting') {
      // 预约 ➔ 到店：弹窗确认用户信息、健康问卷二维码、现场加项与按摩偏好
      setCheckInModal({
        isOpen: true,
        item,
        qrScanned: false,
        contraindications: ['No specific contraindications'],
        massageStrength: 'Medium Pressure',
        aromaOil: 'No Preference',
        focusAreas: [],
        avoidAreas: ['No areas to avoid'],
        selectedAddOnId: '',
        addOnStaffId: item.staffId || '',
        notes: item.notes || '',
      });
    } else if (item.stage === 'waiting' && targetStage === 'in_service') {
      // 到店 ➔ 服务：弹窗指定技师与房间/工位
      const defaultStaff = item.staffId && item.staffId !== UNASSIGNED_STAFF_ID
        ? item.staffId
        : staff.find((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)?.membershipId || '';
      
      const availableRoom = rooms.find((r) => r.status === 'available')?.id || rooms[0]?.id || '';
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      setStartServiceModal({
        isOpen: true,
        item,
        staffId: defaultStaff,
        roomId: availableRoom,
        startTime: timeStr,
        serviceDurationMin: item.durationMin || 60,
        requireBriefingAck: true,
      });
    } else if (item.stage === 'in_service' && targetStage === 'ready_checkout') {
      // 服务 ➔ 结账：弹窗核对服务项目明细与中途加项记录
      setCompleteServiceModal({
        isOpen: true,
        item,
        actualDurationMin: item.durationMin || 60,
        extraAddOnServiceId: '',
        extraAddOnStaffId: item.rawTicket?.items[0]?.membershipId || item.staffId || '',
        addedAddOns: [],
        markRoomCleaning: false,
        technicianNotes: '',
      });
    } else if (item.stage === 'ready_checkout' && targetStage === 'completed') {
      // 结账 ➔ 收银：弹窗录入支付方式、小费与Amount结算
      setCheckoutModal({
        isOpen: true,
        item,
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
        tenderedDollars: centsToDollars(item.priceCents),
        keepChange: false,
        giftCardCode: '',
        giftCardVerified: false,
        giftCardBalanceCents: 0,
        isVerifyingGiftCard: false,
      });
    }
  };

  // 1. Check-In Confirm Submit
  const handleConfirmCheckIn = async () => {
    const {
      item,
      selectedAddOnId,
      contraindications,
      massageStrength,
      aromaOil,
      focusAreas,
      avoidAreas,
      notes,
    } = checkInModal;
    if (!item) return;

    const addOnService = services.find((s) => s.id === selectedAddOnId);

    const contraStr = contraindications.filter((c) => c !== 'No specific contraindications').join('、');
    const focusStr = focusAreas.join('、');
    const avoidStr = avoidAreas.filter((a) => a !== 'No areas to avoid').join('、');
    const oilObj = AROMA_OIL_OPTIONS.find((o) => o.id === aromaOil);

    const parts: string[] = [];
    if (contraStr) parts.push(`【禁忌: ${contraStr}】`);
    if (avoidStr) parts.push(`【避开: ${avoidStr}】`);
    if (focusStr) parts.push(`【重点: ${focusStr}】`);
    if (massageStrength !== 'No Preference') parts.push(`【力度: ${massageStrength}】`);
    if (oilObj && oilObj.id !== 'none_pref') parts.push(`【精油: ${oilObj.label}】`);
    if (notes.trim()) parts.push(notes.trim());
    if (addOnService) parts.push(`[加项: ${addOnService.name}]`);

    const extraNotes = parts.join(' ');

    try {
      const hasUnpersistedDetails = Boolean(
        addOnService || extraNotes || focusAreas.length > 0
        || contraindications.some((value) => value !== 'No specific contraindications')
        || avoidAreas.some((value) => value !== 'No areas to avoid')
        || massageStrength !== 'Medium Pressure'
        || (oilObj && oilObj.id !== 'none_pref'),
      );
      if (hasUnpersistedDetails) {
        toast.danger(t('queue.quCheckInDetailsUnavailable'));
        return;
      }
      if (item.stage === 'booked' && item.appointmentId) {
        await join.mutateAsync({
          appointmentId: item.appointmentId,
          walkInName: item.customerName,
          requestedServiceId: item.serviceId || null,
          requestedStaffId: item.staffId === UNASSIGNED_STAFF_ID ? null : item.staffId || null,
        });
      }

      setCheckInModal((prev) => ({ ...prev, isOpen: false, item: null }));
      toast.success(t('queue.quCheckedIn', { p0: item.customerName }));
      await Promise.all([refetchQueue(), refetchSchedule()]);
    } catch (err: any) {
      toast.danger(t('queue.quCheckInFailed') + (err?.message || t('queue.quNetworkError')));
    }
  };

  // 2. Start Service Confirm Submit
  const handleConfirmStartService = async () => {
    const { item, staffId, roomId, startTime, serviceDurationMin } = startServiceModal;
    if (!item) return;

    const assignedStaff = staff.find((s) => s.membershipId === staffId);
    const assignedRoom = rooms.find((r) => r.id === roomId);

    try {
      if (!staffId || staffId === UNASSIGNED_STAFF_ID || !item.serviceId) {
        toast.danger(t('queue.quSeatFailed'));
        return;
      }

      let ticketItemIds = item.rawTicket?.items
        .filter((ticketItem) => !ticketItem.startedAt)
        .map((ticketItem) => ticketItem.ticketItemId) ?? [];
      if (!item.ticketId) {
        const appointmentItems = item.rawQueue?.items ?? [];
        const itemsToOpen = appointmentItems.length > 0
          ? appointmentItems.map((appointmentItem) => ({
              serviceId: appointmentItem.serviceId,
              membershipId: appointmentItem.staffId ?? staffId,
              minutes: appointmentItem.durationMin,
            }))
          : [{
              serviceId: item.serviceId,
              membershipId: staffId,
              minutes: serviceDurationMin,
            }];
        const opened = await openTicketMutation.mutateAsync({
          customerId: item.rawQueue?.customerId ?? null,
          ...(item.rawQueue?.customerId ? {} : { walkInName: item.customerName }),
          ...(item.appointmentId ? { appointmentId: item.appointmentId } : {}),
          items: itemsToOpen,
          idempotencyKey: `queue-start-${item.appointmentId ?? item.queueId ?? item.id}`,
        });
        ticketItemIds = opened.ticketItemIds;
      }

      for (const ticketItemId of ticketItemIds) {
        await startTicketItemMutation.mutateAsync({ ticketItemId, membershipId: staffId });
      }
      if (item.queueId) {
        await update.mutateAsync({ queueId: item.queueId, status: 'seated' });
      }
      if (roomId) {
        await setResourceStatusMutation.mutateAsync({
          resourceId: roomId,
          status: 'in_service',
          guestName: item.customerName,
          serviceName: item.serviceName,
        });
      }

      setStartServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
      toast.success(t('queue.quSeated', { p0: item.customerName }), {
        description: t('queue.quSeatedDetail', { p0: assignedStaff?.name || '已指派', p1: assignedRoom?.name || '指定房间', p2: startTime, p3: serviceDurationMin }),
      });
      await Promise.all([refetchQueue(), refetchTickets(), refetchSchedule(), refetchRooms()]);
    } catch (err: any) {
      toast.danger(t('queue.quSeatFailed') + (err?.message || t('queue.quNetworkError2')));
    }
  };

  // 3. Complete Service Confirm Submit
  const handleConfirmCompleteService = async () => {
    const { item, addedAddOns, technicianNotes, markRoomCleaning } = completeServiceModal;
    if (!item) return;

    try {
      if (technicianNotes.trim() || markRoomCleaning || !item.rawTicket) {
        toast.danger(t('queue.quFinishFailed'));
        return;
      }
      const addedTicketItems: Array<{ ticketItemId: string; membershipId: string }> = [];
      let finalSubtotalCents = item.rawTicket.subtotalCents;
      for (const addOn of addedAddOns) {
        const added = await addTicketItemMutation.mutateAsync({
          ticketId: item.rawTicket.ticketId,
          serviceId: addOn.serviceId,
          membershipId: addOn.staffId,
          kind: 'addon',
          minutes: addOn.durationMin,
          idempotencyKey: addOn.idempotencyKey,
        });
        finalSubtotalCents = added.subtotalCents;
        addedTicketItems.push({ ticketItemId: added.ticketItemId, membershipId: addOn.staffId });
      }
      const unfinished = [
        ...item.rawTicket.items
          .filter((ticketItem) => !ticketItem.finishedAt)
          .map((ticketItem) => ({
            ticketItemId: ticketItem.ticketItemId,
            membershipId: ticketItem.membershipId,
          })),
        ...addedTicketItems,
      ];
      let actualMinutes = 0;
      for (const ticketItem of unfinished) {
        if (addedTicketItems.some((added) => added.ticketItemId === ticketItem.ticketItemId)) {
          await startTicketItemMutation.mutateAsync({
            ticketItemId: ticketItem.ticketItemId,
            membershipId: ticketItem.membershipId,
          });
        }
        const finished = await finishTicketItemMutation.mutateAsync({
          ticketItemId: ticketItem.ticketItemId,
          membershipId: ticketItem.membershipId,
        });
        actualMinutes += finished.actualMinutes;
      }

      setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
      toast.success(t('queue.quServiceDone', { p0: item.customerName }), {
        description: t('queue.quServiceDoneDetail', { p0: actualMinutes, p1: centsToDollars(finalSubtotalCents) }),
      });
      await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms()]);
    } catch (err: any) {
      toast.danger(t('queue.quFinishFailed') + (err?.message || t('queue.quNetworkError2')));
    }
  };

  // 4. Checkout Tender Confirm Submit
  const handleConfirmCheckout = async () => {
    const {
      item,
      discountDollars,
      enableTax,
      taxRatePercent,
      enableCardSurcharge,
      cardSurchargePercent,
      tipMode,
      tipPercentage,
      totalTipDollars,
      customStaffTips,
      paymentMethod,
      tenderedDollars,
      keepChange,
    } = checkoutModal;
    if (!item) return;

    const baseCents = item.priceCents || 0;
    const discountCents = dollarsToCents(discountDollars || '0');
    const afterDiscountCents = Math.max(0, baseCents - discountCents);
    const taxCents = enableTax
      ? Math.round(afterDiscountCents * (parseFloat(taxRatePercent || '0') / 100))
      : 0;

    let tipCents = 0;
    if (tipMode === 'total_split') {
      tipCents = totalTipDollars !== ''
        ? dollarsToCents(totalTipDollars)
        : Math.round((afterDiscountCents * tipPercentage) / 100);
    } else {
      tipCents = Object.values(customStaffTips).reduce(
        (sum, val) => sum + Math.max(0, dollarsToCents(val || '0')),
        0,
      );
    }

    const cardSurchargeCents =
      enableCardSurcharge && (paymentMethod === 'card' || paymentMethod === 'apple_pay')
        ? Math.round(
            (afterDiscountCents + taxCents + tipCents) *
              (parseFloat(cardSurchargePercent || '0') / 100),
          )
        : 0;

    let finalTotalCents = afterDiscountCents + taxCents + cardSurchargeCents + tipCents;

    try {
      if (!item.ticketId) {
        toast.danger(t('queue.quCheckoutFailed'));
        return;
      }
      const isCash = paymentMethod === 'cash';
      const tenderedCents = isCash ? dollarsToCents(tenderedDollars || '0') : undefined;
      if (tenderedCents !== undefined && tenderedCents < finalTotalCents) {
        toast.danger(t('queue.quCheckoutFailed'));
        return;
      }
      const cashRemainder = tenderedCents === undefined ? 0 : tenderedCents - finalTotalCents;
      if (isCash && keepChange && cashRemainder > 0) {
        tipCents += cashRemainder;
        finalTotalCents += cashRemainder;
      }
      const customTipSplits = tipMode === 'custom_per_staff'
        ? Object.entries(customStaffTips)
            .map(([staffMembershipId, value]) => ({
              staffMembershipId,
              amountCents: Math.max(0, dollarsToCents(value || '0')),
            }))
            .filter((split) => split.amountCents > 0)
        : [];
      if (tipMode === 'custom_per_staff' && tipCents > 0 && customTipSplits.length === 0) {
        toast.danger(t('queue.quCheckoutFailed'));
        return;
      }
      if (customTipSplits.length > 0) {
        const assigned = customTipSplits.reduce((sum, split) => sum + split.amountCents, 0);
        const remainder = tipCents - assigned;
        if (remainder < 0) {
          toast.danger(t('queue.quCheckoutFailed'));
          return;
        }
        if (remainder > 0) customTipSplits[0]!.amountCents += remainder;
      }

      await closeTicketMutation.mutateAsync({
        ticketId: item.ticketId,
        discountCents,
        taxCents,
        surchargeCents: cardSurchargeCents,
        ...(customTipSplits.length > 0 ? { tipSplits: customTipSplits } : {}),
        payments: [
          {
            method: paymentMethod === 'apple_pay' ? 'card' : paymentMethod,
            amountCents: finalTotalCents,
            tipCents,
            ...(tenderedCents !== undefined ? { tenderedCents } : {}),
            changeCents: isCash && !keepChange ? cashRemainder : 0,
            keepChange: Boolean(isCash && keepChange),
          },
        ],
      });

      setCheckoutModal({
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
        giftCardVerified: false,
        giftCardBalanceCents: 0,
        isVerifyingGiftCard: false,
      });

      toast.success(t('queue.quCheckoutDone', { p0: item.customerName }), {
        description: t('queue.quCheckoutDetail', { p0: centsToDollars(finalTotalCents), p1: paymentMethod.toUpperCase() }),
      });

      await Promise.all([refetchTickets(), refetchSchedule(), refetchRooms(), refetchQueue()]);
    } catch (err: any) {
      toast.danger(t('queue.quCheckoutFailed') + (err?.message || t('queue.quNetworkError3')));
    }
  };

  // 5. Reverse Rollback Confirm Submit
  const handleConfirmRollback = async () => {
    const { item, toStage, reason, notes } = rollbackModal;
    if (!item || !toStage) return;
    if (!item.appointmentId || toStage === 'ready_checkout' || toStage === 'completed') {
      toast.danger(t('queue.quRollbackUnavailable'));
      return;
    }
    const fromStage = item.stage === 'ready_checkout' ? 'ready_to_pay'
      : item.stage === 'completed' ? 'completed'
      : item.stage;
    try {
      await rollbackStageMutation.mutateAsync({
        appointmentId: item.appointmentId,
        ...(item.queueId ? { queueId: item.queueId } : {}),
        fromStage: fromStage === 'booked' ? 'checked_in' : fromStage,
        targetStage: toStage,
        reason: reason === 'customer_extend' ? 'customer_delayed'
          : reason === 'staff_emergency' ? 'service_restart'
          : reason === 'entry_error' ? 'wrong_drag' : 'other',
        ...(notes ? { notes } : {}),
      });
      setRollbackModal({ isOpen: false, item: null, fromStage: null, toStage: null, reason: 'entry_error', releaseResources: true, notes: '' });
      toast.warning(t('queue.quRolledBack', { p0: item.customerName, p1: STAGE_NAMES[toStage] }), {
        description: t('queue.quRollbackReason', { p0: ROLLBACK_REASONS.find(r => r.id === reason)?.label ?? '' }),
      });
      await Promise.all([refetchQueue(), refetchSchedule(), refetchTickets()]);
    } catch (err: any) {
      toast.danger(t('queue.quRollbackUnavailable') + (err?.message || t('queue.quNetworkError2')));
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
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2.5">
            <Sparkles className="w-6 h-6 text-teal-600" />
            <span>{t('queue.quTitle')}</span>
          </h1>
          {isSyncing && <Spinner size="sm" className="w-4 h-4 text-teal-600 ml-1" />}
        </div>

        {/* 顶部核心指标与状态药丸卡片组（同高整齐排布） */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* 轮牌前三技师卡片 */}
          <div className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5">
            <Clock className="w-4 h-4 text-teal-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-[10px]">{t('queue.quRotationTop3')}</span>
              {top3Rotation.length === 0 ? (
                <span className="font-bold text-slate-400 font-mono text-[11px]">{t('queue.quNoRotation')}</span>
              ) : (
                <div className="flex items-center gap-1.5 font-mono">
                  {top3Rotation.map((entry, idx) => (
                    <span key={entry.membershipId} className="flex items-center gap-0.5 font-bold text-slate-800">
                      <span className={cn(
                        "w-3.5 h-3.5 rounded text-[9px] flex items-center justify-center font-black",
                        idx === 0 ? "bg-amber-100 text-amber-900" : idx === 1 ? "bg-slate-200 text-slate-700" : "bg-orange-100 text-orange-900"
                      )}>
                        {idx + 1}
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
              <span className="text-slate-400 block text-[10px]">{t('queue.quRoomsFree')}</span>
              <span className="font-bold text-emerald-700 font-mono">
                {availableRoomsCount} / {totalRoomsCount}  {t('queue.quRoomsAvailableUnit')}
              </span>
            </div>
          </div>

          {/* 今日总单 */}
          <div className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center gap-2.5">
            <CalendarDays className="w-4 h-4 text-sky-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-[10px]">{t('queue.quTodayOrders')}</span>
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
              <span className="text-slate-400 block text-[10px]">{t('queue.quWaiting')}</span>
              <span className="font-bold font-mono">{metrics.waiting}  {t('queue.quPeopleUnit')}</span>
            </div>
          </div>

          {/* 服务中 */}
          <div className="px-3.5 py-2 rounded-xl bg-teal-50/80 border border-teal-200 shadow-sm flex items-center gap-2.5 text-teal-900">
            <Scissors className="w-4 h-4 text-teal-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-[10px]">{t('queue.quInService')}</span>
              <span className="font-bold font-mono">{metrics.inService}  {t('queue.quStaffUnit')}</span>
            </div>
          </div>

          {/* Open / Unpaid */}
          <div className="px-3.5 py-2 rounded-xl bg-purple-50/80 border border-purple-200 shadow-sm flex items-center gap-2.5 text-purple-900">
            <CreditCard className="w-4 h-4 text-purple-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-[10px]">Open / Unpaid</span>
              <span className="font-bold font-mono">{metrics.readyCheckout}  {t('queue.quOrderUnit2')}</span>
            </div>
          </div>

          {/* 今日已结营收 */}
          <div className="px-3.5 py-2 rounded-xl bg-emerald-50/80 border border-emerald-200 shadow-sm flex items-center gap-2.5 text-emerald-900">
            <DollarSign className="w-4 h-4 text-emerald-600 shrink-0" />
            <div className="text-xs">
              <span className="text-slate-400 block text-[10px]">{t('queue.quRevenueToday')}</span>
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
            className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs gap-1.5 h-9 shadow-sm shadow-teal-600/20"
            onClick={() => openCreateAppointment?.()}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('queue.quNewAppointment')}</span>
          </Button>
        </div>
      </div>

      {/* 5 列看板主体 (支持横向滚动与列拖拽) */}
      <div className="flex-1 min-h-0 overflow-x-auto custom-scrollbar pb-2">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3.5 min-w-[1100px] h-full items-start">
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
                  'flex flex-col h-[calc(100vh-270px)] rounded-2xl border transition-all duration-200',
                  col.color,
                  isDropTarget
                    ? 'ring-2 ring-teal-500 bg-teal-50/40 border-teal-400 scale-[1.01]'
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
                      <h3 className="font-bold text-xs leading-none">{col.title}</h3>
                      <p className="text-[10px] text-slate-500 mt-0.5 opacity-80">{col.subtitle}</p>
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
                        <span className="text-xs text-slate-400 font-medium">{t('queue.quNoTicketsPrefix')}{col.dropEffectTitle}{t('queue.quNoTicketsSuffix')}</span>
                        <span className="text-[10px] text-slate-400 mt-0.5">{t('queue.quDragInOrder')}</span>
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
                                <div className="w-6 h-6 rounded-full bg-teal-50 text-teal-700 font-bold text-[11px] flex items-center justify-center shrink-0 border border-teal-200">
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
                                    <span className="text-[10px] text-slate-400 block font-mono">
                                      {item.phone}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {item.ticketNumber && (
                                <span className="font-mono text-xs font-black px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 shrink-0">
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

                              <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-100/80">
                                <span className="truncate flex items-center gap-1">
                                  <User className="w-3 h-3 text-slate-400 shrink-0" />
                                  <span className={item.staffName ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                                    {item.staffName || t('queue.quUnassignedStaff')}
                                  </span>
                                </span>
                                {item.roomName && (
                                  <span className="truncate text-[10px] text-teal-700 font-medium flex items-center gap-0.5">
                                    <BedDouble className="w-2.5 h-2.5" />
                                    {item.roomName}
                                  </span>
                                )}
                                {item.isRequest && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-purple-100 text-purple-700 shrink-0">
                                    
                                    {t('queue.quRequested')}
                                  </span>
                                )}
                              </div>

                              {item.notes && (
                                <p className="text-[10px] text-amber-700 bg-amber-50/60 p-1 rounded font-medium truncate">
                                  📝 {item.notes}
                                </p>
                              )}
                            </div>

                            {/* Time Status / Alerts Bar */}
                            <div className="flex items-center justify-between text-[10px] text-slate-500 pt-1 mb-2">
                              <div className="flex items-center gap-1 font-mono font-medium">
                                <Timer className="w-3 h-3 text-slate-400" />
                                <span>{item.timeDisplay}</span>
                              </div>

                              {item.overdue && (
                                <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold text-[9px] flex items-center gap-0.5">
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  
                                  {t('queue.quOverdueWait')}
                                </span>
                              )}

                              {item.pendingForms && item.pendingForms > 0 ? (
                                <span
                                  className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[9px] flex items-center gap-0.5 cursor-pointer hover:bg-amber-200"
                                  onClick={() => void openFormQr(item)}
                                >
                                  <FileWarning className="w-2.5 h-2.5" />
                                  Form Pending
                                </span>
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
                                  <span>Assign Station & Seat</span>
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </Button>
                              )}

                              {col.id === 'in_service' && (
                                <Button
                                  size="sm"
                                  className="w-full h-8 text-xs font-bold bg-purple-600 hover:bg-purple-700 text-white rounded-xl gap-1 shadow-sm"
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
                                <div className="text-center py-1 text-[11px] text-emerald-700 font-mono font-medium flex items-center justify-center gap-1 bg-emerald-50 rounded-lg">
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

        return (
          <Modal
            isOpen={checkInModal.isOpen}
            onOpenChange={(open) => {
              if (!open) setCheckInModal((prev) => ({ ...prev, isOpen: false, item: null }));
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
                  onClick={() => setCheckInModal((prev) => ({ ...prev, isOpen: false, item: null }))}
                >
                  
                  {t('queue.quCheckInCancel')}
                </Button>
                <Button
                  className="bg-amber-600 hover:bg-amber-700 text-white font-bold gap-1 shadow-md shadow-amber-600/20"
                  onClick={handleConfirmCheckIn}
                >
                  <Check className="w-4 h-4" />
                  <span>{t('queue.quCheckInConfirm')}{centsToDollars(totalEstCents)})</span>
                </Button>
              </div>
            }
          >
            <div className="space-y-4 py-2 text-xs text-slate-700 max-h-[72vh] overflow-y-auto custom-scrollbar pr-1">
              {/* 1. 顾客基本信息与预约项目概览 */}
              <div className="p-3 bg-amber-50/70 rounded-2xl border border-amber-200 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                    {item.customerName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                      <Badge variant="warning" className="text-[10px] font-bold px-1.5 py-0">
                        {item.phone || t('queue.quWalkInNoPhone')}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 bg-amber-100 text-amber-900 border-amber-300">
                        
                        {t('queue.quWaitingArea')}
                      </Badge>
                    </div>
                    <span className="text-[11px] text-slate-600 flex items-center gap-1.5 mt-0.5">
                      <span>{t('queue.quBookedService')} <strong>{item.serviceName}</strong> ({item.durationMin}{t('queue.quMinutesSuffix')}</span>
                      <span>•</span>
                      <span>{t('queue.quRequestedStaff')} {item.staffName || t('queue.quUnspecified')}</span>
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-bold text-slate-400 block">{t('queue.quEstimatedAmount')}</span>
                  <span className="font-mono font-black text-amber-900 text-base">
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
                  <Badge variant="secondary" className="text-[10px] bg-sky-50 text-sky-800 border-sky-200">
                    
                    {t('queue.quComplianceWaiver')}
                  </Badge>
                </div>

                <div className="p-3.5 bg-sky-50/70 border border-sky-200 rounded-2xl flex flex-col sm:flex-row items-center gap-3.5">
                  {/* 可点击放大的真实二维码卡片 */}
                  {(() => {
                    const intakeUrl = formShares[item.id]?.url;
                    return (
                      <>
                        <div
                          onClick={() => void openFormQr(item)}
                          className="w-20 h-20 bg-white p-1.5 rounded-2xl border border-sky-300 shadow-sm flex flex-col items-center justify-center shrink-0 cursor-pointer hover:border-sky-500 hover:shadow-md transition-all group relative"
                          title={t('queue.quZoomQr')}
                        >
                          {intakeUrl ? <QRCodeSVG value={intakeUrl} size={52} level="M" /> : <QrCode className="h-10 w-10 text-sky-600" />}
                          <span className="text-[8px] text-sky-800 font-bold mt-0.5 group-hover:text-sky-600 transition-colors">
                            
                            {t('queue.quZoomQrHint')}
                          </span>
                        </div>

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
                              className="text-[10px] text-sky-700 hover:text-sky-900 font-bold underline cursor-pointer"
                            >
                              
                              {t('queue.quCopyLink')}
                            </button>
                          </div>
                          <p className="text-slate-600 text-[11px] leading-relaxed">
                            
                            {t('queue.quIntakeGuide')}
                          </p>
                          <div className="flex items-center justify-between pt-0.5">
                            <label className="flex items-center gap-2 cursor-pointer font-bold text-sky-950 text-[11px]">
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
                              className="text-[10px] text-sky-700 bg-white hover:bg-sky-50 px-2 py-0.5 border border-sky-300 rounded-lg font-bold shadow-xs"
                            >
                              
                              {t('queue.quFullScreenQr')}
                            </button>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* 禁忌快速排查标签 */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1.5">
                    
                    {t('queue.quContraindicationsHint')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {CONTRAINDICATION_TAGS.map((tag) => {
                      const isSelected = checkInModal.contraindications.includes(tag);
                      const isSafe = tag === 'No specific contraindications';
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => {
                            setCheckInModal((prev) => {
                              if (isSafe) {
                                return { ...prev, contraindications: ['No specific contraindications'] };
                              }
                              const listWithoutSafe = prev.contraindications.filter((c) => c !== 'No specific contraindications');
                              const next = listWithoutSafe.includes(tag)
                                ? listWithoutSafe.filter((c) => c !== tag)
                                : [...listWithoutSafe, tag];
                              return {
                                ...prev,
                                contraindications: next.length === 0 ? ['No specific contraindications'] : next,
                              };
                            });
                          }}
                          className={cn(
                            'px-2.5 py-1 text-xs rounded-xl border font-bold transition-all',
                            isSelected
                              ? isSafe
                                ? 'border-emerald-500 bg-emerald-50 text-emerald-900 ring-1 ring-emerald-400'
                                : 'border-red-500 bg-red-50 text-red-900 ring-1 ring-red-400'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {isSelected && !isSafe && '⚠️ '}
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 3. 护理偏好与身体部位偏好 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
                <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('queue.quPreferencesTitle')}</span>
                </h4>

                {/* 力度选择 */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    
                    {t('queue.quPressurePref')}
                  </label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {STRENGTH_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setCheckInModal((prev) => ({ ...prev, massageStrength: opt.label }))}
                        className={cn(
                          'py-1.5 text-xs rounded-xl border text-center font-bold transition-all',
                          checkInModal.massageStrength === opt.label
                            ? 'border-teal-500 bg-teal-50 text-teal-900 ring-1 ring-teal-400'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 芳香精油 */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    
                    {t('queue.quOilPref')}
                  </label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {AROMA_OIL_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setCheckInModal((prev) => ({ ...prev, aromaOil: opt.id }))}
                        className={cn(
                          'p-1.5 text-left rounded-xl border transition-all',
                          checkInModal.aromaOil === opt.id
                            ? 'border-teal-500 bg-teal-50 text-teal-900 ring-1 ring-teal-400'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                        )}
                      >
                        <span className="block font-bold text-xs">{opt.label}</span>
                        <span className="block text-[10px] text-slate-400">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 重点部位 (分左右，可多选) */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    
                    {t('queue.quFocusAreas')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {FOCUS_AREA_TAGS.map((tag) => {
                      const isSelected = checkInModal.focusAreas.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => {
                            setCheckInModal((prev) => ({
                              ...prev,
                              focusAreas: isSelected
                                ? prev.focusAreas.filter((f) => f !== tag)
                                : [...prev.focusAreas, tag],
                            }));
                          }}
                          className={cn(
                            'px-2.5 py-1 text-xs rounded-xl border font-bold transition-all',
                            isSelected
                              ? 'border-teal-500 bg-teal-50 text-teal-900 ring-1 ring-teal-400'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {isSelected ? `✓ ${tag}` : `+ ${tag}`}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 避免触碰敏感部位 */}
                <div>
                  <label className="block text-[11px] font-bold text-red-900 mb-1 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                    <span>{t('queue.quAvoidAreas')}</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {AVOID_AREA_TAGS.map((tag) => {
                      const isSelected = checkInModal.avoidAreas.includes(tag);
                      const isNone = tag === 'No areas to avoid';
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => {
                            setCheckInModal((prev) => {
                              if (isNone) {
                                return { ...prev, avoidAreas: ['No areas to avoid'] };
                              }
                              const listWithoutNone = prev.avoidAreas.filter((a) => a !== 'No areas to avoid');
                              const next = listWithoutNone.includes(tag)
                                ? listWithoutNone.filter((a) => a !== tag)
                                : [...listWithoutNone, tag];
                              return {
                                ...prev,
                                avoidAreas: next.length === 0 ? ['No areas to avoid'] : next,
                              };
                            });
                          }}
                          className={cn(
                            'px-2.5 py-1 text-xs rounded-xl border font-bold transition-all',
                            isSelected
                              ? isNone
                                ? 'border-slate-400 bg-slate-100 text-slate-800'
                                : 'border-red-500 bg-red-50 text-red-900 ring-1 ring-red-400'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                          )}
                        >
                          {isSelected && !isNone && '⛔ '}
                          {tag}
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
                    <label className="block text-[10px] font-bold text-slate-600 mb-1">{t('queue.quSelectAddOn')}</label>
                    <select
                      value={checkInModal.selectedAddOnId}
                      onChange={(e) => setCheckInModal((prev) => ({ ...prev, selectedAddOnId: e.target.value }))}
                      className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900"
                    >
                      <option value="">{t('queue.quNoAddOn')}</option>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          + {s.name} (${centsToDollars(s.priceCents)} · {s.durationMin}m)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 mb-1">{t('queue.quAddOnStaff')}</label>
                    <select
                      value={checkInModal.addOnStaffId}
                      onChange={(e) => setCheckInModal((prev) => ({ ...prev, addOnStaffId: e.target.value }))}
                      className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900"
                    >
                      <option value="">{t('queue.quFollowLeadStaff')}{item.staffName || t('queue.quAssigned')})</option>
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
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  
                  {t('queue.quGuestNotes')}
                </label>
                <Input
                  value={checkInModal.notes}
                  onChange={(e) => setCheckInModal((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder={t('queue.quGuestNotePlaceholder')}
                  className="text-xs"
                />
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* 弹窗 2: [到店 ➔ 服务中] 安排入座与工位启动 (技师指派 · 包厢分配 · 禁忌提示) */}
      {startServiceModal.isOpen && startServiceModal.item && (() => {
        const item = startServiceModal.item;
        const assignedStaff = staff.find((s) => s.membershipId === startServiceModal.staffId);
        const assignedRoom = rooms.find((r) => r.id === startServiceModal.roomId);

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
                  className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1 shadow-md shadow-teal-600/20"
                  onClick={handleConfirmStartService}
                >
                  <Check className="w-4 h-4" />
                  <span>{t('queue.quSeatConfirm')}{assignedRoom?.name || t('queue.quAssignedStation')})</span>
                </Button>
              </div>
            }
          >
            <div className="space-y-4 py-2 text-xs text-slate-700 max-h-[72vh] overflow-y-auto custom-scrollbar pr-1">
              {/* 顾客与服务概要 */}
              <div className="p-3 bg-teal-50/70 rounded-2xl border border-teal-200 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                    <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 bg-teal-100 text-teal-900 border-teal-300">
                      {item.serviceName}
                    </Badge>
                    {item.isRequest && (
                      <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 bg-purple-100 text-purple-700 border-purple-200">
                        
                        {t('queue.quRequestedStar')}
                      </Badge>
                    )}
                  </div>
                  <span className="text-[11px] text-teal-900 block mt-0.5">
                    
                    {t('queue.quApprovedDuration')} <strong>{startServiceModal.serviceDurationMin}  {t('queue.quMinutes')}</strong>  {t('queue.quBaseFee')}{centsToDollars(item.priceCents)}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-bold text-teal-600 block">{t('queue.quStartTime')}</span>
                  <span className="font-mono font-black text-teal-900 text-base">{startServiceModal.startTime || t('queue.quNow')}</span>
                </div>
              </div>

              {/* 技师与工位分配 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* 技师指派 */}
                <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-2xs">
                  <label className="block text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-teal-600" />
                      <span>{t('queue.quLeadTherapistRequired')}</span>
                    </span>
                    <span className="text-[10px] text-teal-600 font-normal">{t('queue.quRotationPriority')}</span>
                  </label>
                  <select
                    value={startServiceModal.staffId}
                    onChange={(e) => setStartServiceModal((prev) => ({ ...prev, staffId: e.target.value }))}
                    className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-900 focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 truncate"
                  >
                    {staff
                      .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                      .map((s, idx) => {
                        const isLead = s.membershipId.includes('lead');
                        return (
                          <option key={s.membershipId} value={s.membershipId}>
                            {s.name} ({isLead ? t('queue.quLevelDirector') : t('queue.quLevelSenior')}  {t('queue.quRotationNo')}{idx + 1})
                          </option>
                        );
                      })}
                  </select>
                  {assignedStaff && (
                    <div className="p-2 bg-slate-50 rounded-xl text-[11px] text-slate-600 flex justify-between items-center gap-1.5">
                      <span className="truncate">{t('queue.quLevelLabel')} {assignedStaff.membershipId.includes('lead') ? t('queue.quLevelDirectorRate') : t('queue.quLevelSeniorRate')}</span>
                      <Badge variant="success" className="text-[9px] px-1.5 py-0.5 font-bold shrink-0 whitespace-nowrap">{t('queue.quIdleAvailable')}</Badge>
                    </div>
                  )}
                </div>

                {/* 房间/工位分配 */}
                <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-2xs">
                  <label className="block text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <BedDouble className="w-3.5 h-3.5 text-teal-600" />
                      <span>{t('queue.quAssignRoomRequired')}</span>
                    </span>
                    <span className="text-[10px] text-slate-400">{t('queue.quAutoRecommended')}</span>
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
                    <div className="p-2 bg-slate-50 rounded-xl text-[11px] text-slate-600 flex justify-between items-center gap-1.5">
                      <span className="truncate">{t('queue.quTypeLabel')} {assignedRoom.type === 'room' ? t('queue.quPrivateRoom') : t('queue.quOpenStation')}  {t('queue.quCapacityPrefix')} {assignedRoom.capacity}{t('queue.quCapacitySuffix')}</span>
                      <Badge
                        variant={assignedRoom.status === 'available' ? 'success' : 'warning'}
                        className="text-[9px] px-1.5 py-0.5 font-bold shrink-0 whitespace-nowrap"
                      >
                        {assignedRoom.status === 'available' ? t('queue.quSanitised') : t('queue.quInUse')}
                      </Badge>
                    </div>
                  )}
                </div>
              </div>

              {/* 健康问卷与免责知情同意书签署状态 (未填时醒目提示与扫码入口) */}
              {(() => {
                const hasPendingForm = Boolean((item.pendingForms && item.pendingForms > 0) || (item.rawQueue?.pendingForms && item.rawQueue.pendingForms > 0));

                if (hasPendingForm) {
                  return (
                    <div className="bg-rose-50/90 border-2 border-rose-200 rounded-2xl p-3.5 space-y-2.5 shadow-2xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <div className="w-7 h-7 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center font-bold shrink-0 mt-0.5 shadow-2xs">
                            <FileWarning className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <h4 className="font-extrabold text-rose-950 text-xs">{t('queue.quNoFormWarning')}</h4>
                            <p className="text-[11px] text-rose-800/90 leading-tight mt-0.5">
                              
                              {t('queue.quNoFormWarningDesc')}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => void copyFormLink(item)}
                            className="px-2 py-1 text-[11px] font-bold bg-white text-rose-800 border border-rose-300 rounded-xl hover:bg-rose-100 flex items-center gap-1 shadow-2xs cursor-pointer transition-colors"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{t('queue.quCopyLink2')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void openFormQr(item)}
                            className="px-2.5 py-1 text-[11px] font-bold bg-rose-600 text-white rounded-xl hover:bg-rose-700 flex items-center gap-1 shadow-2xs cursor-pointer transition-colors"
                          >
                            <QrCode className="w-3 h-3" />
                            <span>{t('queue.quScanToFill')}</span>
                          </button>
                        </div>
                      </div>
                      <div className="p-2 bg-white/90 rounded-xl border border-rose-200/80 flex items-center justify-between text-[11px]">
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

                return (
                  <div className="bg-emerald-50/80 border border-emerald-200 rounded-2xl p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                        <CheckCircle className="w-3.5 h-3.5" />
                      </div>
                      <div>
                        <span className="font-bold text-emerald-950 text-xs">{t('queue.quFormSigned')}</span>
                        <span className="text-[10px] text-emerald-700 block">{t('queue.quNoSevereContraindications')}</span>
                      </div>
                    </div>
                    <Badge variant="success" className="text-[9px] px-1.5 py-0.5 font-bold">{t('queue.quCompliantSigned')}</Badge>
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
                  <Badge variant="warning" className="text-[9px] font-bold shrink-0">{t('queue.quHandoverVerbally')}</Badge>
                </div>
                <div className="p-2.5 bg-white/90 rounded-xl border border-amber-200/80 text-[11px] text-slate-700 leading-relaxed font-medium">
                  {item.notes || t('queue.quNoContraindications')}
                </div>
                {!((item.pendingForms && item.pendingForms > 0) || (item.rawQueue?.pendingForms && item.rawQueue.pendingForms > 0)) && (
                  <label className="flex items-center gap-2 cursor-pointer pt-0.5 text-amber-950 font-bold text-[11px]">
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
                    <span className="text-[10px] text-slate-500">
                      
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

        return (
          <Modal
            isOpen={completeServiceModal.isOpen}
            onOpenChange={(open) => {
              if (!open) setCompleteServiceModal((prev) => ({ ...prev, isOpen: false, item: null }));
            }}
            title={
              <div className="flex items-center gap-2 text-purple-800 font-bold">
                <CheckCircle className="w-5 h-5 text-purple-600" />
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
                  className="bg-purple-600 hover:bg-purple-700 text-white font-bold gap-1 shadow-md shadow-purple-600/20"
                  onClick={handleConfirmCompleteService}
                >
                  <Check className="w-4 h-4" />
                  <span>{t('queue.quFinishConfirm')}{centsToDollars(finalCalculatedCents)})</span>
                </Button>
              </div>
            }
          >
            <div className="space-y-4 py-2 text-xs text-slate-700 max-h-[72vh] overflow-y-auto custom-scrollbar pr-1">
              {/* 服务概要卡片 */}
              <div className="p-3 bg-purple-50/70 rounded-2xl border border-purple-200 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                    <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0 bg-purple-100 text-purple-900 border-purple-300">
                      {item.serviceName}
                    </Badge>
                  </div>
                  <span className="text-[11px] text-purple-950 block mt-0.5">
                    
                    {t('queue.quLeadTherapistLabel')} <strong>{item.staffName || t('queue.quAssigned2')}</strong>  {t('queue.quStationSep')} {item.roomName || t('queue.quAssignedRoom')}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-bold text-purple-600 block">{t('queue.quBaseServiceFee')}</span>
                  <span className="font-mono font-black text-purple-900 text-base">
                    ${centsToDollars(item.priceCents)}
                  </span>
                </div>
              </div>

              {/* 实际服务用时核验 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2 shadow-sm">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-slate-800 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-purple-600" />
                    <span>{t('queue.quVerifyActualTime')}</span>
                  </label>
                  <span className="font-mono text-purple-700 font-bold">{completeServiceModal.actualDurationMin}  {t('queue.quMinutes2')}</span>
                </div>
                <div className="flex gap-2">
                  {[item.durationMin || 45, 60, 75, 90, 120].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setCompleteServiceModal((prev) => ({ ...prev, actualDurationMin: d }))}
                      className={cn(
                        'flex-1 py-1.5 text-xs rounded-xl border font-bold font-mono transition-all',
                        completeServiceModal.actualDurationMin === d
                          ? 'border-purple-500 bg-purple-50 text-purple-900 ring-1 ring-purple-400'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {d}m {d > (item.durationMin || 45) && `(+${d - (item.durationMin || 45)}m)`}
                    </button>
                  ))}
                </div>
              </div>

              {/* 服务中途加项与提成技师归属 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Coins className="w-3.5 h-3.5 text-purple-600" />
                    <span>{t('queue.quAddOnsTitle')}</span>
                  </h4>
                  <span className="text-[10px] text-purple-700 font-bold">
                    
                    {t('queue.quAddOnSubtotal')}{centsToDollars(addOnsTotalCents)}
                  </span>
                </div>

                {/* 当前门店真实服务目录 */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">
                    {t('queue.quSelectAddOn')}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {services.map((service) => (
                      <button
                        key={service.id}
                        type="button"
                        onClick={() => setCompleteServiceModal((prev) => ({
                          ...prev,
                          extraAddOnServiceId: service.id,
                        }))}
                        className={cn(
                          'px-2 py-1 border rounded-lg text-xs font-bold flex items-center gap-1 transition-colors',
                          completeServiceModal.extraAddOnServiceId === service.id
                            ? 'bg-purple-100 text-purple-950 border-purple-500 ring-1 ring-purple-300'
                            : 'bg-purple-50 hover:bg-purple-100 text-purple-900 border-purple-200',
                        )}
                      >
                        <Plus className="w-3 h-3 text-purple-600" />
                        <span>{service.name}</span>
                        <span className="font-mono text-purple-700 font-bold">${centsToDollars(service.priceCents)}</span>
                      </button>
                    ))}
                  </div>
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
                          <span className="text-[10px] text-slate-400 font-mono">({addon.durationMin}m)</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-500">{t('queue.quCommissionTo')}</span>
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
                          <span className="font-mono font-bold text-purple-800">${centsToDollars(addon.priceCents)}</span>
                          <button
                            type="button"
                            className="text-red-500 hover:text-red-700 text-xs font-bold px-1"
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
                    className="text-xs font-bold text-purple-700 border-purple-200 bg-purple-50 hover:bg-purple-100"
                    onClick={() => {
                      const selectedService = services.find(
                        (service) => service.id === completeServiceModal.extraAddOnServiceId,
                      );
                      const selectedStaff = staff.find(
                        (candidate) => candidate.membershipId === completeServiceModal.extraAddOnStaffId,
                      );
                      if (!selectedService || !selectedStaff) return;
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
                  >
                    
                    {t('queue.quAddItem')}
                  </Button>
                </div>
              </div>

              {/* 包厢工位翻台清洁与技师跟进备注 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
                  <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={completeServiceModal.markRoomCleaning}
                      onChange={(e) => setCompleteServiceModal((prev) => ({ ...prev, markRoomCleaning: e.target.checked }))}
                      className="w-3.5 h-3.5 rounded text-purple-600"
                    />
                    <span>{t('queue.quReleaseStation')}</span>
                  </label>
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    
                    {t('queue.quReleaseStationDesc')}
                  </p>
                </div>

                <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
                  <label className="block text-[11px] font-bold text-slate-800">
                    
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
              <div className="p-3.5 bg-slate-900 text-white rounded-2xl flex items-center justify-between shadow-lg">
                <div>
                  <span className="text-[11px] text-slate-400 block">
                    
                    {t('queue.quTotalPrefix')}{centsToDollars(item.priceCents)}  {t('queue.quAddOnSep')}{centsToDollars(addOnsTotalCents)})
                  </span>
                  <span className="font-mono text-xl font-black text-purple-300">
                    ${centsToDollars(finalCalculatedCents)}
                  </span>
                </div>
                <Badge variant="secondary" className="bg-purple-500/20 text-purple-200 font-bold px-2 py-1 text-xs">
                  
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
        const addOns = item.addOns || [];
        const baseCents = item.priceCents || 0;
        const discountCents = dollarsToCents(checkoutModal.discountDollars || '0');
        const afterDiscountCents = Math.max(0, baseCents - discountCents);
        const taxCents = checkoutModal.enableTax
          ? Math.round(afterDiscountCents * (parseFloat(checkoutModal.taxRatePercent || '0') / 100))
          : 0;

        // 收集参与本次单据的所有技师
        const staffMap = new Map<string, {
          name: string;
          items: Array<{ name: string; priceCents: number; roomName?: string }>;
          totalRevenueCents: number;
        }>();

        // 主项目
        const mainStaffName = item.staffName || t('queue.quLeadTherapist');

        staffMap.set(mainStaffName, {
          name: mainStaffName,
          items: [{ name: item.serviceName, priceCents: item.priceCents - addOns.reduce((s, a) => s + a.priceCents, 0), roomName: item.roomName || undefined }],
          totalRevenueCents: item.priceCents - addOns.reduce((s, a) => s + a.priceCents, 0),
        });

        // 加项
        addOns.forEach((addon) => {
          const addonStaffName = addon.staffName || mainStaffName;
          const existing = staffMap.get(addonStaffName) ?? {
            name: addonStaffName,
            items: [],
            totalRevenueCents: 0,
          };
          existing.items.push({ name: t('queue.quAddOnPrefix', { p0: addon.name }), priceCents: addon.priceCents, roomName: item.roomName || undefined });
          existing.totalRevenueCents += addon.priceCents;
          staffMap.set(addonStaffName, existing);
        });

        const staffList = [...staffMap.values()];

        // 计算Total Tips
        let totalTipCents = 0;
        if (checkoutModal.tipMode === 'total_split') {
          totalTipCents = checkoutModal.totalTipDollars !== ''
            ? dollarsToCents(checkoutModal.totalTipDollars)
            : Math.round((afterDiscountCents * checkoutModal.tipPercentage) / 100);
        } else {
          totalTipCents = Object.values(checkoutModal.customStaffTips).reduce(
            (sum, val) => sum + Math.max(0, dollarsToCents(val || '0')),
            0,
          );
        }

        // 小费智能分账明细
        const tipAllocations = staffList.map((st) => {
          let allocatedCents = 0;
          if (checkoutModal.tipMode === 'custom_per_staff') {
            allocatedCents = Math.max(0, dollarsToCents(checkoutModal.customStaffTips[st.name] || '0'));
          } else if (totalTipCents > 0) {
            if (checkoutModal.splitStrategy === 'equal') {
              allocatedCents = Math.round(totalTipCents / staffList.length);
            } else {
              const totalRev = staffList.reduce((sum, s) => sum + s.totalRevenueCents, 0) || 1;
              allocatedCents = Math.round((st.totalRevenueCents / totalRev) * totalTipCents);
            }
          }
          const percent = totalTipCents > 0 ? Math.round((allocatedCents / totalTipCents) * 100) : 0;
          return {
            ...st,
            allocatedTipCents: allocatedCents,
            percent,
          };
        });

        // 信用卡手续费
        const hasCard = checkoutModal.paymentMethod === 'card' || checkoutModal.paymentMethod === 'apple_pay';
        const cardSurchargeCents = checkoutModal.enableCardSurcharge && hasCard
          ? Math.round((afterDiscountCents + taxCents + totalTipCents) * (parseFloat(checkoutModal.cardSurchargePercent || '0') / 100))
          : 0;

        const totalDueCents = afterDiscountCents + taxCents + cardSurchargeCents;
        const chargedTotalCents = totalDueCents + totalTipCents;
        const tenderedCents = dollarsToCents(checkoutModal.tenderedDollars || '0');
        const rawChangeDue = Math.max(0, tenderedCents - chargedTotalCents);

        return (
          <Modal
            isOpen={checkoutModal.isOpen}
            onOpenChange={(open) => {
              if (!open) setCheckoutModal((prev) => ({ ...prev, isOpen: false, item: null }));
            }}
            title={
              <div className="flex items-center gap-2 text-emerald-800 font-bold">
                <CreditCard className="w-5 h-5 text-emerald-600" />
                <span>Front Desk Checkout (Tip & Commission Breakdown)</span>
              </div>
            }
            size="lg"
            footer={
              <div className="flex justify-end gap-2 w-full">
                <Button
                  variant="secondary"
                  onClick={() => setCheckoutModal((prev) => ({ ...prev, isOpen: false, item: null }))}
                >
                  
                  {t('queue.quCheckoutCancel')}
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold gap-1 shadow-md shadow-emerald-600/20"
                  onClick={handleConfirmCheckout}
                >
                  <Check className="w-4 h-4" />
                  <span>Complete Payment (${centsToDollars(chargedTotalCents)})</span>
                </Button>
              </div>
            }
          >
            <div className="space-y-4 py-2 text-xs text-slate-700 max-h-[72vh] overflow-y-auto custom-scrollbar pr-1">
              {/* 1. 客户画像与服务场地概览 */}
              <div className="p-3 bg-emerald-50/70 rounded-2xl border border-emerald-200 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
                    {item.customerName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{item.customerName}</span>
                      <Badge variant="success" className="text-[10px] font-bold px-1.5 py-0">
                        {item.serviceName}
                      </Badge>
                    </div>
                    <span className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                      <BedDouble className="w-3 h-3 text-slate-400" />
                      <span>{item.roomName || 'Unassigned Room'}</span>
                      <span>•</span>
                      <span>{staffList.length} technicians collaborating</span>
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-bold text-slate-400 block">Base Services Subtotal</span>
                  <span className="font-mono font-black text-emerald-800 text-base">
                    ${centsToDollars(baseCents)}
                  </span>
                </div>
              </div>

              {/* 2. 项目明细、包厢工位与多技师执行明细 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2.5 shadow-sm">
                <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Scissors className="w-3.5 h-3.5 text-teal-600" />
                    <span>Execution Details & Commission Split</span>
                  </span>
                  <span className="text-[10px] text-slate-400">{t('queue.quTotalPrefix2')} {staffList.reduce((sum, s) => sum + s.items.length, 0)}  {t('queue.quItemsUnit')}</span>
                </h4>

                <div className="space-y-2">
                  {staffList.map((st) => (
                    <div key={st.name} className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 space-y-1.5">
                      <div className="flex justify-between items-center pb-1 border-b border-slate-200/60">
                        <div className="flex items-center gap-1.5">
                          <User className="w-3 h-3 text-teal-600" />
                          <span className="font-bold text-slate-800">{st.name}</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {st.items.map((it, idx) => (
                          <div key={idx} className="flex justify-between items-center">
                            <span className="text-slate-700 font-medium">{it.name}</span>
                            <span className="font-mono font-bold text-slate-900">${centsToDollars(it.priceCents)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 3. 多技师小费分配与职级分账 */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 space-y-2.5 shadow-sm">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Award className="w-3.5 h-3.5 text-amber-600" />
                    <span>Tip Split & Earnings Estimate</span>
                  </h4>
                  <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg text-[10px] font-bold">
                    <button
                      type="button"
                      onClick={() => setCheckoutModal((prev) => ({ ...prev, tipMode: 'total_split' }))}
                      className={cn(
                        'px-2 py-0.5 rounded-md transition-all',
                        checkoutModal.tipMode === 'total_split' ? 'bg-white shadow-sm text-teal-900' : 'text-slate-500',
                      )}
                    >
                      Smart Tip Split
                    </button>
                    <button
                      type="button"
                      onClick={() => setCheckoutModal((prev) => ({ ...prev, tipMode: 'custom_per_staff' }))}
                      className={cn(
                        'px-2 py-0.5 rounded-md transition-all',
                        checkoutModal.tipMode === 'custom_per_staff' ? 'bg-white shadow-sm text-teal-900' : 'text-slate-500',
                      )}
                    >
                      Enter by Staff
                    </button>
                  </div>
                </div>

                {checkoutModal.tipMode === 'total_split' ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-5 gap-1.5">
                      {[
                        { label: 'No Tip', pct: 0 },
                        { label: '15%', pct: 15 },
                        { label: '18%', pct: 18 },
                        { label: '20%', pct: 20 },
                        { label: '25%', pct: 25 },
                      ].map((btn) => {
                        const tipAmt = centsToDollars(Math.round((afterDiscountCents * btn.pct) / 100));
                        const isSelected = checkoutModal.tipPercentage === btn.pct && checkoutModal.totalTipDollars === '';
                        return (
                          <button
                            key={btn.label}
                            type="button"
                            onClick={() =>
                              setCheckoutModal((prev) => ({
                                ...prev,
                                tipPercentage: btn.pct,
                                totalTipDollars: '',
                              }))
                            }
                            className={cn(
                              'p-1.5 rounded-xl border text-center font-bold transition-all',
                              isSelected
                                ? 'border-teal-500 bg-teal-50 text-teal-900 ring-1 ring-teal-400'
                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                            )}
                          >
                            <span className="block text-[11px]">{btn.label}</span>
                            <span className="block text-[9px] font-mono text-slate-400">${tipAmt}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-1">Custom Total Tip ($)</label>
                        <Input
                          inputMode="decimal"
                          value={checkoutModal.totalTipDollars}
                          onChange={(e) =>
                            setCheckoutModal((prev) => ({ ...prev, totalTipDollars: e.target.value }))
                          }
                          placeholder="0.00"
                          className="font-mono text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 mb-1">Split Strategy</label>
                        <select
                          value={checkoutModal.splitStrategy}
                          onChange={(e) =>
                            setCheckoutModal((prev) => ({ ...prev, splitStrategy: e.target.value as any }))
                          }
                          className="w-full px-2 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium"
                        >
                          <option value="proportional">Proportional to Service Revenue (Recommended)</option>
                          <option value="equal">Equal Split</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {staffList.map((st) => (
                      <div key={st.name} className="p-2 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                        <span className="font-bold text-slate-800 text-[11px] block">{st.name}</span>
                        <Input
                          inputMode="decimal"
                          value={checkoutModal.customStaffTips[st.name] || ''}
                          onChange={(e) =>
                            setCheckoutModal((prev) => ({
                              ...prev,
                              customStaffTips: { ...prev.customStaffTips, [st.name]: e.target.value },
                            }))
                          }
                          placeholder="0.00"
                          className="font-mono text-xs h-7"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* 小费分配预览 */}
                <div className="p-2.5 bg-teal-50/50 rounded-xl border border-teal-100 space-y-1">
                  <div className="flex justify-between items-center text-[10px] font-bold text-teal-900">
                    <span>Tip Allocation:</span>
                    <span className="font-mono text-teal-700">Total Tips: ${centsToDollars(totalTipCents)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {tipAllocations.map((st) => (
                      <div key={st.name} className="p-1.5 bg-white rounded-lg border border-teal-200 text-[11px] space-y-0.5">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-slate-800">{st.name}</span>
                          <span className="font-mono font-bold text-teal-700">+${centsToDollars(st.allocatedTipCents)} ({st.percent}%)</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 4. 税费与信用卡手续费 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
                  <div className="flex justify-between items-center">
                    <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checkoutModal.enableTax}
                        onChange={(e) =>
                          setCheckoutModal((prev) => ({ ...prev, enableTax: e.target.checked }))
                        }
                        className="w-3.5 h-3.5 rounded text-teal-600"
                      />
                      <span>Sales Tax</span>
                    </label>
                    <span className="font-mono font-bold text-slate-700">+${centsToDollars(taxCents)}</span>
                  </div>
                  {checkoutModal.enableTax && (
                    <div className="flex items-center gap-1.5 pt-1">
                      <span className="text-[10px] text-slate-400">Tax Rate (%):</span>
                      <Input
                        inputMode="decimal"
                        value={checkoutModal.taxRatePercent}
                        onChange={(e) =>
                          setCheckoutModal((prev) => ({ ...prev, taxRatePercent: e.target.value }))
                        }
                        className="h-6 w-16 text-xs font-mono"
                      />
                    </div>
                  )}
                </div>

                <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
                  <div className="flex justify-between items-center">
                    <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checkoutModal.enableCardSurcharge}
                        onChange={(e) =>
                          setCheckoutModal((prev) => ({ ...prev, enableCardSurcharge: e.target.checked }))
                        }
                        className="w-3.5 h-3.5 rounded text-purple-600"
                      />
                      <span>Card Surcharge</span>
                    </label>
                    <span className="font-mono font-bold text-purple-700">+${centsToDollars(cardSurchargeCents)}</span>
                  </div>
                  {checkoutModal.enableCardSurcharge && (
                    <div className="flex items-center gap-1 pt-1">
                      {['3.0', '3.5', '4.0'].map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          onClick={() =>
                            setCheckoutModal((prev) => ({ ...prev, cardSurchargePercent: rate }))
                          }
                          className={cn(
                            'px-1.5 py-0.5 text-[9px] rounded border font-bold',
                            checkoutModal.cardSurchargePercent === rate
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'bg-slate-100 text-slate-600',
                          )}
                        >
                          {rate}%
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 5. 费用核算汇总 */}
              <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 space-y-1.5">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal (Base & Add-ons)</span>
                  <span className="font-mono font-bold text-slate-800">${centsToDollars(baseCents)}</span>
                </div>
                <div className="flex justify-between items-center text-slate-600">
                  <span>Discounts & Vouchers</span>
                  <Input
                    inputMode="decimal"
                    value={checkoutModal.discountDollars}
                    onChange={(e) =>
                      setCheckoutModal((prev) => ({ ...prev, discountDollars: e.target.value }))
                    }
                    className="h-6 w-20 text-right font-mono text-xs"
                    placeholder="0"
                  />
                </div>
                {checkoutModal.enableTax && (
                  <div className="flex justify-between text-slate-600">
                    <span>Sales Tax ({checkoutModal.taxRatePercent}%)</span>
                    <span className="font-mono font-bold text-slate-800">+${centsToDollars(taxCents)}</span>
                  </div>
                )}
                {checkoutModal.enableCardSurcharge && hasCard && (
                  <div className="flex justify-between text-purple-700">
                    <span>Credit Card Processing Fee ({checkoutModal.cardSurchargePercent}%)</span>
                    <span className="font-mono font-bold">+${centsToDollars(cardSurchargeCents)}</span>
                  </div>
                )}
                <div className="pt-1.5 border-t border-slate-200 flex justify-between items-end font-bold">
                  <span className="text-slate-800 text-xs">Total Due:</span>
                  <span className="text-base font-black text-teal-700 font-mono">
                    ${centsToDollars(totalDueCents)}
                  </span>
                </div>
              </div>

              {/* 6. 收款方式选择 */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Select Payment Method *
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { id: 'card', label: 'Card / POS', icon: CreditCard },
                    { id: 'cash', label: 'Cash', icon: Coins },
                    { id: 'gift_card', label: 'Gift Card', icon: Gift },
                    { id: 'apple_pay', label: 'ApplePay', icon: Wallet },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setCheckoutModal((prev) => ({ ...prev, paymentMethod: m.id as any }))
                      }
                      className={cn(
                        'p-2 rounded-xl border flex flex-col items-center gap-1 font-bold transition-all text-xs',
                        checkoutModal.paymentMethod === m.id
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-900 shadow-sm ring-1 ring-emerald-400'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                      )}
                    >
                      <m.icon className="w-4 h-4" />
                      <span>{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Cash找零与转小费 */}
              {checkoutModal.paymentMethod === 'cash' && (
                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 space-y-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-amber-900 mb-1">{t('queue.quCashReceived')}</label>
                      <Input
                        inputMode="decimal"
                        value={checkoutModal.tenderedDollars}
                        onChange={(e) =>
                          setCheckoutModal((prev) => ({ ...prev, tenderedDollars: e.target.value }))
                        }
                        placeholder={t('queue.quAmountPlaceholder')}
                        className="font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-amber-900 mb-1">Change Due</label>
                      <div className="py-1.5 px-3 bg-white rounded-xl border border-amber-300 font-mono font-bold text-sm text-amber-900">
                        ${centsToDollars(checkoutModal.keepChange ? 0 : rawChangeDue)}
                      </div>
                    </div>
                  </div>
                  {rawChangeDue > 0 && (
                    <label className="flex items-center gap-2 cursor-pointer p-2 bg-white/80 rounded-lg border border-amber-300">
                      <input
                        type="checkbox"
                        checked={checkoutModal.keepChange}
                        onChange={(e) =>
                          setCheckoutModal((prev) => ({ ...prev, keepChange: e.target.checked }))
                        }
                        className="w-4 h-4 rounded text-teal-600"
                      />
                      <span className="font-bold text-amber-950 text-[11px]">
                        Keep the change (Auto added to tip)（${centsToDollars(rawChangeDue)}  {t('queue.quAutoToTip')}
                      </span>
                    </label>
                  )}
                </div>
              )}

              {/* Gift Card输入与核验 */}
              {checkoutModal.paymentMethod === 'gift_card' && (
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                  <label className="block font-bold text-slate-700 mb-1">{t('queue.quEnterGiftCard')}</label>
                  <div className="flex gap-2">
                    <Input
                      value={checkoutModal.giftCardCode}
                      onChange={(e) =>
                        setCheckoutModal((prev) => ({
                          ...prev,
                          giftCardCode: e.target.value,
                          giftCardVerified: false,
                        }))
                      }
                      placeholder="GF-GC-XXXX"
                      className="font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!checkoutModal.giftCardCode.trim() || checkoutModal.isVerifyingGiftCard}
                      onClick={async () => {
                        setCheckoutModal((prev) => ({ ...prev, isVerifyingGiftCard: true }));
                        try {
                          const res = await verifyGiftCard(checkoutModal.giftCardCode.trim());
                          if (res.valid) {
                            setCheckoutModal((prev) => ({
                              ...prev,
                              giftCardVerified: true,
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
                      className="text-xs font-bold shrink-0"
                    >
                      {checkoutModal.isVerifyingGiftCard ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : t('queue.quVerifyCard')}
                    </Button>
                  </div>
                  {checkoutModal.giftCardVerified && (
                    <div className="p-2 bg-emerald-50 rounded-lg border border-emerald-200 text-emerald-800 text-[11px] font-bold flex justify-between">
                      <span>{t('queue.quGiftCardVerified')}</span>
                      <span>Available Balance: ${centsToDollars(checkoutModal.giftCardBalanceCents)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* 最终深色结算总额 Bar */}
              <div className="p-3.5 bg-slate-900 text-white rounded-2xl flex items-center justify-between shadow-lg">
                <div>
                  <span className="text-[11px] text-slate-400 block">
                    
                    {t('queue.quTotalCollectedPrefix')}{centsToDollars(totalDueCents)}  {t('queue.quTipSep')}{centsToDollars(totalTipCents)})
                  </span>
                  <span className="font-mono text-xl font-black text-emerald-400">
                    ${centsToDollars(chargedTotalCents)}
                  </span>
                </div>
                <Badge variant="secondary" className="bg-emerald-500/20 text-emerald-300 font-black text-xs px-2.5 py-1">
                  {checkoutModal.paymentMethod.toUpperCase()}
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
            <div className="flex items-center gap-2 text-red-600 font-bold">
              <ShieldAlert className="w-5 h-5" />
              <span>Rollback Stage Audit Confirmation</span>
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
                className="bg-red-600 hover:bg-red-700 text-white font-bold gap-1 shadow-md shadow-red-600/20"
                onClick={handleConfirmRollback}
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Confirm Rollback to【{STAGE_NAMES[rollbackModal.toStage]}】</span>
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 py-2 text-xs text-slate-700">
            {/* 顾客与回退流转路径 */}
            <div className="p-3 bg-red-50 rounded-2xl border border-red-200 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-bold text-red-950 text-sm">{rollbackModal.item.customerName}</span>
                <Badge variant="error" className="text-[10px] font-bold">Rollback Operation</Badge>
              </div>
              <div className="flex items-center gap-2 font-mono text-xs font-bold text-red-800">
                <span className="p-1 bg-white rounded-lg border border-red-200">{STAGE_NAMES[rollbackModal.fromStage]}</span>
                <ArrowLeft className="w-3.5 h-3.5 text-red-600" />
                <span className="p-1 bg-red-100 rounded-lg border border-red-300 text-red-950">{STAGE_NAMES[rollbackModal.toStage]}</span>
              </div>
              <p className="text-[11px] text-red-700 leading-relaxed pt-1">
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
                        ? 'border-red-400 bg-red-50/60 text-red-950 font-bold ring-1 ring-red-300'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700',
                    )}
                  >
                    <input
                      type="radio"
                      name="rollbackReason"
                      value={r.id}
                      checked={rollbackModal.reason === r.id}
                      onChange={() => setRollbackModal((prev) => ({ ...prev, reason: r.id }))}
                      className="text-red-600 focus:ring-red-500/20"
                    />
                    <span>{r.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* 自动同步释放资源复选框 */}
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <label className="flex items-center gap-2 cursor-pointer font-bold text-slate-800 text-xs">
                <input
                  type="checkbox"
                  checked={rollbackModal.releaseResources}
                  onChange={(e) => setRollbackModal((prev) => ({ ...prev, releaseResources: e.target.checked }))}
                  className="w-3.5 h-3.5 rounded text-red-600 focus:ring-red-500/20"
                />
                <span>{t('queue.quRollbackAutoSync')}</span>
              </label>
            </div>

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
              <span>Walk-in Guest Record · {viewingQueueModal.item.customerName}</span>
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
                  <span>Assign Station & Seat</span>
                </Button>
              )}
            </div>
          }
        >
          <div className="space-y-4 py-1 text-xs text-slate-700">
            {/* 头部信息 */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-teal-100 text-teal-800 flex items-center justify-center font-extrabold text-sm border border-teal-200">
                  {viewingQueueModal.item.customerName.charAt(0)}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">{viewingQueueModal.item.customerName}</span>
                    {viewingQueueModal.item.ticketNumber && (
                      <span className="font-mono text-xs font-black px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
                        #{viewingQueueModal.item.ticketNumber}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono">
                    {viewingQueueModal.item.phone || 'No phone provided (Walk-in)'}
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-slate-400 block font-bold">Current Status</span>
                <Badge variant="secondary" className="text-xs font-bold bg-amber-100 text-amber-800">
                  {viewingQueueModal.item.timeDisplay}
                </Badge>
              </div>
            </div>

            {/* 服务与排号信息 */}
            <div className="p-3.5 bg-white border border-slate-200 rounded-2xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Requested Service</span>
                <span className="font-bold text-slate-900">{viewingQueueModal.item.serviceName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Assigned Specialist</span>
                <span className="font-bold text-slate-900">{viewingQueueModal.item.staffName || 'Rotation Pending'}</span>
              </div>
              {viewingQueueModal.item.roomName && (
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Reserved Room / Station</span>
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
                      <span className="font-extrabold text-rose-950 text-xs flex items-center gap-1.5">
                        <FileWarning className="w-4 h-4 text-rose-600" />
                        <span>⚠️ Health form and waiver not signed yet</span>
                      </span>
                      <Badge variant="destructive" className="text-[9px] font-bold">Form Pending</Badge>
                    </div>
                    <p className="text-[11px] text-rose-800">
                      Please guide guest to scan or sign on iPad before service.
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
                        <span>Scan Form QR</span>
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
                    <span>✓ Digital waiver signed & verified</span>
                  </span>
                  <Badge variant="success" className="text-[9px] font-bold">Signed & Verified</Badge>
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
