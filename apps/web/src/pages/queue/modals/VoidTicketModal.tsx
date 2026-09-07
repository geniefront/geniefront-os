/**
 * 作废工单。
 *
 * 已开工的单子只能回退到「服务中」，要把客人退回候客区必须先作废 ——
 * 这是那条路的终点，也是看板上唯一的破坏性操作，因此单独成文件。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面，此处只负责呈现与采集。
 */
import { Ban, Check } from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useLanguage } from '@/LanguageContext';
import type { VoidReason } from '@/features/tickets/types';
import { DANGER_ACTION_CLASS } from '../model';
import type { KanbanItem } from '../model';

export interface VoidTicketModalState {
  isOpen: boolean;
  item: KanbanItem | null;
  reason: VoidReason;
  notes: string;
}

export interface VoidTicketModalProps {
  state: VoidTicketModalState;
  isPending: boolean;
  onChange: React.Dispatch<React.SetStateAction<VoidTicketModalState>>;
  onConfirm: () => void | Promise<void>;
}

export function VoidTicketModal({ state, isPending, onChange, onConfirm }: VoidTicketModalProps) {
  const { t } = useLanguage();
  if (!state.isOpen || !state.item) return null;

  return (
    <Modal
      isOpen={state.isOpen}
      onOpenChange={(open) => { if (!open) onChange((prev) => ({ ...prev, isOpen: false, item: null })); }}
      title={
        <div className="flex items-center gap-2 font-bold text-rose-800">
          <Ban className="h-5 w-5 text-rose-600" />
          <span>{t('queue.quVoidTitle')}</span>
        </div>
      }
      size="sm"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            variant="secondary"
            isDisabled={isPending}
            onPress={() => onChange((prev) => ({ ...prev, isOpen: false, item: null }))}
          >
            {t('cancel')}
          </Button>
          <Button
            className={DANGER_ACTION_CLASS}
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {isPending
              ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
              : <><Ban className="h-4 w-4" />{t('queue.quVoidConfirm')}</>}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 py-1 text-xs text-slate-700">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3">
          <span className="block font-bold text-rose-950">{state.item.customerName}</span>
          <span className="block text-rose-800">{state.item.serviceName}</span>
        </div>

        <p className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 leading-relaxed text-slate-600">
          {t('queue.quVoidWarning')}
        </p>

        <div>
          <label htmlFor="queue-void-reason" className="mb-1.5 block text-xs font-bold text-slate-800">
            {t('checkout.tkVoidReasonLabel')}
          </label>
          <select
            id="queue-void-reason"
            value={state.reason}
            onChange={(e) => onChange((prev) => ({ ...prev, reason: e.target.value as VoidReason }))}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800"
          >
            <option value="input_error">{t('checkout.tkVoidReasonWrongItem')}</option>
            <option value="duplicate_booking">{t('checkout.tkVoidReasonDuplicate')}</option>
            <option value="guest_changed_mind">{t('checkout.tkVoidReasonChangedMind')}</option>
            <option value="walk_out">{t('checkout.tkVoidReasonWaited')}</option>
            <option value="paid_externally">{t('checkout.tkVoidReasonSettledElsewhere')}</option>
            <option value="other">{t('checkout.tkVoidReasonOther')}</option>
          </select>
          {/*
            两种后果差别很大，且完全由所选原因决定。此处按当前选择只显示
            实际会发生的那一条 —— 同时列出两条等于让前台自己去对号入座。
          */}
          <p className="mt-1.5 leading-relaxed text-slate-500">
            {t(state.reason === 'input_error' || state.reason === 'duplicate_booking'
              ? 'queue.quVoidOutcomeReopen'
              : 'queue.quVoidOutcomeCancel')}
          </p>
        </div>

        <div>
          <label htmlFor="queue-void-note" className="mb-1 block text-xs font-bold text-slate-800">
            {t('checkout.tkVoidNotesLabel')}
          </label>
          <Input
            id="queue-void-note"
            value={state.notes}
            onChange={(e) => onChange((prev) => ({ ...prev, notes: e.target.value }))}
            placeholder={t('checkout.tkVoidNotesPlaceholder')}
            className="text-xs"
          />
        </div>
      </div>
    </Modal>
  );
}
