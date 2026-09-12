/**
 * 骨架屏。
 *
 * 居中转圈只说明「在加载」，骨架屏还说明**将要出现什么**：页面结构提前占位，
 * 数据到达时内容落进已有的格子里，而不是把整块界面重排一遍。对门店 iPad 的
 * 实际意义是少一次视觉跳动 —— 前台的手指往往已经停在她预期按钮出现的位置上。
 *
 * ⚠️ 骨架的形状必须与真实内容大致对齐。形状对不上的骨架比转圈更糟：它承诺了
 * 一个并不会出现的版式，数据到达时照样重排，中间还多骗了用户一次。因此这里
 * 只提供与本产品实际存在的几种页面骨架一一对应的变体，不做通用积木。
 */
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

/** 单个占位块。`animate-pulse` 在 `prefers-reduced-motion` 下由 Tailwind 自动停用。 */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-slate-200/70', className)} />;
}

/**
 * 页头：标题 + 副标题 + 右侧主操作。
 *
 * 几乎每个后台页面都以这一块开头。骨架里漏掉它，数据到达时整块内容会被真实
 * 页头往下顶一截 —— 正是骨架屏本该消除的那种跳动。
 */
function PageHeadSkeleton() {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-56" />
        <SkeletonBlock className="h-3.5 w-72" />
      </div>
      <div className="flex gap-2">
        <SkeletonBlock className="h-9 w-24 rounded-xl" />
        <SkeletonBlock className="h-9 w-32 rounded-xl" />
      </div>
    </div>
  );
}

/** 工具条：搜索框 + 筛选器 + 右侧按钮组。 */
function ToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3">
      <SkeletonBlock className="h-9 w-56 rounded-xl" />
      <SkeletonBlock className="h-9 w-32 rounded-xl" />
      <div className="ml-auto flex gap-2">
        <SkeletonBlock className="h-9 w-28 rounded-xl" />
        <SkeletonBlock className="h-9 w-28 rounded-xl" />
      </div>
    </div>
  );
}

/** 指标条：页面顶部那排统计卡片。 */
function KpiRowSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {Array.from({ length: count }).map((_, kpi) => (
        <SkeletonBlock key={kpi} className="h-16 w-40 rounded-2xl" />
      ))}
    </div>
  );
}

/** 看板：若干列，每列若干卡片。对应排队看板。 */
function BoardSkeleton() {
  return (
    <div className="space-y-4">
      <KpiRowSkeleton count={6} />
      <ToolbarSkeleton />
      <div className="flex gap-3.5 overflow-hidden">
      {Array.from({ length: 4 }).map((_, column) => (
        <div key={column} className="flex-1 space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50/70 p-2.5">
          <div className="flex items-center justify-between gap-2 pb-2">
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="h-5 w-7 rounded-full" />
          </div>
          {Array.from({ length: 3 - (column % 2) }).map((_, card) => (
            <div key={card} className="space-y-2 rounded-xl border border-slate-200/90 bg-white p-3">
              <div className="flex items-center gap-1.5">
                <SkeletonBlock className="h-6 w-6 rounded-full" />
                <SkeletonBlock className="h-3.5 w-20" />
              </div>
              <SkeletonBlock className="h-3 w-28" />
              <SkeletonBlock className="h-12 w-full rounded-lg" />
              <SkeletonBlock className="h-8 w-full rounded-lg" />
            </div>
          ))}
        </div>
      ))}
      </div>
    </div>
  );
}

/** 主从列表：左侧名录 + 右侧详情。对应客户、单据、消息、收银。 */
function ListSkeleton() {
  return (
    <div className="space-y-4">
      <PageHeadSkeleton />
      <ToolbarSkeleton />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        <SkeletonBlock className="h-4 w-28" />
        {Array.from({ length: 6 }).map((_, row) => (
          <div key={row} className="space-y-1.5 border-t border-slate-100 py-3">
            <SkeletonBlock className="h-3.5 w-32" />
            <SkeletonBlock className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="hidden space-y-4 rounded-2xl border border-slate-200 bg-white p-5 lg:block">
        <SkeletonBlock className="h-5 w-40" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, tile) => (
            <SkeletonBlock key={tile} className="h-16 rounded-xl" />
          ))}
        </div>
        <SkeletonBlock className="h-28 w-full rounded-xl" />
        <SkeletonBlock className="h-40 w-full rounded-xl" />
      </div>
      </div>
    </div>
  );
}

