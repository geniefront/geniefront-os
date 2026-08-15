/**
 * 日程表 —— 按技师列（决策：Phase 1a 默认按技师列，可切按房间列）。
 *
 * 这一屏要同时说清楚三件前台每分钟都在判断的事：
 *   谁在接客、谁只接点钟不吃轮牌、谁根本不接客
 *   哪一单是超卖放行的（决策 17：允许，但必须看得见、有原因）
 *   现在几点（红线），因为前台的所有判断都以"现在"为原点
 */

import { useEffect, useRef, useState } from 'react';
import type { makeT } from '../i18n';

export interface DayStaff {
  membershipId: string; name: string; isBookable: boolean;
  inRotation: boolean; maxConcurrent: number; color: string | null;
}
export interface DayItem {
  itemId: string; appointmentId: string; membershipId: string | null;
  customerName: string; serviceName: string;
  startsAt: string; endsAt: string; durationMin: number;
  status: string; isRequest: boolean; overbooked: boolean;
  overbookReason: string | null; resourceId: string | null;
}
export interface DaySnapshot {
  businessDate: string; timezone: string; openMin: number; closeMin: number;
  staff: DayStaff[]; services: Array<{ id: string; name: string; durationMin: number; priceCents: number }>;
  resources: Array<{ id: string; name: string }>; items: DayItem[];
}

const PX_PER_MIN = 1.5;
const HEAD_H = 64;

/** 一天里的第几分钟（门店本地墙上时间）。时间一律 timestamptz 存，按门店时区显示。 */
function localMin(iso: string, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return g('hour') * 60 + g('minute');
}

/**
 * 重叠的单要并排画，不能叠在一起。
 *
 * 超卖是【默认开启】的（决策 17），所以同一技师同一时段有多单是常态而不是异常。
 * 叠着画的话前台根本看不出有几个人在等 —— 那正是这一屏最该回答的问题。
 *
 * 扫描线分列：每一单放进第一个不与它重叠的列。
 */
