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
import {
  ApiError, apiGet, runCommand, claimByCode, phoneStart, phoneVerify,
  staffMe, getStaffToken, setStaffToken,
  type LocationMembership, type IssuedSession, type StaffMe,
} from './lib/api';
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

/**
 * 技师的身份有两种（sql/0031）：
 *
 *   · `supabase` —— 用邮箱登录的人（店长、老板，或者以前就有账号的技师）
 *   · `staff` —— **上机码 / 手机验证码**上来的人，他没有平台账号，
 *     身份就是「这家店的这条 membership」
 *
 * ⚠️ 两者最大的差别不在权限（那是一样的），而在**实时推送**：
 * Supabase Realtime 的私有频道认的是 Supabase 的 JWT，
 * 上机会话签不出那个东西 —— 详见下面轮询那一段。
 */
type Identity =
  | { kind: 'supabase'; session: Session }
  | { kind: 'staff'; membershipId: string; locationId: string; displayName: string };

function Shell({ identity, onSignOut }: { identity: Identity; onSignOut: () => void }) {
  const session = identity.kind === 'supabase' ? identity.session : null;
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
    queryKey: ['me-locations', session?.user.id ?? 'staff-token'],
    // ⚠️ 上机会话不能调这条：那条路要的是平台账号，服务端会 401。
    // 他的店是会话自己带的，不需要选
    enabled: identity.kind === 'supabase',
    queryFn: () => apiGet<{ locations: LocationMembership[] }>('/v1/me/locations'),
  });

  useEffect(() => {
    if (picked) return;
    if (identity.kind === 'staff') {
      setPicked({
        membershipId: identity.membershipId, orgId: '', locationId: identity.locationId,
        locationName: {}, roleKeys: [],
      });
      return;
    }
    const list = locs.data?.locations;
    if (!list) return;
    if (list.length === 1) { setPicked(list[0]!); return; }
    const last = localStorage.getItem(LS_LOC);
    const hit = list.find((m) => m.membershipId === last);
    if (hit) setPicked(hit);
  }, [locs.data, picked, identity]);

  const todayQ = useQuery({
    queryKey: ['staff-today', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<StaffToday>('/v1/staff/me/today', picked!.membershipId),
    /**
     * 兜底轮询：Realtime 是主通道，这条是它断了之后的安全网。
     * 60 秒不是性能考量 —— 是"就算长连接彻底坏了，技师也不会一直看着旧数据"。
     *
     * ⚠️ **上机会话没有实时推送**（Supabase Realtime 的私有频道认的是
     * Supabase 的 JWT，而上机会话签不出那个东西），所以那种身份下
     * 这条轮询就是**唯一**通道 —— 拉到 10 秒。
     */
    refetchInterval: identity.kind === 'staff' ? 10_000 : 60_000,
    /**
     * ⭐ 页面不在前台时**也要继续拉**（只对上机会话）。
     *
     * React Query 默认在 `document.hidden` 时暂停轮询 —— 对有长连接的人
     * 这没问题（WebSocket 还在，回到前台还有 visibilitychange 对齐）。
     * 但对上机会话，轮询**就是唯一那条通道**：暂停 = 技师切出去看一眼微信
     * 再回来之前，店里发生的一切他都不知道，而他手机上什么都不会响。
     *
     * ⚠️ 手机系统仍然可能挂起定时器（锁屏尤其），所以这条不能替代
     * 下面那个 visibilitychange 对齐 —— 两条一起才覆盖得住。
     */
    refetchIntervalInBackground: identity.kind === 'staff',
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

  // 界面语言按人：登录后跟随 users.locale（共享 iPad 上换人就换语言）。
  // 上机会话那种身份的语言存在 staff_profiles.locale，由服务端在
  // /v1/auth/staff/me 里给出，登录那一屏已经设过了
  useEffect(() => {
    const l = session?.user.user_metadata?.['locale'] as Locale | undefined;
    if (l && LOCALES.includes(l)) setLocale(l);
  }, [session]);

  // ── 实时长连接 ────────────────────────────────────────────────────────────
  const lastEventAt = useRef(0);
  const myName = todayQ.data?.name ?? '';
  useEffect(() => {
    if (!picked || !myName) return;
    // 没有 Supabase 会话 = 连不上私有频道（见上面轮询那段的说明）。
    // 不 return 的话会一直重连一个注定失败的东西，界面上那个指示点
    // 会在「连接中」和「断开」之间闪
    if (!session) { setConn('down'); return; }
    const me = picked.membershipId;
    const handle = subscribeLocation({
      locationId: picked.locationId,
      membershipId: me,
      name: myName,
      accessToken: session!.access_token,
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
  }, [picked?.locationId, picked?.membershipId, myName, session?.access_token, refresh]);

  /**
   * ⭐ 上机会话的响铃：**从轮询结果里认出「这是一单新派给我的」**。
   *
   * 有长连接的人靠 `ticket.assigned` 事件响铃（上面那段）。上机会话收不到
   * 事件 —— 不补这一段的话，新单会**悄无声息**地出现在屏幕上，
   * 而技师正低头做着上一单，根本不会发现。
   *
   * 判定只用一个事实：`next` 那一单的 id 变成了一个没见过的。
   * 不比对列表长度 —— 做完一单之后长度也会变，那会响一次假的。
   */
  const knownNextId = useRef<string | null>(null);
  const nextId = todayQ.data?.next?.ticketItemId ?? null;
  useEffect(() => {
    if (identity.kind !== 'staff') return;
    const first = knownNextId.current === null && nextId !== null;
    const changed = nextId !== null && knownNextId.current !== null && nextId !== knownNextId.current;
    knownNextId.current = nextId;
    // ⚠️ 第一次拿到数据不响 —— 那是他刚打开 app，不是刚被派了单
    if (first || !changed) return;
    alertAssigned();
    setFlash(true);
    setTimeout(() => setFlash(false), 3000);
  }, [nextId, identity.kind]);

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

  /**
   * ⭐ 「现在能不能动手」和「有没有实时推送」是两件事。
   *
   * 上机会话**天生没有实时推送**（Supabase 私有频道认的是 Supabase 的 JWT），
   * 但他的网好得很 —— 把这两件事混成一个 `conn === 'down'` 的话，
   * 用上机码进来的技师会看到「连不上 · 写操作暂停」，
   * 而打卡、开始、完成三个按钮全是灰的。**他整个用不了。**
   *
   * 所以这种身份下，「通不通」看那条 10 秒轮询 —— 它本来就是唯一的通道。
   */
  const offline = identity.kind === 'staff' ? todayQ.isError : conn === 'down';

  /**
   * ⚠️ 选店那一关**只对有平台账号的人成立**。
   *
   * 上机会话不调 `/v1/me/locations`（那条路要账号），于是那个查询
   * 永远停在 `isPending` —— 不把这一关跳过去的话，用上机码进来的技师
   * 会**永远卡在「加载中」**，而服务端那边一切正常、日志里全是 200。
   */
  const needsPicker = identity.kind === 'supabase';

  if (needsPicker && locs.isPending) {
    return <div className="center-page muted">{t('common.loading')}</div>;
  }
  if (needsPicker && (locs.isError || !locs.data)) {
    return (
      <div className="center-page">
        <div className="card stack" style={{ padding: 24, gap: 12 }}>
          <div>{t('common.error')}</div>
          <button className="btn" onClick={() => locs.refetch()}>{t('common.retry')}</button>
          <button className="btn btn-ghost" onClick={onSignOut}>
            {t('auth.signOut')}
          </button>
        </div>
      </div>
    );
  }

  const list = locs.data?.locations ?? [];
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
        {identity.kind === 'staff' ? (
          // 上机会话没有长连接：如实说「每 10 秒刷新一次」，
          // 而不是显示一个吓人的「连不上」—— 他的网好得很
          <span className={`badge ${offline ? 'badge-danger' : 'badge-mute'}`}>
            {offline ? `○ ${t('rt.down')}` : '● 每 10 秒刷新'}
          </span>
        ) : (
          <span className={`badge ${conn === 'live' ? 'badge-ok' : conn === 'down' ? 'badge-danger' : 'badge-mute'}`}>
            {conn === 'live' ? `● ${t('rt.live')}` : conn === 'down' ? `○ ${t('rt.down')}` : t('rt.connecting')}
          </span>
        )}
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
                    disabled={offline}
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
            <button className="btn btn-primary grow" disabled={busy || d.onDuty || offline}
                    style={{ minHeight: 80, fontSize: 'var(--text-lg)' }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'clock_in', ...(pin ? { pin } : {}) }).then(() => setPin(''))}>
              {t('clock.in')}
            </button>
            <button className="btn grow" disabled={busy || !d.onDuty || offline}
                    style={{ minHeight: 80, fontSize: 'var(--text-lg)' }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'clock_out', ...(pin ? { pin } : {}) }).then(() => setPin(''))}>
              {t('clock.out')}
            </button>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <button className="btn grow" disabled={busy || !d.onDuty || offline}
                    style={{ minHeight: 64 }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'break_start', ...(pin ? { pin } : {}) })}>
              ☕ {t('clock.breakStart')}
            </button>
            <button className="btn grow" disabled={busy || !d.onDuty || offline}
                    style={{ minHeight: 64 }}
                    onClick={() => void run('timeclock.punch',
                      { kind: 'break_end', ...(pin ? { pin } : {}) })}>
              ↩ {t('clock.breakEnd')}
            </button>
          </div>

          <button className="btn btn-ghost btn-block"
                  onClick={() => { localStorage.removeItem(LS_LOC); onSignOut(); }}>
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

