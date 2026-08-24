/**
 * 总览 —— 打开系统的默认落地页。
 *
 * 它回答的问题是「现在店里什么情况」，不是「该谁接下一个客人」（那是轮牌板）。
 * 这个区别决定了它的形态：**大部分内容只读，交互靠点开子项的快捷浮层，
 * 而不是把人跳到别的屏**。总览页一旦什么都能跳，它就变成了另一个操作台。
 *
 * 五块内容，取舍依据写在各自的段落里。
 *
 * ⚠️ 这是第一个纯 shadcn/Tailwind 屏，充当其余 24 屏改写的样板。
 * 新代码不再出现内联 style 与 `var(--tap)` 这类写法 —— 尺寸走主题变量。
 */

import { useMemo } from 'react';
import {
  Users, DoorOpen, Phone, Armchair, Receipt, ArrowRight,
  Star, TriangleAlert, Coffee, Play,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardBody } from '../ui/Card';
import { Badge, Dot } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Page, PageHeader, Label } from '../ui/Page';
import { QuickMenu, QuickAction } from '../ui/Overlay';
import { cn } from '../ui/cn';
import type { DaySnapshot, DayItem } from './DaySchedule';

/* ───────────────────────────────────────────────────────────── 时间工具 */

/** 当天第几分钟（门店本地墙上时间）。与 DaySchedule 同一套算法 */
function localMin(iso: string, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return g('hour') * 60 + g('minute');
}
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface OverviewTotals {
  grossCents: number;
  ticketCount: number;
  avgTicketCents: number;
  openTicketCount: number;
  openTicketCents: number;
  /** 与上周同一星期几相比的变化，bp。null = 没有可比数据 */
  grossDeltaBp: number | null;
  guestsDeltaCount: number | null;
  avgDeltaCents: number | null;
}

export interface OverviewProps {
  day: DaySnapshot;
  nowMin: number;
  totals: OverviewTotals;
  /** 待办数量 */
  todo: { calls: number; waiting: number; longestWaitMin: number; stale: number };
  onGo: (where: 'calls' | 'queue' | 'ticket' | 'turn' | 'day' | 'floor') => void;
  /** 点预约块的快捷动作 */
  onCheckIn: (item: DayItem) => void;
  onEditBooking: (item: DayItem) => void;
  /** 点技师的快捷动作 */
  onAssign: (membershipId: string) => void;
  onToggleBreak: (membershipId: string) => void;
}

