/**
 * 安排入座与工位启动：逐项目指派技师、逐项目选工位、入座前加项、交接提示。
 *
 * ⚠️ 工位是**逐项目**选择的。此前只给第一项分配工位，第二项没有占用记录，
 * 房态、清洁流转与房间占用数全部对不上。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import {
  AlertTriangle, Award, BedDouble, Check, CheckCircle, CheckCircle2, Clock, Copy,
  FileText, FileWarning, Plus, QrCode, Scissors, Timer, User,
} from 'lucide-react';
import { Spinner } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { healthFormHonesty } from '@/features/queue/healthFormStatus';
import { rankStaffCandidates } from '@/features/queue/assignment';
import { rotationRank, rotationRankLabel } from '@/features/queue/rotationRank';
import { roomSeatability, ROOM_SEATABILITY_LABEL_KEYS } from '@/features/queue/roomAvailability';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { centsToDollars } from '@/features/checkout/api';
import { customerInitials } from '@/lib/displayName';
import { UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { PRIMARY_ACTION_CLASS, AVOID_AREA_NONE, hasPendingForms } from '../model';
import type { AddOnItem, KanbanItem } from '../model';
import type { DayStaff, DayService } from '@/features/schedule/types';
import type { RoomItem } from '@/features/rooms/types';
import type { DayItem } from '@/features/schedule/types';
import type { RotationEntry } from '@/features/rotation/types';
import type { TranslationKey } from '@/i18n';

export interface StartServiceAssignment {
  serviceId: string;
  serviceName: string;
  durationMin: number;
  staffCount: number;
  roomId: string;
  staffIds: string[];
}

export interface StartServiceModalState {
  isOpen: boolean;
  item: KanbanItem | null;
  staffId: string;
  assignments: StartServiceAssignment[];
  extraAddOnServiceId: string;
  extraAddOnStaffId: string;
  addedAddOns: AddOnItem[];
  roomId: string;
  startTime: string;
  serviceDurationMin: number;
  requireBriefingAck: boolean;
  serviceBrief: string;
  /** 本次尝试的幂等键前缀，由页面在打开弹窗时生成。 */
  attemptKey: string;
}

export interface StartServiceModalProps {
  state: StartServiceModalState;
  staff: DayStaff[];
  rooms: RoomItem[];
  services: DayService[];
  /** 当前在线的技师端。用于在候选列表上标注「手机离线」。 */
  onlineTechIds: ReadonlySet<string>;
  /** 轮牌队列，按顺位排好。候选排序与「本项目首选」的判定都依赖它。 */
  rotationEntries: RotationEntry[];
  /** 今日已排期项目。用于判断某位技师此刻是否已经被占。 */
  scheduledItems: DayItem[];
  isPending: boolean;
  onChange: React.Dispatch<React.SetStateAction<StartServiceModalState>>;
  onConfirm: () => void | Promise<void>;
  onAddAddOn: () => void;
  onOpenFormQr: (item: KanbanItem) => void | Promise<void>;
  onCopyFormLink: (item: KanbanItem) => void | Promise<void>;
}

