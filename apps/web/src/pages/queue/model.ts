/**
 * 运营看板的静态模型：泳道配置、标签选项、卡片形态与几个纯判定。
 *
 * 从 `pages/Queue.tsx` 原样搬出，不含任何行为改动。搬出的理由是这些定义
 * 与 React 状态无关，却混在一个五千行的页面文件里 —— 想确认「回退到底
 * 允许到哪一步」得先翻过几个弹窗的 JSX。
 *
 * ⚠️ 文案一律只存词典键，不存字符串。此前这里写死过中文，切到英文界面时
 * 运营看板每天盯的那块屏完全不跟着语言走。
 */
import {
  CalendarDays, CheckCircle, CheckCircle2, Clock, CreditCard, Scissors, UserCheck, Award,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import type { QueueNextAction } from '@/features/queue/nextAction';
import type { ScheduleItem } from '@/context/ScheduleContext';
import type { QueueEntry } from '@/features/queue/types';
import type { TicketSummary } from '@/features/tickets/types';

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
export const ROLLBACK_REASONS: TagOption[] = [
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
  if (item.ticketId || item.rawTicket) return toStage === 'in_service';
  return toStage !== 'ready_checkout' && toStage !== 'completed';
}

/** 该单据是否还有未签署的健康问卷。看板与两个弹窗判断口径统一在这里。 */
export function hasPendingForms(item: KanbanItem): boolean {
  return Boolean((item.pendingForms && item.pendingForms > 0)
    || (item.rawQueue?.pendingForms && item.rawQueue.pendingForms > 0));
}

/** 弹窗主行动按钮的统一样式。 */
export const PRIMARY_ACTION_CLASS = 'gap-1 bg-teal-700 font-semibold text-white hover:bg-teal-800';
/** 不可逆/破坏性动作的主按钮样式。 */
export const DANGER_ACTION_CLASS = 'gap-1 bg-rose-700 font-semibold text-white hover:bg-rose-800';

/** 完工弹窗速选加项的展示条数，超出部分收进「更多」。 */
export const FINISH_QUICK_PICK_LIMIT = 4;

/** 收款方式的词典键。结算条上的徽章此前直接 toUpperCase 内部枚举值，中文界面下是英文。 */
export const PAYMENT_METHOD_LABEL_KEYS: Record<'card' | 'cash' | 'gift_card' | 'apple_pay', TranslationKey> = {
  card: 'queue.quCoPayCard',
  cash: 'queue.quCoPayCash',
  gift_card: 'queue.quCoPayGiftCard',
  apple_pay: 'queue.quCoPayApplePay',
};

/** 卡片主按钮的配色。颜色沿用各阶段既有的视觉语言，前台无需重新学习。 */
export const NEXT_ACTION_STYLE: Record<Exclude<QueueNextAction['kind'], 'blocked'>, string> = {
  check_in: 'bg-amber-500 hover:bg-amber-600',
  seat: 'bg-teal-600 hover:bg-teal-700',
  start_item: 'bg-teal-600 hover:bg-teal-700',
  finish_item: 'bg-violet-600 hover:bg-violet-700',
  pay_service: 'bg-emerald-600 hover:bg-emerald-700',
  pay_tip: 'bg-emerald-600 hover:bg-emerald-700',
  pay_combined: 'bg-emerald-600 hover:bg-emerald-700',
};

export const NEXT_ACTION_ICON: Record<Exclude<QueueNextAction['kind'], 'blocked'>, LucideIcon> = {
  check_in: UserCheck,
  seat: Scissors,
  start_item: Scissors,
  finish_item: CheckCircle,
  pay_service: CreditCard,
  pay_tip: Award,
  pay_combined: CreditCard,
};

export { nextActionLabelKey } from '@/features/queue/nextAction';

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
  roomId?: string;
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
  /** 到店问卷是否已签齐。来自队列查询，`healthFormHonesty()` 的唯一真值来源。 */
  intakeSigned?: boolean;
  massagePreference?: string;
  /** 未到店预约卡的项目明细（一预约多项目时逐条展示）。 */
  bookedItems?: Array<{
    itemId: string;
    serviceName: string;
    durationMin: number;
    priceCents: number;
    staffName: string | null;
    startTime: string;
  }>;
  rawItem?: ScheduleItem;
  rawQueue?: QueueEntry;
  rawTicket?: TicketSummary;
}

export interface ColumnConfig {
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
export const COLUMNS: ColumnConfig[] = [
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
