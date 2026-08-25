/**
 * 改单 —— 改时间 / 换技师 / 取消。
 *
 * 在这一屏之前，前台**改约只能取消重开**：日程表上的单子块根本不可点，
 * `appointment.reschedule` 和 `appointment.cancel` 两条命令写好了但没有入口。
 * 而「客人打电话说晚半小时到」是前台每天都在处理的事。
 *
 * 两条和开单一样的纪律（都不能因为「只是改一下」就放松）：
 *
 * 1. **超卖放行要说明原因**（决策 17 / 12）。改到一个撞容量的时段和
 *    直接开一单在那个时段，对技师来说是同一件事 —— 流水上必须一样看得见，
 *    否则技师会觉得「前台改单就不用给理由」。
 *
 * 2. **取消必须回答「保不保留技师的轮次」**（`04` §7）。
 *    不问的话系统默认技师没干活，释放档期并打乱轮牌队列 ——
 *    而技师可能已经做了二十分钟。这个字段在契约里就没有默认值，
 *    就是为了逼调用方做选择。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';
import type { makeT } from '../i18n';
import type { DaySnapshot, DayItem } from './DaySchedule';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Alert } from '../ui/Alert';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

/** 与后端 overrideReason 枚举一一对应（和开单那屏同一份） */
const OVERRIDE_REASONS: Array<{ v: string; label: string; hint: string }> = [
  { v: 'walk_in_stacking',  label: '堆叠等位', hint: '客人到店泡脚等着，这是常态' },
  { v: 'guest_requested',   label: '客人指定', hint: '点名要这位技师，愿意等' },
  { v: 'staff_on_break',    label: '技师暂休', hint: '短暂离开，回来接得上' },
  { v: 'desk_coordination', label: '前台协调', hint: '我已经和技师说好了' },
  { v: 'other',             label: '其他',     hint: '需要写清楚' },
];

/** 与后端 cancelReason 枚举一一对应 */
const CANCEL_REASONS: Array<{ v: string; label: string }> = [
  { v: 'guest_changed_mind', label: '客人改主意了' },
  { v: 'no_show',            label: '客人没来' },
  { v: 'walk_out',           label: '客人走了' },
  { v: 'duplicate_booking',  label: '重复的单' },
  { v: 'input_error',        label: '我开错了' },
  { v: 'other',              label: '其他' },
];

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 门店本地墙上时间 → ISO。和开单那屏同一套（DST 当天也成立） */
function toIso(day: DaySnapshot, startMin: number): string {
  const [y, mo, d] = day.businessDate.split('-').map(Number);
  let guess = Date.UTC(y!, mo! - 1, d!, Math.floor(startMin / 60), startMin % 60);
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: day.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
    const actual = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
    guess += Date.UTC(y!, mo! - 1, d!, Math.floor(startMin / 60), startMin % 60) - actual;
  }
  return new Date(guess).toISOString();
}

function localMin(iso: string, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return g('hour') * 60 + g('minute');
}