/** 表格：表头 + 数据行。对应经营数据、薪资、通话与通信记录、员工。 */
function TableSkeleton() {
  return (
    <div className="space-y-4">
      <PageHeadSkeleton />
      <ToolbarSkeleton />
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex gap-4 border-b border-slate-200 bg-slate-50 p-3.5">
          {Array.from({ length: 5 }).map((_, head) => (
            <SkeletonBlock key={head} className="h-3.5 flex-1" />
          ))}
        </div>
        {Array.from({ length: 7 }).map((_, row) => (
          <div key={row} className="flex gap-4 border-b border-slate-100 p-3.5">
            {Array.from({ length: 5 }).map((_, cell) => (
              <SkeletonBlock key={cell} className="h-3.5 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 卡片网格：指标条 + 若干卡片。对应房态、营销、仪表盘。 */
function CardsSkeleton() {
  return (
    <div className="space-y-4">
      <PageHeadSkeleton />
      <KpiRowSkeleton />
      <ToolbarSkeleton />
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, card) => (
          <div key={card} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-7 w-20 rounded-xl" />
            </div>
            <SkeletonBlock className="h-3 w-32" />
            <SkeletonBlock className="h-9 w-full rounded-xl" />
            <div className="flex gap-2">
              <SkeletonBlock className="h-8 flex-1 rounded-lg" />
              <SkeletonBlock className="h-8 flex-1 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 表单详情：标题 + 若干分组字段。对应设置、个人资料、网站装修。 */
function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <PageHeadSkeleton />
      <SkeletonBlock className="h-24 w-full rounded-2xl" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, tab) => (
          <SkeletonBlock key={tab} className="h-10 w-32 rounded-xl" />
        ))}
      </div>
      <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5">
        <SkeletonBlock className="h-4 w-36" />
        {Array.from({ length: 4 }).map((_, group) => (
          <div key={group} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <SkeletonBlock className="h-3 w-20" />
              <SkeletonBlock className="h-10 w-full rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <SkeletonBlock className="h-3 w-24" />
              <SkeletonBlock className="h-10 w-full rounded-xl" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 日历：技师分列 + 时间轴。对应日程。 */
function CalendarSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-3 border-b border-slate-200 p-3">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-8 w-32 rounded-xl" />
        <SkeletonBlock className="ml-auto h-8 w-28 rounded-xl" />
      </div>
      <div className="flex">
        <div className="w-16 shrink-0 space-y-6 border-r border-slate-200 p-2">
          {Array.from({ length: 8 }).map((_, tick) => (
            <SkeletonBlock key={tick} className="h-3 w-10" />
          ))}
        </div>
        <div className="flex flex-1">
          {Array.from({ length: 5 }).map((_, column) => (
            <div key={column} className="flex-1 border-r border-slate-100 last:border-r-0">
              <div className="space-y-1.5 border-b border-slate-200 p-3">
                <SkeletonBlock className="mx-auto h-3.5 w-16" />
                <SkeletonBlock className="mx-auto h-3 w-12" />
              </div>
              <div className="space-y-3 p-2">
                {column % 2 === 0 && <SkeletonBlock className="h-16 w-full rounded-lg" />}
                <SkeletonBlock className="h-10 w-full rounded-lg" />
                {column % 3 === 0 && <SkeletonBlock className="h-20 w-full rounded-lg" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 页面骨架的形状。取值与本产品实际存在的页面版式一一对应。 */
export type SkeletonLayout = 'board' | 'list' | 'table' | 'cards' | 'detail' | 'calendar';

const LAYOUTS: Record<SkeletonLayout, () => ReactElement> = {
  board: BoardSkeleton,
  list: ListSkeleton,
  table: TableSkeleton,
  cards: CardsSkeleton,
  detail: DetailSkeleton,
  calendar: CalendarSkeleton,
};

export function PageSkeleton({ layout, className }: { layout: SkeletonLayout; className?: string }) {
  const Shape = LAYOUTS[layout];
  return (
    <div className={cn('w-full', className)} aria-hidden="true">
      <Shape />
    </div>
  );
}