export function StartServiceModal(props: StartServiceModalProps) {
  const {
    state, staff, rooms, services, onlineTechIds, rotationEntries, scheduledItems, isPending,
    onChange, onConfirm, onAddAddOn, onOpenFormQr, onCopyFormLink,
  } = props;
  const { t } = useLanguage();
  if (!state.isOpen || !state.item) return null;

  const item = state.item;
  const assignedStaff = staff.find((s) => s.membershipId === state.staffId);
  const assignedRoom = rooms.find((r) => r.id === state.roomId);
  /* 本单已经占着的工位对自己不算「已满」—— 与服务端 own_active 的判定一致。 */
  const ownTicketId = item.ticketId ?? item.rawTicket?.ticketId ?? null;
  const noSeatableRoom = rooms.length > 0
    && rooms.every((room) => roomSeatability(room, { ticketId: ownTicketId }) !== 'seatable');
  /*
   * 确认按钮点不动的原因，与提交处的校验一一对应（`handleConfirmStartService`）。
   * 两边必须同源：只在提交处拦，按钮就是「点了没反应」；只在按钮上拦，并发改动
   * 又会漏。这里负责说清楚，那里负责兜底。
   */
  const blockedReasonKey: TranslationKey | null =
    state.assignments.length === 0 ? 'queue.quSeatNeedService'
    : state.assignments.some((assignment) => assignment.staffIds.length !== assignment.staffCount)
      ? 'queue.quSeatNeedStaff'
    : state.addedAddOns.some((addOn) => !addOn.staffId || addOn.staffId === UNASSIGNED_STAFF_ID)
      ? 'queue.quAddOnStaffRequired'
    : hasPendingForms(item) && !state.requireBriefingAck ? 'queue.quSeatBriefingRequired'
    : null;
  const assignmentCandidates = state.assignments.map((assignment) => {
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
        rotationEntries,
        scheduledItems,
        onlineIds: onlineTechIds,
        requestedStaffId: item.staffId,
        isRequest: item.isRequest,
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
      isOpen={state.isOpen}
      onOpenChange={(open) => {
        if (!open) onChange((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
      }}
      isDismissDisabled={isPending}
      title={
        <div className="flex items-center gap-2 text-teal-800 font-bold">
          <Scissors className="w-5 h-5 text-teal-600" />
          <span>{t('queue.quSeatModalTitle')}</span>
        </div>
      }
      size="lg"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {/*
            按钮为什么点不动，必须写在按钮旁边。此前问卷未签署这一条只在**点下去
            之后**以 toast 的形式出现 —— 而勾选框在弹窗上半部分，前台看到的就是
            一个反复点、反复失败的确认按钮。
          */}
          {blockedReasonKey && (
            <span role="alert" className="order-first w-full rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-bold leading-snug text-amber-900">
              {t(blockedReasonKey)}
            </span>
          )}
          <Button
            variant="secondary"
            isDisabled={isPending}
            onClick={() => onChange((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }))}
          >
            {t('queue.quSeatCancel')}
          </Button>
          <Button
            className={PRIMARY_ACTION_CLASS}
            onPress={() => { void onConfirm(); }}
            isDisabled={isPending || blockedReasonKey !== null}
          >
            {isPending
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
              {t('queue.quApprovedDuration')} <strong>{state.serviceDurationMin}  {t('queue.quMinutes')}</strong>  {t('queue.quBaseFee')}{centsToDollars(item.priceCents)}
            </span>
          </div>
          <div className="text-right">
            <span className="text-xs font-bold text-teal-600 block">{t('queue.quStartTime')}</span>
            <span className="font-mono font-bold text-teal-900 text-base">{state.startTime || t('queue.quNow')}</span>
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
                  {rotationEntries.length}
                </span>
              </div>
              {rotationEntries.length === 0 ? (
                <div className="rounded-xl border border-dashed border-indigo-200 bg-white/80 px-3 py-2 text-xs font-semibold text-slate-500">
                  {t('queue.quNoRotation')}
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {rotationEntries.map((entry, index) => {
                    const recommended = assignmentCandidates.some(({ candidates }) => candidates.find((candidate) => candidate.eligible)?.staff.membershipId === entry.membershipId);
                    // 引擎的 position 是 0 基，第一位要显示成 #1，不是 #0。
                    const position = rotationRank(entry.position, index);
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
                      const rotationEntry = rotationEntries.find((entry) => entry.membershipId === candidate.staff.membershipId);
                      const rotationPosition = rotationEntry?.position;
                      const recommended = candidates.find((entry) => entry.eligible)?.staff.membershipId === candidate.staff.membershipId;
                      const warning = !candidate.eligible;
                      return (
                        <button
                          key={candidate.staff.membershipId}
                          type="button"
                          onClick={() => onChange((prev) => {
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
                                {rotationRankLabel(rotationPosition)}
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
                +{centsToDollars(state.addedAddOns.reduce((sum, addOn) => sum + addOn.priceCents, 0))}
              </span>
            </div>

            {state.addedAddOns.length > 0 && (
              <div className="mt-3 space-y-2">
                {state.addedAddOns.map((addOn) => (
                  <div key={addOn.idempotencyKey} className="flex items-center justify-between gap-2 rounded-xl border border-violet-200 bg-white px-2.5 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-slate-900">{addOn.name}</div>
                      <div className="text-xs font-semibold text-slate-500">{addOn.durationMin}m · {addOn.staffName || t('queue.quAssigned')}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-xs font-bold text-violet-800">${centsToDollars(addOn.priceCents)}</span>
                      {/*
                        已经写进单据的加项不再提供「移除」。删掉它只会让本地清单
                        与单据不符，重新选一遍还会换一个新的幂等键，同一项就进单
                        两遍 —— 真要去掉这一项，得走单据本身的作废或退款。
                      */}
                      {addOn.sentTicketItemId ? (
                        <span className="rounded-lg bg-emerald-50 px-1.5 py-1 text-xs font-bold text-emerald-700">
                          {t('queue.quAddOnAlreadyOnTicket')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="rounded-lg px-1.5 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50"
                          onClick={() => onChange((prev) => ({
                            ...prev,
                            addedAddOns: prev.addedAddOns.filter((item) => item.idempotencyKey !== addOn.idempotencyKey),
                          }))}
                        >
                          {t('queue.quRemoveAddOn')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_auto]">
              <select
                aria-label={t('queue.quSelectAddOn')}
                value={state.extraAddOnServiceId}
                onChange={(event) => onChange((prev) => ({
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
                value={state.extraAddOnStaffId}
                onChange={(event) => onChange((prev) => ({ ...prev, extraAddOnStaffId: event.target.value }))}
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
                onClick={onAddAddOn}
                isDisabled={!state.extraAddOnServiceId}
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
            {state.assignments.map((assignment, index) => (
              <label key={`${assignment.serviceId}-${index}`} className="block space-y-1 text-xs">
                {state.assignments.length > 1 && <span>{index + 1}. {assignment.serviceName}</span>}
                <select
                  aria-label={`${assignment.serviceName} · ${t('queue.quAssignRoomRequired')}`}
                  value={assignment.roomId}
                  onChange={(event) => {
                    const selectedRoomId = event.target.value;
                    onChange((prev) => ({
                      ...prev,
                      roomId: index === 0 ? selectedRoomId : prev.roomId,
                      assignments: prev.assignments.map((entry, entryIndex) => entryIndex === index
                        ? { ...entry, roomId: selectedRoomId } : entry),
                    }));
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs"
                >
                  <option value="">{t('queue.quRoomUnassigned')}</option>
                  {/*
                    接不了客的工位一律置灰。此前它们与空位混在一起、只在名字后面
                    缀一句「占用中」，前台选中后要填完整张表、点了确认才吃到
                    RESOURCE_CONFLICT —— 而那时候工单已经开出来了。
                  */}
                  {rooms.map((room) => {
                    const seatability = roomSeatability(room, { ticketId: ownTicketId });
                    return (
                      <option key={room.id} value={room.id} disabled={seatability !== 'seatable'}>
                        {room.name} · {seatability === 'seatable'
                          ? t('queue.quRoomFree')
                          : t(ROOM_SEATABILITY_LABEL_KEYS[seatability])}
                      </option>
                    );
                  })}
                </select>
              </label>
            ))}
            {noSeatableRoom && (
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-bold text-amber-900">
                {t('queue.quRoomNoneSeatable')}
              </p>
            )}
            {state.addedAddOns.map((addOn, index) => (
              <label key={addOn.idempotencyKey} className="block space-y-1 text-xs">
                <span>{addOn.name}</span>
                <select aria-label={`${addOn.name} · ${t('queue.quAssignRoomRequired')}`}
                  value={addOn.roomId ?? ''}
                  /* 已进单的加项改工位要走「换工位」命令，不能靠重发开单参数。 */
                  disabled={Boolean(addOn.sentTicketItemId)}
                  onChange={(event) => { const roomId = event.target.value;
                    onChange((prev) => ({ ...prev, addedAddOns: prev.addedAddOns.map((entry, i) =>
                      i === index ? { ...entry, roomId } : entry) })); }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs disabled:bg-slate-100 disabled:text-slate-500">
                  <option value="">{t('queue.quRoomUnassigned')}</option>
                  {rooms.map((room) => {
                    const seatability = roomSeatability(room, { ticketId: ownTicketId });
                    return (
                      <option key={room.id} value={room.id} disabled={seatability !== 'seatable'}>
                        {room.name}{seatability === 'seatable' ? '' : ` · ${t(ROOM_SEATABILITY_LABEL_KEYS[seatability])}`}
                      </option>
                    );
                  })}
                </select>
              </label>
            ))}
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
                      onClick={() => void onCopyFormLink(item)}
                      className="px-2 py-1 text-xs font-bold bg-white text-rose-800 border border-rose-300 rounded-xl hover:bg-rose-100 flex items-center gap-1 shadow-2xs cursor-pointer transition-colors"
                    >
                      <Copy className="w-3 h-3" />
                      <span>{t('queue.quCopyLink2')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onOpenFormQr(item)}
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
                      checked={state.requireBriefingAck}
                      onChange={(e) => onChange((prev) => ({ ...prev, requireBriefingAck: e.target.checked }))}
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
            value={state.serviceBrief}
            onChange={(event) => onChange((prev) => ({ ...prev, serviceBrief: event.target.value }))}
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
                checked={state.requireBriefingAck}
                onChange={(e) => onChange((prev) => ({ ...prev, requireBriefingAck: e.target.checked }))}
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
                {t('queue.quStartsAt')} {state.startTime || t('queue.quCurrent')}  {t('queue.quExpectedFinish')} {(() => {
                  const [h, m] = (state.startTime || '14:00').split(':').map(Number);
                  const endMin = (m || 0) + (state.serviceDurationMin || 60);
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
                onClick={() => onChange((prev) => ({ ...prev, serviceDurationMin: d }))}
                className={cn(
                  'px-2 py-1 text-xs rounded-lg border font-bold font-mono transition-all',
                  state.serviceDurationMin === d
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
}