export function EditBookingSheet({
  day, item, membershipId, t, onDone, onCancel,
}: {
  day: DaySnapshot;
  item: DayItem;
  membershipId: string;
  t: ReturnType<typeof makeT>;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'move' | 'cancel'>('move');
  const [startMin, setStartMin] = useState(() => localMin(item.startsAt, day.timezone));
  const [staffId, setStaffId] = useState(item.membershipId ?? '');
  const [busy, setBusy] = useState(false);
  const [hardError, setHardError] = useState('');
  const [issue, setIssue] = useState<ApiError | null>(null);
  const [reason, setReason] = useState('walk_in_stacking');
  const [note, setNote] = useState('');

  const [cancelReason, setCancelReason] = useState('guest_changed_mind');
  const [keepTurn, setKeepTurn] = useState<boolean | null>(null);

  const bookable = day.staff.filter((s) => s.isBookable);
  const started = item.status === 'in_progress' || item.status === 'completed';
  const origMin = localMin(item.startsAt, day.timezone);
  const changed = startMin !== origMin || staffId !== (item.membershipId ?? '');

  async function move(withOverride: boolean) {
    setBusy(true); setHardError('');
    try {
      await runCommand('appointment.reschedule', {
        appointmentId: item.appointmentId,
        itemId: item.itemId,
        startsAt: toIso(day, startMin),
        membershipId: staffId || null,
        ...(withOverride ? { override: { reason, ...(note ? { note } : {}) } } : {}),
      }, membershipId);
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.overridable) setIssue(e);
      else if (e instanceof ApiError && e.code === 'RESOURCE_CONFLICT') {
        setHardError('这个房间/座位在该时段已被占用，换个时间或换个人');
      } else if (e instanceof ApiError && e.code === 'STAFF_NOT_BOOKABLE') {
        setHardError('这位不接客（前台/老板），换一位技师');
      } else setHardError(t('common.error'));
    } finally { setBusy(false); }
  }

  async function drop() {
    if (keepTurn === null) return;
    setBusy(true); setHardError('');
    try {
      await runCommand('appointment.cancel', {
        appointmentId: item.appointmentId,
        reason: cancelReason,
        ...(note ? { note } : {}),
        keepStaffTurn: keepTurn,
      }, membershipId);
      await onDone();
    } catch {
      setHardError(t('common.error'));
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
      display: 'grid', placeItems: 'end center', zIndex: 50,
    }} onClick={onCancel}>
      <Card className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(620px,100%)', maxHeight: '92vh', overflow: 'auto',
                    padding: 24, gap: 18, borderRadius: '18px 18px 0 0' }}>

        <div className="flex flex-col gap-0.5">
          <div className="text-2xl font-extrabold">{item.customerName}</div>
          <div className="text-ink-2">
            {item.serviceName} · {hhmm(origMin)} · {item.durationMin} 分钟
            {item.isRequest && ' · ★ 点钟'}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {([['move', '改时间 / 换人'], ['cancel', '取消这一单']] as const).map(([k, l]) => (
            <Button className="min-w-0 flex-1" key={k} style={{ minHeight: 'var(--tap)', borderWidth: 2, borderColor: mode === k ? 'var(--brand)' : 'var(--line)', background: mode === k ? 'var(--brand-soft)' : 'var(--surface)', }} onClick={() => { setMode(k); setIssue(null); setHardError(''); }}>{l}</Button>
          ))}
        </div>

        {hardError && (
          <Alert tone="danger">{hardError}</Alert>
        )}

        {mode === 'move' && !issue && (
          <>
            {started && (
              <Alert tone="warn">这一单已经开始做了。改时间不会把已经做的部分抹掉，
                但技师那边看到的时间会变 —— 确认过再改。</Alert>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-3">改到几点</span>
              <Field mono  type="time" step={300}
                     value={hhmm(startMin)}
                     onChange={(e) => {
                       const [h, m] = e.target.value.split(':').map(Number);
                       if (!Number.isNaN(h) && !Number.isNaN(m)) setStartMin(h! * 60 + m!);
                     }} />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-3">换人做（不换就别动）</span>
              <div className="flex items-center gap-2 flex-wrap">
                {bookable.map((s) => (
                  <Button key={s.membershipId} onClick={() => setStaffId(s.membershipId)}
                          style={{
                            minHeight: 44, borderWidth: 2,
                            borderColor: staffId === s.membershipId ? 'var(--brand)' : 'var(--line)',
                            background: staffId === s.membershipId ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>
                    {s.inRotation ? '● ' : '○ '}{s.name}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <Button className="min-w-0 flex-1" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>先不改</Button>
              <Button variant="primary" className="min-w-0 flex-1" disabled={busy || !changed} style={{ minHeight: 'var(--tap)' }} onClick={() => void move(false)}>
                {busy ? <Spinner /> : '改到这个时间'}
              </Button>
            </div>
          </>
        )}

        {mode === 'move' && issue && (
          <>
            {/*
              软约束撞上了。前台不是被拦住，而是被要求说明原因然后放行 ——
              和开单那一屏一模一样。改单不该有更松的口子：对技师来说，
              「被改过来一单」和「被开一单」占的是同一段时间。
            */}
            <Alert tone="warn">{issue.code === 'STAFF_OVER_CAPACITY'
                ? '这位技师那个时段已经排满了。要放行的话，写一句为什么 —— 技师看得到这条流水。'
                : '那个时段店里已经排满了。要放行的话，写一句为什么。'}</Alert>
            <div className="flex flex-col gap-2">
              {OVERRIDE_REASONS.map((r) => (
                <Button key={r.v} onClick={() => setReason(r.v)}
                        style={{
                          minHeight: 'var(--tap)', textAlign: 'left', borderWidth: 2,
                          borderColor: reason === r.v ? 'var(--brand)' : 'var(--line)',
                          background: reason === r.v ? 'var(--brand-soft)' : 'var(--surface)',
                        }}>
                  <strong>{r.label}</strong> <span className="text-xs text-ink-3">· {r.hint}</span>
                </Button>
              ))}
            </div>
            {reason === 'other' && (
              <Field  placeholder="写清楚原因" value={note}
                     onChange={(e) => setNote(e.target.value)} />
            )}
            <div className="flex items-center gap-2.5">
              <Button className="min-w-0 flex-1" style={{ minHeight: 'var(--tap)' }} onClick={() => setIssue(null)}>返回</Button>
              <Button variant="primary" className="min-w-0 flex-1" disabled={busy || (reason === 'other' && !note.trim())} style={{ minHeight: 'var(--tap)' }} onClick={() => void move(true)}>
                {busy ? <Spinner /> : '说明原因并放行'}
              </Button>
            </div>
          </>
        )}

        {mode === 'cancel' && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-3">为什么取消</span>
              <div className="flex items-center gap-2 flex-wrap">
                {CANCEL_REASONS.map((r) => (
                  <Button key={r.v} onClick={() => setCancelReason(r.v)}
                          style={{
                            minHeight: 44, borderWidth: 2,
                            borderColor: cancelReason === r.v ? 'var(--brand)' : 'var(--line)',
                            background: cancelReason === r.v ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>{r.label}</Button>
                ))}
              </div>
            </div>

            {/*
              ⭐ 这一问不能省，也不能给默认值（`04` §7）。
              不问的话系统默认技师没干活 —— 释放档期、打乱轮牌队列，
              而技师可能已经做了二十分钟。门店排班会因此大乱，
              而且技师只会看到「我的轮次没了」，不知道是怎么没的。
            */}
            <Card className="flex flex-col gap-2.5" style={{ padding: 14,  background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
              <strong>技师的轮次要不要保留？</strong>
              <div className="text-xs text-ink-3" style={{ lineHeight: 1.6 }}>
                他已经开始做了、或者已经为这一单空出了时间 → 选<strong>保留</strong>，
                他的排队位置不变。<br />
                客人根本没来、他也没耽误 → 选<strong>不保留</strong>，他回到队列里继续接下一个。
              </div>
              <div className="flex items-center gap-2.5">
                {([[true, '保留他的轮次'], [false, '不保留，他继续排队']] as const).map(([v, l]) => (
                  <Button className="min-w-0 flex-1" key={String(v)} onClick={() => setKeepTurn(v)}
                          style={{
                            minHeight: 'var(--tap)', borderWidth: 2,
                            borderColor: keepTurn === v ? 'var(--brand)' : 'var(--line)',
                            background: keepTurn === v ? 'var(--brand-soft)' : 'var(--surface)',
                          }}>{l}</Button>
                ))}
              </div>
            </Card>

            {cancelReason === 'other' && (
              <Field  placeholder="写清楚原因" value={note}
                     onChange={(e) => setNote(e.target.value)} />
            )}

            <div className="flex items-center gap-2.5">
              <Button className="min-w-0 flex-1" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>先不取消</Button>
              <Button className="min-w-0 flex-1" disabled={busy || keepTurn === null || (cancelReason === 'other' && !note.trim())} style={{ minHeight: 'var(--tap)', borderColor: 'var(--danger)', color: keepTurn === null ? undefined : 'var(--danger)', borderWidth: 2, }} onClick={() => void drop()}>
                {busy ? <Spinner />
                  : keepTurn === null ? '先回答上面那一问' : '确认取消'}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
