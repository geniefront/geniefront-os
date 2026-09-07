/**
 * 看板上的房间快捷清理面板。
 *
 * 前台在看板上最常问的一句是「哪个位子扫好了没有」。此前答案只在「房间状态」
 * 页里，扫完一个位子要离开看板、切页、点完再切回来 —— 而这中间客人就站在
 * 台前等位。这个面板把「扫完了」这一个动作搬到看板上，其余的房间管理
 * （新建工位、停用检修、改容量）仍然留在房间状态页，不在这里重复一遍。
 *
 * 待清洁的排在最前面：那是唯一挡着下一位客人的状态。
 */
import { BedDouble, Check, Sparkles } from 'lucide-react';
import { Spinner } from '@heroui/react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';
import type { RoomItem } from '@/features/rooms/types';

/**
 * 服务端的 `cleaning_required`（刚做完、还没人动手）与 `cleaning`
 * （已经在扫）对前台是同一件事：这个位子现在不能接客，扫完点一下。
 */
export function roomNeedsCleaning(room: RoomItem): boolean {
  return room.status === 'cleaning' || room.rawStatus === 'cleaning_required';
}

const STATUS_LABEL: Record<string, TranslationKey> = {
  available: 'queue.quRoomStatusAvailable',
  in_service: 'queue.quRoomStatusInUse',
  cleaning: 'queue.quRoomStatusCleaning',
  maintenance: 'queue.quRoomStatusMaintenance',
};

export interface RoomsQuickModalProps {
  isOpen: boolean;
  rooms: RoomItem[];
  /** 正在提交的那一间。逐行显示 spinner，不锁死整个面板。 */
  cleaningRoomId: string | null;
  onOpenChange: (open: boolean) => void;
  onCleanDone: (room: RoomItem) => void | Promise<void>;
}

export function RoomsQuickModal({
  isOpen, rooms, cleaningRoomId, onOpenChange, onCleanDone,
}: RoomsQuickModalProps) {
  const { t } = useLanguage();
  if (!isOpen) return null;

  // 待清洁的排最前，其余按名字，保证顺序稳定不跳动。
  const ordered = [...rooms].sort((a, b) => {
    const dirty = Number(roomNeedsCleaning(b)) - Number(roomNeedsCleaning(a));
    return dirty !== 0 ? dirty : a.name.localeCompare(b.name);
  });
  const dirtyCount = ordered.filter(roomNeedsCleaning).length;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={
        <div className="flex items-center gap-2 font-bold text-slate-900">
          <BedDouble className="h-5 w-5 text-indigo-600" />
          <span>{t('queue.quRoomsPanelTitle')}</span>
        </div>
      }
      description={t('queue.quRoomsPanelHint')}
      size="md"
      footer={
        <div className="flex w-full justify-end">
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
        </div>
      }
    >
      <div className="space-y-2 py-1 text-xs">
        <p className={cn('font-bold', dirtyCount > 0 ? 'text-amber-800' : 'text-slate-500')}>
          {dirtyCount > 0
            ? t('queue.quRoomsNeedCleaning', { p0: dirtyCount })
            : t('queue.quRoomsAllClean')}
        </p>

        <ul className="space-y-1.5">
          {ordered.map((room) => {
            const dirty = roomNeedsCleaning(room);
            const busy = cleaningRoomId === room.id;
            const guest = room.currentSession?.customerName
              ?? room.currentSessions?.[0]?.customerName
              ?? null;
            return (
              <li
                key={room.id}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-xl border p-2.5',
                  dirty ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white',
                )}
              >
                <div className="min-w-0">
                  <span className="block truncate font-bold text-slate-900">{room.name}</span>
                  <span className="block truncate text-slate-500">
                    {t(STATUS_LABEL[room.status] ?? 'queue.quRoomStatusAvailable')}
                    {guest ? ` · ${guest}` : ''}
                  </span>
                </div>

                {/*
                  只有待清洁的位子给动作。空闲的无事可做，服务中的要先完工，
                  停用检修是店长的决定 —— 那三种在这里给按钮只会让人误点。
                */}
                {dirty && (
                  <Button
                    size="sm"
                    className="shrink-0 gap-1 bg-teal-700 font-semibold text-white hover:bg-teal-800"
                    isDisabled={busy}
                    onPress={() => { void onCleanDone(room); }}
                  >
                    {busy
                      ? <><Spinner size="sm" />{t('queue.quProcessing')}</>
                      : <><Check className="h-3.5 w-3.5" />{t('queue.quRoomCleanDone')}</>}
                  </Button>
                )}
                {!dirty && room.status === 'available' && (
                  <Sparkles className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
