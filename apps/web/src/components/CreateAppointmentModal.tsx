import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';
import { useSchedule, useScheduleMutations, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { isOverridableConflict, OVERRIDE_REASONS, type Override } from '@/features/schedule/api';
import { deskAppointmentCustomer } from '@/features/schedule/deskCustomer';
import { useSaveCustomerProfile } from '@/features/customers/api';
import { wallMinutesToInstant, instantToWallDate, nowWallHhMm } from '@/lib/time';
import { useErrorMessage } from '@/lib/errorMessage';
import { centsToDollars } from '@/features/checkout/api';
import { toast } from '@heroui/react';
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

type DurationParse =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'format' | 'range' };

/** 只在失焦/提交时调用 —— 逐次按键不做任何强制回填 */
export const parseDuration = (text: string): DurationParse => {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^\d{1,4}$/.test(trimmed)) return { ok: false, reason: 'format' };
  const value = Number(trimmed);
  if (value < DURATION_MIN || value > DURATION_MAX) return { ok: false, reason: 'range' };
  return { ok: true, value };
};

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
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { services, staff, currentDate, timezone, openMin, closeMin, setCurrentDate } = useSchedule();
  const { create } = useScheduleMutations();
  const saveProfile = useSaveCustomerProfile();

  const [customerName, setCustomerName] = useState(defaultCustomerName);
  const [phone, setPhone] = useState(defaultPhone);
  const [date, setDate] = useState(defaultDate || currentDate);
  const [notes, setNotes] = useState('');
  const [nameError, setNameError] = useState(false);

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

  const availableStaff = useMemo(() => {
    return staff.filter((s) => s.membershipId === UNASSIGNED_STAFF_ID || s.isBookable);
  }, [staff]);

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
    setNameError(false);
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

  // 计算最早已过去时间（是否早于当前时刻 30 分钟）
  const pastMinutes = useMemo(() => {
    if (!date || summary.earliestStart === '--:--') return 0;
    try {
      const startsAt = wallMinutesToInstant(date || currentDate, timeToMins(summary.earliestStart), timezone);
      const apptTimestamp = new Date(startsAt).getTime();
      const nowTimestamp = Date.now();
      return Math.round((nowTimestamp - apptTimestamp) / 60000);
    } catch {
      return 0;
    }
  }, [date, summary.earliestStart, currentDate, timezone]);

  const isPastOver30Min = pastMinutes > 30;

  // 提交创建聚合预约
  const handleSubmit = async (override?: Override, retryKey?: string, customNotes?: string) => {
    if (!customerName.trim()) {
      toast.danger(t('schedule.apptNameRequired'));
      return;
    }
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
        toast.danger(errorMessage(err));
      }
    }
  };

  const handleInitialSubmit = () => {
    if (!customerName.trim()) {
      setNameError(true);
      toast.danger(t('schedule.apptNameRequired2'));
      return;
    }
    setNameError(false);
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
              disabled={create.isPending}
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
                  value={customerName}
                  onChange={(e) => {
                    markDirty();
                    setCustomerName(e.target.value);
                    if (nameError && e.target.value.trim()) setNameError(false);
                  }}
                  placeholder={t('schedule.apptNamePlaceholder')}
                  className={cn(nameError && 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20 bg-rose-50/20')}
                  autoFocus
                />
                {nameError && (
                  <p className="text-[11px] text-rose-600 font-medium mt-1">
                    {t('schedule.apptNameRequired2')}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('phone') || t('schedule.apptPhoneOptional')}
                </label>
                <Input
                  value={phone}
                  onChange={(e) => {
                    markDirty();
                    setPhone(formatPhoneInput(e.target.value));
                  }}
                  placeholder="(555) 000-0000"
                  maxLength={14}
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

          {/* 多项目与多技师指派行编辑器 */}
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

          {/* 聚合开单汇总状态条 */}
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
                  
                  {t('schedule.apptBackfillBody1')} <strong>{date} {summary.earliestStart}</strong>{t('schedule.apptBackfillBody2')}<strong>{t('schedule.apptBackfillBody3')}</strong>{t('schedule.apptBackfillBody4')}
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
                    {date} {summary.earliestStart}
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
              <Button
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold"
                onClick={() => {
                  const key = conflictError.key;
                  setConflictError(null);
                  handleSubmit({ reason: overrideReason }, key);
                }}
              >
                {t('forceSchedule')}
              </Button>
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
