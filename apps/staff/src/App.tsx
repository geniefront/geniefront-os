/**
 * 技师端 PWA（Phase 1c）。
 *
 * 三个页签，一屏一件事：**今日单 / 我的收入 / 打卡**。
 * 没有快捷键（宪法第 12 条：Staff 与 Kiosk 一律纯触屏）。
 *
 * ⚠️ 宪法第 14 条：这一端**永远是可选增强**。它挂了、技师不用它、
 * 手机没电了，前台一台电脑照样能把这一天跑完 —— 所以这里没有任何
 * 「前台必须等技师确认」的流程。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { ApiError, apiGet, runCommand, type LocationMembership } from './lib/api';
import { subscribeLocation, type ConnState, type DomainEvent } from './lib/realtime';
import { unlockAudio, audioReady, alertAssigned, playTick } from './lib/alert';
import { makeT, LOCALES, LOCALE_LABEL, type Locale } from './i18n';
import { NextCard, type StaffTask } from './screens/NextCard';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const LS_LOC = 'gf.staff.membership';
const LS_LOCALE = 'gf.staff.locale';

interface StaffToday {
  businessDate: string;
  membershipId: string;
  name: string;
  current: StaffTask | null;
  next: StaffTask | null;
  tasks: StaffTask[];
  doneCount: number;
  onDuty: boolean;
  workedMinutes: number;
  rotation: { position: number | null; isNextUp: boolean; onBreak: boolean };
  earnings: {
    serviceRevenueCents: number; commissionCents: number;
    tipCashCents: number; tipCardCents: number;
    payCents: number; cashTipOwedCents: number;
  };
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function Shell({ session }: { session: Session }) {
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');
  const t = makeT(locale);
  const [picked, setPicked] = useState<LocationMembership | null>(null);
  const [tab, setTab] = useState<'today' | 'money' | 'clock'>('today');
  const [conn, setConn] = useState<ConnState>('connecting');
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [soundOn, setSoundOn] = useState(false);
  const [pin, setPin] = useState('');

  const locs = useQuery({
    queryKey: ['me-locations', session.user.id],
    queryFn: () => apiGet<{ locations: LocationMembership[] }>('/v1/me/locations'),
  });

  useEffect(() => {
    const list = locs.data?.locations;
    if (!list || picked) return;
    if (list.length === 1) { setPicked(list[0]!); return; }
    const last = localStorage.getItem(LS_LOC);
    const hit = list.find((m) => m.membershipId === last);
    if (hit) setPicked(hit);
  }, [locs.data, picked]);

  const todayQ = useQuery({
    queryKey: ['staff-today', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<StaffToday>('/v1/staff/me/today', picked!.membershipId),
    // 兜底轮询：Realtime 是主通道，这条是它断了之后的安全网。
    // 60 秒不是性能考量 —— 是"就算长连接彻底坏了，技师也不会一直看着旧数据"
    refetchInterval: 60_000,
  });

  /**
   * ⚠️ 必须用 queryClient 而不是 todayQ.refetch：
   * useQuery 每次渲染都返回新对象，把它放进 useCallback 的依赖里，
   * `refresh` 就每次渲染都是新函数 —— 下面那个订阅 effect 于是
   * 每次渲染都拆掉重连，永远到不了 SUBSCRIBED，界面一直卡在「连接中」。
   * queryClient 实例是稳定的。
   */
  const client = useQueryClient();
  const membershipId = picked?.membershipId;
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['staff-today', membershipId] });
  }, [client, membershipId]);

  // 界面语言按人：登录后跟随 users.locale（共享 iPad 上换人就换语言）
  useEffect(() => {
    const l = session.user.user_metadata?.['locale'] as Locale | undefined;
    if (l && LOCALES.includes(l)) setLocale(l);
  }, [session]);

  // ── 实时长连接 ────────────────────────────────────────────────────────────
  const lastEventAt = useRef(0);
  const myName = todayQ.data?.name ?? '';
  useEffect(() => {
    if (!picked || !myName) return;
    const me = picked.membershipId;
    const handle = subscribeLocation({
      locationId: picked.locationId,
      membershipId: me,
      name: myName,
      accessToken: session.access_token,
      onState: setConn,
      onEvent: (e: DomainEvent) => {
        // 事件只带 id 和类型：这里只决定"要不要重新拉"和"要不要响铃"，
        // 显示的数据永远来自那条有 RLS 的读接口
        const mine = !e.membershipId || e.membershipId === me;
        if (!mine && e.type === 'ticket.assigned') return;

        if (e.type === 'ticket.assigned') {
          // 防连击：一张单派给两个人会来两条，别响两次
          if (Date.now() - lastEventAt.current > 1500) {
            alertAssigned();
            setFlash(true);
            setTimeout(() => setFlash(false), 3000);
          }
          lastEventAt.current = Date.now();
        }
        refresh();
      },
    });
    return handle.close;
  }, [picked?.locationId, picked?.membershipId, myName, session.access_token, refresh]);

  /**
   * ⭐ 锁屏唤醒后的静默增量对齐（`00` §2、`01` §6）。
   *
   * 手机锁屏时 WebSocket 会被系统挂起，期间的事件收不到。
   * 技师点亮屏幕那一瞬间必须看到最新的单 —— 否则他会拿着一张
   * 已经被前台改派的单去找客人，而这种错只会在店里当面爆发。
   */
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [refresh]);

  async function run(name: string, input: unknown, sound = true) {
    if (!picked) return;
    setBusy(true); setErr('');
    try {
      await runCommand(name, input, picked.membershipId);
      if (sound) playTick();
      await todayQ.refetch();
    } catch (e) {
      setErr(e instanceof ApiError
        ? e.code === 'PERMISSION_DENIED' ? String(e.details['reason'] ?? '没有权限')
        : e.code === 'DAY_ALREADY_CLOSED' ? '今天已经结账封账了，找前台'
        : e.code === 'VALIDATION_FAILED' ? String(e.details['reason'] ?? '这一步现在做不了')
        : `${t('common.error')}（${e.code}）`
        : t('common.error'));
    } finally { setBusy(false); }
  }

  function enableSound() {
    unlockAudio();
    setSoundOn(audioReady());
    playTick();
  }

  if (locs.isPending) return <div className="center-page muted">{t('common.loading')}</div>;
  if (locs.isError || !locs.data) {
    return (
      <div className="center-page">
        <div className="card stack" style={{ padding: 24, gap: 12 }}>
          <div>{t('common.error')}</div>
          <button className="btn" onClick={() => locs.refetch()}>{t('common.retry')}</button>
          <button className="btn btn-ghost" onClick={() => void supabase.auth.signOut()}>
            {t('auth.signOut')}
          </button>
        </div>
      </div>
    );
  }

  const list = locs.data.locations;
  if (!picked) {
    return (
      <div className="center-page">
        <div className="card stack" style={{ padding: 24, gap: 12, minWidth: 280 }}>
          <strong style={{ fontSize: 'var(--text-lg)' }}>{t('loc.pick')}</strong>
          {list.map((m) => (
            <button key={m.membershipId} className="btn btn-block"
                    style={{ minHeight: 'var(--tap-lg)' }}
                    onClick={() => {
                      localStorage.setItem(LS_LOC, m.membershipId);
                      setPicked(m);
                    }}>
              {m.locationName[locale] ?? m.locationName['zh-Hans'] ?? m.locationName['en']}
            </button>
          ))}
          {list.length === 0 && <div className="muted">{t('common.error')}</div>}
        </div>
      </div>
    );
  }

  const d = todayQ.data;

  return (
    <div style={{ minHeight: '100%', paddingBottom: 96 }}>
      {/* 顶栏：名字 + 连接状态。状态永远可见 —— 「看起来正常但收不到派单」
          是这一层最坏的失败模式，所以宁可占一行也要说清楚 */}
      <header className="row" style={{
        padding: '10px 16px', gap: 10, background: 'var(--surface)',
        borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <strong className="truncate" style={{ fontSize: 'var(--text-lg)' }}>
          {d?.name ?? '…'}
        </strong>
        <span className={`badge ${conn === 'live' ? 'badge-ok' : conn === 'down' ? 'badge-danger' : 'badge-mute'}`}>
          {conn === 'live' ? `● ${t('rt.live')}` : conn === 'down' ? `○ ${t('rt.down')}` : t('rt.connecting')}
        </span>
        <span className="grow" />
        <select className="btn" style={{ minHeight: 44, padding: '0 8px' }}
                value={locale}
                onChange={(e) => {
                  const v = e.target.value as Locale;
                  setLocale(v);
                  localStorage.setItem(LS_LOCALE, v);
                  // 按人存：换个人登录同一台 iPad 就跟着换语言
                  void run('staff.setLocale', { locale: v }, false);
                }}>
          {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_LABEL[l]}</option>)}
        </select>
      </header>

      {/* 提示音必须由一次用户手势解锁，否则整个提醒会静默失效 */}
      {!soundOn && (
        <button className="btn btn-block" onClick={enableSound}
                style={{
                  margin: '12px 16px 0', width: 'calc(100% - 32px)', minHeight: 'var(--tap-lg)',
                  borderWidth: 2, borderColor: 'var(--warn)', background: 'var(--warn-soft)',
                  color: 'var(--warn)', fontWeight: 700,
                }}>
          🔔 {t('rt.enable')}
        </button>
      )}

      {err && (
        <div className="card" role="alert" style={{
          margin: '12px 16px 0', padding: 14,
          background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>✕ {err}</span>
        </div>
      )}

      {todayQ.isPending || !d ? (
        <div className="center-page muted">{t('common.loading')}</div>
      ) : tab === 'today' ? (
        <>
          <NextCard task={d.current ?? d.next} t={t} busy={busy} flash={flash}
                    disabled={conn === 'down'}
                    onStart={(task) => void run('ticket.startItem', { ticketItemId: task.ticketItemId })}
                    onFinish={(task) => void run('ticket.finishItem', { ticketItemId: task.ticketItemId })} />

          <div className="stack" style={{ padding: '0 16px', gap: 10 }}>
            <div className="row">
              <span className="muted grow">{t('today.count')}</span>
              <strong style={{ fontSize: 'var(--text-lg)' }}>{d.doneCount}</strong>
            </div>
            {d.tasks.filter((x) => x.ticketItemId !== (d.current ?? d.next)?.ticketItemId).map((x) => (
              <div key={x.ticketItemId} className="card row"
                   style={{ padding: '14px 16px', gap: 10,
                            opacity: x.state === 'done' ? 0.55 : 1 }}>
                <span className="badge badge-mute">
                  {x.state === 'done' ? '✓' : x.state === 'in_service' ? '▶' : '·'}
                </span>
                <div className="grow stack" style={{ gap: 2 }}>
                  <strong>{x.customerName}</strong>
                  <span className="tiny">{x.serviceName} · {x.durationMin}min</span>
                </div>
                {x.alerts.length > 0 && <span className="badge badge-danger">⚠️</span>}
              </div>
            ))}
          </div>
        </>
      ) : tab === 'money' ? (
        <div className="stack" style={{ padding: 16, gap: 12 }}>
          <div className="card stack" style={{ padding: 20, gap: 6, textAlign: 'center' }}>
            <span className="muted">{t('money.today')}</span>
            <strong style={{ fontSize: 46, fontVariantNumeric: 'tabular-nums' }}>
              {money(d.earnings.payCents)}
            </strong>
          </div>
          <Row label={t('money.revenue')} value={money(d.earnings.serviceRevenueCents)} />
          <Row label={t('money.commission')} value={money(d.earnings.commissionCents)} />
          <Row label={t('money.tipCash')} value={money(d.earnings.tipCashCents)} tone="ok" />
          <Row label={t('money.tipCard')} value={money(d.earnings.tipCardCents)} />
          {d.earnings.cashTipOwedCents > 0 && (
            <div className="card row" style={{
              padding: 18, gap: 10, background: 'var(--ok-soft)', borderColor: 'var(--ok)' }}>
              <strong className="grow" style={{ color: 'var(--ok)' }}>
                💵 {t('money.cashTonight')}
              </strong>
              <strong style={{ fontSize: 'var(--text-xl)', color: 'var(--ok)',
                               fontVariantNumeric: 'tabular-nums' }}>
                {money(d.earnings.cashTipOwedCents)}
              </strong>
            </div>
          )}
        </div>
      ) : (
        <div className="stack" style={{ padding: 16, gap: 14 }}>
          <div className="card stack" style={{ padding: 20, gap: 8, textAlign: 'center' }}>
            <span className={`badge ${d.onDuty ? 'badge-ok' : 'badge-mute'}`}
                  style={{ justifySelf: 'center' }}>
              {d.onDuty ? `● ${t('clock.onDuty')}` : `○ ${t('clock.off')}`}
            </span>
            <div className="muted">{t('clock.worked')}</div>
            <strong style={{ fontSize: 40, fontVariantNumeric: 'tabular-nums' }}>
              {(d.workedMinutes / 60).toFixed(1)}h
            </strong>
          </div>

          <input className="field field-mono" inputMode="numeric" maxLength={6}
                 placeholder={t('clock.pin')} value={pin}
                 onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                 style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-xl)',
                          textAlign: 'center', letterSpacing: 8 }} />

          <div className="row" style={{ gap: 12 }}>
            <button className="btn btn-primary grow" disabled={busy || d.onDuty || conn === 'down'}
                    style={{ minHeight: 80, fontSize: 'var(--text-lg)' }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'clock_in', ...(pin ? { pin } : {}) }).then(() => setPin(''))}>
              {t('clock.in')}
            </button>
            <button className="btn grow" disabled={busy || !d.onDuty || conn === 'down'}
                    style={{ minHeight: 80, fontSize: 'var(--text-lg)' }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'clock_out', ...(pin ? { pin } : {}) }).then(() => setPin(''))}>
              {t('clock.out')}
            </button>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <button className="btn grow" disabled={busy || !d.onDuty || conn === 'down'}
                    style={{ minHeight: 64 }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'break_start', ...(pin ? { pin } : {}) })}>
              ☕ {t('clock.breakStart')}
            </button>
            <button className="btn grow" disabled={busy || !d.onDuty || conn === 'down'}
                    style={{ minHeight: 64 }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'break_end', ...(pin ? { pin } : {}) })}>
              ↩ {t('clock.breakEnd')}
            </button>
          </div>

          <button className="btn btn-ghost btn-block"
                  onClick={() => { localStorage.removeItem(LS_LOC); void supabase.auth.signOut(); }}>
            {t('auth.signOut')}
          </button>
        </div>
      )}

      {/* 底部页签：拇指够得到的位置，三个大方块 */}
      <nav className="row" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, gap: 0,
        background: 'var(--surface)', borderTop: '1px solid var(--line)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {([['today', '📋', t('nav.today')], ['money', '💰', t('nav.money')],
           ['clock', '⏱', t('nav.clock')]] as const).map(([k, icon, label]) => (
          <button key={k} className="grow stack"
                  onClick={() => setTab(k)}
                  style={{
                    minHeight: 76, gap: 2, border: 0, cursor: 'pointer',
                    alignItems: 'center', justifyContent: 'center',
                    background: tab === k ? 'var(--brand-soft)' : 'transparent',
                    color: tab === k ? 'var(--brand)' : 'var(--ink-2)',
                    fontWeight: tab === k ? 800 : 500,
                    borderTop: tab === k ? '3px solid var(--brand)' : '3px solid transparent',
                  }}>
            <span style={{ fontSize: 24 }}>{icon}</span>
            <span className="tiny">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <div className="card row" style={{ padding: '16px 18px' }}>
      <span className="grow muted">{label}</span>
      <strong style={{
        fontSize: 'var(--text-lg)', fontVariantNumeric: 'tabular-nums',
        color: tone === 'ok' ? 'var(--ok)' : undefined,
      }}>{value}</strong>
    </div>
  );
}

