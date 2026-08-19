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
    businessDayCutoff: string;
    /** setup = 开店向导还没走完（sql/0030） */
    status: string;
    /** 开店向导的进度全部从真实数据推出来，没有「走到第几步」那种计数器 */
    hasAddress: boolean;
    profileConfirmedAt: string | null;
  };
  services: Array<{
    id: string; name: Record<string, string>; displayName: string;
    durationMin: number; basePriceCents: number;
    taxable: boolean; onlineBookable: boolean; active: boolean;
  }>;
  staff: Array<{
    membershipId: string; name: string; isBookable: boolean;
    maxConcurrent: number; levelKey: string | null; inRotation: boolean;
    roleKeys: string[];
    phoneE164: string | null;
    /** 用邮箱登录过 */
    hasAccount: boolean;
    /** 手机上还活着几个上机会话。0 且没账号 = 他还没在自己手机上看过派单 */
    liveSessions: number;
  }>;
  levels: Array<{ id: string; key: string; name: string }>;
  phone: {
    storefrontE164: string | null;
    transferTargetE164: string | null;
    /** 我们买的落地号。null = 还没开通 —— 这个状态是推导的，没有状态列 */
    aiVoiceE164: string | null;
    /** 店家说他在运营商那儿设的转接方式。我们改不了，只记录 */
    forwardingMode: 'all' | 'busy_no_answer' | null;
  };
}

const DAYS: Array<[string, string]> = [
  ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'],
  ['fri', '周五'], ['sat', '周六'], ['sun', '周日'],
];

const money = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, '');

export function Settings({
  data, membershipId, onChanged, onPhotoSetup, onYelpFill, initialPane,
}: {
  data: SettingsData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
  /** 从开店向导跳进来时，落在他刚点的那一项上（不落的话他得自己再找一次） */
  initialPane?: 'service' | 'staff' | 'hours' | 'device' | 'phone' | null;
  /** 打开「拍价目表」。项目一个个敲太慢，这是 Phase 2 的主入口（05 §4） */
  onPhotoSetup: () => void;
  /** 打开「Yelp 一键填店」。店名 + 邮编两个字段把店建起来（05 §4.1） */
  onYelpFill: () => void;
}) {
  const [pane, setPane] = useState<
    'service' | 'staff' | 'hours' | 'device' | 'phone'>(initialPane ?? 'service');
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
        {([['service', '项目'], ['staff', '员工'], ['hours', '营业时间'],
           ['device', '门口 iPad'], ['phone', '☎️ AI 接电话']] as const).map(([k, l]) => (
          <button key={k} className="btn" onClick={() => setPane(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: pane === k ? 'var(--brand)' : 'var(--line)',
                    background: pane === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>{l}</button>
        ))}
      </div>

      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {pane === 'service' && (
        <ServicePane data={data} busy={busy} run={run} onPhotoSetup={onPhotoSetup} />
      )}
      {pane === 'staff' && <StaffPane data={data} busy={busy} run={run} membershipId={membershipId} />}
      {pane === 'hours' && <HoursPane data={data} busy={busy} run={run} onYelpFill={onYelpFill} />}
      {pane === 'device' && <DevicePane membershipId={membershipId} />}
      {pane === 'phone' && <PhonePane data={data} busy={busy} run={run} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── 项目

function ServicePane({ data, busy, run, onPhotoSetup }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
  onPhotoSetup: () => void;
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
      {/* 一个个敲 38 个项目，老板会在第 5 个的时候放弃。拍照那条路放在最上面。 */}
      <button className="btn btn-block" onClick={onPhotoSetup} disabled={busy}
              style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)',
                       borderWidth: 2, borderColor: 'var(--brand)',
                       background: 'var(--brand-soft)' }}>
        📷 拍价目表，自动建项目
      </button>
      {data.services.length === 0 && (
        <div className="tiny">
          还一个项目都没有。拍一张墙上的价目表，比一个个敲快得多 ——
          建之前你可以逐项核对。
        </div>
      )}

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

function StaffPane({ data, busy, run, membershipId }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
  membershipId: string;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="stack" style={{ gap: 12 }}>
      {/*
        ⭐ 「加员工」放在最上面。
        开一家新店的第一件事就是这个 —— 而在此之前系统里根本没有这条路
        （docs/12 §6.3）。加进来的是一条**没有账号的身份**：
        他立刻就能被派单、能开单、能算提成，本人上机是后来的事。
      */}
      {!adding && (
        <button className="btn btn-primary" style={{ minHeight: 'var(--tap)' }}
                onClick={() => setAdding(true)}>
          ＋ 加一个员工
        </button>
      )}
      {adding && (
        <AddStaffForm busy={busy} onCancel={() => setAdding(false)}
                      onSave={async (input) => { await run('staff.add', input); setAdding(false); }} />
      )}

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

          <ClaimRow staff={s} busy={busy} run={run} membershipId={membershipId} />
        </div>
      ))}
    </div>
  );
}

