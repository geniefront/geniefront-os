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
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Alert } from '../ui/Alert';
import { Spinner } from '../ui/Spinner';

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
    taxable: boolean; onlineBookable: boolean; isAddon: boolean; active: boolean;
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
  /** 官网对接（docs/13）。老板把 publicKey 和域名交给做官网的人 */
  web: {
    /** ⚠️ 不是密钥 —— 它本来就要出现在官网的 JS 里 */
    publicKey: string;
    slug: string;
    allowedOrigins: Array<{ id: string; origin: string; label: string | null }>;
    onlineBooking: {
      enabled: boolean;
      maxDaysAhead: number;
      minMinutesAhead: number;
      requirePhoneVerification: boolean;
      cancelCutoffHours: number;
    };
    /** 一个都没勾就打不开在线预约 */
    onlineBookableCount: number;
  };
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
  initialPane?: 'service' | 'staff' | 'hours' | 'device' | 'phone' | 'web' | null;
  /** 打开「拍价目表」。项目一个个敲太慢，这是 Phase 2 的主入口（05 §4） */
  onPhotoSetup: () => void;
  /** 打开「Yelp 一键填店」。店名 + 邮编两个字段把店建起来（05 §4.1） */
  onYelpFill: () => void;
}) {
  const [pane, setPane] = useState<
    'service' | 'staff' | 'hours' | 'device' | 'phone' | 'web'>(initialPane ?? 'service');
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
    <div className="flex flex-col gap-3.5 px-4 pb-6">
      <div className="flex items-center gap-2.5">
        {([['service', '项目'], ['staff', '员工'], ['hours', '营业时间'],
           ['device', '门口 iPad'], ['phone', '☎️ AI 接电话'],
           ['web', '🌐 官网对接']] as const).map(([k, l]) => (
          <Button key={k} onClick={() => setPane(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: pane === k ? 'var(--brand)' : 'var(--line)',
                    background: pane === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>{l}</Button>
        ))}
      </div>

      {err && <Alert tone="danger">{err}</Alert>}

      {pane === 'service' && (
        <ServicePane data={data} busy={busy} run={run} onPhotoSetup={onPhotoSetup} />
      )}
      {pane === 'staff' && <StaffPane data={data} busy={busy} run={run} membershipId={membershipId} />}
      {pane === 'hours' && <HoursPane data={data} busy={busy} run={run} onYelpFill={onYelpFill} />}
      {pane === 'device' && <DevicePane membershipId={membershipId} />}
      {pane === 'phone' && <PhonePane data={data} busy={busy} run={run} />}
      {pane === 'web' && <WebPane data={data} busy={busy} run={run} />}
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
  const [isAddon, setIsAddon] = useState(false);
  /**
   * ⚠️ 这一项在这个界面上没有开关，但**必须原样带回去**。
   *
   * `catalog.saveService` 的 Zod 给它们的默认值是 false：不传就等于关掉。
   * 老板只是来改个价格，回头却发现这个项目从官网上消失了 ——
   * 而他什么都没动过。
   */
  const [flags, setFlags] = useState({ taxable: false, onlineBookable: false, active: true });

  function startEdit(s?: SettingsData['services'][number]) {
    setEditing(s?.id ?? 'new');
    setName(s?.displayName ?? '');
    setDur(String(s?.durationMin ?? 45));
    setPrice(s ? money(s.basePriceCents) : '');
    setIsAddon(s?.isAddon ?? false);
    setFlags({
      taxable: s?.taxable ?? false,
      onlineBookable: s?.onlineBookable ?? false,
      active: s?.active ?? true,
    });
  }

  async function save() {
    await run('catalog.saveService', {
      ...(editing !== 'new' ? { serviceId: editing } : {}),
      // 老板打什么就存什么语言；AI 开店向导以后会补齐其他语言（05 §4.4）
      name: { 'zh-Hans': name, en: name },
      durationMin: Number(dur) || 45,
      basePriceCents: dollarsToCents(price),
      isAddon,
      ...flags,
    });
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 一个个敲 38 个项目，老板会在第 5 个的时候放弃。拍照那条路放在最上面。 */}
      <Button block onClick={onPhotoSetup} disabled={busy} style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)', borderWidth: 2, borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
        📷 拍价目表，自动建项目
      </Button>
      {data.services.length === 0 && (
        <div className="text-xs text-ink-3">
          还一个项目都没有。拍一张墙上的价目表，比一个个敲快得多 ——
          建之前你可以逐项核对。
        </div>
      )}

      {data.services.map((s) => (
        <Card key={s.id} className="flex items-center gap-3" style={{ padding: '14px 16px',  opacity: s.active ? 1 : .5 }}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5" style={{ minWidth: 0 }}>
            <div className="flex items-center gap-2">
              <strong className="truncate text-lg">
                {s.displayName}
              </strong>
              {s.isAddon && <Badge >加项</Badge>}
              {!s.active && <Badge tone="mute" >已下架</Badge>}
            </div>
            <span className="text-xs text-ink-3">
              {s.durationMin} 分钟 · {s.isAddon ? '加' : ''}${money(s.basePriceCents)}
            </span>
          </div>
          <Button style={{ minHeight: 44 }} disabled={busy} onClick={() => startEdit(s)}>改</Button>
          {s.active && (
            <Button style={{ minHeight: 44 }} disabled={busy} onClick={() => void run('catalog.archiveService', { serviceId: s.id })}>
              下架
            </Button>
          )}
        </Card>
      ))}

      <Button variant="primary" block onClick={() => startEdit()} disabled={busy}>
        ＋ 加一个项目
      </Button>
      <div className="text-xs text-ink-3">下架不会影响已经开过的单 —— 项目名和价格在开单时就存下来了</div>

      {editing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
          display: 'grid', placeItems: 'end center', zIndex: 50,
        }} onClick={() => setEditing(null)}>
          <Card className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}
               style={{ width: 'min(560px,100%)', padding: 24, gap: 16,
                        borderRadius: '18px 18px 0 0' }}>
            <div className="text-xl font-extrabold">
              {editing === 'new' ? '加一个项目' : '改项目'}
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-3">项目名</span>
              <Field  value={name} autoFocus
                     placeholder="例：甲油胶美甲"
                     onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="flex items-center gap-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-ink-3">要多久（分钟）</span>
                <Field mono  inputMode="numeric" value={dur}
                       onChange={(e) => setDur(e.target.value)} />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs text-ink-3">多少钱（美元）</span>
                <Field mono  inputMode="decimal" value={price}
                       placeholder="45" onChange={(e) => setPrice(e.target.value)} />
              </label>
            </div>

            {/*
              * 加项这个勾直接影响电话 AI 怎么报价：勾上之后它会说
              * 「加十五块」，不勾会说「十五块一次」。所以说明写在旁边，
              * 而不是指望老板知道「加项」这个词在系统里意味着什么。
              */}
            <label className="flex items-center gap-2.5 items-start">
              <input type="checkbox" checked={isAddon} style={{ width: 22, height: 22 }}
                     onChange={(e) => setIsAddon(e.target.checked)} />
              <span className="flex flex-col gap-0.5">
                <span>这是加项（只能加在别的项目上）</span>
                <span className="text-xs text-ink-3">
                  像「热石 +$15」「French +$10」。勾上以后，电话里的 AI 会说
                  「加十五块」，不会当成一个单独的项目卖给客人。
                </span>
              </span>
            </label>

            {/* 常用时长一键选，省得敲键盘 */}
            <div className="flex items-center gap-2 flex-wrap">
              {[15, 30, 45, 60, 90].map((m) => (
                <Button key={m} style={{ minHeight: 48 }} onClick={() => setDur(String(m))}>{m} 分钟</Button>
              ))}
            </div>

            <div className="flex items-center gap-2.5">
              <Button className="min-w-0 flex-1" onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" className="min-w-0 flex-1" disabled={busy || !name.trim() || !price.trim()} onClick={() => void save()}>
                {busy ? <Spinner /> : '保存'}
              </Button>
            </div>
          </Card>
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
    <div className="flex flex-col gap-3">
      {/*
        ⭐ 「加员工」放在最上面。
        开一家新店的第一件事就是这个 —— 而在此之前系统里根本没有这条路
        （docs/12 §6.3）。加进来的是一条**没有账号的身份**：
        他立刻就能被派单、能开单、能算提成，本人上机是后来的事。
      */}
      {!adding && (
        <Button variant="primary" style={{ minHeight: 'var(--tap)' }} onClick={() => setAdding(true)}>
          ＋ 加一个员工
        </Button>
      )}
      {adding && (
        <AddStaffForm busy={busy} onCancel={() => setAdding(false)}
                      onSave={async (input) => { await run('staff.add', input); setAdding(false); }} />
      )}

      {data.staff.map((s) => (
        <Card key={s.membershipId} className="flex flex-col p-4 gap-3">
          <div className="flex items-center gap-2.5">
            <strong className="min-w-0 flex-1 text-lg">{s.name}</strong>
            {s.levelKey && (
              <Badge tone="brand" >
                {data.levels.find((l) => l.key === s.levelKey)?.name ?? s.levelKey}
              </Badge>
            )}
          </div>

          {/* 两个开关是一人多角色的全部（决策 20） */}
          <div className="flex flex-col gap-2">
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
            <div className="flex items-center gap-2 items-center">
              <span className="text-xs text-ink-3 min-w-0 flex-1">同时能接几单</span>
              {[1, 2, 3].map((n) => (
                <Button key={n} disabled={busy} style={{ minHeight: 48, minWidth: 56, borderWidth: 2, borderColor: s.maxConcurrent === n ? 'var(--brand)' : 'var(--line)', background: s.maxConcurrent === n ? 'var(--brand-soft)' : 'var(--surface)', }} onClick={() => void run('staff.saveProfile',
                          { membershipId: s.membershipId, maxConcurrentAppointments: n })}>
                  {n}
                </Button>
              ))}
            </div>
          )}
          {s.isBookable && s.maxConcurrent > 1 && (
            <div className="text-xs text-ink-3">做手的时候脚在泡水，可以同时压 {s.maxConcurrent} 单</div>
          )}

          <ClaimRow staff={s} busy={busy} run={run} membershipId={membershipId} />
        </Card>
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
    <Card className="flex flex-col p-4 gap-3.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">名字（技师端和轮牌板上显示的就是它）</span>
        <Field  value={name} autoFocus
               onChange={(e) => setName(e.target.value)} placeholder="Linh" />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">手机号（可不填。填了他就能自己用短信验证码上机）</span>
        <Field  value={phone} inputMode="tel"
               onChange={(e) => setPhone(e.target.value)} placeholder="512-555-0142" />
        {!phoneOk && <span className="text-xs text-ink-3 text-danger">这个号码看起来不对</span>}
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">他是做什么的</span>
        <div className="flex items-center gap-2 flex-wrap">
          {([['tech', '技师'], ['senior_tech', '资深技师'],
             ['front_desk', '前台'], ['manager', '店长']] as const).map(([k, l]) => (
            <Button key={k} style={{ minHeight: 'var(--tap)', borderWidth: 2, borderColor: role === k ? 'var(--brand)' : 'var(--line)', background: role === k ? 'var(--brand-soft)' : 'var(--surface)', }} onClick={() => { setRole(k); if (k === 'front_desk') setBookable(false); }}>{l}</Button>
          ))}
        </div>
        {/* ⚠️ 这里没有「老板」这一项，而且后端也不接受 —— 谁是老板只由付款那条链路决定 */}
      </div>

      <Toggle label="接客（出现在日程表和轮牌板里）" on={bookable} busy={busy}
              onChange={setBookable} />

      <div className="flex items-center gap-2.5">
        <Button variant="primary" className="min-w-0 flex-1" style={{ minHeight: 'var(--tap)' }} disabled={busy || name.trim() === '' || !phoneOk} onClick={() => void onSave({
                  displayName: name.trim(),
                  ...(e164() ? { phoneE164: e164() } : {}),
                  roleKeys: [role],
                  isBookable: bookable,
                  inRotation: bookable,
                })}>
          {busy ? <Spinner /> : '加进来'}
        </Button>
        <Button style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>取消</Button>
      </div>
    </Card>
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
    <div className="flex flex-col gap-2" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="flex items-center gap-2.5 flex-wrap">
        {/* 颜色 + 图标 + 文字三通道（很多老板分不清红绿） */}
        <Badge tone={online ? 'ok' : 'mute'}>
          {online ? '● 手机上能看到派单' : '○ 还没在自己手机上登录'}
        </Badge>
        {staff.phoneE164 && <span className="text-xs text-ink-3">{staff.phoneE164}</span>}
        <span className="min-w-0 flex-1" />
        <Button disabled={busy || working} style={{ minHeight: 44 }} onClick={() => void issue()}>
          {working ? <Spinner /> : '给他上机码'}
        </Button>
        {staff.liveSessions > 0 && (
          <Button disabled={busy} style={{ minHeight: 44 }} onClick={() => { setCode(null); void run('staff.revokeSessions', { membershipId: staff.membershipId }); }}>
            踢下线
          </Button>
        )}
        <Button variant="ghost" disabled={busy} style={{ minHeight: 44 }} onClick={() => {
                  if (confirm(`把 ${staff.name} 设为离职？他做过的单和提成都不会动。`)) {
                    void run('staff.setEmployment',
                      { membershipId: staff.membershipId, status: 'left' });
                  }
                }}>
          离职
        </Button>
      </div>

      {code && (
        <Card className="flex flex-col p-3.5 gap-1.5 bg-brand-soft">
          <div className="text-xs text-ink-3">念给他，让他在自己手机上打开技师端输进去</div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, letterSpacing: 6 }}>
            {code.code}
          </div>
          {/* 明文只出现这一次 —— 关掉就再也看不到了，要的话重新点一次 */}
          <div className="text-xs text-ink-3">15 分钟内有效，只能用一次</div>
        </Card>
      )}
    </div>
  );
}