function layout(items: DayItem[], tz: string): Array<{ it: DayItem; lane: number; lanes: number }> {
  const sorted = [...items].sort(
    (a, b) => localMin(a.startsAt, tz) - localMin(b.startsAt, tz));
  const laneEnd: number[] = [];
  const placed = sorted.map((it) => {
    const s = localMin(it.startsAt, tz);
    const e = localMin(it.endsAt, tz);
    let lane = laneEnd.findIndex((end) => end <= s);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(e); }
    else laneEnd[lane] = e;
    return { it, lane, s, e };
  });
  // 同一簇（互相重叠的一组）共用同一个列数，宽度才一致
  return placed.map((p) => {
    const overlapping = placed.filter((q) => q.s < p.e && p.s < q.e);
    return { it: p.it, lane: p.lane, lanes: Math.max(...overlapping.map((q) => q.lane)) + 1 };
  });
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function DaySchedule({
  day, t, onSlotClick,
}: {
  day: DaySnapshot;
  t: ReturnType<typeof makeT>;
  onSlotClick: (membershipId: string, startMin: number) => void;
}) {
  const cols = day.staff.filter((s) => s.isBookable);
  const scroller = useRef<HTMLDivElement>(null);
  const [nowMin, setNowMin] = useState(() => localMin(new Date().toISOString(), day.timezone));

  useEffect(() => {
    const id = setInterval(() => setNowMin(localMin(new Date().toISOString(), day.timezone)), 60_000);
    return () => clearInterval(id);
  }, [day.timezone]);

  // 打开就滚到"现在"，前台不用先找位置
  useEffect(() => {
    if (!scroller.current) return;
    const y = (nowMin - day.openMin) * PX_PER_MIN - 120;
    scroller.current.scrollTop = Math.max(0, y);
    // 只在首次挂载时滚
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = Math.max(day.closeMin - day.openMin, 60);
  const hours: number[] = [];
  for (let m = Math.floor(day.openMin / 60) * 60; m <= day.closeMin; m += 60) hours.push(m);

  if (cols.length === 0) {
    return (
      <div className="card" style={{ padding: 28, textAlign: 'center', margin: 16 }}>
        <div className="muted">今天没有可排单的技师</div>
        <div className="tiny" style={{ marginTop: 6 }}>
          在「员工」里把接客的人打开「可被排单」
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ overflow: 'hidden', margin: '0 16px 16px' }}>
      {/* 表头：技师 + 他今天的角色状态 */}
      <div style={{
        display: 'grid', gridTemplateColumns: `62px repeat(${cols.length}, minmax(150px, 1fr))`,
        borderBottom: '1px solid var(--line)', background: 'var(--surface)',
        position: 'sticky', top: 0, zIndex: 3,
      }}>
        <div style={{ height: HEAD_H, borderRight: '1px solid var(--line)' }} />
        {cols.map((s) => (
          <div key={s.membershipId} className="stack"
               style={{ height: HEAD_H, padding: '8px 10px', gap: 3,
                        borderRight: '1px solid var(--line)', justifyContent: 'center' }}>
            <div className="row" style={{ gap: 6 }}>
              <strong className="truncate" style={{ fontSize: 'var(--text-lg)' }}>{s.name}</strong>
              {s.maxConcurrent > 1 && (
                <span className="badge badge-mute" title="可同时接多单（做手时脚在泡）">
                  ×{s.maxConcurrent}
                </span>
              )}
            </div>
            {/* 「参与轮牌」是每天变的，必须一眼看到（决策 20） */}
            <span className={s.inRotation ? 'badge badge-ok' : 'badge badge-mute'}
                  style={{ alignSelf: 'flex-start' }}>
              {s.inRotation ? '● 排轮牌' : '○ 只接点钟'}
            </span>
          </div>
        ))}
      </div>

      <div ref={scroller} style={{ maxHeight: '62vh', overflow: 'auto', position: 'relative' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: `62px repeat(${cols.length}, minmax(150px, 1fr))`,
          height: total * PX_PER_MIN, position: 'relative',
        }}>
          {/* 时间轴 */}
          <div style={{ borderRight: '1px solid var(--line)', position: 'relative' }}>
            {hours.map((m) => (
              <div key={m} className="tiny" style={{
                position: 'absolute', top: (m - day.openMin) * PX_PER_MIN - 8,
                right: 8, fontVariantNumeric: 'tabular-nums',
              }}>{hhmm(m)}</div>
            ))}
          </div>

          {cols.map((s) => {
            const mine = day.items.filter((i) => i.membershipId === s.membershipId);
            return (
              <div key={s.membershipId}
                   style={{ borderRight: '1px solid var(--line)', position: 'relative' }}>
                {/* 整点线 */}
                {hours.map((m) => (
                  <div key={m} style={{
                    position: 'absolute', left: 0, right: 0,
                    top: (m - day.openMin) * PX_PER_MIN,
                    borderTop: '1px solid var(--line)', opacity: .7,
                  }} />
                ))}

                {/* 空白处点一下就开单 —— 半小时一格 */}
                {hours.flatMap((m) => [m, m + 30]).map((m) => (
                  <button key={m} aria-label={`${s.name} ${hhmm(m)} 建单`}
                          onClick={() => onSlotClick(s.membershipId, m)}
                          style={{
                            position: 'absolute', left: 2, right: 2,
                            top: (m - day.openMin) * PX_PER_MIN, height: 30 * PX_PER_MIN,
                            background: 'transparent', border: 0, cursor: 'pointer', padding: 0,
                          }} />
                ))}

                {layout(mine, day.timezone).map(({ it, lane, lanes }) => {
                  const top = (localMin(it.startsAt, day.timezone) - day.openMin) * PX_PER_MIN;
                  const h = Math.max(it.durationMin * PX_PER_MIN, 34);
                  const w = 100 / lanes;
                  return (
                    <div key={it.itemId} className="stack"
                         style={{
                           position: 'absolute', top, height: h,
                           left: `calc(${lane * w}% + 4px)`,
                           width: `calc(${w}% - 6px)`,
                           padding: '6px 9px', gap: 2, overflow: 'hidden',
                           borderRadius: 10,
                           // 超卖单用【虚线边框 + 图标】而不是只靠颜色区分
                           border: it.overbooked
                             ? '2px dashed var(--warn)' : '1px solid var(--brand)',
                           background: it.overbooked ? 'var(--warn-soft)' : 'var(--brand-soft)',
                         }}>
                      <div className="row" style={{ gap: 5 }}>
                        {it.overbooked && <span title={`超卖放行：${it.overbookReason}`}>⚠️</span>}
                        {it.isRequest && <span title="点钟单">★</span>}
                        <strong className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
                          {it.customerName}
                        </strong>
                      </div>
                      <div className="truncate tiny">{it.serviceName}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* 现在几点 —— 前台所有判断的原点 */}
          {nowMin >= day.openMin && nowMin <= day.closeMin && (
            <div style={{
              position: 'absolute', left: 62, right: 0,
              top: (nowMin - day.openMin) * PX_PER_MIN,
              borderTop: '2px solid var(--danger)', zIndex: 2, pointerEvents: 'none',
            }}>
              <span className="badge badge-danger" style={{
                position: 'absolute', left: -58, top: -13, fontSize: 12,
              }}>{hhmm(nowMin)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="row tiny" style={{ padding: '8px 12px', gap: 16, borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
        <span>点空白处建单</span>
        <span>★ 点钟单</span>
        <span>⚠️ 虚线 = 超卖放行</span>
        <span>● 排轮牌 / ○ 只接点钟</span>
        <span className="grow" />
        <span>{t('common.loading') === 'Loading…' ? day.businessDate : `营业日 ${day.businessDate}`}</span>
      </div>
    </div>
  );
}