export function Overview(p: OverviewProps) {
  const { day, nowMin, totals, todo } = p;

  /* 每个技师此刻在做什么。按时间判断而非按 status —— 技师忘了点「开始」是常事 */
  const staffNow = useMemo(() => {
    const roomOf = new Map(day.resources.map((r) => [r.id, r.name]));
    return day.staff.filter((s) => s.isBookable).map((s) => {
      const mine = day.items.filter(
        (it) => it.membershipId === s.membershipId && it.status !== 'cancelled');
      const cur = mine.find((it) => {
        const a = localMin(it.startsAt, day.timezone);
        const b = localMin(it.endsAt, day.timezone);
        return a <= nowMin && b > nowMin && it.status !== 'done';
      });
      const last = mine
        .filter((it) => localMin(it.endsAt, day.timezone) <= nowMin)
        .sort((a, b) => localMin(b.endsAt, day.timezone) - localMin(a.endsAt, day.timezone))[0];
      return {
        staff: s,
        cur,
        curRoom: cur?.resourceId ? roomOf.get(cur.resourceId) ?? null : null,
        startMin: cur ? localMin(cur.startsAt, day.timezone) : null,
        endMin: cur ? localMin(cur.endsAt, day.timezone) : null,
        lastEndMin: last ? localMin(last.endsAt, day.timezone) : null,
      };
    });
  }, [day, nowMin]);

  /* 工位占用。两个容量分开算 —— 见 RoomCell 上的注释 */
  const rooms = useMemo(() => day.resources.map((r) => {
    const inside = day.items.filter((it) => {
      if (it.resourceId !== r.id || it.status === 'done' || it.status === 'cancelled') return false;
      const a = localMin(it.startsAt, day.timezone);
      const b = localMin(it.endsAt, day.timezone);
      return a <= nowMin && b > nowMin;
    });
    return {
      id: r.id, name: r.name, capacity: r.capacity, maxStaff: r.maxStaff,
      guests: inside.length,
      staff: new Set(inside.map((i) => i.membershipId).filter(Boolean)).size,
    };
  }), [day, nowMin]);

  const busyRooms = rooms.filter((r) => r.guests > 0).length;
  const freeStaff = staffNow.filter((s) => !s.cur).length;
  const todoCount = (todo.calls > 0 ? 1 : 0) + (todo.waiting > 0 ? 1 : 0) + (todo.stale > 0 ? 1 : 0);

  return (
    <Page>
      <PageHeader
        title="总览"
        sub={<span className="tnum">{day.businessDate} · 现在 {hhmm(nowMin)}</span>}
      />

      {/* ── 指标。孤立的「$2,450」没有信息量，同比才有 ─────────────────── */}
      <div className="mb-4 grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        <Metric label="今日营收" value={money(totals.grossCents)}
                delta={totals.grossDeltaBp === null ? null
                  : `${totals.grossDeltaBp >= 0 ? '↑' : '↓'} ${Math.abs(totals.grossDeltaBp / 100).toFixed(0)}%`}
                up={(totals.grossDeltaBp ?? 0) >= 0} />
        <Metric label="客流" value={String(totals.ticketCount)}
                delta={totals.guestsDeltaCount === null ? null
                  : `${totals.guestsDeltaCount >= 0 ? '↑' : '↓'} ${Math.abs(totals.guestsDeltaCount)} 人`}
                up={(totals.guestsDeltaCount ?? 0) >= 0} />
        <Metric label="客单价" value={money(totals.avgTicketCents)}
                delta={totals.avgDeltaCents === null ? null
                  : `${totals.avgDeltaCents >= 0 ? '↑' : '↓'} ${money(Math.abs(totals.avgDeltaCents))}`}
                up={(totals.avgDeltaCents ?? 0) >= 0} />
        <Metric label="待结工单" value={String(totals.openTicketCount)}
                note={totals.openTicketCents > 0 ? `${money(totals.openTicketCents)} 未入账` : undefined} />
      </div>

      {/* ── 当日预约时间轴 ────────────────────────────────────────────── */}
      <Card className="mb-4 overflow-hidden">
        <CardHeader>
          <CardTitle>当日预约</CardTitle>
          <span className="ml-auto text-xs text-ink-3 tnum">{day.items.length} 单</span>
          <Button size="sm" variant="ghost" onClick={() => p.onGo('day')}>
            完整日程 <ArrowRight size={15} />
          </Button>
        </CardHeader>
        <Timeline day={day} nowMin={nowMin}
                  onCheckIn={p.onCheckIn} onEdit={p.onEditBooking} />
      </Card>

      <div className="grid grid-cols-[1.15fr_1fr] gap-4 max-xl:grid-cols-1">
        {/* ── 技师 ──────────────────────────────────────────────────── */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>技师</CardTitle>
            <span className="ml-auto text-xs text-ink-3">
              在岗 {staffNow.length} · 空闲 {freeStaff}
            </span>
          </CardHeader>
          <div>
            {staffNow.map((s) => (
              <StaffRow key={s.staff.membershipId} s={s}
                        onAssign={() => p.onAssign(s.staff.membershipId)}
                        onBreak={() => p.onToggleBreak(s.staff.membershipId)} />
            ))}
            {staffNow.length === 0 && (
              <div className="px-5 py-8 text-center text-xs text-ink-3">今天没有可接单的技师</div>
            )}
          </div>
        </Card>

        {/* ── 房间 / 工位 ───────────────────────────────────────────── */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>房间 / 工位</CardTitle>
            <span className="ml-auto text-xs text-ink-3 tnum">
              占 {busyRooms} / {rooms.length}
            </span>
          </CardHeader>
          <CardBody className="grid grid-cols-3 gap-2.5 p-4 max-sm:grid-cols-2">
            {rooms.map((r) => <RoomCell key={r.id} r={r} />)}
            {rooms.length === 0 && (
              <div className="col-span-full py-6 text-center text-xs text-ink-3">
                还没配房间 —— 去「门店设置 → 房间与设备」
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ── 需要处理。⭐ 全屏唯一带跳转的一块 ───────────────────────────── */}
      {todoCount > 0 && (
        <Card className="mt-4 overflow-hidden">
          <CardHeader>
            <CardTitle>需要处理</CardTitle>
            <Badge tone="warn" className="ml-auto">{todoCount}</Badge>
          </CardHeader>
          <div>
            {todo.calls > 0 && (
              <TodoRow icon={<Phone size={15} />} tone="warn" label="来电"
                       text={`${todo.calls} 条待复核`} cta="去复核"
                       onClick={() => p.onGo('calls')} />
            )}
            {todo.waiting > 0 && (
              <TodoRow icon={<Armchair size={15} />} tone="warn" label="候客"
                       text={`${todo.waiting} 位在等 · 最久 ${todo.longestWaitMin} 分钟`}
                       cta="去叫号" onClick={() => p.onGo('queue')} />
            )}
            {todo.stale > 0 && (
              <TodoRow icon={<Receipt size={15} />} tone="mute" label="跨日"
                       text={`${todo.stale} 张未结工单`} cta="去结账"
                       onClick={() => p.onGo('ticket')} />
            )}
          </div>
        </Card>
      )}
    </Page>
  );
}

/* ═══════════════════════════════════════════════════════════════ 子组件 */

function Metric({ label, value, delta, up, note }: {
  label: string; value: string;
  delta?: string | null | undefined; up?: boolean | undefined; note?: string | undefined;
}) {
  return (
    <div className="rounded border border-line bg-surface px-4 py-3.5">
      <Label>{label}</Label>
      <div className="mt-2 text-2xl font-bold tracking-[-0.03em] tnum leading-none">{value}</div>
      {delta && (
        <div className={cn('mt-1.5 text-xs font-semibold tnum', up ? 'text-ok' : 'text-danger')}>
          {delta} <span className="font-normal text-ink-3">较上周同日</span>
        </div>
      )}
      {note && <div className="mt-1.5 text-xs text-ink-3 tnum">{note}</div>}
    </div>
  );
}

/**
 * 当日预约时间轴。
 *
 * ⭐ 用轴不用列表：列表答不了「四点还有没有人手」，
 * 而这正是接电话时要当场回答的问题。
 */
function Timeline({ day, nowMin, onCheckIn, onEdit }: {
  day: DaySnapshot; nowMin: number;
  onCheckIn: (i: DayItem) => void; onEdit: (i: DayItem) => void;
}) {
  const ROW = 15;                       // 一行 15 分钟
  const PX = 26;                        // 每行像素
  const cols = day.staff.filter((s) => s.isBookable);
  // 只画营业时段，且把当前时刻放在可视范围内
  const from = Math.max(day.openMin, Math.floor((nowMin - 90) / 60) * 60);
  const to = Math.min(day.closeMin, from + 300);
  const rows = Math.max(1, Math.round((to - from) / ROW));

  if (cols.length === 0) {
    return <div className="px-5 py-10 text-center text-xs text-ink-3">今天没有排班的技师</div>;
  }

  return (
    <div className="relative overflow-x-auto">
      <div
        className="grid min-w-[560px]"
        style={{
          gridTemplateColumns: `52px repeat(${cols.length}, minmax(96px, 1fr))`,
          gridTemplateRows: `auto repeat(${rows}, ${PX}px)`,
        }}
      >
        <div className="sticky left-0 z-20 border-b border-line bg-surface" />
        {cols.map((s, i) => (
          <div key={s.membershipId}
               className="border-b border-line bg-surface px-1 py-2 text-center text-xs font-semibold"
               style={{ gridColumn: i + 2, gridRow: 1 }}>
            {s.name}
          </div>
        ))}

        {Array.from({ length: rows }, (_, r) => {
          const min = from + r * ROW;
          const isHour = min % 60 === 0;
          return (
            <div key={`t${r}`}
                 className={cn('sticky left-0 z-10 bg-surface pr-1.5 text-right text-2xs text-ink-3 tnum',
                   isHour ? 'border-t border-line-2' : 'border-t border-dashed border-line')}
                 style={{ gridColumn: 1, gridRow: r + 2 }}>
              {isHour ? hhmm(min) : ''}
            </div>
          );
        })}
        {Array.from({ length: rows }, (_, r) =>
          cols.map((_s, c) => {
            const min = from + r * ROW;
            return (
              <div key={`c${r}-${c}`}
                   className={cn('border-r border-line/60',
                     min % 60 === 0 ? 'border-t border-line-2' : 'border-t border-dashed border-line')}
                   style={{ gridColumn: c + 2, gridRow: r + 2 }} />
            );
          }))}

        {day.items.filter((it) => it.status !== 'cancelled').map((it) => {
          const c = cols.findIndex((s) => s.membershipId === it.membershipId);
          if (c < 0) return null;
          const a = localMin(it.startsAt, day.timezone);
          const b = localMin(it.endsAt, day.timezone);
          if (b <= from || a >= to) return null;
          const r0 = Math.max(0, Math.round((a - from) / ROW));
          const span = Math.max(1, Math.round((Math.min(b, to) - Math.max(a, from)) / ROW));
          const past = b <= nowMin || it.status === 'done';
          const live = a <= nowMin && b > nowMin;
          return (
            <div key={it.itemId} style={{ gridColumn: c + 2, gridRow: `${r0 + 2} / span ${span}` }}
                 className="relative z-[2] p-0.5">
              <BookingBlock item={it} past={past} live={live} startMin={a}
                            onCheckIn={onCheckIn} onEdit={onEdit} />
            </div>
          );
        })}

        {/* 当前时刻 */}
        {nowMin >= from && nowMin <= to && (
          <div className="pointer-events-none z-[3] border-t-2 border-brand"
               style={{
                 gridColumn: `2 / span ${cols.length}`,
                 gridRow: Math.round((nowMin - from) / ROW) + 2,
                 alignSelf: 'start',
               }} />
        )}
      </div>
    </div>
  );
}

function BookingBlock({ item, past, live, startMin, onCheckIn, onEdit }: {
  item: DayItem; past: boolean; live: boolean; startMin: number;
  onCheckIn: (i: DayItem) => void; onEdit: (i: DayItem) => void;
}) {
  return (
    <QuickMenu
      title={item.customerName}
      subtitle={`${hhmm(startMin)} · ${item.serviceName}`}
      trigger={
        <button type="button"
          className={cn(
            'size-full overflow-hidden rounded-sm border-l-[3px] px-1.5 py-1 text-left text-2xs leading-tight',
            'transition-[filter] cursor-pointer hoverable:hover:brightness-[0.97]',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
            past ? 'border-l-line-2 bg-sunken text-ink-3'
              : live ? 'border-l-brand bg-brand-soft text-ink'
              : 'border-l-ok bg-ok-soft text-ink',
          )}>
          <span className="block truncate font-semibold">
            {item.customerName}{item.isRequest && ' ★'}
          </span>
          <span className="block truncate opacity-70">{item.serviceName}</span>
        </button>
      }
    >
      {!past && (
        <QuickAction primary onClick={() => onCheckIn(item)}>签到 · 安排入座</QuickAction>
      )}
      <QuickAction onClick={() => onEdit(item)}>改时间 / 换技师</QuickAction>
      {/*
        ⚠️ 浮层里**不放**不可逆动作。「取消预约…」带省略号，
        点了是开确认框（在 onEdit 那一屏里），不是当场取消。
      */}
    </QuickMenu>
  );
}

/**
 * 技师行。
 *
 * ⭐ 带完整服务上下文：服务对象 · 项目 · 地点 · 起始 → 预计完成。
 * 「Kim 忙」没用；「Kim 在足疗区 1 给王太太做足疗，16:10 完」
 * 才能据此决定下一个客人怎么排。
 */
function StaffRow({ s, onAssign, onBreak }: {
  s: {
    staff: DaySnapshot['staff'][number];
    cur?: DayItem | undefined;
    curRoom: string | null;
    startMin: number | null;
    endMin: number | null;
    lastEndMin: number | null;
  };
  onAssign: () => void; onBreak: () => void;
}) {
  const busy = Boolean(s.cur);
  return (
    <QuickMenu
      align="end"
      title={s.staff.name}
      subtitle={busy ? `服务中 · ${s.cur!.customerName}` : '空闲'}
      trigger={
        <button type="button"
          className={cn(
            'flex min-h-tap w-full items-center gap-3 border-t border-line px-4 text-left first:border-t-0',
            'transition-colors cursor-pointer hoverable:hover:bg-sunken',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
          )}>
          <span className="grid size-8 shrink-0 place-items-center rounded-sm border border-line bg-sunken text-xs font-semibold text-ink-2">
            {s.staff.name.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{s.staff.name}</span>
            <span className="block truncate text-xs text-ink-3">
              {busy
                ? `${s.cur!.customerName} · ${s.cur!.serviceName}${s.curRoom ? ` · ${s.curRoom}` : ''}`
                : s.lastEndMin !== null
                  ? `空闲 · 上一单 ${hhmm(s.lastEndMin)} 结束`
                  : '空闲 · 今天还没接单'}
            </span>
          </span>
          {busy ? (
            <span className="shrink-0 text-right text-2xs text-ink-3 tnum">
              {hhmm(s.startMin!)} 起
              <b className="block font-semibold text-ink">{hhmm(s.endMin!)} 完</b>
            </span>
          ) : (
            <Badge tone="ok"><Dot />空闲</Badge>
          )}
        </button>
      }
    >
      {!busy && <QuickAction primary onClick={onAssign}><Play size={15} />派单</QuickAction>}
      <QuickAction onClick={onBreak}><Coffee size={15} />{busy ? '标记休息' : '去休息 / 回来'}</QuickAction>
      <QuickAction><Users size={15} />看今日收入</QuickAction>
    </QuickMenu>
  );
}

/**
 * 工位格。
 *
 * ⭐ **两个容量分开显示。** 足疗房还有四张空椅、但技师位可能已满 ——
 * 这是两回事。合成一个「占用」会让前台不敢往里排人。
 */
function RoomCell({ r }: {
  r: { name: string; capacity: number; maxStaff: number | null; guests: number; staff: number };
}) {
  const full = r.guests >= r.capacity;
  const staffFull = r.maxStaff !== null && r.staff >= r.maxStaff;
  const free = r.guests === 0;

  return (
    <QuickMenu
      title={r.name}
      subtitle={`客 ${r.guests}/${r.capacity}${r.maxStaff ? ` · 技师 ${r.staff}/${r.maxStaff}` : ''}`}
      trigger={
        <button type="button"
          className={cn(
            'min-h-[68px] w-full rounded-sm border p-2.5 text-left transition-colors cursor-pointer',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
            full ? 'border-transparent bg-warn-soft'
              : free ? 'border-line bg-surface hoverable:hover:bg-sunken'
              : 'border-transparent bg-ok-soft',
          )}>
          <div className="truncate text-xs font-semibold">{r.name}</div>
          <div className="mt-1.5 flex gap-2.5 text-2xs font-medium tnum text-ink-2">
            <span><span className="text-ink-3">客</span> {r.guests}/{r.capacity}</span>
            {r.maxStaff !== null && (
              <span className={cn(staffFull && !full && 'text-warn font-semibold')}>
                <span className="text-ink-3">技</span> {r.staff}/{r.maxStaff}
              </span>
            )}
          </div>
        </button>
      }
    >
      <QuickAction primary><DoorOpen size={15} />标记打扫完成</QuickAction>
      <QuickAction><Star size={15} />看今日排期</QuickAction>
      <QuickAction><TriangleAlert size={15} />临时停用…</QuickAction>
    </QuickMenu>
  );
}

function TodoRow({ icon, tone, label, text, cta, onClick }: {
  icon: React.ReactNode; tone: 'warn' | 'mute'; label: string;
  text: string; cta: string; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className={cn(
        'flex min-h-tap w-full items-center gap-3 border-t border-line px-4 text-left first:border-t-0',
        'transition-colors cursor-pointer hoverable:hover:bg-sunken',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
      )}>
      <Badge tone={tone}>{icon}{label}</Badge>
      <span className="min-w-0 flex-1 truncate text-sm">{text}</span>
      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ink-2">
        {cta} <ArrowRight size={14} />
      </span>
    </button>
  );
}
