import { useEntitlements } from '@/features/billing/useEntitlements';
import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';
import { useSchedule, useScheduleMutations, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { isOverridableConflict, OVERRIDE_REASONS, type Override } from '@/features/schedule/api';
import type { CreateBundleSelectionInput } from '@/features/schedule/api';
import { deskAppointmentCustomer } from '@/features/schedule/deskCustomer';
import { useSaveCustomerProfile } from '@/features/customers/api';
import { useCan } from '@/lib/permissions';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { useBundleCatalogQuery, quoteBundle } from '@/features/bundles/api';
import type { BundleQuoteResult, BundleTemplateView } from '@/features/bundles/types';
import { wallMinutesToInstant, instantToWallDate, nowWallHhMm } from '@/lib/time';
import { useErrorMessage } from '@/lib/errorMessage';
import { centsToDollars } from '@/features/checkout/api';
import { toast } from '@heroui/react';
import { useFieldErrors } from '@/lib/formFeedback';
import { parseDurationMinutes } from '@/lib/validation';
import type { DurationReason, ParseResult } from '@/lib/validation';
import { cn, formatPhoneInput, formatPhoneDisplay } from '@/lib/utils';
import {
  Calendar,
  Clock,
  User,
  Scissors,
  Users,
  AlertTriangle,
  Sparkles,
  Plus,
  Trash2,
  Layers,
  Zap,
  FastForward,
  Package,
} from 'lucide-react';

export interface CreateAppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultDate?: string;
  defaultStaffId?: string;
  defaultTime?: string;
  defaultCustomerName?: string;
  defaultPhone?: string;
  defaultServiceId?: string;
}

export interface AppointmentItemDraft {
  id: string;
  serviceId: string;
  membershipId: string;
  startTime: string; // HH:mm
  /** 已确认的有效时长（分钟）。预约起止、价格预览、提交都读它，永远是合法整数 */
  durationMin: number;
  /** 时长输入框正在编辑的原文。允许编辑过程中暂时为空或非法；失焦/提交才收敛 */
  durationText: string;
  priceCents: number;
  isRequest: boolean;
}

/**
 * 预约项时长的服务端契约：正整数、上限 600 分钟
 * （`packages/contracts/src/commands/appointment.ts` 的 `durationMin`）。
 * 目录 SaveService 的 5 分钟下限是目录侧的约束，不套到预约 override 上。
 */
const DURATION_MIN = 1;
const DURATION_MAX = 600;

type DurationParse = ParseResult<number, DurationReason>;

/**
 * 只在失焦/提交时调用 —— 逐次按键不做任何强制回填。
 *
 * 判定本身已收进 `lib/validation`，此处仅固定本场景的边界：预约内对单项时长的
 * 覆盖允许低到 1 分钟（前台按实际情况微调），而目录里新建项目不得短于 5 分钟。
 * 两者是不同的业务约束，因此下限由调用方给出而非写死在规则层。
 */
export const parseDuration = (text: string): DurationParse =>
  parseDurationMinutes(text, { min: DURATION_MIN, max: DURATION_MAX });

const timeToMins = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const minsToTime = (mins: number) => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

/**
 * 新建预约弹窗打开时，默认落在哪个日期与钟点（U03「预约偶尔变昨天」）。
 *
 * 规则（计划 §6.1）：
 *  · 有 `defaultDate`（日历格子、日历页顶部新建）→ 按其明确选择，不改；
 *  · 无 `defaultDate`（全局「新建预约」、Queue、Calls 带号）→ 门店**日历日**今天，
 *    **不是营业日**（营业日在 cutoff 前是昨天）；
 *  · 有 `defaultTime`（日历格子）→ 按格子的钟点；
 *  · 目标日期就是今天 → 门店墙上钟点按 30 分钟步长向上取整，落在营业时段内才用，
 *    否则退到开门时间；
 *  · 目标日期不是今天（未来日 / 历史补录）→ 一律从开门时间起，不把「现在」的钟点套上去。
 *
 * ## 跨午夜营业（`closeMin > 1440`，计划 §6.1–§6.2）
 *
 * 例：10:00 开、次日 02:00 打烊（`closeMin = 1560`）。此刻墙上 01:30，`calendarToday`
 * 已经是次日的日历日 —— 门店其实**还在营业**（属于昨日营业日的凌晨延长段）。
 * 旧逻辑因 `snapped(90) < openMin(600)` 把默认退到开门时间 10:00，是错的。
 * 现在：识别「墙上钟点 + 1440 仍落在延长营业段内」，直接用当前钟点（`calendarToday`
 * 01:30），提交时由 `wallMinutesToInstant` 得到唯一时刻。
 *
 * 纯函数：时区换算（`calendarToday` / `nowWallMinutes`）由调用方在 effect 里算好传入。
 */
export function resolveInitialDateTime(params: {
  defaultDate?: string;
  defaultTime?: string;
  calendarToday: string;
  nowWallMinutes: number;
  openMin: number;
  closeMin: number;
}): { date: string; time: string } {
  const targetDate = params.defaultDate || params.calendarToday;
  if (params.defaultTime) return { date: targetDate, time: params.defaultTime };
  if (targetDate !== params.calendarToday) {
    return { date: targetDate, time: minsToTime(params.openMin) };
  }
  const snapped = Math.ceil(params.nowWallMinutes / 30) * 30;
  const inRegularWindow = snapped >= params.openMin && snapped < params.closeMin - 30;
  // 跨午夜营业：当前是凌晨（早于开门），但把它当作「昨日营业日 + 24h」看仍在营业段内。
  // 尾段贴着打烊时刻，不套常规窗口那 30 分钟余量（那是白天的排期余地，凌晨这头
  // 更在意「别把 01:45 的新建默认踢回 10:00」）。
  const inCrossMidnightTail =
    params.closeMin > 1440 &&
    snapped < params.openMin &&
    snapped + 1440 < params.closeMin;
  const startM = inRegularWindow || inCrossMidnightTail ? snapped : params.openMin;
  return { date: targetDate, time: minsToTime(startM) };
}

/**
 * 组合套餐（U10）选择草稿 → `appointment.create` 的 `bundleSelections` 载荷。
 *
 * 纯函数，便于单测：展开顺序、金额、排程都由服务端按 `bundle.quote` 完成，
 * 这里只把「第一个子项开始时刻 + 各执行单元派给谁」整理成契约形状。
 * `unitOverrides` 与 `quote.units` 顺序一一对应；未指派技师留 `null`（进待分配池）。
 * 买两份同一套餐 = 调两次本函数并把结果拼接。
 */
export interface BundleUnitAssignmentDraft {
  /** UNASSIGNED_STAFF_ID 或真实 membershipId。 */
  membershipId: string;
  isRequest: boolean;
}

export function buildBundleSelections(params: {
  bundleId: string;
  expectedVersion?: number;
  startsAt: string;
  unitCount: number;
  assignments: BundleUnitAssignmentDraft[];
  unassignedId: string;
  /** 额外加项，`attachToUnit` 用 `quote` 的 `unitKey`；金额由服务端算。 */
  extraAddons?: Array<{ ref: string; attachToUnit: string; serviceId: string; qty: number }>;
}): CreateBundleSelectionInput[] {
  const unitOverrides = Array.from({ length: params.unitCount }, (_, i) => {
    const a = params.assignments[i];
    const assigned = a && a.membershipId && a.membershipId !== params.unassignedId;
    return {
      membershipId: assigned ? a!.membershipId : null,
      resourceId: null,
      isRequest: assigned ? Boolean(a!.isRequest) : false,
    };
  });
  return [{
    bundleId: params.bundleId,
    ...(params.expectedVersion ? { expectedVersion: params.expectedVersion } : {}),
    startsAt: params.startsAt,
    unitOverrides,
    ...(params.extraAddons?.length ? { extraAddons: params.extraAddons } : {}),
  }];
}

