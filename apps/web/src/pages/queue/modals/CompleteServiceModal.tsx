/**
 * 服务完工与账单明细核对：中途加项、提成归属、翻台清洁、技师跟进备注。
 *
 * 完工按「本单全部未完工项」处理，含从未点过开始的加项 —— 服务端会补开始
 * 时间并在审计里标注。只结算已启动项曾让多项目单永久卡在服务中。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import { useState } from 'react';
import { Check, CheckCircle, Clock, Coins, Plus, Scissors, User } from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';
import { toast } from '@/lib/toast';
import { centsToDollars } from '@/features/checkout/api';
import { queueTicketItems } from '@/features/queue/ticketItems';
import { UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { PRIMARY_ACTION_CLASS, FINISH_QUICK_PICK_LIMIT } from '../model';
import type { AddOnItem, KanbanItem } from '../model';

export interface CompleteServiceModalState {
  isOpen: boolean;
  item: KanbanItem | null;
  extraAddOnServiceId: string;
  extraAddOnStaffId: string;
  addedAddOns: AddOnItem[];
  markRoomCleaning: boolean;
  technicianNotes: string;
  roomId: string | null;
}

export interface CompleteServiceModalProps {
  state: CompleteServiceModalState;
  services: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
  staff: Array<{ membershipId: string; name: string; isBookable: boolean }>;
  rooms: Array<{ id: string; name: string; status: string }>;
  isPending: boolean;
  onChange: React.Dispatch<React.SetStateAction<CompleteServiceModalState>>;
  onConfirm: () => void | Promise<void>;
}

export function CompleteServiceModal({
  state, services, staff, rooms, isPending, onChange, onConfirm,
}: CompleteServiceModalProps) {
  const { t } = useLanguage();
  /* 速选加项的「更多」只影响这一个弹窗，状态留在这里即可，不必上提到页面。 */
  const [showAllFinishAddOns, setShowAllFinishAddOns] = useState(false);
  if (!state.isOpen || !state.item) return null;

  const item = state.item;
  const addOnsTotalCents = state.addedAddOns.reduce((sum, a) => sum + a.priceCents, 0);
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
      isOpen={state.isOpen}
      onOpenChange={(open) => {
        if (!open) onChange((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }));
      }}
      isDismissDisabled={isPending}
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
            isDisabled={isPending}
            onClick={() => onChange((prev) => ({ ...prev, isOpen: false, item: null, addedAddOns: [] }))}
          >
            {t('queue.quFinishCancel')}
          </Button>
          <Button
            className={PRIMARY_ACTION_CLASS}
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {isPending
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
                  aria-pressed={state.extraAddOnServiceId === service.id}
                  onClick={() => onChange((prev) => ({
                    ...prev,
                    extraAddOnServiceId: prev.extraAddOnServiceId === service.id ? '' : service.id,
                  }))}
                  className={cn(
                    'flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
                    state.extraAddOnServiceId === service.id
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
          {state.addedAddOns.length === 0 ? (
            <div className="text-xs text-slate-400 p-2.5 border border-dashed rounded-xl text-center bg-slate-50/50">
              {t('queue.quNoAddOns')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {state.addedAddOns.map((addon, idx) => (
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
                        /* 已进单的加项改归属要走「换技师」命令，不能靠重发加项参数。 */
                        disabled={Boolean(addon.sentTicketItemId)}
                        onChange={(e) => {
                          const newStaff = staff.find((candidate) => candidate.membershipId === e.target.value);
                          onChange((prev) => ({
                            ...prev,
                            addedAddOns: prev.addedAddOns.map((a, i) =>
                              i === idx
                                ? { ...a, staffId: e.target.value, staffName: newStaff?.name }
                                : a,
                            ),
                          }));
                        }}
                        className="px-2 py-0.5 text-xs rounded-lg border border-slate-200 bg-white font-medium text-slate-800 disabled:bg-slate-100 disabled:text-slate-500"
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
                    {/*
                      已经写进单据的加项不提供「移除」：删掉只会让本地清单与单据
                      不符，重新选一遍还会换一个新的幂等键，同一项就进单两遍。
                    */}
                    {addon.sentTicketItemId ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-bold text-emerald-700">
                        {t('queue.quAddOnAlreadyOnTicket')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-rose-500 hover:text-rose-700 text-xs font-bold px-1"
                        onClick={() => {
                          onChange((prev) => ({
                            ...prev,
                            addedAddOns: prev.addedAddOns.filter((_, i) => i !== idx),
                          }));
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 从目录确认加项与执行技师 */}
          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
            <select
              value={state.extraAddOnServiceId}
              onChange={(e) => onChange((prev) => ({
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
              value={state.extraAddOnStaffId}
              onChange={(e) => onChange((prev) => ({
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
                  (service) => service.id === state.extraAddOnServiceId,
                );
                const selectedStaff = staff.find(
                  (candidate) => candidate.membershipId === state.extraAddOnStaffId,
                );
                if (!selectedService || !selectedStaff || selectedStaff.membershipId === UNASSIGNED_STAFF_ID) {
                  toast.danger(t('queue.quAddOnStaffRequired'));
                  return;
                }
                onChange((prev) => ({
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
              isDisabled={!state.extraAddOnServiceId || !state.extraAddOnStaffId}
            >
              {t('queue.quAddItem')}
            </Button>
          </div>
        </div>

        {/* 包厢工位翻台清洁与技师跟进备注 */}
        <div className={state.roomId ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
          {state.roomId && (
          <div className="p-3 bg-white rounded-2xl border border-slate-200 space-y-1.5 shadow-sm">
            <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={state.markRoomCleaning}
                onChange={(e) => onChange((prev) => ({ ...prev, markRoomCleaning: e.target.checked }))}
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
              value={state.technicianNotes}
              onChange={(e) => onChange((prev) => ({ ...prev, technicianNotes: e.target.value }))}
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
}