function Login({ t }: { t: ReturnType<typeof makeT> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function signIn() {
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(t('auth.failed'));
    setBusy(false);
  }

  return (
    <div className="center-page">
      <div className="card stack" style={{ padding: 24, gap: 14, minWidth: 300 }}>
        <strong style={{ fontSize: 'var(--text-xl)' }}>{t('auth.title')}</strong>
        <input className="field" type="email" autoComplete="username"
               placeholder={t('auth.email')} value={email}
               style={{ minHeight: 'var(--tap-lg)' }}
               onChange={(e) => setEmail(e.target.value)} />
        <input className="field" type="password" autoComplete="current-password"
               placeholder={t('auth.password')} value={password}
               style={{ minHeight: 'var(--tap-lg)' }}
               onChange={(e) => setPassword(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void signIn(); }} />
        {err && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{err}</span>}
        <button className="btn btn-primary btn-block" disabled={busy || !email || !password}
                style={{ minHeight: 'var(--tap-lg)' }}
                onClick={() => void signIn()}>
          {busy ? <span className="spin" /> : t('auth.signIn')}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const locale = (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans';

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="center-page muted">…</div>;

  return (
    <QueryClientProvider client={qc}>
      {session ? <Shell session={session} /> : <Login t={makeT(locale)} />}
    </QueryClientProvider>
  );
}
