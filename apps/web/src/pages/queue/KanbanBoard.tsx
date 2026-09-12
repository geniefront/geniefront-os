/**
 * 五列看板本体与卡片。
 *
 * 卡片 = 客人，卡片内的行 = 项目：每个项目独立显示技师、工位、时段、金额与
 * 状态，并自带该项目的动作。整张卡片同一时刻只有一个主按钮，由
 * `queueNextAction()` 按工单事实推导，其余动作收进「⋯」菜单。
 *
 * ⚠️ 拖拽只是鼠标端的增强。前台用 iPad，HTML5 drag 在触屏上根本不触发，
 * 因此每一步流转都必须另有点击路径。
 * 从 `pages/Queue.tsx` 原样搬出，状态与命令仍留在页面。
 */
import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle, ArrowLeft, ArrowRightLeft, Ban, BedDouble, CheckCircle2, ChevronRight,
  FileText, FileWarning, Plus, Printer, Scissors, Timer, User,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { cn, formatPhoneDisplay } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';
import { centsToDollars } from '@/features/checkout/api';
import { formatIsoWallClock } from '@/lib/time';
import { queueTicketItems, groupTicketItemsByBundle } from '@/features/queue/ticketItems';
import { queueNextAction } from '@/features/queue/nextAction';
import type { QueueNextAction } from '@/features/queue/nextAction';
import type { TicketItem, TicketBundle } from '@/features/tickets/types';
import { COLUMNS, NEXT_ACTION_ICON, NEXT_ACTION_STYLE, nextActionLabelKey } from './model';
import type { KanbanItem, KanbanStage } from './model';

export interface KanbanBoardProps {
  items: KanbanItem[];
  /** 深链 ?focus=<appointmentId>：把匹配卡片滚进视野并高亮。 */
  focusItemId?: string | null;
  timezone: string;
  draggingItemId: string | null;
  dragOverColumn: KanbanStage | null;
  /** 整块看板正在重新拉取。此时任何按钮按下去读到的都是旧事实，统一禁用。 */
  isRefreshing: boolean;
  /**
   * 正在直接执行命令的那一张卡 / 那一行。
   *
   * ⚠️ 禁用范围必须精确到这一个目标。此前是一个全局布尔：任意一次开始或完工
   * 进行中，整块看板十几张卡的按钮一起变灰 —— 门店里前台本来就是一边接这位、
   * 一边给那位点完工，全屏冻结把并行的活儿强行串了起来。
   */
  busyTarget: { itemId: string; ticketItemId: string | null } | null;
  canVoidTicket: boolean;
  onDragStart: (e: React.DragEvent, item: KanbanItem) => void;
  onDragOver: (e: React.DragEvent, stage: KanbanStage) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, stage: KanbanStage) => void;
  onViewDetails: (item: KanbanItem) => void;
  onOpenFormQr: (item: KanbanItem) => void | Promise<void>;
  onRunNextAction: (item: KanbanItem, action: QueueNextAction) => void | Promise<void>;
  onItemAction: (item: KanbanItem, mode: 'add' | 'staff' | 'room') => void;
  onRequestRollback: (item: KanbanItem) => void;
  onRequestVoid: (item: KanbanItem) => void;
  onPrintBrief: (item: KanbanItem) => void;
  onToggleItem: (item: KanbanItem, service: TicketItem) => void | Promise<void>;
  /** 未开工未付款时把一份组合套餐拆成按原价单独计费的项目（U10 / B14）。 */
  onSplitBundle?: (ticketId: string, bundle: TicketBundle) => void;
}

