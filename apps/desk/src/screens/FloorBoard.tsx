/**
 * 房态看板 —— 「哪间房现在能用」。
 *
 * 这一屏原来不存在。房间只在「开店配置」里能配，配完之后前台就再也看不见它们了 ——
 * 于是排单时「这个点还有房吗」只能靠走过去看一眼，或者靠记性。
 *
 * ⭐ 它**不发一个新请求**：数据全部从已经在拉的 `/v1/desk/day` 里算出来。
 * 房间、每一单的 resourceId、起止时间都在那份快照里，缺的只是把它们摆出来。
 * 多一个接口就多一份会和日程表对不上的数据。
 *
 * ⭐ 「占用」不是一个布尔值（决策 25）。一间房能同时容纳几个人：
 * 足疗房排 6 张躺椅、双人房两张床两个技师。所以这里画的是 **3/6 位**
 * 而不是「占用」—— 后者会让前台看到一间还空着四张椅子的房不敢再排人。
 */

import { useMemo } from 'react';
import { DoorOpen, Star, TriangleAlert } from 'lucide-react';
import { InfoDot } from '../ui/Info';
import type { DaySnapshot, DayItem } from './DaySchedule';

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

/** 剩余时长比结束时刻好用：前台不必拿当前时间去减 */
const leftLabel = (endMin: number, now: number) => {
  const d = endMin - now;
  if (d <= 0) return '已超时';
  if (d < 60) return `剩 ${d} 分钟`;
  return `剩 ${Math.floor(d / 60)} 小时 ${d % 60} 分`;
};

interface Slot {
  item: DayItem;
  staffName: string;
  startMin: number;
  endMin: number;
}

interface RoomState {
  id: string;
  name: string;
  capacity: number;
  maxStaff: number | null;
  /** 此刻正在里面的 */
  now: Slot[];
  /** 今天晚些时候要用这间房的（按时间排） */
  upcoming: Slot[];
  /** 不同技师数 —— maxStaff 是拿来跟它比的 */
  staffCount: number;
}

