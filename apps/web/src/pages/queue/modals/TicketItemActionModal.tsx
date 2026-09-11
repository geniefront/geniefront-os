/**
 * 服务中的三个局部改动：加项、换技师、换工位。
 *
 * 三者共用一个弹窗：形状是一样的 —— 选一项服务（单项目单自动选中）、
 * 选一个新的目标、给一句理由。拆成三个弹窗只会让同一段选择逻辑抄三遍。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import { ArrowRightLeft, Check } from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useLanguage } from '@/LanguageContext';
import { centsToDollars } from '@/features/checkout/api';
import { queueTicketItems } from '@/features/queue/ticketItems';
import { roomSeatability, ROOM_SEATABILITY_LABEL_KEYS } from '@/features/queue/roomAvailability';
import { UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { PRIMARY_ACTION_CLASS } from '../model';
import type { KanbanItem } from '../model';
import type { RoomItem } from '@/features/rooms/types';

export interface TicketItemActionModalState {
  isOpen: boolean;
  mode: 'add' | 'staff' | 'room';
  item: KanbanItem | null;
  ticketItemId: string;
  serviceId: string;
  staffId: string;
  resourceId: string;
  reason: string;
}

export interface TicketItemActionModalProps {
  state: TicketItemActionModalState;
  services: Array<{ id: string; name: string; priceCents: number; durationMin: number }>;
  staff: Array<{ membershipId: string; name: string; isBookable: boolean }>;
  rooms: RoomItem[];
  isPending: boolean;
  onChange: React.Dispatch<React.SetStateAction<TicketItemActionModalState>>;
  onConfirm: () => void | Promise<void>;
}

export function TicketItemActionModal({
  state, services, staff, rooms, isPending, onChange, onConfirm,
}: TicketItemActionModalProps) {
  const { t } = useLanguage();
  if (!state.isOpen || !state.item?.rawTicket) return null;

  const modal = state;
  const pending = isPending;
  const entries = queueTicketItems(modal.item!.rawTicket!.items);
  const editable = modal.mode === 'add' ? entries : entries.filter((entry) => !entry.finishedAt);
  const bookable = staff.filter((member) => member.membershipId !== UNASSIGNED_STAFF_ID && member.isBookable);
  const chosen = entries.find((entry) => entry.ticketItemId === modal.ticketItemId);
  const needsReason = modal.mode !== 'add';
  const ready = modal.mode === 'add'
    ? Boolean(modal.serviceId && modal.staffId)
    : Boolean(modal.ticketItemId && modal.reason.trim().length >= 2
      && (modal.mode === 'staff' ? modal.staffId : modal.resourceId));
  const titleKey = modal.mode === 'add' ? 'queue.quAddItemTitle'
    : modal.mode === 'staff' ? 'queue.quMoveStaffTitle' : 'queue.quMoveRoomTitle';

  return (
    <Modal
      isOpen={modal.isOpen}
      onOpenChange={(open) => { if (!open) onChange((prev) => ({ ...prev, isOpen: false, item: null })); }}
      isDismissDisabled={pending}
      title={
        <div className="flex items-center gap-2 font-bold text-slate-900">
          <ArrowRightLeft className="h-5 w-5 text-teal-600" />
          <span>{t(titleKey)}</span>
        </div>
      }
      size="sm"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={pending}
            onPress={() => onChange((prev) => ({ ...prev, isOpen: false, item: null }))}
          >
            {t('cancel')}
          </Button>
          <Button className={PRIMARY_ACTION_CLASS} isDisabled={pending || !ready} onPress={onConfirm}>
            {pending
              ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
              : <><Check className="h-4 w-4" />{t('queue.quMoveConfirm')}</>}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 py-1 text-xs text-slate-700">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <span className="block font-bold text-slate-900">{modal.item!.customerName}</span>
          <span className="block text-slate-500">{modal.item!.serviceName}</span>
        </div>

        {/* 换技师 / 换工位先选改哪一项；单项目单已自动选中，此处仍显示以便核对。 */}
        {needsReason && (
          <div>
            <label htmlFor="qa-item" className="mb-1 block text-xs font-bold text-slate-800">{t('queue.quPickItem')}</label>
            <select
              id="qa-item"
              value={modal.ticketItemId}
              onChange={(e) => onChange((prev) => ({ ...prev, ticketItemId: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="">—</option>
              {editable.map((entry) => (
                <option key={entry.ticketItemId} value={entry.ticketItemId}>
                  {entry.name} · {entry.staffName} · {entry.roomName || t('queue.quRoomUnassigned')}
                </option>
              ))}
            </select>
          </div>
        )}

        {modal.mode === 'add' && (
          <div>
            <label htmlFor="qa-service" className="mb-1 block text-xs font-bold text-slate-800">{t('queue.quPickService')}</label>
            <select
              id="qa-service"
              value={modal.serviceId}
              onChange={(e) => onChange((prev) => ({ ...prev, serviceId: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="">—</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} · ${centsToDollars(service.priceCents)} · {service.durationMin}m
                </option>
              ))}
            </select>
          </div>
        )}

        {(modal.mode === 'add' || modal.mode === 'staff') && (
          <div>
            <label htmlFor="qa-staff" className="mb-1 block text-xs font-bold text-slate-800">
              {t(modal.mode === 'add' ? 'queue.quPickStaff' : 'queue.quPickNewStaff')}
            </label>
            <select
              id="qa-staff"
              value={modal.staffId}
              onChange={(e) => onChange((prev) => ({ ...prev, staffId: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="">—</option>
              {bookable
                .filter((member) => modal.mode === 'add' || member.membershipId !== chosen?.membershipId)
                .map((member) => (
                  <option key={member.membershipId} value={member.membershipId}>{member.name}</option>
                ))}
            </select>
          </div>
        )}

        {(modal.mode === 'add' || modal.mode === 'room') && (
          <div>
            <label htmlFor="qa-room" className="mb-1 block text-xs font-bold text-slate-800">
              {t(modal.mode === 'add' ? 'queue.quAssignRoomRequired' : 'queue.quPickNewRoom')}
            </label>
            <select
              id="qa-room"
              value={modal.resourceId}
              onChange={(e) => onChange((prev) => ({ ...prev, resourceId: e.target.value }))}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800"
            >
              <option value="">—</option>
              {/*
                与入座弹窗同一套判定：接不了客的工位置灰。本单自己正占着的那间
                不算已满（服务端同样按 own_active 放行），因此要把 ticketId 传进去。
              */}
              {rooms
                .filter((room) => modal.mode === 'add' || room.id !== chosen?.resourceId)
                .map((room) => {
                  const seatability = roomSeatability(room, { ticketId: modal.item!.rawTicket!.ticketId });
                  return (
                    <option key={room.id} value={room.id} disabled={seatability !== 'seatable'}>
                      {room.name}{seatability === 'seatable' ? '' : ` · ${t(ROOM_SEATABILITY_LABEL_KEYS[seatability])}`}
                    </option>
                  );
                })}
            </select>
          </div>
        )}

        {needsReason && (
          <div>
            <label htmlFor="qa-reason" className="mb-1 block text-xs font-bold text-slate-800">{t('queue.quMoveReason')}</label>
            <Input
              id="qa-reason"
              value={modal.reason}
              onChange={(e) => onChange((prev) => ({ ...prev, reason: e.target.value }))}
              placeholder={t('queue.quMoveReasonPlaceholder')}
              className="text-xs"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
