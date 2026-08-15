/**
 * 开店配置 —— 项目 / 员工 / 营业时间。
 *
 * 这三样是门店能真正用起来的前提。面向的是「英文不好、四十岁以上」的老板，
 * 所以：字段能少就少，能给默认值就别让他填，一屏做完一件事（`04` §2）。
 *
 * 价格用整数分存，但输入框里给他填美元 —— 让老板算分数是荒谬的。
 */

import { useState } from 'react';
import { dollarsToCents } from '@gf/contracts';
import { ApiError, runCommand } from '../lib/api';

export interface SettingsData {
  location: {
    name: string; timezone: string; businessType: string;
    businessHours: Record<string, { open: string; close: string } | null>;
  };
  services: Array<{
    id: string; name: Record<string, string>; displayName: string;
    durationMin: number; basePriceCents: number;
    taxable: boolean; onlineBookable: boolean; active: boolean;
  }>;
  staff: Array<{
    membershipId: string; name: string; isBookable: boolean;
    maxConcurrent: number; levelKey: string | null; inRotation: boolean;
  }>;
  levels: Array<{ id: string; key: string; name: string }>;
}

const DAYS: Array<[string, string]> = [
  ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'],
  ['fri', '周五'], ['sat', '周六'], ['sun', '周日'],
];

const money = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, '');