/** label/desc 只存词典键，id 是唯一持久化/比对的值 */
const PAST_BOOKING_REASONS: Array<{ id: string; labelKey: TranslationKey; descKey: TranslationKey }> = [
  { id: 'walk_in_backfill', labelKey: 'schedule.apptReasonWalkInLabel', descKey: 'schedule.apptReasonWalkInDesc' },
  { id: 'phone_offline', labelKey: 'schedule.apptReasonPhoneOfflineLabel', descKey: 'schedule.apptReasonPhoneOfflineDesc' },
  { id: 'guest_delayed', labelKey: 'schedule.apptReasonGuestDelayedLabel', descKey: 'schedule.apptReasonGuestDelayedDesc' },
  { id: 'other', labelKey: 'schedule.apptReasonOtherLabel', descKey: 'schedule.apptReasonOtherDesc' },
];

const formatPastDuration = (mins: number, t: (key: TranslationKey, params?: Record<string, string | number>) => string) => {
  if (mins < 60) return t('schedule.apptDurationMinutes', { p0: mins });
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return remMins > 0
      ? t('schedule.apptDurationHoursMinutes', { p0: hours, p1: remMins })
      : t('schedule.apptDurationHours', { p0: hours });
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0
    ? t('schedule.apptDurationDaysHours', { p0: days, p1: remHours })
    : t('schedule.apptDurationDays', { p0: days });
};

