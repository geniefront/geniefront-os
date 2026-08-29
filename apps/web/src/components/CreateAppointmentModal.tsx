import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useLanguage } from '@/LanguageContext';
import { useSchedule, useScheduleMutations, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { isOverridableConflict, OVERRIDE_REASONS, type Override } from '@/features/schedule/api';
import { wallMinutesToInstant } from '@/lib/time';
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
  durationMin: number;
  priceCents: number;
  isRequest: boolean;
}

const timeToMins = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const minsToTime = (mins: number) => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

const PAST_BOOKING_REASONS = [
  { id: 'walk_in_backfill', label: '现场到店已服务完成 (事后补录工单)', desc: '客人已经离店或正在服务，前台忙碌现在补录' },
  { id: 'phone_offline', label: '电话/微信离线预约 (未及时录入系统)', desc: '早前通过电话预约但未录入，现在补登' },
  { id: 'guest_delayed', label: '顾客迟到/改期 (协商后保留原定时间)', desc: '与顾客沟通确认按原定工时与预约核算' },
  { id: 'other', label: '其他特殊历史建单原因', desc: '如系统维护或前台交接班补录' },
];

const formatPastDuration = (mins: number) => {
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return remMins > 0 ? `${hours} 小时 ${remMins} 分钟` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days} 天 ${remHours} 小时` : `${days} 天`;
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
  const { services, staff, currentDate, timezone, openMin, closeMin } = useSchedule();
  const { create } = useScheduleMutations();

  const [customerName, setCustomerName] = useState(defaultCustomerName);
  const [phone, setPhone] = useState(defaultPhone);
  const [date, setDate] = useState(defaultDate || currentDate);
  const [notes, setNotes] = useState('');

  // 聚合多项目行列表
  const [items, setItems] = useState<AppointmentItemDraft[]>([]);

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
    if (isOpen) {
      setCustomerName(defaultCustomerName);
      setPhone(defaultPhone);
      setDate(defaultDate || currentDate);
      setNotes('');
      setConflictError(null);
      setPastTimeConfirmModal(null);

      let initialTime = defaultTime;
      if (!initialTime) {
        const now = new Date();
        const currentMins = now.getHours() * 60 + now.getMinutes();
        const snappedMins = Math.ceil(currentMins / 30) * 30;
        let startM = openMin;
        if (snappedMins >= openMin && snappedMins < closeMin - 30) {
          startM = snappedMins;
        }
        initialTime = minsToTime(startM);
      }

      const firstSvc = services.find((s) => s.id === defaultServiceId) || services[0];
      const initialStaffId = defaultStaffId || UNASSIGNED_STAFF_ID;

      setItems([
        {
          id: crypto.randomUUID(),
          serviceId: firstSvc?.id || '',
          membershipId: initialStaffId,
          startTime: initialTime,
          durationMin: firstSvc?.durationMin || 60,
          priceCents: firstSvc?.priceCents || 0,
          isRequest: false,
        },
      ]);
    }
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
    openMin,
    closeMin,
  ]);

  // 添加服务项目行
  const handleAddItem = () => {
    const defaultSvc = services[0];
    if (!defaultSvc) return;

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

    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        serviceId: defaultSvc.id,
        membershipId: nextStaff?.membershipId || UNASSIGNED_STAFF_ID,
        startTime: nextStart,
        durationMin: defaultSvc.durationMin || 60,
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
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  // 修改单行属性
  const handleUpdateItem = (id: string, patch: Partial<AppointmentItemDraft>) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        let nextDuration = item.durationMin;
        let nextPrice = item.priceCents;

        if (patch.serviceId && patch.serviceId !== item.serviceId) {
          const svc = services.find((s) => s.id === patch.serviceId);
          if (svc) {
            nextDuration = svc.durationMin;
            nextPrice = svc.priceCents;
          }
        }

        return {
          ...item,
          ...patch,
          durationMin: patch.durationMin ?? nextDuration,
          priceCents: patch.priceCents ?? nextPrice,
        };
      }),
    );
  };

  // 一键编排：全部同时进行 (Parallel)
  const handleAlignParallel = () => {
    if (items.length === 0) return;
    const baseTime = items[0].startTime;
    setItems((prev) => prev.map((item) => ({ ...item, startTime: baseTime })));
    toast.success(t('schedule.apptAlignedParallel'));
  };

  // 一键编排：按序顺次接力 (Sequential)
  const handleAlignSequential = () => {
    if (items.length === 0) return;
    let currentMins = timeToMins(items[0].startTime);
    setItems((prev) =>
      prev.map((item, idx) => {
        if (idx === 0) {
          currentMins += item.durationMin;
          return item;
        }
        const assignedTime = minsToTime(currentMins);
        currentMins += item.durationMin;
        return { ...item, startTime: assignedTime };
      }),
    );
    toast.success(t('schedule.apptCascaded'));
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
      await create.mutateAsync({
        customerId: null,
        walkInName: customerName.trim() + (phone.trim() ? ` (${phone.trim()})` : ''),
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
      onClose();
    } catch (err: any) {
      if (isOverridableConflict(err)) {
        const conflictMsg =
          err.code === 'STAFF_OVER_CAPACITY'
            ? '所选技师在当前时段已有重叠预约，是否由前台统筹强制放行排单？'
            : err.code === 'LOCATION_OVER_CAPACITY'
            ? '门店在当前时段接待预约已达上限，是否由前台统筹强制放行排单？'
            : err.code === 'STAFF_LACKS_SKILL'
            ? '所选技师可能未标记该服务专长，是否由前台确认继续指派？'
            : (err.message || '检测到排期容量约束，是否确认放行？');
        setConflictError({ message: conflictMsg, key: idempotencyKey });
      } else {
        toast.danger(errorMessage(err));
      }
    }
  };

  const handleInitialSubmit = () => {
    if (!customerName.trim()) {
      toast.danger(t('schedule.apptNameRequired2'));
      return;
    }
    if (items.some((i) => !i.serviceId)) {
      toast.danger(t('schedule.apptServicePerRow'));
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
    const reasonText =
      PAST_BOOKING_REASONS.find((r) => r.id === pastTimeConfirmModal.reason)?.label || '事后补录预约';
    const noteSuffix = pastTimeConfirmModal.notes.trim() ? ` · ${pastTimeConfirmModal.notes.trim()}` : '';
    const updatedNotes = notes.trim()
      ? `${notes.trim()} 【补单说明: ${reasonText}${noteSuffix}】`
      : `【补单说明: ${reasonText}${noteSuffix}】`;

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
        title={
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-700 border border-teal-200 flex items-center justify-center shadow-2xs">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base text-slate-900">{t('newAppointment') || 'New Appointment'}</span>
                {items.length > 1 && (
                  <Badge variant="default" className="text-[10px] px-2 py-0 font-bold">
                    
                    {t('schedule.apptModalTitle')}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-slate-500 font-normal">{t('schedule.apptModalDesc')}</p>
            </div>
          </div>
        }
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
                ? t('schedule.apptBackfillWarn', { p0: formatPastDuration(pastMinutes) })
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
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder={t('schedule.apptNamePlaceholder')}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('phone') || t('schedule.apptPhoneOptional')}
                </label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                  placeholder="(555) 000-0000"
                  maxLength={14}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-teal-600" />
                  {t('date') || t('schedule.apptDate')}
                </label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
                    className="flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-lg bg-white shadow-2xs hover:text-teal-700 text-slate-700 cursor-pointer transition-all"
                    title={t('schedule.apptParallelHint')}
                  >
                    <Zap className="w-3 h-3 text-amber-500" />
                    
                    {t('schedule.apptParallel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleAlignSequential}
                    className="flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-lg bg-white shadow-2xs hover:text-teal-700 text-slate-700 cursor-pointer transition-all"
                    title={t('schedule.apptSequentialHint')}
                  >
                    <FastForward className="w-3 h-3 text-teal-600" />
                    
                    {t('schedule.apptSequential')}
                  </button>
                </div>
              )}
            </div>

            {/* 项目列表卡片 */}
            <div className="space-y-2">
              {items.map((item, index) => {
                const svc = services.find((s) => s.id === item.serviceId);
                const endMins = timeToMins(item.startTime) + (item.durationMin || 30);
                const itemEnd = minsToTime(endMins);

                return (
                  <div
                    key={item.id}
                    className="p-3 bg-white border border-slate-200 rounded-2xl space-y-2.5 shadow-2xs hover:border-teal-300 transition-all"
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

                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 cursor-pointer text-[11px] font-medium text-slate-600 bg-slate-50 px-2 py-0.5 rounded-lg border border-slate-200">
                          <input
                            type="checkbox"
                            checked={item.isRequest}
                            onChange={(e) => handleUpdateItem(item.id, { isRequest: e.target.checked })}
                            className="w-3.5 h-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500/20"
                          />
                          <span>{t('schedule.apptRequested')}</span>
                        </label>

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
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                      {/* 服务选择 */}
                      <div className="sm:col-span-1">
                        <label className="block text-[10px] font-bold text-slate-500 mb-1">{t('schedule.apptCategory')}</label>
                        <select
                          value={item.serviceId}
                          onChange={(e) => handleUpdateItem(item.id, { serviceId: e.target.value })}
                          className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 bg-white font-medium truncate"
                        >
                          {services.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} (${centsToDollars(s.priceCents)})
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* 技师指派 */}
                      <div className="sm:col-span-1">
                        <label className="block text-[10px] font-bold text-slate-500 mb-1">{t('schedule.apptAssignStaff')}</label>
                        <select
                          value={item.membershipId}
                          onChange={(e) => handleUpdateItem(item.id, { membershipId: e.target.value })}
                          className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 bg-white font-medium truncate"
                        >
                          <option value={UNASSIGNED_STAFF_ID}>{t('schedule.apptUnassignedPool')}</option>
                          {availableStaff
                            .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                            .map((s) => (
                              <option key={s.membershipId} value={s.membershipId}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                      </div>

                      {/* 开始时间 */}
                      <div className="sm:col-span-1">
                        <label className="block text-[10px] font-bold text-slate-500 mb-1">{t('schedule.apptStartTime')}</label>
                        <Input
                          type="time"
                          value={item.startTime}
                          onChange={(e) => handleUpdateItem(item.id, { startTime: e.target.value })}
                          className="py-1 px-2 text-xs font-mono"
                        />
                      </div>

                      {/* Duration与结束时刻 */}
                      <div className="sm:col-span-1 flex items-end gap-1.5">
                        <div className="flex-1">
                          <label className="block text-[10px] font-bold text-slate-500 mb-1">{t('schedule.apptDurationMin')}</label>
                          <Input
                            type="number"
                            min={5}
                            max={600}
                            step={5}
                            value={item.durationMin}
                            onChange={(e) =>
                              handleUpdateItem(item.id, { durationMin: parseInt(e.target.value) || 30 })
                            }
                            className="py-1 px-2 text-xs font-mono"
                          />
                        </div>
                        <div className="text-[10px] text-slate-500 pb-1.5 whitespace-nowrap font-mono">
                          ➔ {itemEnd}
                        </div>
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
                    
                    {t('schedule.apptPastWarn')} {formatPastDuration(pastMinutes)}
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
              onChange={(e) => setNotes(e.target.value)}
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
              <span>Past Booking Audit & Confirmation</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setPastTimeConfirmModal(null)}>
                Change Time
              </Button>
              <Button
                className="bg-amber-600 hover:bg-amber-700 text-white font-bold gap-1 shadow-md shadow-amber-600/20"
                onClick={handleConfirmPastBooking}
              >
                <span>Confirm Backfill & Book</span>
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 text-xs text-slate-700 py-2">
            <div className="p-3 bg-amber-50 rounded-2xl border border-amber-300 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-amber-950 text-sm">{t('schedule.apptBackfillConfirmTitle')}</span>
                <Badge variant="error" className="text-[10px] font-bold">
                  
                  {t('schedule.apptEarlierThanNow')} {formatPastDuration(pastTimeConfirmModal.pastMinutes)}
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
              <label className="block text-xs font-bold text-slate-800">Select Backfill Reason Category *</label>
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
                      <span className="block font-bold">{r.label}</span>
                      <span className="block text-[10px] text-slate-500 font-normal">{r.desc}</span>
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
              <span>Schedule Conflict Detected</span>
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
                {t('forceSchedule') || 'Force Schedule'}
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
                {t('overrideReasonLabel') || 'Override Reason:'}
              </label>
              <select
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value as Override['reason'])}
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 bg-white"
              >
                <option value="desk_coordination">{t('overrideDeskCoordination') || 'Desk coordination'}</option>
                <option value="guest_requested">{t('overrideGuestRequested') || 'Guest requested'}</option>
                <option value="staff_on_break">{t('overrideStaffOnBreak') || 'Staff on break'}</option>
                <option value="walk_in_stacking">{t('overrideWalkInStacking') || 'Walk-in stacking'}</option>
                <option value="other">{t('overrideOther') || 'Other reason'}</option>
              </select>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