/**
 * 上机（登录）。三条路，默认那条**不依赖短信**。
 *
 * 顺序是有意的：
 *
 *   ① **上机码** —— 老板在店里点一下、念给他，15 分钟内输一次就绑定。
 *      不经过任何运营商，10DLC 还没批下来也能用（宪法第 13 条）
 *   ② **手机验证码** —— 他自己来，不用麻烦老板。⚠️ 美国 A2P 没批之前
 *      多半收不到，所以它不是默认那条
 *   ③ **邮箱密码** —— 有平台账号的人（店长、老板）走这条
 *
 * 面向的是「四十岁以上、手上有水、店里光线杂」的人：大号输入框、
 * 大按钮、每屏只问一件事（`00` §2、宪法第 11 条）。
 */
function Login({ t, locale, onStaffSession }: {
  t: ReturnType<typeof makeT>;
  /** 发验证码短信时一起传给服务端 —— 他还没登录，语言只能从这里知道 */
  locale: Locale;
  onStaffSession: (s: IssuedSession) => void;
}) {
  const [way, setWay] = useState<'code' | 'phone' | 'email'>('code');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // ① 上机码
  const [code, setCode] = useState('');
  // ② 手机
  const [phone, setPhone] = useState('');
  const [sms, setSms] = useState('');
  const [sent, setSent] = useState(false);
  const [choices, setChoices] = useState<Array<{
    membershipId: string; locationId: string; shopName: string; displayName: string;
  }> | null>(null);
  // ③ 邮箱
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const e164 = (): string => {
    const d = phone.replace(/\D/g, '');
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith('1')) return `+${d}`;
    return d ? `+${d}` : '';
  };

  async function guard(fn: () => Promise<void>): Promise<void> {
    setBusy(true); setErr('');
    try { await fn(); }
    catch (e) {
      const code2 = e instanceof ApiError ? (e.details['reason'] ?? e.code) : '';
      setErr(
        code2 === 'bad_claim_code' ? '这个码不对，或者已经过期了 —— 让老板再点一次'
        : code2 === 'bad_code' ? '验证码不对'
        : code2 === 'too_many_attempts' ? '试得太多了，等一分钟再来'
        : code2 === 'not_on_any_roster' ? '这个号码不在任何一家店的花名册上'
        : code2 === 'not_configured' ? '短信通道还没开通 —— 先用老板给的上机码'
        : t('auth.failed'));
    }
    finally { setBusy(false); }
  }

  const label = navigator.userAgent.slice(0, 40);

  return (
    <div className="center-page">
      <div className="card stack" style={{ padding: 24, gap: 16, minWidth: 320, maxWidth: 420 }}>
        <strong style={{ fontSize: 'var(--text-xl)' }}>{t('auth.title')}</strong>

        <div className="row" style={{ gap: 8 }}>
          {([['code', '上机码'], ['phone', '手机号'], ['email', '邮箱']] as const).map(([k, l]) => (
            <button key={k} className="btn grow" style={{
              minHeight: 'var(--tap)', borderWidth: 2,
              borderColor: way === k ? 'var(--brand)' : 'var(--line)',
              background: way === k ? 'var(--brand-soft)' : 'var(--surface)',
            }} onClick={() => { setWay(k); setErr(''); }}>{l}</button>
          ))}
        </div>

        {way === 'code' && (
          <div className="stack" style={{ gap: 12 }}>
            <span className="tiny">让老板在前台点「给他上机码」，把那 6 个数字念给你</span>
            <input className="field" inputMode="numeric" autoFocus placeholder="123456"
                   value={code} maxLength={6}
                   style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-xl)',
                            letterSpacing: 8, textAlign: 'center' }}
                   onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}
                    style={{ minHeight: 'var(--tap-lg)' }}
                    onClick={() => void guard(async () => {
                      onStaffSession(await claimByCode(code, label));
                    })}>
              {busy ? <span className="spin" /> : '进去'}
            </button>
          </div>
        )}

        {way === 'phone' && !choices && (
          <div className="stack" style={{ gap: 12 }}>
            <input className="field" inputMode="tel" placeholder="512-555-0142"
                   value={phone} style={{ minHeight: 'var(--tap-lg)' }}
                   onChange={(e) => { setPhone(e.target.value); setSent(false); }} />
            {!sent && (
              <button className="btn btn-primary btn-block" disabled={busy || e164().length < 9}
                      style={{ minHeight: 'var(--tap-lg)' }}
                      onClick={() => void guard(async () => {
                        await phoneStart(e164(), locale); setSent(true);
                      })}>
                {busy ? <span className="spin" /> : '给我发验证码'}
              </button>
            )}
            {sent && (
              <>
                <span className="tiny">验证码发到 {e164()} 了</span>
                <input className="field" inputMode="numeric" autoFocus placeholder="验证码"
                       value={sms} style={{ minHeight: 'var(--tap-lg)', letterSpacing: 6,
                                            textAlign: 'center' }}
                       onChange={(e) => setSms(e.target.value.replace(/\D/g, ''))} />
                <button className="btn btn-primary btn-block" disabled={busy || sms.length < 4}
                        style={{ minHeight: 'var(--tap-lg)' }}
                        onClick={() => void guard(async () => {
                          const out = await phoneVerify(e164(), sms, undefined, label);
                          // 在两家店上班的人要先点一家 —— 和多店老板的选店器同一件事
                          if ('needsLocation' in out) setChoices(out.locations);
                          else onStaffSession(out);
                        })}>
                  {busy ? <span className="spin" /> : '进去'}
                </button>
                <button className="btn btn-ghost btn-block" disabled={busy}
                        onClick={() => void guard(async () => { await phoneStart(e164(), locale); })}>
                  没收到，重发一条
                </button>
              </>
            )}
          </div>
        )}

        {way === 'phone' && choices && (
          <div className="stack" style={{ gap: 10 }}>
            <span className="tiny">你在这几家店都有身份，进哪一家？</span>
            {choices.map((c) => (
              <button key={c.locationId} className="btn btn-block"
                      style={{ minHeight: 'var(--tap-lg)' }} disabled={busy}
                      onClick={() => void guard(async () => {
                        const out = await phoneVerify(e164(), sms, c.locationId, label);
                        if (!('needsLocation' in out)) onStaffSession(out);
                      })}>
                {c.shopName}
              </button>
            ))}
          </div>
        )}

        {way === 'email' && (
          <div className="stack" style={{ gap: 12 }}>
            <input className="field" type="email" autoComplete="username"
                   placeholder={t('auth.email')} value={email}
                   style={{ minHeight: 'var(--tap-lg)' }}
                   onChange={(e) => setEmail(e.target.value)} />
            <input className="field" type="password" autoComplete="current-password"
                   placeholder={t('auth.password')} value={password}
                   style={{ minHeight: 'var(--tap-lg)' }}
                   onChange={(e) => setPassword(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') void signInEmail(); }} />
            <button className="btn btn-primary btn-block" disabled={busy || !email || !password}
                    style={{ minHeight: 'var(--tap-lg)' }}
                    onClick={() => void signInEmail()}>
              {busy ? <span className="spin" /> : t('auth.signIn')}
            </button>
          </div>
        )}

        {err && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{err}</span>}
      </div>
    </div>
  );

  async function signInEmail(): Promise<void> {
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(t('auth.failed'));
    setBusy(false);
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  /**
   * 上机会话（sql/0031）。undefined = 还在问服务端「这个令牌还作数吗」。
   *
   * ⚠️ 每次启动都要问一次：老板可能已经把他踢下线了（手机丢了、人离职了），
   * 而本地存着的那个字符串自己不会知道这件事。
   */
  const [staffMeState, setStaffMeState] = useState<StaffMe | null | undefined>(undefined);
  const locale = (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans';

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!getStaffToken()) { setStaffMeState(null); return; }
    void staffMe()
      .then((me) => setStaffMeState(me))
      .catch(() => {
        // 被踢下线 / 过期了 —— 清掉，让他重新上机。
        // 留着的话每一次请求都会 401，而界面上看不出为什么
        setStaffToken(null);
        setStaffMeState(null);
      });
  }, []);

  if (session === undefined || staffMeState === undefined) {
    return <div className="center-page muted">…</div>;
  }

  const identity: Identity | null =
    staffMeState
      ? { kind: 'staff', membershipId: staffMeState.membershipId,
          locationId: staffMeState.locationId, displayName: staffMeState.displayName }
      : session ? { kind: 'supabase', session } : null;

  const signOut = (): void => {
    setStaffToken(null);
    setStaffMeState(null);
    void supabase.auth.signOut();
  };

  return (
    <QueryClientProvider client={qc}>
      {identity
        ? <Shell identity={identity} onSignOut={signOut} />
        : <Login t={makeT(locale)} locale={locale} onStaffSession={(s) => {
            setStaffToken(s.token);
            setStaffMeState({
              membershipId: s.membershipId, locationId: s.locationId,
              displayName: s.displayName, locale, permissions: [],
            });
          }} />}
    </QueryClientProvider>
  );
}
