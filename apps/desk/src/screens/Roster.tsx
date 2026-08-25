/**
 * 排班：周模板 + 一键铺开 + 单日调整 + 发布。
 *
 * 真店里的排班动作只有三个：设一次每周固定班、铺开、临时改某个人某天。
 * 所以这一屏只做这三件事，不做拖拽、不做冲突求解 ——
 * 那些是给连锁店做的，种子店的老板会直接放弃。
 *
 * ⚠️ 显示的是墙上时间（10:00–19:00）。工时按真实流逝时间算，
 * DST 那天跨夜班会差一小时，后端已经算好，这里只负责显示。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const hhmm = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const toMin = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hours = (min: number) => `${(min / 60).toFixed(1)}h`;

export interface RosterData {
  fromDate: string;
  toDate: string;
  dates: string[];
  timezone: string;
  staff: Array<{ membershipId: string; name: string; isBookable: boolean }>;
  shifts: Array<{
    membershipId: string; businessDate: string;
    startMin: number; endMin: number; breakMin: number;
    status: 'planned' | 'published' | 'off';
    offReason: string | null; note: string | null;
    fromTemplate: boolean; realMinutes: number;
  }>;
  templates: Array<{
    membershipId: string; weekday: number;
    startMin: number; endMin: number; breakMin: number;
  }>;
  totals: Array<{ membershipId: string; minutes: number }>;
  hasUnpublished: boolean;
}

export function Roster({
  data, membershipId, canWrite, onChanged, onDateChange,
}: {
  data: RosterData;
  membershipId: string;
  canWrite: boolean;
  onChanged: () => Promise<unknown>;
  onDateChange: (from: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<{ membershipId: string; date: string } | null>(null);
  const [tplFor, setTplFor] = useState<string | null>(null);

  const shiftAt = (m: string, d: string) =>
    data.shifts.find((s) => s.membershipId === m && s.businessDate === d);
  const minutesOf = (m: string) =>
    data.totals.find((t) => t.membershipId === m)?.minutes ?? 0;

  async function run(name: string, input: unknown, tag: string) {
    setBusy(tag); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError
        ? e.code === 'NOT_FOUND' ? '还没有周模板，先给每个人设一次每周固定班'
        : `操作失败（${e.code}）`
        : '操作失败');
    } finally { setBusy(''); }
  }

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-6">
      <div className="flex items-center gap-2.5 flex-wrap">
        <strong className="text-xl">排班</strong>
        <Badge tone="brand" >{data.fromDate} ~ {data.toDate}</Badge>
        {data.hasUnpublished && <Badge tone="warn" >有未发布的班</Badge>}
        <span className="min-w-0 flex-1" />
        <Button onClick={() => onDateChange(shiftDate(data.fromDate, -7))}>← 上周</Button>
        <Button onClick={() => onDateChange(shiftDate(data.fromDate, 7))}>下周 →</Button>
      </div>

      {err && (
        <Card role="alert" style={{
          padding: 14, background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
          <span className="text-danger font-bold">✕ {err}</span>
        </Card>
      )}

      {canWrite && (
        <div className="flex items-center gap-2.5 flex-wrap">
          <Button disabled={busy === 'apply'} onClick={() => void run('shift.applyTemplate',
                    { fromDate: data.fromDate, days: 7, skipExisting: true }, 'apply')}>
            {busy === 'apply' ? <Spinner /> : '按模板铺开这一周'}
          </Button>
          <Button disabled={busy === 'apply2'} onClick={() => void run('shift.applyTemplate',
                    { fromDate: data.fromDate, days: 14, skipExisting: true }, 'apply2')}>
            铺开两周
          </Button>
          <Button variant="primary" disabled={busy === 'pub' || !data.hasUnpublished} onClick={() => void run('shift.publish',
                    { fromDate: data.fromDate, toDate: data.toDate }, 'pub')}>
            {busy === 'pub' ? <Spinner /> : '发布给技师'}
          </Button>
          {/* 这句话是这个按钮敢被点的全部理由 */}
          <span className="text-xs text-ink-3">铺开只填空白的日子，不会冲掉手工调过的班</span>
        </div>
      )}

      {/* ── 周表格 ───────────────────────────────────────────────────────── */}
      <Card style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
          <thead>
            <tr>
              <th style={{ ...th, position: 'sticky', left: 0, background: 'var(--surface)' }}>技师</th>
              {data.dates.map((d) => (
                <th key={d} style={th}>
                  <div>{WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]}</div>
                  <div className="text-xs text-ink-3">{d.slice(5)}</div>
                </th>
              ))}
              <th style={th}>工时</th>
            </tr>
          </thead>
          <tbody>
            {data.staff.map((s) => (
              <tr key={s.membershipId}>
                <td style={{ ...td, position: 'sticky', left: 0, background: 'var(--surface)' }}>
                  <div className="flex flex-col gap-0.5">
                    <strong>{s.name}</strong>
                    {canWrite && (
                      <button className="text-xs text-ink-3" style={linkBtn}
                              onClick={() => setTplFor(tplFor === s.membershipId ? null : s.membershipId)}>
                        每周固定班 ▾
                      </button>
                    )}
                  </div>
                </td>
                {data.dates.map((d) => {
                  const sh = shiftAt(s.membershipId, d);
                  return (
                    <td key={d} style={td}>
                      <button
                        disabled={!canWrite}
                        onClick={() => setEditing({ membershipId: s.membershipId, date: d })}
                        style={{
                          ...cell,
                          cursor: canWrite ? 'pointer' : 'default',
                          background: !sh ? 'transparent'
                            : sh.status === 'off' ? 'var(--warn-soft)'
                            : sh.status === 'published' ? 'var(--ok-soft)' : 'var(--brand-soft)',
                          borderColor: !sh ? 'var(--line)'
                            : sh.status === 'off' ? 'var(--warn)'
                            : sh.status === 'published' ? 'var(--ok)' : 'var(--brand)',
                        }}>
                        {!sh ? <span className="text-xs text-ink-3 text-ink-2">—</span>
                          : sh.status === 'off'
                            ? <span className="text-xs text-ink-3">休 {sh.offReason === 'sick' ? '病' : ''}</span>
                            : (
                              <span className="text-xs text-ink-3 tnum">
                                {hhmm(sh.startMin)}<br />{hhmm(sh.endMin)}
                              </span>
                            )}
                      </button>
                    </td>
                  );
                })}
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>
                  {hours(minutesOf(s.membershipId))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {tplFor && (
        <TemplateEditor
          staffName={data.staff.find((s) => s.membershipId === tplFor)?.name ?? ''}
          entries={data.templates.filter((t) => t.membershipId === tplFor)}
          busy={busy === 'tpl'}
          onCancel={() => setTplFor(null)}
          onSave={(entries) => void run('shift.saveTemplate',
            { membershipId: tplFor, entries }, 'tpl').then(() => setTplFor(null))}
        />
      )}

      {editing && (
        <ShiftEditor
          staffName={data.staff.find((s) => s.membershipId === editing.membershipId)?.name ?? ''}
          date={editing.date}
          current={shiftAt(editing.membershipId, editing.date)}
          busy={busy === 'set'}
          onCancel={() => setEditing(null)}
          onSave={(payload) => void run('shift.set',
            { membershipId: editing.membershipId, businessDate: editing.date, ...payload }, 'set')
            .then(() => setEditing(null))}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── 子组件

function TemplateEditor({ staffName, entries, busy, onSave, onCancel }: {
  staffName: string;
  entries: Array<{ weekday: number; startMin: number; endMin: number; breakMin: number }>;
  busy: boolean;
  onSave: (e: Array<{ weekday: number; startMin: number; endMin: number; breakMin: number }>) => void;
  onCancel: () => void;
}) {
  // ⚠️ 一律用函数式更新：同一批次里连续改两天（勾上周一又勾周三）时，
  // setRows(rows.map(...)) 用的是闭包里那一版 rows，后一次会把前一次盖掉。
  const [rows, setRows] = useState(() =>
    WEEKDAYS.map((_, wd) => {
      const e = entries.find((x) => x.weekday === wd);
      return {
        on: Boolean(e),
        start: hhmm(e?.startMin ?? 600),
        end: hhmm(e?.endMin ?? 1140),
        // 跨夜要保留 >1440 的语义，hhmm 会把 1560 显示成 02:00
        overnight: (e?.endMin ?? 1140) > 1440,
        breakMin: String(e?.breakMin ?? 0),
      };
    }));

  return (
    <Sheet title={`${staffName} 的每周固定班`} onCancel={onCancel}>
      <div className="flex flex-col gap-2">
        {rows.map((r, wd) => (
          <div key={wd} className="flex items-center gap-2">
            <Button style={{ width: 76, minHeight: 52, borderWidth: 2, borderColor: r.on ? 'var(--brand)' : 'var(--line)', background: r.on ? 'var(--brand-soft)' : 'var(--surface)' }} onClick={() => setRows((prev) => prev.map((x, i) => i === wd ? { ...x, on: !x.on } : x))}>
              {WEEKDAYS[wd]}
            </Button>
            <Field mono  style={{ width: 90 }} disabled={!r.on}
                   value={r.start}
                   onChange={(e) => setRows((prev) => prev.map((x, i) => i === wd ? { ...x, start: e.target.value } : x))} />
            <span className="text-ink-2">–</span>
            <Field mono  style={{ width: 90 }} disabled={!r.on}
                   value={r.end}
                   onChange={(e) => setRows((prev) => prev.map((x, i) => i === wd ? { ...x, end: e.target.value } : x))} />
            <label className="flex items-center text-xs text-ink-3 gap-1">
              <input type="checkbox" checked={r.overnight} disabled={!r.on}
                     onChange={(e) => setRows((prev) => prev.map((x, i) => i === wd ? { ...x, overnight: e.target.checked } : x))} />
              跨夜
            </label>
            <Field mono  style={{ width: 70 }} disabled={!r.on}
                   inputMode="numeric" value={r.breakMin} placeholder="休息"
                   onChange={(e) => setRows((prev) => prev.map((x, i) => i === wd ? { ...x, breakMin: e.target.value.replace(/\D/g, '') } : x))} />
          </div>
        ))}
        <div className="text-xs text-ink-3">
          跨夜勾上表示做到第二天（足疗店 18:00 到次日 02:00）。休息填的是无薪餐休分钟数。
        </div>
        <Button variant="primary" block disabled={busy} onClick={() => onSave(rows.flatMap((r, wd) => {
                  if (!r.on) return [];
                  const s = toMin(r.start); const e = toMin(r.end);
                  if (s === null || e === null) return [];
                  return [{
                    weekday: wd, startMin: s,
                    endMin: r.overnight ? e + 1440 : e,
                    breakMin: Number(r.breakMin) || 0,
                  }];
                }))}>
          {busy ? <Spinner /> : '保存模板'}
        </Button>
      </div>
    </Sheet>
  );
}

function ShiftEditor({ staffName, date, current, busy, onSave, onCancel }: {
  staffName: string;
  date: string;
  current?: { startMin: number; endMin: number; breakMin: number; status: string } | undefined;
  busy: boolean;
  onSave: (p: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState(hhmm(current?.startMin ?? 600));
  const [end, setEnd] = useState(hhmm(current?.endMin ?? 1140));
  const [overnight, setOvernight] = useState((current?.endMin ?? 0) > 1440);
  const [breakMin, setBreakMin] = useState(String(current?.breakMin ?? 0));

  return (
    <Sheet title={`${staffName} · ${date}`} onCancel={onCancel}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Field mono  style={{ width: 100 }} value={start}
                 onChange={(e) => setStart(e.target.value)} />
          <span className="text-ink-2">–</span>
          <Field mono  style={{ width: 100 }} value={end}
                 onChange={(e) => setEnd(e.target.value)} />
          <label className="flex items-center text-xs text-ink-3 gap-1">
            <input type="checkbox" checked={overnight}
                   onChange={(e) => setOvernight(e.target.checked)} />
            跨夜
          </label>
          <Field mono  style={{ width: 80 }} inputMode="numeric"
                 value={breakMin} placeholder="休息"
                 onChange={(e) => setBreakMin(e.target.value.replace(/\D/g, ''))} />
        </div>

        <Button variant="primary" block disabled={busy} onClick={() => {
                  const s = toMin(start); const e = toMin(end);
                  if (s === null || e === null) return;
                  onSave({
                    action: 'work', startMin: s,
                    endMin: overnight ? e + 1440 : e,
                    breakMin: Number(breakMin) || 0,
                  });
                }}>
          {busy ? <Spinner /> : '保存这天的班'}
        </Button>

        <div className="flex items-center gap-2 flex-wrap">
          {([['sick', '病假'], ['vacation', '休假'], ['personal', '事假'],
             ['store_closed', '店休']] as const).map(([r, l]) => (
            <Button className="min-w-0 flex-1" key={r} disabled={busy} onClick={() => onSave({ action: 'off', offReason: r })}>
              标为{l}
            </Button>
          ))}
        </div>
        <Button variant="ghost" block disabled={busy} onClick={() => onSave({ action: 'delete' })}>
          这天不排班
        </Button>
      </div>
    </Sheet>
  );
}

function Sheet({ title, children, onCancel }: {
  title: string; children: React.ReactNode; onCancel: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
      display: 'grid', placeItems: 'end center', zIndex: 50,
    }} onClick={onCancel}>
      <Card className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(660px,100%)', maxHeight: '94vh', overflow: 'auto',
                    padding: 24, gap: 16, borderRadius: '18px 18px 0 0' }}>
        <div className="flex items-center gap-3">
          <strong className="min-w-0 flex-1 text-xl">{title}</strong>
          <Button variant="ghost" onClick={onCancel}>关闭</Button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const th: React.CSSProperties = {
  padding: '10px 8px', borderBottom: '2px solid var(--line)',
  textAlign: 'center', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '8px', borderBottom: '1px solid var(--line)', textAlign: 'center',
};
const cell: React.CSSProperties = {
  width: '100%', minHeight: 56, borderRadius: 10, borderWidth: 2, borderStyle: 'solid',
  padding: 4, lineHeight: 1.3,
};
const linkBtn: React.CSSProperties = {
  background: 'none', border: 0, padding: 0, textAlign: 'left',
  color: 'var(--brand)', cursor: 'pointer', textDecoration: 'underline',
};
