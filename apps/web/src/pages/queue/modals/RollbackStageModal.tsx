/**
 * 阶段回退的审计确认。
 *
 * 回退是显式动作，必须先把后果逐条摆出来：会重开哪几项、房间会不会重新
 * 占用、已收的钱会怎样。已开单的卡片还要给出「作废工单并退回候客区」——
 * 那是它唯一可走的另一条路。
 * 从 `pages/Queue.tsx` 原样搬出，状态仍留在页面。
 */
import { ArrowLeft, ArrowRight, Ban, ShieldAlert } from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';
import { queueTicketItems } from '@/features/queue/ticketItems';
import { DANGER_ACTION_CLASS, ROLLBACK_REASONS, STAGE_NAME_KEYS } from '../model';
import type { KanbanItem, KanbanStage } from '../model';

export interface RollbackStageModalState {
  isOpen: boolean;
  item: KanbanItem | null;
  fromStage: KanbanStage | null;
  toStage: KanbanStage | null;
  reason: string;
  notes: string;
}

export interface RollbackStageModalProps {
  state: RollbackStageModalState;
  isPending: boolean;
  canVoidTicket: boolean;
  onChange: React.Dispatch<React.SetStateAction<RollbackStageModalState>>;
  onConfirm: () => void | Promise<void>;
  onRequestVoid: (item: KanbanItem) => void;
}

export function RollbackStageModal({
  state, isPending, canVoidTicket, onChange, onConfirm, onRequestVoid,
}: RollbackStageModalProps) {
  const { t } = useLanguage();
  if (!state.isOpen || !state.item || !state.fromStage || !state.toStage) return null;

  return (
    <Modal
      isOpen={state.isOpen}
      onOpenChange={(open) => {
        if (!open) onChange((prev) => ({ ...prev, isOpen: false, item: null, fromStage: null, toStage: null }));
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
            onClick={() => onChange((prev) => ({ ...prev, isOpen: false, item: null, fromStage: null, toStage: null }))}
          >
            {t('queue.quRollbackCancel')}
          </Button>
          <Button
            className={DANGER_ACTION_CLASS}
            isDisabled={isPending}
            onPress={onConfirm}
          >
            {isPending
              ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
              : <><ArrowLeft className="h-4 w-4" />{t('queue.quRollbackConfirmTo', { p0: t(STAGE_NAME_KEYS[state.toStage]) })}</>}
          </Button>
        </div>
      }
    >
      <div className="space-y-3.5 py-2 text-xs text-slate-700">
        {/* 顾客与回退流转路径 */}
        <div className="p-3 bg-rose-50 rounded-2xl border border-rose-200 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-bold text-rose-950 text-sm">{state.item.customerName}</span>
            <Badge variant="error" className="text-xs font-bold">{t('queue.quRollbackOperationBadge')}</Badge>
          </div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold text-rose-800">
            <span className="p-1 bg-white rounded-lg border border-rose-200">{t(STAGE_NAME_KEYS[state.fromStage])}</span>
            <ArrowLeft className="w-3.5 h-3.5 text-rose-600" />
            <span className="p-1 bg-rose-100 rounded-lg border border-rose-300 text-rose-950">{t(STAGE_NAME_KEYS[state.toStage])}</span>
          </div>
          <p className="text-xs text-rose-700 leading-relaxed pt-1">
            {state.fromStage === 'ready_checkout' && state.toStage === 'in_service' && (
              <span>{t('queue.quRollbackWarnService')}</span>
            )}
            {state.fromStage === 'in_service' && state.toStage === 'waiting' && (
              <span>{t('queue.quRollbackWarnWaiting')}</span>
            )}
            {state.fromStage === 'waiting' && state.toStage === 'booked' && (
              <span>{t('queue.quRollbackWarnBooked')}</span>
            )}
            {!['ready_checkout->in_service', 'in_service->waiting', 'waiting->booked'].includes(`${state.fromStage}->${state.toStage}`) && (
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
                  state.reason === r.id
                    ? 'border-rose-400 bg-rose-50/60 text-rose-950 font-bold ring-1 ring-rose-300'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700',
                )}
              >
                <input
                  type="radio"
                  name="rollbackReason"
                  value={r.id}
                  checked={state.reason === r.id}
                  onChange={() => onChange((prev) => ({ ...prev, reason: r.id }))}
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
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs leading-relaxed text-slate-600">
          {/* 外层此前是 <p>，内嵌 <ul> 属于非法嵌套，浏览器会重排 DOM 并触发水合告警。 */}
          <p>{t('queue.quRollbackResourceNotice')}</p>
          {state.item?.rawTicket && <ul className="mt-2 list-disc pl-4">
            {queueTicketItems(state.item.rawTicket.items).filter((entry) => entry.finishedAt).map((entry) =>
              <li key={entry.ticketItemId}>{entry.name} · {entry.roomName || t('queue.quRoomUnassigned')}</li>)}
          </ul>}
        </div>

        {/*
          已开工的单子回不到候客区。与其只丢一句「不支持」，不如把唯一
          可走的路直接摆出来 —— 前台要的是下一步怎么办，不是规则说明。
        */}
        {state.item && (state.item.ticketId || state.item.rawTicket) && canVoidTicket && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">
            <p>{t('queue.quRollbackNeedsVoid')}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2 gap-1 border-rose-200 bg-white text-xs font-semibold text-rose-700 hover:bg-rose-50"
              onPress={() => { if (state.item) onRequestVoid(state.item); }}
            >
              <Ban className="h-3.5 w-3.5" />
              {t('queue.quRollbackVoidInstead')}
            </Button>
          </div>
        )}

        {/* 具体备注说明 */}
        <div>
          <label className="block text-xs font-bold text-slate-800 mb-1">{t('queue.quRollbackNoteLabel')}</label>
          <Input
            value={state.notes}
            onChange={(e) => onChange((prev) => ({ ...prev, notes: e.target.value }))}
            placeholder={t('queue.quRollbackNotePlaceholder')}
            className="text-xs"
          />
        </div>
      </div>
    </Modal>
  );
}