export function CreateAppointmentModal({
  isOpen,
  onClose,
  defaultDate,
  defaultStaffId,
  defaultTime,
  defaultCustomerName = '',
  defaultPhone = '',
  defaultServiceId,
}: CreateAppointmentModalProps) {
  const voiceOnly = useEntitlements().data?.plan === 'voice_booking';
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { services, staff, currentDate, timezone, openMin, closeMin, setCurrentDate } = useSchedule();
  const { create } = useScheduleMutations();
  const saveProfile = useSaveCustomerProfile();

  const [customerName, setCustomerName] = useState(defaultCustomerName);
  const [phone, setPhone] = useState(defaultPhone);
  const [date, setDate] = useState(defaultDate || currentDate);
  const [notes, setNotes] = useState('');
  /*
   * 顾客姓名的字段级校验。此前是手写的 `nameError` 布尔：红框与提示文案都有，
   * 但不聚焦、不滚动，且无论字段是否在视口内都照弹 toast。改用共享 hook，
   * 与全站其余表单保持同一套行为。
   */
  const apptForm = useFieldErrors<'customerName'>();

  // 聚合多项目行列表
  const [items, setItems] = useState<AppointmentItemDraft[]>([]);

  /**
   * 草稿生命周期。
   *
   * 初始化 effect 的依赖里有 `services` / `staff` —— `useDaySnapshot` 每次
   * 后台 refetch 都会给这两个数组换新引用，历史上这会把用户已经改过的
   * 时长、日期、客户、备注整个重置掉（U03/U11 的「数字跳回去」）。
   *
   * 现在：一次「打开」只播种一次；用户一旦动过任何字段（`dirtyRef`），
   * refetch 和切换日期都不再重置草稿。关闭时清掉标记，下次打开重新播种。
   */
  const seededRef = React.useRef(false);
  const dirtyRef = React.useRef(false);
  const markDirty = () => {
    dirtyRef.current = true;
  };

  // 过去时间强提醒模态状态
  const [pastTimeConfirmModal, setPastTimeConfirmModal] = useState<{
    isOpen: boolean;
    pastMinutes: number;
    reason: string;
    notes: string;
  } | null>(null);

  // 冲突放行模态状态
  const [conflictError, setConflictError] = useState<{ message: string; key: string } | null>(null);
  const [overrideReason, setOverrideReason] = useState<Override['reason']>('desk_coordination');

  // ── 组合套餐（U10）─────────────────────────────────────────────────────
  const canAppointmentWrite = useCan('appointment.write');
  const [mode, setMode] = useState<'items' | 'bundle'>('items');
  const [selectedBundleId, setSelectedBundleId] = useState('');
  const [bundleStartTime, setBundleStartTime] = useState('10:00');
  const [unitStaff, setUnitStaff] = useState<BundleUnitAssignmentDraft[]>([]);
  /** 额外加项：不在套餐模板内、按正常价追加，归属到某个执行单元（`attachToUnit` = quote 的 `unitKey`）。 */
  const [bundleExtraAddons, setBundleExtraAddons] = useState<
    Array<{ ref: string; attachToUnit: string; serviceId: string; qty: number }>
  >([]);
  const [bundleQuote, setBundleQuote] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    data: BundleQuoteResult | null;
  }>({ status: 'idle', data: null });
  // 加项变化要重新报价；用稳定字符串做 effect 依赖。
  const bundleExtraAddonsKey = useMemo(
    () => JSON.stringify(bundleExtraAddons.map((a) => [a.attachToUnit, a.serviceId, a.qty])),
    [bundleExtraAddons],
  );

  // 只在弹窗打开且切到「套餐」标签后才拉目录；避免每次开弹窗都打一发请求。
  const bundleCatalog = useBundleCatalogQuery({
    enabled: !voiceOnly && isOpen && canAppointmentWrite && mode === 'bundle',
  });
  const bundleTemplates = useMemo<BundleTemplateView[]>(
    () => (bundleCatalog.data?.templates ?? []).filter((b) => b.active),
    [bundleCatalog.data],
  );
  const selectedBundle = useMemo(
    () => bundleTemplates.find((b) => b.id === selectedBundleId) ?? null,
    [bundleTemplates, selectedBundleId],
  );
  // 组成项目名：quote 的 unit 只给 serviceId / componentId，名称从模板 components 取。
  const componentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of selectedBundle?.components ?? []) m.set(c.componentId, c.serviceName);
    return m;
  }, [selectedBundle]);
  const bundleAvailableAddons = useMemo(
    () => bundleCatalog.data?.availableAddons ?? [],
    [bundleCatalog.data],
  );
  const bundleAddonById = useMemo(
    () => new Map(bundleAvailableAddons.map((a) => [a.id, a])),
    [bundleAvailableAddons],
  );

  const addBundleAddon = (unitKey: string, serviceId: string) => {
    if (!serviceId) return;
    markDirty();
    setBundleExtraAddons((prev) => [
      ...prev,
      { ref: crypto.randomUUID(), attachToUnit: unitKey, serviceId, qty: 1 },
    ]);
  };
  const removeBundleAddon = (ref: string) => {
    markDirty();
    setBundleExtraAddons((prev) => prev.filter((a) => a.ref !== ref));
  };
  const setBundleAddonQty = (ref: string, qty: number) => {
    markDirty();
    setBundleExtraAddons((prev) => prev.map((a) => (
      a.ref === ref ? { ...a, qty: Math.min(20, Math.max(1, Number.isFinite(qty) ? qty : 1)) } : a
    )));
  };

  const availableStaff = useMemo(() => {
    return staff.filter((s) => s.membershipId === UNASSIGNED_STAFF_ID || s.isBookable);
  }, [staff]);

  /**
   * 选中套餐（或版本 / 加项变化）后取服务端权威报价。金额、展开顺序、排程都以
   * `quote` 为准，前端不自算。加项变化会重新报价 —— 此时**保留**已指派的技师
   * （单元数不变），只在首次报价或单元数变化时按默认技师铺一遍。
   */
  useEffect(() => {
    if (!isOpen || mode !== 'bundle') return;
    const tpl = bundleTemplates.find((b) => b.id === selectedBundleId);
    if (!tpl) {
      setBundleQuote({ status: 'idle', data: null });
      return;
    }
    let cancelled = false;
    setBundleQuote((prev) => ({ status: 'loading', data: prev.data }));
    quoteBundle({
      bundleId: tpl.id,
      expectedVersion: tpl.version,
      ...(bundleExtraAddons.length
        ? {
            extraAddons: bundleExtraAddons.map((a) => ({
              ref: a.ref, attachToUnit: a.attachToUnit, serviceId: a.serviceId, qty: a.qty,
            })),
          }
        : {}),
    })
      .then((res) => {
        if (cancelled) return;
        setBundleQuote({ status: 'ready', data: res });
        setUnitStaff((prev) => (
          prev.length === res.units.length
            ? prev
            : res.units.map((_, i) => prev[i] ?? {
                membershipId: defaultStaffId || UNASSIGNED_STAFF_ID,
                isRequest: false,
              })
        ));
      })
      .catch(() => {
        if (!cancelled) setBundleQuote({ status: 'error', data: null });
      });
    return () => {
      cancelled = true;
    };
    // bundleExtraAddons 经 bundleExtraAddonsKey 参与依赖（内容变化才重新报价）。
  }, [isOpen, mode, selectedBundleId, bundleTemplates, bundleExtraAddonsKey, bundleExtraAddons, defaultStaffId]);

  // 初始化多项目
  useEffect(() => {
    if (!isOpen) {
      seededRef.current = false;
      dirtyRef.current = false;
      return;
    }
    // 已播种且用户动过草稿：后台 refetch（services/staff 换引用）与切日期都不再重置
    if (seededRef.current && dirtyRef.current) return;

    setCustomerName(defaultCustomerName);
    setPhone(defaultPhone);
    setNotes('');
    apptForm.clear();
    setConflictError(null);
    setPastTimeConfirmModal(null);

    // 时区换算（不纯的部分）在这里做，落点规则交给 resolveInitialDateTime
    const nowIso = new Date().toISOString();
    const calendarToday = timezone ? instantToWallDate(nowIso, timezone) : currentDate;
    const nowWall = timezone
      ? nowWallHhMm(timezone)
      : `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;

    const { date: targetDate, time: initialTime } = resolveInitialDateTime({
      defaultDate,
      defaultTime,
      calendarToday,
      nowWallMinutes: timeToMins(nowWall),
      openMin,
      closeMin,
    });
    setDate(targetDate);
    setBundleStartTime(initialTime);
    setMode('items');
    setSelectedBundleId('');
    setUnitStaff([]);
    setBundleExtraAddons([]);
    setBundleQuote({ status: 'idle', data: null });

    const firstSvc = services.find((s) => s.id === defaultServiceId) || services[0];
    const initialStaffId = defaultStaffId || UNASSIGNED_STAFF_ID;
    const initialDuration = firstSvc?.durationMin || 60;

    setItems([
      {
        id: crypto.randomUUID(),
        serviceId: firstSvc?.id || '',
        membershipId: initialStaffId,
        startTime: initialTime,
        durationMin: initialDuration,
        durationText: String(initialDuration),
        priceCents: firstSvc?.priceCents || 0,
        isRequest: false,
      },
    ]);
    seededRef.current = true;
  }, [
    isOpen,
    defaultDate,
    defaultStaffId,
    defaultTime,
    defaultCustomerName,
    defaultPhone,
    defaultServiceId,
    services,
    staff,
    currentDate,
    timezone,
    openMin,
    closeMin,
  ]);

  // 添加服务项目行
  const handleAddItem = () => {
    const defaultSvc = services[0];
    if (!defaultSvc) return;
    markDirty();

    // 默认接在最后一个项目结束后开始
    const lastItem = items[items.length - 1];
    let nextStart = lastItem?.startTime || '10:00';
    if (lastItem) {
      const endMins = timeToMins(lastItem.startTime) + (lastItem.durationMin || 30);
      nextStart = minsToTime(endMins);
    }

    // 寻找下一个可用的不同技师
    const usedStaffIds = new Set(items.map((i) => i.membershipId));
    const nextStaff = availableStaff.find(
      (s) => s.membershipId !== UNASSIGNED_STAFF_ID && !usedStaffIds.has(s.membershipId),
    );

    const addDuration = defaultSvc.durationMin || 60;
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        serviceId: defaultSvc.id,
        membershipId: nextStaff?.membershipId || UNASSIGNED_STAFF_ID,
        startTime: nextStart,
        durationMin: addDuration,
        durationText: String(addDuration),
        priceCents: defaultSvc.priceCents || 0,
        isRequest: false,
      },
    ]);
  };

  // 删除项目行
  const handleRemoveItem = (id: string) => {
    if (items.length <= 1) {
      toast.danger(t('schedule.apptKeepOneService'));
      return;
    }
    markDirty();
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  // 修改单行属性
  const handleUpdateItem = (id: string, patch: Partial<AppointmentItemDraft>) => {
    markDirty();
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        let nextDuration = item.durationMin;
        let nextDurationText = item.durationText;
        let nextPrice = item.priceCents;

        // 切换服务：目录默认时长只在这一刻填入，之后店主手改的值不被后续刷新冲掉
        if (patch.serviceId && patch.serviceId !== item.serviceId) {
          const svc = services.find((s) => s.id === patch.serviceId);
          if (svc) {
            nextDuration = svc.durationMin;
            nextDurationText = String(svc.durationMin);
            nextPrice = svc.priceCents;
          }
        }

        // 时长输入：逐次按键只存原文，能解析成合法值才更新已确认时长；否则保留上一个合法值
        if (patch.durationText !== undefined) {
          nextDurationText = patch.durationText;
          const parsed = parseDuration(patch.durationText);
          if (parsed.ok) nextDuration = parsed.value;
        }

        let nextMembershipId = patch.membershipId !== undefined ? patch.membershipId : item.membershipId;
        let nextIsRequest = patch.isRequest !== undefined ? patch.isRequest : item.isRequest;

        // 如果开启点钟，技师绝不能是待分配
        if (nextIsRequest && nextMembershipId === UNASSIGNED_STAFF_ID) {
          const firstBookable = availableStaff.find(
            (s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable
          );
          if (firstBookable) {
            nextMembershipId = firstBookable.membershipId;
          }
        }
        // 如果选择待分配，则自动取消点钟标记
        if (nextMembershipId === UNASSIGNED_STAFF_ID) {
          nextIsRequest = false;
        }

        return {
          ...item,
          ...patch,
          membershipId: nextMembershipId,
          isRequest: nextIsRequest,
          durationMin: nextDuration,
          durationText: nextDurationText,
          priceCents: patch.priceCents ?? nextPrice,
        };
      }),
    );
  };

  /** 时长框失焦：合法则规范化（去空格 / "090"→"90"），非法则原样留着让行内错误显示 */
  const handleDurationBlur = (id: string) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const parsed = parseDuration(item.durationText);
        if (!parsed.ok) return item;
        return { ...item, durationMin: parsed.value, durationText: String(parsed.value) };
      }),
    );
  };

  const durationErrorText = (reason: 'empty' | 'format' | 'range'): string =>
    reason === 'empty'
      ? t('schedule.apptDurationRequired')
      : reason === 'range'
      ? t('schedule.apptDurationRange')
      : t('schedule.apptDurationInvalid');

  // 计算当前时间编排模式（同时并行 vs 顺次接力 vs 自定义）
  const activeAlignMode = useMemo<'parallel' | 'sequential' | 'custom' | null>(() => {
    if (items.length <= 1) return null;
    const firstStart = items[0].startTime;
    const isAllParallel = items.every((i) => i.startTime === firstStart);
    if (isAllParallel) return 'parallel';

    let isSequential = true;
    let expectedStart = timeToMins(firstStart);
    for (let i = 0; i < items.length; i++) {
      if (i > 0 && timeToMins(items[i].startTime) !== expectedStart) {
        isSequential = false;
        break;
      }
      expectedStart += items[i].durationMin;
    }
    if (isSequential) return 'sequential';
    return 'custom';
  }, [items]);

  // 一键编排：全部同时进行 (Parallel)
  const handleAlignParallel = () => {
    if (items.length === 0) return;
    const baseTime = items[0].startTime;
    const isAlreadyParallel = items.every((i) => i.startTime === baseTime);
    if (isAlreadyParallel) {
      toast.info(t('schedule.apptAlreadyParallel', { p0: baseTime }));
      return;
    }
    markDirty();
    setItems((prev) => prev.map((item) => ({ ...item, startTime: baseTime })));
    toast.success(
      t('schedule.apptAlignedParallelDynamic', {
        p0: items.length,
        p1: baseTime,
        p2: summary.staffCount || items.length,
      }),
    );
  };

  // 一键编排：按序顺次接力 (Sequential)
  const handleAlignSequential = () => {
    if (items.length === 0) return;
    let wasAlreadySequential = true;
    let checkMins = timeToMins(items[0].startTime);
    for (let idx = 0; idx < items.length; idx++) {
      if (idx > 0 && timeToMins(items[idx].startTime) !== checkMins) {
        wasAlreadySequential = false;
        break;
      }
      checkMins += items[idx].durationMin;
    }

    if (wasAlreadySequential && items.length > 1) {
      toast.info(t('schedule.apptAlreadySequential'));
      return;
    }

    markDirty();
    let currentMins = timeToMins(items[0].startTime);
    let totalDuration = 0;
    const nextItems = items.map((item, idx) => {
      totalDuration += item.durationMin;
      if (idx === 0) {
        currentMins += item.durationMin;
        return item;
      }
      const assignedTime = minsToTime(currentMins);
      currentMins += item.durationMin;
      return { ...item, startTime: assignedTime };
    });

    setItems(nextItems);

    const firstStart = nextItems[0].startTime;
    const finalEnd = minsToTime(timeToMins(firstStart) + totalDuration);
    toast.success(
      t('schedule.apptCascadedDynamic', {
        p0: firstStart,
        p1: finalEnd,
        p2: totalDuration,
      }),
    );
  };

  // 聚合指标计算
  const summary = useMemo(() => {
    if (items.length === 0) {
      return { totalDuration: 0, totalPriceCents: 0, earliestStart: '--:--', latestEnd: '--:--', staffCount: 0 };
    }

    let minStartMins = Infinity;
    let maxEndMins = -Infinity;
    let totalPrice = 0;
    const staffSet = new Set<string>();

    for (const item of items) {
      const sMins = timeToMins(item.startTime);
      const eMins = sMins + (item.durationMin || 0);
      if (sMins < minStartMins) minStartMins = sMins;
      if (eMins > maxEndMins) maxEndMins = eMins;
      totalPrice += item.priceCents || 0;
      if (item.membershipId && item.membershipId !== UNASSIGNED_STAFF_ID) {
        staffSet.add(item.membershipId);
      }
    }

    const totalSpan = maxEndMins > minStartMins ? maxEndMins - minStartMins : 0;

    return {
      totalDuration: totalSpan,
      totalPriceCents: totalPrice,
      earliestStart: minStartMins !== Infinity ? minsToTime(minStartMins) : '--:--',
      latestEnd: maxEndMins !== -Infinity ? minsToTime(maxEndMins) : '--:--',
      staffCount: staffSet.size,
    };
  }, [items]);

  // 套餐模式下「最早开始」就是套餐起点，其余子项顺排在后。
  const earliestStartTime = mode === 'bundle' ? bundleStartTime : summary.earliestStart;
  // 报价就绪后的快照。取成独立 const 便于在 map 闭包里保持非空收窄。
  const readyQuote = bundleQuote.status === 'ready' ? bundleQuote.data : null;

  // 计算最早已过去时间（是否早于当前时刻 30 分钟）
  const pastMinutes = useMemo(() => {
    if (!date || earliestStartTime === '--:--') return 0;
    try {
      const startsAt = wallMinutesToInstant(date || currentDate, timeToMins(earliestStartTime), timezone);
      const apptTimestamp = new Date(startsAt).getTime();
      const nowTimestamp = Date.now();
      return Math.round((nowTimestamp - apptTimestamp) / 60000);
    } catch {
      return 0;
    }
  }, [date, earliestStartTime, currentDate, timezone]);

  const isPastOver30Min = pastMinutes > 30;

  // 提交创建聚合预约
  const handleSubmit = async (override?: Override, retryKey?: string, customNotes?: string) => {
    if (!customerName.trim()) {
      apptForm.fail('customerName', t('schedule.apptNameRequired'));
      return;
    }
    if (mode === 'bundle') {
      if (!selectedBundleId || bundleQuote.status !== 'ready' || !bundleQuote.data) {
        toast.danger(t('bundle.pickerQuoteFailed'));
        return;
      }
    } else {
      if (items.length === 0) {
        toast.danger(t('schedule.apptServiceRequired'));
        return;
      }
      // 时长非法就地拦下 —— 不把空值当 30 分钟、也不把 "60abc" 截成 60 提交
      const badDuration = items
        .map((it) => parseDuration(it.durationText))
        .find((p): p is Extract<DurationParse, { ok: false }> => !p.ok);
      if (badDuration) {
        toast.danger(durationErrorText(badDuration.reason));
        return;
      }
    }

    const idempotencyKey = retryKey || crypto.randomUUID();
    const finalNotes = (customNotes !== undefined ? customNotes : notes).trim() || undefined;

    const payloadItems = items.map((it) => {
      const startsAt = wallMinutesToInstant(date || currentDate, timeToMins(it.startTime), timezone);
      return {
        serviceId: it.serviceId,
        membershipId: it.membershipId === UNASSIGNED_STAFF_ID ? null : it.membershipId,
        startsAt,
        durationMin: it.durationMin,
        isRequest: it.isRequest,
      };
    });

    try {
      const identity = deskAppointmentCustomer({ name: customerName, phone });
      let customerId: string | null = null;
      let walkInName: string | undefined;
      if (identity.mode === 'profile') {
        const saved = await saveProfile.mutateAsync({
          name: identity.name,
          phoneE164: identity.phoneE164,
        });
        customerId = saved.customerId;
      } else {
        walkInName = identity.walkInName;
      }

      if (mode === 'bundle' && bundleQuote.data) {
        const startsAt = wallMinutesToInstant(
          date || currentDate, timeToMins(bundleStartTime), timezone,
        );
        const bundleSelections = buildBundleSelections({
          bundleId: selectedBundleId,
          expectedVersion: bundleQuote.data.version,
          startsAt,
          unitCount: bundleQuote.data.units.length,
          assignments: unitStaff,
          unassignedId: UNASSIGNED_STAFF_ID,
          extraAddons: bundleExtraAddons,
        });
        await create.mutateAsync({
          customerId,
          walkInName,
          items: [],
          bundleSelections,
          notes: finalNotes,
          override,
          idempotencyKey,
        });
        toast.success(t('saved') || t('schedule.apptCreated'));
        setCurrentDate(date || currentDate);
        onClose();
        return;
      }

      await create.mutateAsync({
        customerId,
        walkInName,
        items: payloadItems,
        notes: finalNotes,
        override,
        idempotencyKey,
      });

      toast.success(
        items.length > 1
          ? t('schedule.apptCreatedMulti', { p0: items.length, p1: summary.staffCount })
          : (t('saved') || t('schedule.apptCreated')),
      );
      setCurrentDate(date || currentDate);
      onClose();
    } catch (err: any) {
      if (isOverridableConflict(err)) {
        const conflictMsg =
          err.code === 'STAFF_OVER_CAPACITY'
            ? t('schedule.apptConflictStaffOverCapacity')
            : err.code === 'LOCATION_OVER_CAPACITY'
            ? t('schedule.apptConflictLocationOverCapacity')
            : err.code === 'STAFF_LACKS_SKILL'
            ? t('schedule.apptConflictStaffLacksSkill')
            : t('schedule.apptConflictGeneric');
        setConflictError({ message: conflictMsg, key: idempotencyKey });
      } else {
        // 组合套餐专属失败：服务端把成因放在 details.reason（见 BundleManagerPanel）。
        const reason = (err as { details?: { reason?: string } })?.details?.reason;
        if (reason === 'bundle_version_conflict') toast.danger(t('bundle.errVersionConflict'));
        else if (reason === 'bundle_service_inactive') toast.danger(t('bundle.errInactiveService'));
        else if (reason === 'bundle_not_found') toast.danger(t('bundle.errNotFound'));
        else toast.danger(errorMessage(err));
      }
    }
  };

  const handleInitialSubmit = () => {
    apptForm.clear();
    if (!customerName.trim()) {
      apptForm.fail('customerName', t('schedule.apptNameRequired2'));
      return;
    }
    if (mode === 'bundle') {
      if (!selectedBundleId) {
        toast.danger(t('bundle.pickerPlaceholder'));
        return;
      }
      if (bundleQuote.status === 'loading') {
        toast.danger(t('bundle.pickerLoadingQuote'));
        return;
      }
      if (bundleQuote.status !== 'ready' || !bundleQuote.data) {
        toast.danger(t('bundle.pickerQuoteFailed'));
        return;
      }
    } else {
      if (items.some((i) => !i.serviceId)) {
        toast.danger(t('schedule.apptServicePerRow'));
        return;
      }
      const firstBadDuration = items
        .map((it) => parseDuration(it.durationText))
        .find((p): p is Extract<DurationParse, { ok: false }> => !p.ok);
      if (firstBadDuration) {
        toast.danger(durationErrorText(firstBadDuration.reason));
        return;
      }
    }

    if (isPastOver30Min) {
      setPastTimeConfirmModal({
        isOpen: true,
        pastMinutes,
        reason: 'walk_in_backfill',
        notes: '',
      });
      return;
    }

    void handleSubmit();
  };

  const handleConfirmPastBooking = () => {
    if (!pastTimeConfirmModal) return;
    const reasonKey = PAST_BOOKING_REASONS.find((r) => r.id === pastTimeConfirmModal.reason)?.labelKey;
    const reasonText = reasonKey ? t(reasonKey) : t('schedule.apptBackfillReasonDefault');
    const noteSuffix = pastTimeConfirmModal.notes.trim() ? ` · ${pastTimeConfirmModal.notes.trim()}` : '';
    const backfillNote = t('schedule.apptBackfillNoteWrap', { p0: `${reasonText}${noteSuffix}` });
    const updatedNotes = notes.trim()
      ? `${notes.trim()} ${backfillNote}`
      : backfillNote;

    setPastTimeConfirmModal(null);
    void handleSubmit(undefined, undefined, updatedNotes);
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={t('newAppointment')}
        description={t('schedule.apptModalDesc')}
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2.5 w-full">
            <Button variant="secondary" onClick={onClose} className="px-4">
              {t('cancel') || t('schedule.apptCancel')}
            </Button>
            <Button
              className={cn(
                'text-white font-bold px-6 transition-all shadow-sm',
                isPastOver30Min
                  ? 'bg-amber-600 hover:bg-amber-700 shadow-amber-600/20'
                  : 'bg-teal-600 hover:bg-teal-700 shadow-teal-600/20',
              )}
              isPending={create.isPending}
              onClick={handleInitialSubmit}
            >
              {create.isPending
                ? t('schedule.apptCreating')
                : isPastOver30Min
                ? t('schedule.apptBackfillWarn', { p0: formatPastDuration(pastMinutes, t) })
                : (t('newAppointment') || t('schedule.apptCreateNow'))}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-sm max-h-[72vh] overflow-y-auto custom-scrollbar px-1">
          {/* 顾客基本信息 */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-teal-600" />
                  {t('customerName') || t('schedule.apptCustomerName')} *
                </label>
                <Input
                  {...apptForm.bind('customerName')}
                  value={customerName}
                  onChange={(e) => {
                    markDirty();
                    setCustomerName(e.target.value);
                    apptForm.clearField('customerName');
                  }}
                  placeholder={t('schedule.apptNamePlaceholder')}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('phone') || t('schedule.apptPhoneOptional')}
                </label>
                <Input type="tel"
                  value={phone}
                  onChange={(e) => {
                    markDirty();
                    setPhone(e.target.value);
                  }}
                  placeholder="(555) 000-0000"
                  maxLength={32}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-teal-600" />
                  {t('date') || t('schedule.apptDate')}
                </label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    markDirty();
                    setDate(e.target.value);
                  }}
                />
              </div>
            </div>
          </div>

          {/* 单项 / 组合套餐 切换（U10）*/}
          {!voiceOnly && <>
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-fit">
            {(['items', 'bundle'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { markDirty(); setMode(m); }}
                className={cn(
                  'flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg cursor-pointer transition-all',
                  mode === m ? 'bg-white text-teal-700 shadow-2xs' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                {m === 'items' ? <Scissors className="w-3 h-3" /> : <Package className="w-3 h-3" />}
                <span>{m === 'items' ? t('bundle.pickerModeSingle') : t('bundle.pickerModeBundle')}</span>
              </button>
            ))}
          </div>

          </>}
          {/* 多项目与多技师指派行编辑器 */}
          {mode === 'items' && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <Scissors className="w-3.5 h-3.5 text-teal-600" />

                  {t('schedule.apptServiceListPrefix')}{items.length})
                </span>
              </div>

              {items.length > 1 && (
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                  <button
                    type="button"
                    onClick={handleAlignParallel}
                    className={cn(
                      "flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg cursor-pointer transition-all",
                      activeAlignMode === 'parallel'
                        ? "bg-teal-600 text-white shadow-xs"
                        : "bg-white text-slate-700 hover:text-teal-700 shadow-2xs"
                    )}
                    title={t('schedule.apptParallelHint')}
                  >
                    <Zap className={cn("w-3 h-3", activeAlignMode === 'parallel' ? "text-amber-300" : "text-amber-500")} />
                    <span>{t('schedule.apptParallel')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleAlignSequential}
                    className={cn(
                      "flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg cursor-pointer transition-all",
                      activeAlignMode === 'sequential'
                        ? "bg-teal-600 text-white shadow-xs"
                        : "bg-white text-slate-700 hover:text-teal-700 shadow-2xs"
                    )}
                    title={t('schedule.apptSequentialHint')}
                  >
                    <FastForward className={cn("w-3 h-3", activeAlignMode === 'sequential' ? "text-white" : "text-teal-600")} />
                    <span>{t('schedule.apptSequential')}</span>
                  </button>
                </div>
              )}
            </div>

            {/* 项目列表卡片 */}
            <div className="space-y-2.5">
              {items.map((item, index) => {
                const svc = services.find((s) => s.id === item.serviceId);
                const endMins = timeToMins(item.startTime) + (item.durationMin || 30);
                const itemEnd = minsToTime(endMins);
                const durationParse = parseDuration(item.durationText);
                const durationError = durationParse.ok ? null : durationErrorText(durationParse.reason);

                return (
                  <div
                    key={item.id}
                    className="p-3 bg-white border border-slate-200 rounded-2xl space-y-3 shadow-2xs hover:border-teal-300 transition-all"
                  >
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-teal-50 text-teal-700 border border-teal-200 flex items-center justify-center text-[10px] font-bold">
                          {index + 1}
                        </span>
                        <span className="font-bold text-xs text-slate-900">
                          {svc ? svc.name : t('schedule.apptSelectService')}
                        </span>
                        <span className="text-[11px] text-teal-700 font-semibold">
                          ${centsToDollars(item.priceCents)}
                        </span>
                      </div>

                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(item.id)}
                          className="text-slate-400 hover:text-rose-600 p-1 cursor-pointer transition-colors"
                          title={t('schedule.apptRemoveRow')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* 服务选择 (Col 1) */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 mb-1">
                          {t('schedule.apptCategory')}
                        </label>
                        <select
                          value={item.serviceId}
                          onChange={(e) => handleUpdateItem(item.id, { serviceId: e.target.value })}
                          className="w-full h-9 px-2.5 py-1 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 bg-white font-medium truncate"
                        >
                          {services.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} (${centsToDollars(s.priceCents)})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 技师指派与点钟 (Col 2) */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-[10px] font-bold text-slate-500">
                            {t('schedule.apptAssignStaff')}
                          </label>
                          <label
                            className={cn(
                              "flex items-center gap-1 cursor-pointer text-[10px] px-1.5 py-0.5 rounded-md border transition-all select-none",
                              item.isRequest
                                ? "bg-amber-50 border-amber-300 text-amber-900 font-bold shadow-2xs ring-1 ring-amber-300"
                                : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100 font-medium"
                            )}
                            title={t('schedule.apptRequestedTooltip')}
                          >
                            <input
                              type="checkbox"
                              checked={item.isRequest}
                              onChange={(e) => {
                                const isReq = e.target.checked;
                                if (isReq) {
                                  let targetStaffId = item.membershipId;
                                  if (!targetStaffId || targetStaffId === UNASSIGNED_STAFF_ID) {
                                    const firstBookable = availableStaff.find(
                                      (s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable
                                    );
                                    targetStaffId = firstBookable ? firstBookable.membershipId : '';
                                  }
                                  handleUpdateItem(item.id, { isRequest: true, membershipId: targetStaffId });
                                } else {
                                  handleUpdateItem(item.id, { isRequest: false });
                                }
                              }}
                              className="w-3 h-3 rounded border-slate-300 text-amber-600 focus:ring-amber-500/20"
                            />
                            <span className="flex items-center gap-0.5">
                              {item.isRequest && <Sparkles className="w-2.5 h-2.5 text-amber-500" />}
                              {t('schedule.apptRequested')}
                            </span>
                          </label>
                        </div>
                        <select
                          value={item.membershipId}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === UNASSIGNED_STAFF_ID) {
                              handleUpdateItem(item.id, { membershipId: val, isRequest: false });
                            } else {
                              handleUpdateItem(item.id, { membershipId: val });
                            }
                          }}
                          className={cn(
                            "w-full h-9 px-2.5 py-1 text-xs rounded-xl border focus:outline-none focus:ring-2 bg-white font-medium truncate transition-colors",
                            item.isRequest
                              ? "border-amber-400 bg-amber-50/20 text-amber-950 font-semibold focus:ring-amber-500/20"
                              : "border-slate-200 focus:ring-teal-500/20 text-slate-800"
                          )}
                        >
                          {!item.isRequest && (
                            <option value={UNASSIGNED_STAFF_ID}>{t('schedule.apptUnassignedPool')}</option>
                          )}
                          {availableStaff
                            .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                            .map((s) => (
                              <option key={s.membershipId} value={s.membershipId}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                      </div>

                      {/* 开始时刻 (Col 1) */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 mb-1">
                          {t('schedule.apptStartTime')}
                        </label>
                        <Input
                          type="time"
                          value={item.startTime}
                          onChange={(e) => handleUpdateItem(item.id, { startTime: e.target.value })}
                          className="h-9 min-h-0 py-1 px-2.5 text-xs font-mono w-full"
                        />
                      </div>

                      {/* 服务时长与完成时刻 (Col 2) */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 mb-1">
                          {t('schedule.apptDurationMin')}
                        </label>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={4}
                              value={item.durationText}
                              onChange={(e) =>
                                handleUpdateItem(item.id, { durationText: e.target.value })
                              }
                              onBlur={() => handleDurationBlur(item.id)}
                              aria-invalid={durationError !== null}
                              className={cn(
                                "h-9 min-h-0 py-1 pl-2.5 pr-6 text-xs font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none w-full",
                                durationError && "border-rose-400 focus:border-rose-500 focus:ring-rose-500/20 bg-rose-50/20",
                              )}
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 pointer-events-none font-medium">
                              m
                            </span>
                          </div>

                          <div className="shrink-0 h-9 px-2.5 flex items-center justify-center text-xs font-mono font-bold text-teal-800 bg-teal-50 border border-teal-200 rounded-xl whitespace-nowrap shadow-2xs">
                            → {itemEnd}
                          </div>
                        </div>
                        {durationError && (
                          <p className="text-[11px] text-rose-600 font-medium mt-1">{durationError}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 增加项目行按钮 */}
            <button
              type="button"
              onClick={handleAddItem}
              className="w-full py-2.5 border border-dashed border-teal-300 rounded-2xl bg-teal-50/40 text-teal-800 hover:bg-teal-50 hover:border-teal-400 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-all shadow-2xs"
            >
              <Plus className="w-4 h-4 text-teal-600" />
              <span>{t('schedule.apptAddService')}</span>
            </button>
          </div>
          )}

          {/* 组合套餐选择（U10）*/}
          {mode === 'bundle' && (
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 mb-1">
                  {t('bundle.pickerHeading')}
                </label>
                {bundleCatalog.isLoading ? (
                  <p className="text-xs text-slate-400">{t('bundle.pickerLoadingQuote')}</p>
                ) : bundleTemplates.length === 0 ? (
                  <p className="text-xs text-slate-500 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                    {t('bundle.pickerNoTemplates')}
                  </p>
                ) : (
                  <select
                    value={selectedBundleId}
                    onChange={(e) => {
                      markDirty();
                      setSelectedBundleId(e.target.value);
                      setBundleExtraAddons([]);
                      setUnitStaff([]);
                    }}
                    className="w-full h-9 px-2.5 py-1 text-xs rounded-xl border border-slate-200 bg-white font-medium"
                  >
                    <option value="">{t('bundle.pickerPlaceholder')}</option>
                    {bundleTemplates.map((b) => (
                      <option key={b.id} value={b.id} disabled={!b.fulfillable}>
                        {b.name}{b.fulfillable ? '' : ` — ${t('bundle.pickerUnfulfillable')}`}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {selectedBundle && !selectedBundle.fulfillable && (
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-600">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {t('bundle.pickerUnfulfillable')}
                </div>
              )}

              {selectedBundleId !== '' && (
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 mb-1">
                    {t('bundle.pickerStartTime')}
                  </label>
                  <Input
                    type="time"
                    value={bundleStartTime}
                    onChange={(e) => { markDirty(); setBundleStartTime(e.target.value); }}
                    className="h-9 min-h-0 py-1 px-2.5 text-xs font-mono w-40"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">{t('bundle.pickerSubItemsFollow')}</p>
                </div>
              )}

              {bundleQuote.status === 'loading' && (
                <p className="text-xs text-slate-400">{t('bundle.pickerLoadingQuote')}</p>
              )}
              {bundleQuote.status === 'error' && (
                <p className="text-xs text-rose-600 font-medium">{t('bundle.pickerQuoteFailed')}</p>
              )}

              {readyQuote && (
                <>
                  <div className="space-y-2">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      {t('bundle.pickerUnitsHeading')}
                    </span>
                    {readyQuote.units.map((u, i) => {
                      const startMins = timeToMins(bundleStartTime)
                        + readyQuote.units.slice(0, i).reduce((n, x) => n + x.durationMin, 0);
                      const endMins = startMins + u.durationMin;
                      const a = unitStaff[i] ?? { membershipId: UNASSIGNED_STAFF_ID, isRequest: false };
                      return (
                        <div key={u.unitKey} className="p-2.5 bg-white border border-slate-200 rounded-2xl space-y-2 shadow-2xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-xs text-slate-900 truncate">
                              {i + 1}. {componentNameById.get(u.componentId) ?? '—'}
                            </span>
                            <span className="text-[10px] font-mono text-slate-500 whitespace-nowrap">
                              {minsToTime(startMins)}–{minsToTime(endMins)} · {t('schedule.apptDurationMinutes', { p0: u.durationMin })}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={a.membershipId}
                              onChange={(e) => {
                                markDirty();
                                const val = e.target.value;
                                setUnitStaff((prev) => prev.map((x, j) => j === i
                                  ? { membershipId: val, isRequest: val === UNASSIGNED_STAFF_ID ? false : x.isRequest }
                                  : x));
                              }}
                              className="flex-1 h-8 px-2 text-xs rounded-xl border border-slate-200 bg-white font-medium truncate"
                              aria-label={t('schedule.apptAssignStaff')}
                            >
                              <option value={UNASSIGNED_STAFF_ID}>{t('schedule.apptUnassignedPool')}</option>
                              {availableStaff
                                .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                                .map((s) => (
                                  <option key={s.membershipId} value={s.membershipId}>{s.name}</option>
                                ))}
                            </select>
                            <label className={cn(
                              'flex items-center gap-1 cursor-pointer text-[10px] px-1.5 py-0.5 rounded-md border select-none',
                              a.isRequest
                                ? 'bg-amber-50 border-amber-300 text-amber-900 font-bold'
                                : 'bg-slate-50 border-slate-200 text-slate-500',
                            )}>
                              <input
                                type="checkbox"
                                checked={a.isRequest}
                                disabled={a.membershipId === UNASSIGNED_STAFF_ID}
                                onChange={(e) => {
                                  markDirty();
                                  const checked = e.target.checked;
                                  setUnitStaff((prev) => prev.map((x, j) => j === i ? { ...x, isRequest: checked } : x));
                                }}
                                className="w-3 h-3"
                              />
                              <span>{t('schedule.apptRequested')}</span>
                            </label>
                          </div>

                          {/* 额外加项：归属到这个执行单元，价 / 时长由服务端重新报价并入 */}
                          <div className="pt-1.5 border-t border-slate-100 space-y-1.5">
                            <span className="text-[10px] font-bold text-slate-400">{t('bundle.addonSectionLabel')}</span>
                            {bundleExtraAddons.filter((ad) => ad.attachToUnit === u.unitKey).map((ad) => (
                              <div key={ad.ref} className="flex items-center gap-1.5">
                                <span className="flex-1 truncate text-[11px] text-slate-700">
                                  {bundleAddonById.get(ad.serviceId)?.name ?? '—'}
                                </span>
                                <input
                                  type="number" min={1} max={20} value={ad.qty}
                                  onChange={(e) => setBundleAddonQty(ad.ref, parseInt(e.target.value, 10))}
                                  aria-label={t('bundle.addonQty')}
                                  className="w-12 h-7 px-1.5 text-[11px] text-center rounded-lg border border-slate-200"
                                />
                                <button
                                  type="button"
                                  onClick={() => removeBundleAddon(ad.ref)}
                                  aria-label={t('bundle.addonRemove')}
                                  className="text-slate-400 hover:text-rose-500 p-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                            {bundleAvailableAddons.length === 0 ? (
                              <p className="text-[10px] text-slate-400">{t('bundle.addonNone')}</p>
                            ) : (
                              <select
                                value=""
                                onChange={(e) => { addBundleAddon(u.unitKey, e.target.value); e.target.value = ''; }}
                                className="w-full h-7 px-2 text-[11px] rounded-lg border border-slate-200 bg-white text-slate-600"
                              >
                                <option value="">{t('bundle.addonPick')}</option>
                                {bundleAvailableAddons.map((ad) => (
                                  <option key={ad.id} value={ad.id}>
                                    {ad.name} (+${centsToDollars(ad.priceCents)})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="p-3 bg-teal-50/70 border border-teal-200 rounded-2xl space-y-1 text-xs">
                    <div className="flex justify-between text-slate-500">
                      <span>{t('bundle.pickerOriginalTotal')}</span>
                      <span className="font-mono line-through">${centsToDollars(readyQuote.originalTotalCents)}</span>
                    </div>
                    {readyQuote.bundleDiscountCents > 0 && (
                      <div className="flex justify-between text-emerald-600 font-semibold">
                        <span>{t('bundle.pickerSavings')}</span>
                        <span className="font-mono">−${centsToDollars(readyQuote.bundleDiscountCents)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-bold text-teal-900 border-t border-teal-200 pt-1">
                      <span>{t('bundle.pickerBundlePrice')}</span>
                      <span className="font-mono">${centsToDollars(readyQuote.bundlePriceCents)}</span>
                    </div>
                    {readyQuote.extraAddonListTotalCents > 0 && (
                      <>
                        <div className="flex justify-between text-slate-600">
                          <span>{t('bundle.addonExtraLine')}</span>
                          <span className="font-mono">+${centsToDollars(readyQuote.extraAddonListTotalCents)}</span>
                        </div>
                        <div className="flex justify-between font-bold text-teal-900 border-t border-teal-200 pt-1">
                          <span>{t('bundle.addonNetTotal')}</span>
                          <span className="font-mono">${centsToDollars(readyQuote.serviceNetTotalCents)}</span>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 聚合开单汇总状态条 */}
          {mode === 'items' && (
          <div className="p-3 bg-gradient-to-r from-teal-50/90 via-emerald-50/70 to-teal-50/90 border border-teal-200 rounded-2xl flex flex-wrap items-center justify-between gap-2 shadow-2xs">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="flex items-center gap-1 font-bold text-slate-900 bg-white/90 px-2.5 py-1 rounded-xl border border-teal-100 shadow-2xs">
                <Scissors className="w-3.5 h-3.5 text-teal-600" />
                {items.length}  {t('schedule.apptServicesCount')}
              </span>
              <span className="flex items-center gap-1 font-medium text-slate-700 bg-white/90 px-2.5 py-1 rounded-xl border border-teal-100 shadow-2xs">
                <Users className="w-3.5 h-3.5 text-teal-600" />
                {summary.staffCount > 0 ? t('schedule.apptStaffCount', { p0: summary.staffCount }) : t('schedule.apptUnassignedShort')}
              </span>
              <span className="flex items-center gap-1 font-medium text-slate-700 bg-white/90 px-2.5 py-1 rounded-xl border border-teal-100 shadow-2xs">
                <Clock className="w-3.5 h-3.5 text-teal-600" />
                
                {t('schedule.apptEstimatedEnd')} {summary.latestEnd}
              </span>
            </div>
            <div className="flex items-center gap-1.5 font-bold text-teal-800 text-sm bg-white/90 px-3 py-1 rounded-xl border border-teal-200 shadow-2xs">
              <span className="text-[11px] text-slate-500 font-normal">{t('schedule.apptEstimatedTotal')}</span>
              <span>${centsToDollars(summary.totalPriceCents)}</span>
            </div>
          </div>
          )}

          {/* 实时过去时间超过30分钟强警示卡片 */}
          {isPastOver30Min && (
            <div className="p-3.5 bg-amber-50/90 border border-amber-300 rounded-2xl flex items-start gap-3 text-amber-950 shadow-sm animate-fadeIn">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs space-y-1 w-full">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-900">
                    
                    {t('schedule.apptPastWarn')} {formatPastDuration(pastMinutes, t)}
                  </span>
                  <Badge variant="warning" className="text-[10px] px-1.5 py-0 font-bold">
                    
                    {t('schedule.apptBackfillMode')}
                  </Badge>
                </div>
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  
                  {t('schedule.apptBackfillBody1')} <strong>{date} {earliestStartTime}</strong>{t('schedule.apptBackfillBody2')}<strong>{t('schedule.apptBackfillBody3')}</strong>{t('schedule.apptBackfillBody4')}
                </p>
              </div>
            </div>
          )}

          {/* 备注 */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {t('note') || t('schedule.apptNotesOptional')}
            </label>
            <Input
              value={notes}
              onChange={(e) => {
                markDirty();
                setNotes(e.target.value);
              }}
              placeholder={t('schedule.apptNotesPlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 过去时间强提醒确认模态框 */}
      {pastTimeConfirmModal && (
        <Modal
          isOpen={pastTimeConfirmModal.isOpen}
          onOpenChange={(open) => {
            if (!open) setPastTimeConfirmModal(null);
          }}
          title={
            <div className="flex items-center gap-2 text-amber-800 font-bold">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <span>{t('schedule.apptPastAuditTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setPastTimeConfirmModal(null)}>
                {t('schedule.apptChangeTime')}
              </Button>
              <Button
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold gap-1 shadow-md shadow-amber-600/20"
                onClick={handleConfirmPastBooking}
              >
                <span>{t('schedule.apptConfirmBackfill')}</span>
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 text-xs text-slate-700 py-2">
            <div className="p-3 bg-amber-50 rounded-2xl border border-amber-300 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-amber-950 text-sm">{t('schedule.apptBackfillConfirmTitle')}</span>
                <Badge variant="error" className="text-[10px] font-bold">
                  
                  {t('schedule.apptEarlierThanNow')} {formatPastDuration(pastTimeConfirmModal.pastMinutes, t)}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="p-2 bg-white/90 rounded-xl border border-amber-200">
                  <span className="text-slate-400 block text-[10px]">{t('schedule.apptEarliestStart')}</span>
                  <span className="font-mono font-bold text-slate-900 text-xs">
                    {date} {earliestStartTime}
                  </span>
                </div>
                <div className="p-2 bg-white/90 rounded-xl border border-amber-200">
                  <span className="text-slate-400 block text-[10px]">{t('schedule.apptServiceAndStaff')}</span>
                  <span className="font-bold text-slate-900 text-xs truncate block">
                    {items.length}  {t('schedule.apptItemsSep')} {summary.staffCount}  {t('schedule.apptStaffSuffix')}
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-amber-800 leading-relaxed pt-0.5">
                
                {t('schedule.apptExpiredBody1')}<strong>{t('schedule.apptExpiredBody2')}</strong>{t('schedule.apptExpiredBody3')}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-800">{t('schedule.apptBackfillReasonLabel')}</label>
              <div className="space-y-1.5">
                {PAST_BOOKING_REASONS.map((r) => (
                  <label
                    key={r.id}
                    className={cn(
                      'flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-all text-xs',
                      pastTimeConfirmModal.reason === r.id
                        ? 'border-amber-400 bg-amber-50/70 text-amber-950 font-bold ring-1 ring-amber-300'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-700',
                    )}
                  >
                    <input
                      type="radio"
                      name="pastBookingReason"
                      value={r.id}
                      checked={pastTimeConfirmModal.reason === r.id}
                      onChange={() =>
                        setPastTimeConfirmModal((prev) => (prev ? { ...prev, reason: r.id } : null))
                      }
                      className="text-amber-600 focus:ring-amber-500/20 mt-0.5"
                    />
                    <div>
                      <span className="block font-bold">{t(r.labelKey)}</span>
                      <span className="block text-[10px] text-slate-500 font-normal">{t(r.descKey)}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1">{t('schedule.apptBackfillNotes')}</label>
              <Input
                value={pastTimeConfirmModal.notes}
                onChange={(e) =>
                  setPastTimeConfirmModal((prev) => (prev ? { ...prev, notes: e.target.value } : null))
                }
                placeholder={t('schedule.apptBackfillPlaceholder')}
                className="text-xs"
              />
            </div>
          </div>
        </Modal>
      )}

      {/* 冲突放行确认模态框 */}
      {conflictError && (
        <Modal
          isOpen={Boolean(conflictError)}
          onOpenChange={(open) => {
            if (!open) setConflictError(null);
          }}
          title={
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              <span>{t('schedule.apptConflictDetected')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setConflictError(null)}>
                {t('cancel')}
              </Button>
              {/*
                强制排入会真的创建预约。此前按下即关弹窗、再异步提交，
                中间既无转圈也无拦截，连点两次就是两条重复预约。
                改为保持弹窗、按钮转圈，提交完成后再关。
              */}
              {/*
                放行软容量需要 `appointment.overbook` —— 服务端已按字段级权限
                判定（AUD-02）。这里用 GuardedButton 而非普通 Button，是为了让
                没有这条权限的人看到「你没有这项权限」，而不是按下去收一个 403。
              */}
              <GuardedButton
                permission="appointment.overbook"
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold"
                isPending={create.isPending}
                onClick={() => {
                  const key = conflictError.key;
                  /*
                    不要在这里清 conflictError：提交成功走 onClose()，弹窗随
                    整个创建流程一起关；再次冲突时 handleSubmit 会用新的幂等键
                    重新写入 conflictError，提前清掉会让第二次冲突无从显示。
                  */
                  void handleSubmit({ reason: overrideReason }, key);
                }}
              >
                {t('forceSchedule')}
              </GuardedButton>
            </div>
          }
        >
          <div className="space-y-4 text-sm text-slate-700 py-2">
            <p className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-medium">
              {conflictError.message}
            </p>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                {t('overrideReasonLabel')}
              </label>
              <select
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value as Override['reason'])}
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white"
              >
                <option value="desk_coordination">{t('overrideDeskCoordination')}</option>
                <option value="guest_requested">{t('overrideGuestRequested')}</option>
                <option value="staff_on_break">{t('overrideStaffOnBreak')}</option>
                <option value="walk_in_stacking">{t('overrideWalkInStacking')}</option>
                <option value="other">{t('overrideOther')}</option>
              </select>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
