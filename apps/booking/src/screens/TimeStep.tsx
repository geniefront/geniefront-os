/**
 * 第二步：选日子 + 选时段（可以顺便点技师）。
 *
 * ## ⭐ 空数组不是错误
 *
 * 那天不营业、排班没人、或者已经订满，接口都返回 `slots: []`。
 * 显示一个转圈或者一句 "error" 会让客人以为网站坏了然后关掉 ——
 * 要说清楚「这天约满了」并且**指出下一个有空的日子**（docs/13 §4.3）。
 *
 * ## 时间一律按门店时区
 *
 * 每一处显示都走 `lib/format.ts`，那里每个 Intl 都显式传了 `timeZone`。
 * 用 `toLocaleTimeString()` 的话，加州的客人看到的会是差三小时的时间。
 */

import type { Availability, Service, Shop } from '../lib/api';
import type { Draft } from '../App';
import { addDays, dayParts, duration, timeOf, todayIn } from '../lib/format';
import { Card, Dock, Loading, Note } from './Chrome';

export function TimeStep({
  shop, service, addons, draft, avail, busy, onDate, onStaff, onSlot, onBack,
}: {
  shop: Shop;
  service: Service;
  /** 选中的加项。时长已经算进 avail.durationMin 里了，这里只是说给客人看 */
  addons: Service[];
  draft: Draft;
  avail: Availability | null;
  busy: boolean;
  onDate: (date: string) => void;
  onStaff: (staffId: string | null) => void;
  onSlot: (startsAt: string) => void;
  onBack: () => void;
}) {
  const start = todayIn(shop.timezone);
  // 只铺 14 天。`maxDaysAhead` 可能是 60，但一次给六十个格子没人会滑到底 ——
  // 真要订两个月后的人，他会打电话
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));

  return (
    <>
      <Card>
        <h2 className="card-title">什么时候？</h2>
        <p className="card-sub">
          {[service.name, ...addons.map((a) => `＋${a.name}`)].join(' ')} ·
          {' '}{duration(avail?.durationMin
            ?? service.durationMin + addons.reduce((n, a) => n + a.durationMin, 0))}
        </p>

        <div className="days" role="tablist" aria-label="选择日期">
          {days.map((d) => {
            const p = dayParts(d, shop.timezone);
            return (
              <button key={d} type="button" role="tab"
                      aria-selected={draft.date === d}
                      className={`day ${draft.date === d ? 'sel' : ''}`}
                      onClick={() => onDate(d)}>
                <div className="day-wd">{d === start ? '今天' : p.weekday}</div>
                <div className="day-d">{p.day}</div>
              </button>
            );
          })}
        </div>

        {avail && avail.staff.length > 1 && (
          <div style={{ marginBottom: 16 }}>
            <div className="label">指定技师（可不选）</div>
            <div className="slots">
              <button type="button"
                      className={`slot ${draft.staffId === null ? 'sel' : ''}`}
                      onClick={() => onStaff(null)}>不指定</button>
              {avail.staff.map((s) => (
                <button key={s.id} type="button"
                        className={`slot ${draft.staffId === s.id ? 'sel' : ''}`}
                        onClick={() => onStaff(s.id)}>{s.displayName}</button>
              ))}
            </div>
          </div>
        )}

        {busy && <Loading label="正在查空档" />}

        {!busy && avail && avail.slots.length > 0 && (
          <>
            <div className="label">
              可约时段（{shop.timezone.split('/')[1]?.replace('_', ' ')} 当地时间）
            </div>
            <div className="slots">
              {avail.slots.map((s) => (
                <button key={s.startsAt} type="button"
                        className={`slot ${draft.startsAt === s.startsAt ? 'sel' : ''}`}
                        onClick={() => onSlot(s.startsAt)}>
                  {timeOf(s.startsAt, shop.timezone)}
                </button>
              ))}
            </div>
          </>
        )}

        {!busy && (!avail || avail.slots.length === 0) && (
          <Note>
            <strong>这天约满了</strong>，换一天看看 ——
            {shop.phone ? <> 或者<a className="tel" href={`tel:${shop.phone}`}>打给店里</a>问问。</> : ' 或者直接到店问问。'}
          </Note>
        )}

        <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
          {shop.onlineBooking.minMinutesAhead >= 60
            ? `${Math.round(shop.onlineBooking.minMinutesAhead / 60)} 小时`
            : `${shop.onlineBooking.minMinutesAhead} 分钟`}
          以内的预约请直接致电门店 —— 电话里能当场告诉你要不要等。
        </p>
      </Card>

      <Dock>
        <button className="btn btn-ghost" type="button" onClick={onBack}>上一步</button>
        <span className="muted" style={{ flex: 1, textAlign: 'right', paddingRight: 6 }}>
          选一个时段继续
        </span>
      </Dock>
    </>
  );
}