/**
 * 加员工。
 *
 * 字段少到不能再少：名字是必填，别的都有默认值（`04` §2：能给默认值
 * 就别让他填）。手机号是**可选**的 —— 不填也能加人，只是这个人以后
 * 只能用老板给的上机码登录。
 */
function AddStaffForm({ busy, onSave, onCancel }: {
  busy: boolean;
  onSave: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'tech' | 'senior_tech' | 'front_desk' | 'manager'>('tech');
  const [bookable, setBookable] = useState(true);

  // 老板会输 512-555-0142 这种写法，也会只输十位。统一拼成 E.164 ——
  // 让四十岁的老板自己打 +1 是不现实的
  const e164 = (): string | undefined => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 0) return undefined;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+${digits}`;
  };
  const phoneOk = phone.trim() === '' || /^\+[1-9]\d{7,14}$/.test(e164() ?? '');

  return (
    <div className="card stack" style={{ padding: 16, gap: 14 }}>
      <label className="stack" style={{ gap: 6 }}>
        <span className="tiny">名字（技师端和轮牌板上显示的就是它）</span>
        <input className="field" value={name} autoFocus
               onChange={(e) => setName(e.target.value)} placeholder="Linh" />
      </label>

      <label className="stack" style={{ gap: 6 }}>
        <span className="tiny">手机号（可不填。填了他就能自己用短信验证码上机）</span>
        <input className="field" value={phone} inputMode="tel"
               onChange={(e) => setPhone(e.target.value)} placeholder="512-555-0142" />
        {!phoneOk && <span className="tiny" style={{ color: 'var(--danger)' }}>这个号码看起来不对</span>}
      </label>

      <div className="stack" style={{ gap: 6 }}>
        <span className="tiny">他是做什么的</span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {([['tech', '技师'], ['senior_tech', '资深技师'],
             ['front_desk', '前台'], ['manager', '店长']] as const).map(([k, l]) => (
            <button key={k} className="btn" style={{
              minHeight: 'var(--tap)', borderWidth: 2,
              borderColor: role === k ? 'var(--brand)' : 'var(--line)',
              background: role === k ? 'var(--brand-soft)' : 'var(--surface)',
            }} onClick={() => { setRole(k); if (k === 'front_desk') setBookable(false); }}>{l}</button>
          ))}
        </div>
        {/* ⚠️ 这里没有「老板」这一项，而且后端也不接受 —— 谁是老板只由付款那条链路决定 */}
      </div>

      <Toggle label="接客（出现在日程表和轮牌板里）" on={bookable} busy={busy}
              onChange={setBookable} />

      <div className="row" style={{ gap: 10 }}>
        <button className="btn btn-primary grow" style={{ minHeight: 'var(--tap)' }}
                disabled={busy || name.trim() === '' || !phoneOk}
                onClick={() => void onSave({
                  displayName: name.trim(),
                  ...(e164() ? { phoneE164: e164() } : {}),
                  roleKeys: [role],
                  isBookable: bookable,
                  inRotation: bookable,
                })}>
          {busy ? <span className="spin" /> : '加进来'}
        </button>
        <button className="btn" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/**
 * 「他能不能在自己手机上看到派单」这一行。
 *
 * ⭐ 状态是**推导**出来的，没有「已上机」这样一个字段：
 * 有账号 = 用邮箱登录过；有活着的会话 = 手机上机过。
 * 存一个布尔的话，踢下线之后它就开始说谎。
 */
function ClaimRow({ staff, busy, run, membershipId }: {
  staff: SettingsData['staff'][number];
  busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
  membershipId: string;
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [working, setWorking] = useState(false);
  const online = staff.hasAccount || staff.liveSessions > 0;

  async function issue() {
    setWorking(true);
    try {
      const out = await runCommand<{ code: string; expiresAt: string }>(
        'staff.issueClaimCode', { membershipId: staff.membershipId }, membershipId);
      setCode(out.result);
    } catch { /* 错误由外层的 run 统一显示；这里失败只是没拿到码 */ }
    finally { setWorking(false); }
  }

  return (
    <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {/* 颜色 + 图标 + 文字三通道（很多老板分不清红绿） */}
        <span className={`badge ${online ? 'badge-ok' : 'badge-mute'}`}
              style={{ padding: '6px 10px' }}>
          {online ? '● 手机上能看到派单' : '○ 还没在自己手机上登录'}
        </span>
        {staff.phoneE164 && <span className="tiny">{staff.phoneE164}</span>}
        <span className="grow" />
        <button className="btn" disabled={busy || working} style={{ minHeight: 44 }}
                onClick={() => void issue()}>
          {working ? <span className="spin" /> : '给他上机码'}
        </button>
        {staff.liveSessions > 0 && (
          <button className="btn" disabled={busy} style={{ minHeight: 44 }}
                  onClick={() => { setCode(null); void run('staff.revokeSessions', { membershipId: staff.membershipId }); }}>
            踢下线
          </button>
        )}
        <button className="btn btn-ghost" disabled={busy} style={{ minHeight: 44 }}
                onClick={() => {
                  if (confirm(`把 ${staff.name} 设为离职？他做过的单和提成都不会动。`)) {
                    void run('staff.setEmployment',
                      { membershipId: staff.membershipId, status: 'left' });
                  }
                }}>
          离职
        </button>
      </div>

      {code && (
        <div className="card stack" style={{ padding: 14, gap: 6, background: 'var(--brand-soft)' }}>
          <div className="tiny">念给他，让他在自己手机上打开技师端输进去</div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: 6 }}>
            {code.code}
          </div>
          {/* 明文只出现这一次 —— 关掉就再也看不到了，要的话重新点一次 */}
          <div className="tiny">15 分钟内有效，只能用一次</div>
        </div>
      )}
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

function HoursPane({ data, busy, run, onYelpFill }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
  onYelpFill: () => void;
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
      {/* 七天一格格敲太慢。店名 + 邮编两个字段就能把地址电话营业时间一起填了 */}
      <button className="btn btn-block" onClick={onYelpFill} disabled={busy}
              style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)',
                       borderWidth: 2, borderColor: 'var(--brand)',
                       background: 'var(--brand-soft)' }}>
        🔎 输店名和邮编，自动填地址 · 电话 · 营业时间
      </button>

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

// ─────────────────────────────────────────────────────────────── 门口 iPad

/**
 * 配对门口那台 iPad。
 *
 * ⚠️ **配对码明文只出现这一次**。库里只有摘要，关掉这个框就再也拿不回来 ——
 * 和密码一个道理。所以这一屏做得比别处啰嗦：明确告诉前台
 * 「现在就贴到 iPad 上，关掉就没了」。
 *
 * ⚠️ 宪法第 14 条：**没有 iPad 也完全不影响开店**。这一页是可选的，
 * 所以放在最后一个页签，而且第一句话就说清楚。
 */
function DevicePane({ membershipId }: { membershipId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [label, setLabel] = useState('门口 iPad');
  const [issued, setIssued] = useState<string | null>(null);

  async function issue() {
    setBusy(true); setErr('');
    try {
      const out = await runCommand<{ deviceId: string; token: string }>(
        'device.issueToken', { label: label.trim() || '门口 iPad' }, membershipId);
      setIssued(out.result.token);
    } catch (e) {
      setErr(e instanceof ApiError ? `生成失败（${e.code}）` : '生成失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 14, maxWidth: 720 }}>
      <div className="card stack" style={{ padding: 18, gap: 8 }}>
        <strong style={{ fontSize: 'var(--text-lg)' }}>门口自助签到 iPad（可选）</strong>
        <div className="tiny" style={{ lineHeight: 1.7 }}>
          <strong>没有 iPad 完全不影响开店</strong> —— 取号、签免责书你都能在
          「🎫 等位」那一页替客人做。这一页只是让客人自己动手，省你几步。
        </div>
      </div>

      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      <label className="stack" style={{ gap: 6 }}>
        <span className="tiny">给这台设备起个名字（丢了要认得出是哪一台）</span>
        <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <button className="btn btn-primary btn-block" disabled={busy}
              style={{ minHeight: 'var(--tap)' }} onClick={() => void issue()}>
        {busy ? <span className="spin" /> : '生成配对码'}
      </button>

      {issued && (
        <div className="card stack" style={{ padding: 18, gap: 12,
             borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
          <strong>⚠️ 现在就贴到 iPad 上 —— 关掉这个框就再也看不到了</strong>
          <div className="tiny">
            在那台 iPad 上打开门口签到页，把下面这一串粘进去。
          </div>
          <div className="field field-mono"
               style={{ wordBreak: 'break-all', height: 'auto', padding: 14,
                        lineHeight: 1.6, userSelect: 'all' }}>
            {issued}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn grow" onClick={() => void navigator.clipboard.writeText(issued)}>
              复制
            </button>
            <button className="btn grow" onClick={() => setIssued(null)}>我贴好了</button>
          </div>
        </div>
      )}

      <div className="tiny" style={{ lineHeight: 1.7 }}>
        iPad 丢了怎么办：回到这一页重新生成一个码给新设备，
        丢的那台会在下一次连接时被拒。<br />
        实际摆到门口之前，记得在 iPad 上开【引导式访问】（设置 → 辅助功能），
        不然客人一个误触就退出到桌面了。
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────── AI 接电话

/**
 * AI 接电话的配置。
 *
 * ⭐ **这一屏不做开通**。买号、建 AI、绑定、设转人工全是我们人工做的
 * （`09` §2）——自动化那一套要五步外部调用，中间挂掉会留下没人知道的
 * 孤儿号码，而这件事一家店只发生一次、几分钟就做完。
 *
 * 老板在这里只做一件事：**确认两个号码**。
 */
function PhonePane({ data, busy, run }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
}) {
  const { storefrontE164, transferTargetE164, aiVoiceE164, forwardingMode } = data.phone;
  const [store, setStore] = useState(storefrontE164 ?? '');
  const [human, setHuman] = useState(transferTargetE164 ?? '');
  const [mode, setMode] = useState<'all' | 'busy_no_answer'>(
    forwardingMode ?? 'busy_no_answer');

  const submitted = Boolean(storefrontE164 && transferTargetE164);
  const live = Boolean(aiVoiceE164);
  const same = store.trim() !== '' && store.trim() === human.trim();

  // ⭐ 两个号相同**本身没问题** —— 一家店就一部电话是常态。
  // 坏掉的只有「全转 + 两号相同」：转人工打回对外号，那个号无条件
  // 又转给 AI，人永远接不到。所以按模式判，不一刀切。
  const deadLoop = same && mode === 'all';

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>AI 帮你接电话</div>
        <div className="tiny" style={{ lineHeight: 1.7 }}>
          <strong>你的号码不用换。</strong>你在自己的电话公司那里设个转接，
          转到我们给你的号码上。AI 接起来问清楚要做什么项目、什么时候来，
          放到「待复核」等你确认。
        </div>
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <span className="tiny"><strong>① 什么时候让 AI 接</strong></span>
        {([
          ['busy_no_answer', '只在没人接或占线时', '推荐 —— 你有空照样自己接，AI 只接你接不了的'],
          ['all', '所有来电都让 AI 接', '店里没人守电话时用。AI 会接每一通'],
        ] as const).map(([k, label, hint]) => (
          <button key={k} className="btn" onClick={() => setMode(k)}
                  style={{
                    textAlign: 'left', borderWidth: 2, padding: '10px 12px',
                    borderColor: mode === k ? 'var(--brand)' : 'var(--line)',
                    background: mode === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            <div style={{ fontWeight: 600 }}>{mode === k ? '● ' : '○ '}{label}</div>
            <div className="tiny" style={{ fontWeight: 400, marginTop: 2 }}>{hint}</div>
          </button>
        ))}
      </div>

      <label className="stack" style={{ gap: 4 }}>
        <span className="tiny"><strong>② 对外公布的电话</strong>（名片、Google、Yelp 上的那个）</span>
        <input className="input" value={store} inputMode="tel"
               placeholder="+1 512 555 0100"
               onChange={(e) => setStore(e.target.value)} />
      </label>

      <label className="stack" style={{ gap: 4 }}>
        <span className="tiny">
          <strong>③ 转人工的电话</strong>（AI 答不上来时打给谁）
        </span>
        <input className="input" value={human} inputMode="tel"
               placeholder="+1 512 555 0200"
               onChange={(e) => setHuman(e.target.value)} />
      </label>

      {deadLoop && (
        <div className="badge badge-danger" style={{ padding: '10px 14px', lineHeight: 1.6 }}>
          ✕ 选了「所有来电都让 AI 接」时，这两个号不能一样。
          <div className="tiny" style={{ marginTop: 4 }}>
            AI 要转人工 → 打回这个号 → 这个号又把电话无条件转给 AI → 再转人工……
            <strong>客人永远等不到人。</strong>
            换成店里另一部电话或你的手机，或者上面改成「只在没人接时」。
          </div>
        </div>
      )}

      {same && !deadLoop && (
        <div className="badge" style={{
          padding: '10px 14px', lineHeight: 1.6,
          background: 'var(--warn-soft, #fff8e1)', border: '1px solid var(--line)',
        }}>
          ⓘ 两个号一样 —— <strong>店里只有一部电话的话这样是对的</strong>。
          <div className="tiny" style={{ marginTop: 4 }}>
            AI 转人工时会打回这部电话。要是那会儿还是没人接，客人会再听一遍 AI。
            想避免的话，这里填你的手机。
          </div>
        </div>
      )}

      <button className="btn btn-primary" disabled={busy || deadLoop || !store || !human}
              onClick={() => run('location.requestAiVoice', {
                storefrontE164: store.trim(),
                transferTargetE164: human.trim(),
                forwardingMode: mode,
              })}>
        {submitted ? '保存修改' : '提交，申请开通'}
      </button>

      {submitted && !live && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 600 }}>⏳ 我们正在给你开通</div>
          <div className="tiny" style={{ marginTop: 6, lineHeight: 1.7 }}>
            一个工作日之内会办好。办好之后这里会出现<strong>你的专属号码</strong>
            和设置转接的说明。这期间店里一切照常，什么都不用改。
          </div>
        </div>
      )}

      {live && <ForwardingGuide landing={aiVoiceE164!} mode={mode} />}
    </div>
  );
}

/**
 * 转接设置说明。
 *
 * ⚠️ **不要给死的星号码。** `*72`（无条件转接）/ `*92`（无应答转接）
 * 是常见值，但**各家电话公司不一样**。给错了的后果是老板把电话转到一个
 * 不存在的地方然后彻底失联 —— 比不给说明糟得多。
 *
 * 所以这里只说清「要达成什么效果」，具体按键让他问电话公司，
 * 再给一个「我们帮你设」的出口。宁可让人来问。
 */
function ForwardingGuide({ landing, mode }: {
  landing: string; mode: 'all' | 'busy_no_answer';
}) {
  const all = mode === 'all';
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 600 }}>✅ 已开通 —— 最后一步要你来做</div>

      <div className="stack" style={{ gap: 4, margin: '10px 0' }}>
        <span className="tiny">你的专属号码（把电话转接到这里）：</span>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>{landing}</div>
      </div>

      <div className="tiny" style={{ lineHeight: 1.8 }}>
        打电话给<strong>你的电话公司</strong>（Verizon / AT&amp;T / Spectrum / Comcast…），
        或者登录他们的网站/App，设置这一项：
        <div style={{
          margin: '8px 0', padding: 10, borderRadius: 8,
          background: 'var(--brand-soft)', fontWeight: 600,
        }}>
          {all
            ? <>「把所有来电都转到 {landing}」</>
            : <>「响 4 声没人接（或占线），就把电话转到 {landing}」</>}
          <div className="tiny" style={{ fontWeight: 400, marginTop: 4 }}>
            英文叫 {all
              ? <em>Call Forwarding — Always</em>
              : <em>Call Forwarding — Busy / No Answer</em>}
          </div>
        </div>

        {all
          ? <>⚠️ 你选的是<strong>全部转接</strong> —— 设好之后店里的电话
              <strong>不会再响</strong>，所有来电都由 AI 接。
              想自己接电话的时候，记得先把转接关掉。<br /><br /></>
          : <>⚠️ <strong>别选成「所有来电都转接」</strong>（Call Forwarding Always）——
              那样店里的电话就不响了。要选<strong>没人接才转</strong>的那种。<br /><br /></>}
        ⚠️ 有些电话公司转接是<strong>按分钟收费的，算在你自己的账单上</strong>。
        设之前先问一句多少钱，别等下个月账单来了才发现。
        <br /><br />
        网上能查到 <code>*72</code> / <code>*92</code> 之类的按键，但
        <strong>每家公司不一样</strong>，按错了电话会转丢。
        <strong>拿不准就让我们帮你设</strong> —— 把电话公司的名字告诉我们就行。
      </div>
    </div>
  );
}