export function KanbanBoard({
  items, focusItemId, timezone, draggingItemId, dragOverColumn, isRefreshing, busyTarget, canVoidTicket,
  onDragStart, onDragOver, onDragLeave, onDrop, onViewDetails, onOpenFormQr,
  onRunNextAction, onItemAction, onRequestRollback, onRequestVoid, onPrintBrief, onToggleItem, onSplitBundle,
}: KanbanBoardProps) {
  const { t } = useLanguage();
  const focusRef = useRef<HTMLDivElement>(null);
  const isFocusMatch = (item: KanbanItem) =>
    Boolean(focusItemId) && (item.appointmentId === focusItemId || item.id === focusItemId);
  useEffect(() => {
    if (focusItemId && focusRef.current) {
      focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusItemId, items]);

  return (
  <div className="custom-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto pb-6">
    {/*
      断点与 min-width 此前互相矛盾：min-w-[1100px] 让容器在任何视口下都不低于
      1100px，grid-cols-1 / md:grid-cols-3 因此永远不会生效，窄屏只会横向滚动。
      现改为窄屏单列纵向排布，宽屏才进入多列。

      ⚠️ 宽屏分支用 `auto-cols-[minmax(15.5rem,1fr)]` 而不是 `grid-cols-5`：
      固定五等分会把列宽交给视口除以 5，平板横屏（1024–1194px，且平板字号刻度
      比桌面大一档）下每列只剩 190px 左右，姓名截成两个字、电话折三行、状态
      徽章竖排成一列字。改成「每列不低于 15.5rem，有余量再均分」之后，列宽有
      下限，放不下的列由容器横向滚动承接，可读性不再随视口缩水。
    */}
    <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-3 lg:grid-flow-col lg:auto-cols-[minmax(15.5rem,1fr)] lg:grid-cols-none min-h-full lg:items-stretch">
      {COLUMNS.map((col) => {
        const colItems = items.filter((it) => it.stage === col.id);
        const isDropTarget = dragOverColumn === col.id;

        return (
          <div
            key={col.id}
            onDragOver={(e) => onDragOver(e, col.id)}
            onDragLeave={onDragLeave}
            onDrop={(e) => onDrop(e, col.id)}
            className={cn(
              /*
                列高此前是硬编码的 calc(100vh-270px)，顶部指标栏一换行就溢出。
                改为跟随可用高度：窄屏按内容展开并限高，宽屏撑满看板容器。
              */
              'flex max-h-[70vh] flex-col rounded-2xl border transition-colors duration-200 lg:min-h-full lg:max-h-none',
              col.color,
              isDropTarget
                ? 'border-teal-400 bg-teal-50/40 ring-2 ring-teal-500'
                : 'bg-slate-50/70',
            )}
          >
            {/* Column Header */}
            <div
              className={cn(
                'p-3 rounded-t-2xl border-b flex items-center justify-between shrink-0 select-none',
                col.headerBg,
              )}
            >
              {/*
                左侧标题组必须带 min-w-0：flex 子项的默认最小尺寸是内容宽度，
                没有这一句时标题不会收缩，而是把右侧计数徽章挤出列外 ——
                平板字号下五列看板每列的计数都被裁掉了一半。
              */}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <col.icon className="w-4 h-4 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-bold text-xs leading-tight truncate">{t(col.titleKey)}</h3>
                  <p className="text-xs text-slate-500 mt-0.5 opacity-80 truncate">{t(col.subtitleKey)}</p>
                </div>
              </div>
              <Badge variant={col.badgeVariant} className="shrink-0 font-mono text-xs px-2 py-0.5 font-bold">
                {colItems.length}
              </Badge>
            </div>

            {/* Column Body / Card List */}
            <div className="flex-1 p-2.5 overflow-y-auto space-y-2.5 custom-scrollbar min-h-0">
              {/*
                空状态留在 AnimatePresence 之外。
                此前二者是同一个三元表达式的两个分支，最后一张卡片离开本列时，
                AnimatePresence 的子节点会被整体换成这个没有 key 的 div ——
                它要跟踪的退场元素与新children混在一起，属于该组件明确不支持的用法。
                现在它只负责这一列的卡片列表，空状态由外层条件渲染。
              */}
              {colItems.length === 0 && (
                <div className="h-40 border-2 border-dashed border-slate-200/80 rounded-xl flex flex-col items-center justify-center text-center p-3">
                  <col.icon className="w-6 h-6 text-slate-300 mb-1" />
                  <span className="text-xs text-slate-400 font-medium">{t(col.emptyKey)}</span>
                  <span className="text-xs text-slate-400 mt-0.5">{t('queue.quAdvanceByButtons')}</span>
                </div>
              )}
              <AnimatePresence mode="popLayout">
                {colItems.map((item) => {
                  const isDragging = draggingItemId === item.id;
                  const isFocused = isFocusMatch(item);
                  const nextAction = queueNextAction({
                    stage: item.stage,
                    ticket: item.rawTicket
                      ? { ...item.rawTicket, items: queueTicketItems(item.rawTicket.items) }
                      : null,
                  });

                  return (
                    <motion.div
                      key={item.id}
                      ref={isFocused ? focusRef : undefined}
                      layout
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.18 }}
                      draggable
                      onDragStart={(e: any) => onDragStart(e, item)}
                      className={cn(
                        'p-3 bg-white rounded-xl border border-slate-200/90 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing group relative select-none',
                        isDragging && 'opacity-40 scale-95 border-teal-400',
                        isFocused && 'ring-2 ring-teal-400 ring-offset-2 border-teal-400',
                      )}
                    >
                      {/* Card Top: Customer & Tags */}
                      {/*
                        姓名与电话此前和排号徽章、操作菜单挤在同一行里分宽度。
                        平板字号下留给姓名/电话的净宽不足 100px，结果是姓名截成
                        「David …」、号码截成「(917) 555-01…」—— 前台最常用来
                        核对身份的两项信息双双读不全。
                        现在只让姓名与右侧徽章竞争（姓名短、能放下），电话独占
                        下一行整幅卡宽，并用左内边距对齐到姓名的起始位置。
                      */}
                      <div className="mb-1.5">
                      <div className="flex items-start justify-between gap-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="w-6 h-6 rounded-full bg-teal-50 text-teal-700 font-bold text-xs flex items-center justify-center shrink-0 border border-teal-200">
                            {item.customerName.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <span
                              className="font-bold text-xs text-slate-900 truncate block hover:text-teal-600 cursor-pointer"
                              onClick={() => onViewDetails(item)}
                            >
                              {item.customerName}
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {item.ticketNumber && (
                            <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded-lg bg-amber-100 text-amber-800">
                              #{item.ticketNumber}
                            </span>
                          )}
                          {/* 主按钮之外的动作统一收进这里，回退不再依赖拖拽。 */}
                          <ActionMenu
                            label={t('queue.quCardMenuLabel')}
                            items={[
                              {
                                id: 'detail',
                                label: t('queue.quViewDetail'),
                                icon: <FileText className="h-4 w-4" />,
                                onSelect: () => onViewDetails(item),
                              },
                              {
                                id: 'print-brief',
                                label: t('queue.quPrintBriefAction'),
                                icon: <Printer className="h-4 w-4" />,
                                isDisabled: !item.rawTicket,
                                onSelect: () => onPrintBrief(item),
                              },
                              {
                                id: 'add-item',
                                label: t('queue.quAddItemAction'),
                                icon: <Plus className="h-4 w-4" />,
                                isDisabled: !item.rawTicket,
                                onSelect: () => onItemAction(item, 'add'),
                              },
                              {
                                id: 'move-staff',
                                label: t('queue.quMoveStaffAction'),
                                icon: <User className="h-4 w-4" />,
                                isDisabled: !item.rawTicket,
                                onSelect: () => onItemAction(item, 'staff'),
                              },
                              {
                                id: 'move-room',
                                label: t('queue.quMoveRoomAction'),
                                icon: <ArrowRightLeft className="h-4 w-4" />,
                                isDisabled: !item.rawTicket,
                                onSelect: () => onItemAction(item, 'room'),
                              },
                              {
                                id: 'rollback',
                                label: t('queue.quRollbackAction'),
                                icon: <ArrowLeft className="h-4 w-4" />,
                                onSelect: () => onRequestRollback(item),
                              },
                              ...(canVoidTicket ? [{
                                id: 'void',
                                label: t('queue.quVoidAction'),
                                icon: <Ban className="h-4 w-4" />,
                                tone: 'danger' as const,
                                isDisabled: !item.ticketId && !item.rawTicket,
                                onSelect: () => onRequestVoid(item),
                              }] : []),
                            ]}
                          />
                        </div>
                      </div>

                      {/* 电话独占一行：`pl-[1.875rem]` = 头像 24px + 间隙 6px，与姓名左缘对齐 */}
                      {item.phone && (
                        <span className="mt-0.5 block truncate whitespace-nowrap pl-[1.875rem] font-mono text-xs text-slate-400">
                          {formatPhoneDisplay(item.phone)}
                        </span>
                      )}
                      </div>

                      {/* Service Info, Room & Staff */}
                      <div className="text-xs space-y-1 my-2 bg-slate-50/70 p-2 rounded-lg border border-slate-100">
                        {!item.rawTicket && <div className="flex items-center justify-between text-slate-700 font-medium">
                          <span className="truncate flex items-center gap-1">
                            <Scissors className="w-3 h-3 text-teal-600 shrink-0" />
                            {item.serviceName}
                          </span>
                          {item.priceCents > 0 && (
                            <span className="font-mono font-bold text-slate-900 shrink-0 ml-1">
                              ${centsToDollars(item.priceCents)}
                            </span>
                          )}
                        </div>}

                        {item.rawTicket && (() => {
                          const renderService = (service: typeof item.rawTicket.items[number]) => (
                              <li key={service.ticketItemId} className="space-y-1 text-xs">
                                <div className="flex justify-between gap-2"><span>{service.name} · {service.durationMin}m</span>
                                  <span>${centsToDollars(service.totalCents)}</span></div>
                                <div>{service.staffName} · {service.roomName || t('queue.quRoomUnassigned')}</div>
                                <div className="flex flex-wrap items-center justify-between gap-1 text-slate-500">
                                  <span>{service.startedAt ? `${formatIsoWallClock(service.startedAt, timezone)} – ${formatIsoWallClock(
                                    service.finishedAt ?? new Date(Date.parse(service.startedAt) + service.durationMin * 60_000).toISOString(), timezone,
                                  )}` : t('queue.quElapsedNotStarted')}</span>
                                  <span>{service.finishedAt ? t('queue.quItemFinished') : service.startedAt ? t('queue.quInServiceStatus') : t('queue.quItemWaiting')}</span>
                                </div>
                                {!service.finishedAt && <Button size="sm" variant="secondary"
                                  isDisabled={isRefreshing || busyTarget?.ticketItemId === service.ticketItemId}
                                  onPress={() => { void onToggleItem(item, service); }}>
                                  {service.startedAt ? t('queue.quFinishItem') : t('queue.quStartItem')}
                                </Button>}
                              </li>
                          );
                          const groups = groupTicketItemsByBundle(
                            queueTicketItems(item.rawTicket.items), item.rawTicket.bundles ?? [],
                          );
                          return (
                            <ul className="space-y-2 border-t border-slate-100 pt-2">
                              {groups.map((group, gi) => group.bundle ? (
                                <li key={`b-${group.bundle.instanceId}`} className="rounded-lg bg-teal-50/60 border border-teal-100 p-2 space-y-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1.5 min-w-0">
                                      <Badge className="bg-teal-600 text-white shrink-0">{t('bundle.cardBadge')}</Badge>
                                      <span className="font-semibold text-teal-900 truncate">{group.bundle.name}</span>
                                    </span>
                                    <span className="font-mono font-bold text-teal-800 shrink-0">${centsToDollars(group.bundle.bundlePriceCents)}</span>
                                  </div>
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-semibold text-teal-700">
                                      {group.bundle.fulfilled
                                        ? t('bundle.cardFulfilled')
                                        : t('bundle.cardProgress', { done: group.bundle.doneCount, total: group.bundle.unitCount })}
                                    </span>
                                    {onSplitBundle && item.ticketId
                                      && group.bundle.status === 'active' && group.bundle.doneCount === 0 && (
                                      <button
                                        type="button"
                                        className="text-[11px] font-semibold text-teal-700 underline hover:text-teal-900"
                                        onClick={() => onSplitBundle(item.ticketId!, group.bundle!)}
                                      >
                                        {t('bundle.split')}
                                      </button>
                                    )}
                                  </div>
                                  <ul className="space-y-2 pl-2 border-l-2 border-teal-200">
                                    {group.items.map(renderService)}
                                  </ul>
                                </li>
                              ) : (
                                group.items.map(renderService)
                              )).flat()}
                            </ul>
                          );
                        })()}

                        {item.bookedItems && item.bookedItems.length > 1 && (
                          <ul className="space-y-0.5 border-t border-slate-100/80 pt-1">
                            {item.bookedItems.map((sub) => (
                              <li key={sub.itemId} className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                                <span className="truncate">
                                  {sub.startTime} · {sub.serviceName}
                                  {sub.staffName ? ` · ${sub.staffName}` : ''}
                                </span>
                                {sub.priceCents > 0 && (
                                  <span className="font-mono shrink-0">${centsToDollars(sub.priceCents)}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}

                        {!item.rawTicket && <div className="flex items-center justify-between text-xs text-slate-500 pt-1 border-t border-slate-100/80">
                          <span className="truncate flex items-center gap-1">
                            <User className="w-3 h-3 text-slate-400 shrink-0" />
                            <span className={item.staffName ? 'text-slate-800 font-semibold' : 'text-slate-400'}>
                              {item.staffName || t('queue.quUnassignedStaff')}
                            </span>
                          </span>
                          {item.roomName && (
                            <span className="truncate text-xs text-teal-700 font-medium flex items-center gap-0.5">
                              <BedDouble className="w-2.5 h-2.5" />
                              {item.roomName}
                            </span>
                          )}
                          {item.isRequest && (
                            <span className="text-xs font-bold px-1.5 py-0.2 rounded bg-violet-100 text-violet-700 shrink-0">
                              {t('queue.quRequested')}
                            </span>
                          )}
                        </div>}
                        {/*
                          单项目单的合计等于唯一那一行的金额，再列一次只是重复信息。
                          简单单子不应为了与多项目单版式统一而变复杂。
                        */}
                        {item.rawTicket && queueTicketItems(item.rawTicket.items).length > 1 && (
                          <div className="border-t border-slate-100 pt-1 text-right font-mono font-bold">
                            ${centsToDollars(item.priceCents)}
                          </div>
                        )}

                        {item.notes && (
                          <p className="text-xs text-amber-700 bg-amber-50/60 p-1 rounded font-medium truncate">
                            📝 {item.notes}
                          </p>
                        )}
                      </div>

                      {/* Time Status / Alerts Bar */}
                      {/*
                        计时、超时与待签署三者可能同时出现。此前是一行不换行的
                        justify-between，窄列里 flex 会压缩每个徽章的宽度，中文
                        文案随即被逐字竖排成一列。改为允许换行、且各徽章自身
                        不收缩不折行：放不下就整块落到下一行，而不是被压扁。
                      */}
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-slate-500 pt-1 mb-2">
                        <div className="flex shrink-0 items-center gap-1 font-mono font-medium">
                          <Timer className="w-3 h-3 text-slate-400" />
                          <span>{item.timeDisplay}</span>
                        </div>

                        {item.overdue && (
                          <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-rose-100 px-1.5 py-0.5 text-xs font-bold text-rose-700">
                            <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                            {t('queue.quOverdueWait')}
                          </span>
                        )}

                        {item.pendingForms && item.pendingForms > 0 ? (
                          <button
                            type="button"
                            className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200"
                            onClick={(event) => { event.stopPropagation(); void onOpenFormQr(item); }}
                          >
                            <FileWarning className="h-3 w-3 shrink-0" />
                            {t('queue.quWiFormPendingBadge')}
                          </button>
                        ) : null}
                      </div>

                      {/* 显眼放大版 详情按钮 与 快捷流转动作 */}
                      <div className="space-y-1.5 pt-2 border-t border-slate-100">
                        {/* 放大版 详情按钮 */}
                        <Button
                          size="sm"
                          variant="secondary"
                          className="w-full h-8 text-xs font-semibold text-slate-700 hover:text-teal-700 hover:bg-slate-100 gap-1"
                          onClick={() => onViewDetails(item)}
                        >
                          <FileText className="w-3.5 h-3.5 text-slate-500" />
                          <span>{t('queue.quViewDetail')}</span>
                        </Button>

                        {/*
                          主按钮：一张卡片同一时刻只有一个，且由 `queueNextAction()`
                          按工单事实推导。此前按列硬编码，门店把结账时机设为
                          先服务后小费时，这个按钮发出的命令必然被服务端拒绝。
                        */}
                        {col.id === 'completed' ? (
                          <div className="text-center py-1 text-xs text-emerald-700 font-mono font-medium flex items-center justify-center gap-1 bg-emerald-50 rounded-lg">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>{t('queue.quArchived')}</span>
                          </div>
                        ) : nextAction.kind === 'blocked' ? (
                          <p className="rounded-lg bg-slate-50 px-2 py-1.5 text-center text-xs text-slate-500">
                            {t(nextAction.reasonKey)}
                          </p>
                        ) : (
                          <Button
                            size="sm"
                            className={cn(
                              'w-full h-8 text-xs font-bold text-white rounded-xl gap-1 shadow-sm',
                              NEXT_ACTION_STYLE[nextAction.kind],
                            )}
                            /*
                              主按钮只在这张卡自己正在跑命令时禁用。开始 / 完工
                              之外的分支（签到、入座、收银）点下去只是打开弹窗，
                              重复提交由各弹窗自己的忙碌态与服务端幂等兜住。
                            */
                            isDisabled={isRefreshing || busyTarget?.itemId === item.id}
                            onPress={() => { void onRunNextAction(item, nextAction); }}
                          >
                            {(() => {
                              const Icon = NEXT_ACTION_ICON[nextAction.kind];
                              return <Icon className="w-3.5 h-3.5" />;
                            })()}
                            <span>{t(nextActionLabelKey(nextAction, { checkoutTiming: item.rawTicket?.checkoutTiming }))}</span>
                            <ChevronRight className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        );
      })}
    </div>
  </div>
  );
}