function Toggle({ label, on, busy, hint, onChange }: {
  label: string; on: boolean; busy: boolean; hint?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className="flex items-center gap-3" disabled={busy} onClick={() => onChange(!on)}
            style={{
              minHeight: 'var(--tap)', padding: '0 14px', gap: 12, width: '100%',
              border: '2px solid', borderRadius: 'var(--r)', cursor: busy ? 'default' : 'pointer',
              borderColor: on ? 'var(--ok)' : 'var(--line)',
              background: on ? 'var(--ok-soft)' : 'var(--surface)',
              textAlign: 'left',
            }}>
      {/* 状态用 图标 + 文字 + 颜色 三通道 */}
      <span style={{ fontSize: 20 }}>{on ? '✓' : '○'}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0">
        <span className="font-semibold">{label}</span>
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </span>
      <Badge style={{
        background: on ? 'var(--ok)' : '#efedea', color: on ? '#fff' : 'var(--ink-2)',
      }}>{on ? '开' : '关'}</Badge>
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
    <div className="flex flex-col gap-3">
      {/* 七天一格格敲太慢。店名 + 邮编两个字段就能把地址电话营业时间一起填了 */}
      <Button block onClick={onYelpFill} disabled={busy} style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)', borderWidth: 2, borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
        🔎 输店名和邮编，自动填地址 · 电话 · 营业时间
      </Button>

      <Card className="flex flex-col p-4 gap-2.5">
        {DAYS.map(([k, label]) => {
          const v = hours[k];
          return (
            <div key={k} className="flex items-center gap-2.5">
              <span style={{ width: 46, fontWeight: 600 }}>{label}</span>
              <Button style={{ minHeight: 48, minWidth: 74, borderWidth: 2, borderColor: v ? 'var(--ok)' : 'var(--line)', background: v ? 'var(--ok-soft)' : 'var(--surface)', }} onClick={() => set(k, v ? null : {})}>
                {v ? '营业' : '休息'}
              </Button>
              {v && (
                <>
                  {/* 中文 locale 的时间控件要显示「上午 09:30」加时钟图标，
                      窄了会把数字挤没 —— 看起来像没填，其实值是在的 */}
                  <Field mono  type="time" value={v.open}
                         style={{ width: 156, padding: '0 10px' }}
                         aria-label={`${label}开门时间`}
                         onChange={(e) => set(k, { open: e.target.value })} />
                  <span className="text-ink-2">–</span>
                  <Field mono  type="time" value={v.close}
                         style={{ width: 156, padding: '0 10px' }}
                         aria-label={`${label}关门时间`}
                         onChange={(e) => set(k, { close: e.target.value })} />
                </>
              )}
            </div>
          );
        })}
      </Card>

      <div className="text-xs text-ink-3">
        关门时间可以早于开门时间 —— 足疗店开到凌晨 1:00 就填 01:00，
        跨不跨天由「营业日切换点」决定，不用管这里。
      </div>

      <div className="flex items-center gap-2.5">
        <Button className="min-w-0 flex-1" onClick={copyToAll} disabled={busy}>七天都一样</Button>
        <Button variant="primary" className="min-w-0 flex-1" disabled={busy} onClick={() => void run('location.saveHours', { hours })}>
          {busy ? <Spinner /> : '保存营业时间'}
        </Button>
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
    <div className="flex flex-col gap-3.5" style={{ maxWidth: 720 }}>
      <Card className="flex flex-col p-4.5 gap-2">
        <strong className="text-lg">门口自助签到 iPad（可选）</strong>
        <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
          <strong>没有 iPad 完全不影响开店</strong> —— 取号、签免责书你都能在
          「🎫 等位」那一页替客人做。这一页只是让客人自己动手，省你几步。
        </div>
      </Card>

      {err && <Alert tone="danger">{err}</Alert>}

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3">给这台设备起个名字（丢了要认得出是哪一台）</span>
        <Field  value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <Button variant="primary" block disabled={busy} style={{ minHeight: 'var(--tap)' }} onClick={() => void issue()}>
        {busy ? <Spinner /> : '生成配对码'}
      </Button>

      {issued && (
        <Card className="flex flex-col gap-3" style={{ padding: 18,  borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
          <strong>⚠️ 现在就贴到 iPad 上 —— 关掉这个框就再也看不到了</strong>
          <div className="text-xs text-ink-3">
            在那台 iPad 上打开门口签到页，把下面这一串粘进去。
          </div>
          <div className="tnum min-h-tap rounded border border-line-2 bg-sunken px-4 font-mono"
               style={{ wordBreak: 'break-all', height: 'auto', padding: 14,
                        lineHeight: 1.6, userSelect: 'all' }}>
            {issued}
          </div>
          <div className="flex items-center gap-2.5">
            <Button className="min-w-0 flex-1" onClick={() => void navigator.clipboard.writeText(issued)}>
              复制
            </Button>
            <Button className="min-w-0 flex-1" onClick={() => setIssued(null)}>我贴好了</Button>
          </div>
        </Card>
      )}

      <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
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
    <div className="flex flex-col gap-3.5">
      <Card className="p-3.5">
        <div className="font-semibold mb-1.5">AI 帮你接电话</div>
        <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
          <strong>你的号码不用换。</strong>你在自己的电话公司那里设个转接，
          转到我们给你的号码上。AI 接起来问清楚要做什么项目、什么时候来，
          放到「待复核」等你确认。
        </div>
      </Card>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-3"><strong>① 什么时候让 AI 接</strong></span>
        {([
          ['busy_no_answer', '只在没人接或占线时', '推荐 —— 你有空照样自己接，AI 只接你接不了的'],
          ['all', '所有来电都让 AI 接', '店里没人守电话时用。AI 会接每一通'],
        ] as const).map(([k, label, hint]) => (
          <Button key={k} onClick={() => setMode(k)}
                  style={{
                    textAlign: 'left', borderWidth: 2, padding: '10px 12px',
                    borderColor: mode === k ? 'var(--brand)' : 'var(--line)',
                    background: mode === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            <div className="font-semibold">{mode === k ? '● ' : '○ '}{label}</div>
            <div className="text-xs text-ink-3 font-normal mt-0.5">{hint}</div>
          </Button>
        ))}
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-3"><strong>② 对外公布的电话</strong>（名片、Google、Yelp 上的那个）</span>
        <Field mono value={store} inputMode="tel"
               placeholder="+1 512 555 0100"
               onChange={(e) => setStore(e.target.value)} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-3">
          <strong>③ 转人工的电话</strong>（AI 答不上来时打给谁）
        </span>
        <Field mono value={human} inputMode="tel"
               placeholder="+1 512 555 0200"
               onChange={(e) => setHuman(e.target.value)} />
      </label>

      {deadLoop && (
        <Alert tone="danger" title="选了「所有来电都让 AI 接」时，这两个号不能一样">
          AI 要转人工 → 打回这个号 → 这个号又把电话无条件转给 AI → 再转人工……
          <strong>客人永远等不到人。</strong>
          换成店里另一部电话或你的手机，或者上面改成「只在没人接时」。
        </Alert>
      )}

      {same && !deadLoop && (
        <Alert tone="info" title="两个号一样 —— 店里只有一部电话的话这样是对的">
          AI 转人工时会打回这部电话。要是那会儿还是没人接，客人会再听一遍 AI。
          想避免的话，这里填你的手机。
        </Alert>
      )}

      <Button variant="primary" disabled={busy || deadLoop || !store || !human} onClick={() => run('location.requestAiVoice', {
                storefrontE164: store.trim(),
                transferTargetE164: human.trim(),
                forwardingMode: mode,
              })}>
        {submitted ? '保存修改' : '提交，申请开通'}
      </Button>

      {submitted && !live && (
        <Card className="p-3.5">
          <div className="font-semibold">⏳ 我们正在给你开通</div>
          <div className="text-xs text-ink-3" style={{ marginTop: 6, lineHeight: 1.7 }}>
            一个工作日之内会办好。办好之后这里会出现<strong>你的专属号码</strong>
            和设置转接的说明。这期间店里一切照常，什么都不用改。
          </div>
        </Card>
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
    <Card className="p-3.5">
      <div className="font-semibold">✅ 已开通 —— 最后一步要你来做</div>

      <div className="flex flex-col gap-1" style={{ margin: '10px 0' }}>
        <span className="text-xs text-ink-3">你的专属号码（把电话转接到这里）：</span>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>{landing}</div>
      </div>

      <div className="text-xs text-ink-3" style={{ lineHeight: 1.8 }}>
        打电话给<strong>你的电话公司</strong>（Verizon / AT&amp;T / Spectrum / Comcast…），
        或者登录他们的网站/App，设置这一项：
        <div style={{
          margin: '8px 0', padding: 10, borderRadius: 8,
          background: 'var(--brand-soft)', fontWeight: 600,
        }}>
          {all
            ? <>「把所有来电都转到 {landing}」</>
            : <>「响 4 声没人接（或占线），就把电话转到 {landing}」</>}
          <div className="text-xs text-ink-3 font-normal mt-1">
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
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────── 官网对接

/**
 * 把这家店接到它自己的官网上（docs/13）。
 *
 * 这一页的读者其实有两个：**老板**（他要打开开关、填自己网站的域名）
 * 和**做官网的那个人**（他要那串 key 和一份文档）。所以它做成
 * 「一句话说清楚 + 一键复制 + 一个开关」，而不是一堆技术参数。
 *
 * ⚠️ 那串 `pk_…` **不是密钥**。它会明文出现在官网的 HTML 里，谁都看得到。
 * 界面上必须这么写 —— 不然老板会把它当密码，出于谨慎不敢交给做官网的人，
 * 然后这件事就卡住了。
 */
function WebPane({ data, busy, run }: {
  data: SettingsData; busy: boolean;
  run: (n: string, i: unknown) => Promise<void>;
}) {
  const w = data.web;
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);

  const canEnable = w.onlineBookableCount > 0;

  async function toggle(enabled: boolean) {
    await run('location.saveOnlineBooking', { ...toInput(w.onlineBooking), enabled });
  }

  return (
    <div className="flex flex-col gap-3.5" style={{ maxWidth: 720 }}>
      <Card className="flex flex-col p-4.5 gap-2">
        <strong className="text-lg">官网在线预约（可选）</strong>
        <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
          让客人在<strong>你自己的官网</strong>上直接约。订单会实时出现在前台看板上，
          标着「网站」来源。<strong>没有官网完全不影响开店</strong>。
        </div>
      </Card>

      {/* ── 开关 ─────────────────────────────────────────────────────── */}
      <Card className="flex flex-col p-4.5 gap-3">
        <div className="flex items-center gap-3 justify-between items-center">
          <div className="flex flex-col gap-1">
            <strong>在线预约</strong>
            <span className="text-xs text-ink-3">
              {w.onlineBooking.enabled ? '开着 —— 官网上能订' : '关着 —— 官网上只显示电话'}
            </span>
          </div>
          <Button variant={w.onlineBooking.enabled ? 'primary' : 'default'}
                  disabled={busy || (!w.onlineBooking.enabled && !canEnable)}
                  style={{ minHeight: 'var(--tap)', minWidth: 120 }}
                  onClick={() => void toggle(!w.onlineBooking.enabled)}>
            {w.onlineBooking.enabled ? '关掉' : '打开'}
          </Button>
        </div>

        {!canEnable && (
          <Alert tone="warn">还没有任何项目允许在线预约。先去「项目」那一页，
            把想让客人自己约的项目勾上「可在线预约」。</Alert>
        )}
      </Card>

      {/* ── 给做官网的人的两样东西 ───────────────────────────────────── */}
      <Card className="flex flex-col p-4.5 gap-3">
        <strong>把这两样交给做官网的人</strong>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-3">
            ① 本店标识（<strong>不是密码</strong> —— 它本来就要写在官网的网页里，
            给谁看都没关系）
          </span>
          <div className="tnum min-h-tap rounded border border-line-2 bg-sunken px-4 font-mono"
               style={{ wordBreak: 'break-all', height: 'auto', padding: 14, userSelect: 'all' }}>
            {w.publicKey}
          </div>
        </label>

        <Button block style={{ minHeight: 'var(--tap)' }} onClick={() => {
                  void navigator.clipboard.writeText(w.publicKey);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}>
          {copied ? '✓ 已复制' : '复制这串标识'}
        </Button>

        <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
          ② 对接文档：仓库里的 <code className="tnum font-mono">docs/13-PUBLIC-BOOKING-API.md</code>。
          整份发给他，他读完就能开工。
        </div>
      </Card>

      {/* ── 域名白名单 ───────────────────────────────────────────────── */}
      <Card className="flex flex-col p-4.5 gap-3">
        <strong>允许哪些网站调用</strong>
        <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
          填你自己官网的网址。<strong>不填的话官网那边会全部报错</strong> ——
          这是有意的：不填就等于任何网站都能拿你的标识建单。
          做官网的人如果有预览地址（<code className="tnum font-mono">xxx.pages.dev</code>），
          也要一起填。
        </div>

        {w.allowedOrigins.length === 0 && (
          <Alert tone="warn">一条都还没填 —— 现在官网上还订不了</Alert>
        )}

        <div className="flex flex-col gap-2">
          {w.allowedOrigins.map((o) => (
            <div key={o.id} className="flex items-center justify-between items-center gap-2.5">
              <span className="tnum font-mono" style={{ wordBreak: 'break-all' }}>{o.origin}</span>
              <Button disabled={busy} onClick={() => void run('location.removeWebOrigin', { id: o.id })}>
                去掉
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2.5">
          <Field className="min-w-0 flex-1"  placeholder="lotusnails.com"
                 value={origin} onChange={(e) => setOrigin(e.target.value)} />
          <Button variant="primary" disabled={busy || !origin.trim()} style={{ minHeight: 'var(--tap)' }} onClick={async () => {
                    await run('location.addWebOrigin', { origin: origin.trim() });
                    setOrigin('');
                  }}>
            加上
          </Button>
        </div>
      </Card>

      {/* ── 护栏 ─────────────────────────────────────────────────────── */}
      <Card className="flex flex-col p-4.5 gap-3">
        <strong>护栏</strong>
        <NumberRow label="最远能订多少天以后" suffix="天"
                   value={w.onlineBooking.maxDaysAhead} busy={busy}
                   hint="排班还没排到那么远的话，客人订了你也安排不了人"
                   onSave={(v) => run('location.saveOnlineBooking',
                     { ...toInput(w.onlineBooking), maxDaysAhead: v })} />
        <NumberRow label="多久之内的不让网上订" suffix="分钟"
                   value={w.onlineBooking.minMinutesAhead} busy={busy}
                   hint="太急的单让客人打电话 —— 电话里你能当场说「现在过来要等一会儿」"
                   onSave={(v) => run('location.saveOnlineBooking',
                     { ...toInput(w.onlineBooking), minMinutesAhead: v })} />
        <NumberRow label="开始前几小时不能自己取消" suffix="小时"
                   value={w.onlineBooking.cancelCutoffHours} busy={busy}
                   hint="过了这个点客人只能打电话 —— 那时候你还有机会挽留"
                   onSave={(v) => run('location.saveOnlineBooking',
                     { ...toInput(w.onlineBooking), cancelCutoffHours: v })} />
      </Card>
    </div>
  );
}

/** 命令要的是一整份配置，界面上只改其中一项 —— 这里把当前值补齐 */
function toInput(ob: SettingsData['web']['onlineBooking']) {
  return {
    enabled: ob.enabled,
    maxDaysAhead: ob.maxDaysAhead,
    minMinutesAhead: ob.minMinutesAhead,
    requirePhoneVerification: ob.requirePhoneVerification,
    cancelCutoffHours: ob.cancelCutoffHours,
  };
}

function NumberRow({ label, hint, suffix, value, busy, onSave }: {
  label: string; hint: string; suffix: string; value: number; busy: boolean;
  onSave: (v: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const dirty = draft.trim() !== String(value);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-3"><strong>{label}</strong></span>
      <div className="flex items-center gap-2.5 items-center">
        <Field  style={{ width: 110 }} inputMode="numeric"
               value={draft} onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))} />
        <span className="text-xs text-ink-3">{suffix}</span>
        {dirty && (
          <Button variant="primary" disabled={busy} onClick={() => void onSave(Number(draft || '0'))}>存</Button>
        )}
      </div>
      <span className="text-xs text-ink-3" style={{ opacity: 0.8 }}>{hint}</span>
    </div>
  );
}