export function FloorBoard({ day, nowMin }: { day: DaySnapshot; nowMin: number }) {
  const rooms = useMemo<RoomState[]>(() => {
    const nameOf = new Map(day.staff.map((s) => [s.membershipId, s.name]));

    return day.resources.map((r) => {
      const mine = day.items
        .filter((it) => it.resourceId === r.id && it.status !== 'done')
        .map<Slot>((it) => ({
          item: it,
          staffName: (it.membershipId && nameOf.get(it.membershipId)) || '未指定',
          startMin: localMin(it.startsAt, day.timezone),
          endMin: localMin(it.endsAt, day.timezone),
        }))
        .sort((a, b) => a.startMin - b.startMin);

      // 「此刻在里面」按时间判断，不看 status —— 技师忘了点「开始」是常事，
      // 而墙上的钟不会忘。status 只用来排除已经做完和取消的
      const now = mine.filter((s) => s.startMin <= nowMin && s.endMin > nowMin);
      const upcoming = mine.filter((s) => s.startMin > nowMin);

      return {
        id: r.id, name: r.name,
        capacity: r.capacity, maxStaff: r.maxStaff,
        now, upcoming,
        staffCount: new Set(now.map((s) => s.item.membershipId).filter(Boolean)).size,
      };
    });
  }, [day, nowMin]);

  const freeCount = rooms.filter((r) => r.now.length === 0).length;
  const fullCount = rooms.filter((r) => r.now.length >= r.capacity).length;

  if (day.resources.length === 0) {
    return (
      <div className="page">
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <DoorOpen size={36} style={{ color: 'var(--ink-3)' }} />
          <div className="title" style={{ marginTop: 14 }}>尚未配置资源</div>
          <div className="tiny row" style={{ marginTop: 8, justifyContent: 'center', gap: 6 }}>
            在「门店设置 → 房间与设备」中添加
            <InfoDot text="资源配置后，系统会在排单时按容量校验，阻止同一房间超额占用。未配置时不做校验。" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div className="grow">
          <h1 className="display">房态</h1>
          <div className="tiny sub row" style={{ gap: 6 }}>
            <span>
              空闲 <span className="num">{freeCount}</span>
              {fullCount > 0 && <> · 满位 <span className="num">{fullCount}</span></>}
              {' · '}截至 <span className="num">{hhmm(nowMin)}</span>
            </span>
            <InfoDot text="占用情况按预约的起止时间判断，不依赖技师是否点了「开始服务」。" />
          </div>
        </div>
      </div>

      <div className="grid-cards">
        {rooms.map((r) => <RoomCard key={r.id} room={r} nowMin={nowMin} />)}
      </div>
    </div>
  );
}

function RoomCard({ room, nowMin }: { room: RoomState; nowMin: number }) {
  const used = room.now.length;
  const full = used >= room.capacity;
  const free = used === 0;

  /*
   * 状态三通道：颜色 + 图标 + 文字。廉价 iPad 屏上只靠颜色是分不出来的。
   *
   * ⚠️ 分状态靠**顶部色带 + 徽章**，不靠给整张卡描一圈粗彩边。
   * 一屏八张卡各描一圈的话，满屏都是重线条，反而看不出哪张要紧 ——
   * 卡片本身保持几乎无边，让阴影和底色去分层。
   */
  const tone = free
    ? { label: '空闲',   cls: 'badge-mute', fg: 'var(--ink-3)' }
    : full
      ? { label: '满位',   cls: 'badge-warn', fg: 'var(--warn)' }
      : { label: '有空位', cls: 'badge-ok',   fg: 'var(--ok)' };

  /** 双人房只剩一个技师位的话，能进人但**不能进第二个技师** —— 这条得说出来 */
  const staffFull = room.maxStaff !== null && room.staffCount >= room.maxStaff;

  return (
    <div className="card stack" style={{ padding: 18, gap: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        <strong className="title grow truncate">{room.name}</strong>
        {/* ⭐ 容量画成 3/6 而不是「占用」—— 见文件头那段 */}
        {room.capacity > 1 && (
          <span className="num" style={{ color: 'var(--ink-3)', fontWeight: 600 }}>
            {used}/{room.capacity}
          </span>
        )}
        {/* 状态点 + 文字。点不单独承载信息，文字才是（宪法第 11 条） */}
        <span className={`badge ${tone.cls}`}>
          <span className="dot" style={{ color: tone.fg }} />{tone.label}
        </span>
      </div>
      <div className="stack" style={{ gap: 14 }}>
        {room.now.length === 0 ? (
          <div className="tiny">当前无占用</div>
        ) : (
          room.now.map((s) => (
            <div key={s.item.itemId} className="stack" style={{ gap: 3 }}>
              <div className="row" style={{ gap: 7 }}>
                <strong className="truncate">{s.item.customerName}</strong>
                {s.item.isRequest && (
                  <span className="badge badge-line" title="点钟：客人指定技师">
                    <Star size={12} /> 点钟
                  </span>
                )}
                {s.item.overbooked && (
                  <span className="badge badge-warn" title="超出容量，前台已确认放行">
                    <TriangleAlert size={12} /> 超排
                  </span>
                )}
              </div>
              <div className="tiny truncate">{s.staffName} · {s.item.serviceName}</div>
              <div className="tiny num" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>
                {hhmm(s.startMin)}–{hhmm(s.endMin)} · {leftLabel(s.endMin, nowMin)}
              </div>
            </div>
          ))
        )}

        {staffFull && !full && (
          <div className="tiny row" style={{ color: 'var(--warn)', fontWeight: 500, gap: 5 }}>
            <TriangleAlert size={14} />
            技师位已满（上限 {room.maxStaff}）
            <InfoDot text={`该资源仍有空位，但同时进入的技师数已达上限 ${room.maxStaff} 人。可继续安排由现有技师服务的客人。`} />
          </div>
        )}

        {/* 下一单：回答「这间房什么时候能腾出来」*/}
        {room.upcoming.length > 0 && (
          <div className="tiny" style={{
            borderTop: '1px solid var(--line)', paddingTop: 12,
          }}>
            下一位 <span className="num">{hhmm(room.upcoming[0]!.startMin)}</span>
            {' · '}{room.upcoming[0]!.item.customerName}
            {room.upcoming.length > 1 && ` · 今日另有 ${room.upcoming.length - 1} 单`}
          </div>
        )}
      </div>
    </div>
  );
}