export function Settings({
  data, membershipId, onChanged,
}: {
  data: SettingsData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [pane, setPane] = useState<'service' | 'staff' | 'hours'>('service');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function run(name: string, input: unknown) {
    setBusy(true); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `保存失败（${e.code}）` : '保存失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        {([['service', '项目'], ['staff', '员工'], ['hours', '营业时间']] as const).map(([k, l]) => (
          <button key={k} className="btn" onClick={() => setPane(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: pane === k ? 'var(--brand)' : 'var(--line)',
                    background: pane === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>{l}</button>
        ))}
      </div>

      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {pane === 'service' && <ServicePane data={data} busy={busy} run={run} />}
      {pane === 'staff' && <StaffPane data={data} busy={busy} run={run} />}
      {pane === 'hours' && <HoursPane data={data} busy={busy} run={run} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── 项目

function ServicePane({ data, busy, run }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [dur, setDur] = useState('45');
  const [price, setPrice] = useState('');

  function startEdit(s?: SettingsData['services'][number]) {
    setEditing(s?.id ?? 'new');
    setName(s?.displayName ?? '');
    setDur(String(s?.durationMin ?? 45));
    setPrice(s ? money(s.basePriceCents) : '');
  }

  async function save() {
    await run('catalog.saveService', {
      ...(editing !== 'new' ? { serviceId: editing } : {}),
      // 老板打什么就存什么语言；AI 开店向导以后会补齐其他语言（05 §4.4）
      name: { 'zh-Hans': name, en: name },
      durationMin: Number(dur) || 45,
      basePriceCents: dollarsToCents(price),
    });
    setEditing(null);
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {data.services.map((s) => (
        <div key={s.id} className="card row"
             style={{ padding: '14px 16px', gap: 12, opacity: s.active ? 1 : .5 }}>
          <div className="grow stack" style={{ gap: 2, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <strong className="truncate" style={{ fontSize: 'var(--text-lg)' }}>
                {s.displayName}
              </strong>
              {!s.active && <span className="badge badge-mute">已下架</span>}
            </div>
            <span className="tiny">{s.durationMin} 分钟 · ${money(s.basePriceCents)}</span>
          </div>
          <button className="btn" style={{ minHeight: 44 }} disabled={busy}
                  onClick={() => startEdit(s)}>改</button>
          {s.active && (
            <button className="btn" style={{ minHeight: 44 }} disabled={busy}
                    onClick={() => void run('catalog.archiveService', { serviceId: s.id })}>
              下架
            </button>
          )}
        </div>
      ))}

      <button className="btn btn-primary btn-block" onClick={() => startEdit()} disabled={busy}>
        ＋ 加一个项目
      </button>
      <div className="tiny">下架不会影响已经开过的单 —— 项目名和价格在开单时就存下来了</div>

      {editing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
          display: 'grid', placeItems: 'end center', zIndex: 50,
        }} onClick={() => setEditing(null)}>
          <div className="card stack" onClick={(e) => e.stopPropagation()}
               style={{ width: 'min(560px,100%)', padding: 24, gap: 16,
                        borderRadius: '18px 18px 0 0' }}>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>
              {editing === 'new' ? '加一个项目' : '改项目'}
            </div>

            <label className="stack" style={{ gap: 6 }}>
              <span className="tiny">项目名</span>
              <input className="field" value={name} autoFocus
                     placeholder="例：甲油胶美甲"
                     onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="row" style={{ gap: 12 }}>
              <label className="stack grow" style={{ gap: 6 }}>
                <span className="tiny">要多久（分钟）</span>
                <input className="field field-mono" inputMode="numeric" value={dur}
                       onChange={(e) => setDur(e.target.value)} />
              </label>
              <label className="stack grow" style={{ gap: 6 }}>
                <span className="tiny">多少钱（美元）</span>
                <input className="field field-mono" inputMode="decimal" value={price}
                       placeholder="45" onChange={(e) => setPrice(e.target.value)} />
              </label>
            </div>

            {/* 常用时长一键选，省得敲键盘 */}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {[15, 30, 45, 60, 90].map((m) => (
                <button key={m} className="btn" style={{ minHeight: 48 }}
                        onClick={() => setDur(String(m))}>{m} 分钟</button>
              ))}
            </div>

            <div className="row" style={{ gap: 10 }}>
              <button className="btn grow" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary grow"
                      disabled={busy || !name.trim() || !price.trim()}
                      onClick={() => void save()}>
                {busy ? <span className="spin" /> : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── 员工

function StaffPane({ data, busy, run }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
}) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      {data.staff.map((s) => (
        <div key={s.membershipId} className="card stack" style={{ padding: 16, gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <strong className="grow" style={{ fontSize: 'var(--text-lg)' }}>{s.name}</strong>
            {s.levelKey && (
              <span className="badge badge-soft">
                {data.levels.find((l) => l.key === s.levelKey)?.name ?? s.levelKey}
              </span>
            )}
          </div>

          {/* 两个开关是一人多角色的全部（决策 20） */}
          <div className="stack" style={{ gap: 8 }}>
            <Toggle label="接客（出现在日程表里）" on={s.isBookable} busy={busy}
                    onChange={(v) => void run('staff.saveProfile',
                      { membershipId: s.membershipId, isBookable: v })} />
            <Toggle label="今天排轮牌（吃 walk-in）" on={s.inRotation}
                    busy={busy || !s.isBookable}
                    hint={s.isBookable ? '关掉 = 只接点钟，店长常这么设' : '要先打开「接客」'}
                    onChange={(v) => void run('staff.setRotation',
                      { membershipId: s.membershipId, inRotation: v })} />
          </div>

          {s.isBookable && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="tiny grow">同时能接几单</span>
              {[1, 2, 3].map((n) => (
                <button key={n} className="btn" disabled={busy}
                        style={{
                          minHeight: 48, minWidth: 56, borderWidth: 2,
                          borderColor: s.maxConcurrent === n ? 'var(--brand)' : 'var(--line)',
                          background: s.maxConcurrent === n ? 'var(--brand-soft)' : 'var(--surface)',
                        }}
                        onClick={() => void run('staff.saveProfile',
                          { membershipId: s.membershipId, maxConcurrentAppointments: n })}>
                  {n}
                </button>
              ))}
            </div>
          )}
          {s.isBookable && s.maxConcurrent > 1 && (
            <div className="tiny">做手的时候脚在泡水，可以同时压 {s.maxConcurrent} 单</div>
          )}
        </div>
      ))}
    </div>
  );
}

function Toggle({ label, on, busy, hint, onChange }: {
  label: string; on: boolean; busy: boolean; hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className="row" disabled={busy} onClick={() => onChange(!on)}
            style={{
              minHeight: 'var(--tap)', padding: '0 14px', gap: 12, width: '100%',
              border: '2px solid', borderRadius: 'var(--r)', cursor: busy ? 'default' : 'pointer',
              borderColor: on ? 'var(--ok)' : 'var(--line)',
              background: on ? 'var(--ok-soft)' : 'var(--surface)',
              textAlign: 'left',
            }}>
      {/* 状态用 图标 + 文字 + 颜色 三通道 */}
      <span style={{ fontSize: 20 }}>{on ? '✓' : '○'}</span>
      <span className="grow stack" style={{ gap: 0 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {hint && <span className="tiny">{hint}</span>}
      </span>
      <span className="badge" style={{
        background: on ? 'var(--ok)' : '#efedea', color: on ? '#fff' : 'var(--ink-2)',
      }}>{on ? '开' : '关'}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────── 营业时间

function HoursPane({ data, busy, run }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
}) {
  const [hours, setHours] = useState<Record<string, { open: string; close: string } | null>>(
    () => {
      const h: Record<string, { open: string; close: string } | null> = {};
      for (const [k] of DAYS) h[k] = data.location.businessHours[k] ?? null;
      return h;
    });

  const set = (d: string, patch: Partial<{ open: string; close: string }> | null) =>
    setHours((h) => ({ ...h, [d]: patch === null ? null : { ...(h[d] ?? { open: '09:30', close: '19:30' }), ...patch } }));

  /** 多数店七天时间一样，一键铺开省掉六次输入 */
  const copyToAll = () => {
    const first = DAYS.map(([k]) => hours[k]).find((v) => v);
    if (!first) return;
    const next: typeof hours = {};
    for (const [k] of DAYS) next[k] = { ...first };
    setHours(next);
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card stack" style={{ padding: 16, gap: 10 }}>
        {DAYS.map(([k, label]) => {
          const v = hours[k];
          return (
            <div key={k} className="row" style={{ gap: 10 }}>
              <span style={{ width: 46, fontWeight: 600 }}>{label}</span>
              <button className="btn" style={{
                minHeight: 48, minWidth: 74, borderWidth: 2,
                borderColor: v ? 'var(--ok)' : 'var(--line)',
                background: v ? 'var(--ok-soft)' : 'var(--surface)',
              }} onClick={() => set(k, v ? null : {})}>
                {v ? '营业' : '休息'}
              </button>
              {v && (
                <>
                  {/* 中文 locale 的时间控件要显示「上午 09:30」加时钟图标，
                      窄了会把数字挤没 —— 看起来像没填，其实值是在的 */}
                  <input className="field field-mono" type="time" value={v.open}
                         style={{ width: 156, padding: '0 10px' }}
                         aria-label={`${label}开门时间`}
                         onChange={(e) => set(k, { open: e.target.value })} />
                  <span className="muted">–</span>
                  <input className="field field-mono" type="time" value={v.close}
                         style={{ width: 156, padding: '0 10px' }}
                         aria-label={`${label}关门时间`}
                         onChange={(e) => set(k, { close: e.target.value })} />
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="tiny">
        关门时间可以早于开门时间 —— 足疗店开到凌晨 1:00 就填 01:00，
        跨不跨天由「营业日切换点」决定，不用管这里。
      </div>

      <div className="row" style={{ gap: 10 }}>
        <button className="btn grow" onClick={copyToAll} disabled={busy}>七天都一样</button>
        <button className="btn btn-primary grow" disabled={busy}
                onClick={() => void run('location.saveHours', { hours })}>
          {busy ? <span className="spin" /> : '保存营业时间'}
        </button>
      </div>
    </div>
  );
}
