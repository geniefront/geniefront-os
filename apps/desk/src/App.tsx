import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import {
  ApiError, apiGet, apiGetCached, runCommand, API_BASE, type LocationMembership,
} from './lib/api';
import { watchNetwork, type NetState } from './lib/offline';
import { OfflineBanner } from './screens/OfflineBanner';
import { makeT, LOCALE_LABEL, LOCALES, type Locale } from './i18n';
import { Login } from './screens/Login';
import { LocationPicker } from './screens/LocationPicker';
import { CustomerSearch, type CustomerHit } from './screens/CustomerSearch';
import { DaySchedule, type DaySnapshot } from './screens/DaySchedule';
import { BookSheet } from './screens/BookSheet';
import { TurnBoard, type RotationSnapshot } from './screens/TurnBoard';
import { Checkout, type OpenTicket } from './screens/Checkout';
import { Settings, type SettingsData } from './screens/Settings';
import { Earnings, type EarningsBoard } from './screens/Earnings';
import { DayClose, type DayCloseData } from './screens/DayClose';
import { Roster, type RosterData } from './screens/Roster';
import { Reports, type ReportData } from './screens/Reports';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const LS_LOC = 'gf.lastMembership';
const LS_LOCALE = 'gf.locale';

function Shell({ session }: { session: Session }) {
  // 界面语言按【人】记，不是按店
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');
  const t = makeT(locale);
  const [picked, setPicked] = useState<LocationMembership | null>(null);
  const [tab, setTab] = useState<
    'turn' | 'day' | 'ticket' | 'earn' | 'close' | 'roster' | 'report' | 'find' | 'setup'>('turn');
  const [rosterFrom, setRosterFrom] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<string[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [net, setNet] = useState<NetState>('online');
  const [netSince, setNetSince] = useState(Date.now());
  const [cached, setCached] = useState<{ rot: RotationSnapshot | null; day: DaySnapshot | null; at: number } | null>(null);

  // 断网时把最后一次成功的快照读出来展示（宪法第 18 条）
  useEffect(() => {
    if (net === 'online' || !picked) { setCached(null); return; }
    void (async () => {
      const [r, d] = await Promise.all([
        apiGetCached<RotationSnapshot>('/v1/desk/rotation', picked.membershipId),
        apiGetCached<DaySnapshot>('/v1/desk/day', picked.membershipId),
      ]);
      setCached({
        rot: r?.value ?? null, day: d?.value ?? null,
        at: Math.max(r?.at ?? 0, d?.at ?? 0),
      });
    })();
  }, [net, picked]);

  useEffect(() => watchNetwork(API_BASE, (s, since) => { setNet(s); setNetSince(since); }), []);
  const [checkout, setCheckout] = useState<OpenTicket | null>(null);
  const [chosen, setChosen] = useState<CustomerHit | null | undefined>(undefined);
  const [slot, setSlot] = useState<{ staffId: string; startMin: number } | null>(null);

  const locs = useQuery({
    queryKey: ['me-locations', session.user.id],
    queryFn: () => apiGet<{ locations: LocationMembership[] }>('/v1/me/locations'),
  });

  /**
   * 存下来的 membershipId 会失效：技师离职（membership.status = left）后
   * 后端立刻拒绝，而前端还揣着旧 id —— 那会卡在一个出不去的错误页上。
   * 遇到 membership_not_owned 就清掉重选，而不是让人只能清浏览器缓存。
   */
  const onApiError = (e: unknown) => {
    if (e instanceof ApiError && e.details['reason'] === 'membership_not_owned') {
      localStorage.removeItem(LS_LOC);
      setPicked(null);
      void locs.refetch();
      return true;
    }
    return false;
  };

  // 只有一家店就直接进；多店记住上次选择（02 §2 user_last_location 的前端侧）
  useEffect(() => {
    const list = locs.data?.locations;
    if (!list || picked) return;
    if (list.length === 1) { setPicked(list[0]!); return; }
    const last = localStorage.getItem(LS_LOC);
    const hit = list.find((m) => m.membershipId === last);
    if (hit) setPicked(hit);
    else if (last) localStorage.removeItem(LS_LOC);  // 存的那家已经没身份了
  }, [locs.data, picked]);

  const dayQ = useQuery({
    queryKey: ['day', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<DaySnapshot>('/v1/desk/day', picked!.membershipId),
  });

  const rotQ = useQuery({
    queryKey: ['rotation', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<RotationSnapshot>('/v1/desk/rotation', picked!.membershipId),
    // 轮牌板是墙上大屏，会一直开着 —— 定时刷新到 Phase 1c 换成 Realtime 推送
    refetchInterval: 20_000,
  });

  const tktQ = useQuery({
    queryKey: ['tickets', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<{ tickets: OpenTicket[] }>('/v1/desk/tickets', picked!.membershipId),
  });

  const canManage = picked?.roleKeys.some((r) => ['owner', 'manager'].includes(r)) ?? false;
  // 权限判断按角色近似（后端才是权威）：前台能日结、能发现金小费，
  // 但历史营业报表只给老板和店长（决策 19 极致隐私）
  const canDesk = picked?.roleKeys.some((r) =>
    ['owner', 'manager', 'front_desk'].includes(r)) ?? false;
  const canReport = canManage;

  const earnQ = useQuery({
    queryKey: ['earnings', picked?.membershipId],
    enabled: Boolean(picked) && tab === 'earn',
    queryFn: () => apiGet<EarningsBoard>('/v1/desk/earnings', picked!.membershipId),
  });

  const closeQ = useQuery({
    queryKey: ['dayclose', picked?.membershipId],
    enabled: Boolean(picked) && tab === 'close' && canDesk,
    queryFn: () => apiGet<DayCloseData>('/v1/desk/dayclose', picked!.membershipId),
  });

  const rosterQ = useQuery({
    queryKey: ['roster', picked?.membershipId, rosterFrom],
    enabled: Boolean(picked) && tab === 'roster',
    queryFn: () => apiGet<RosterData>(
      `/v1/desk/roster?days=7${rosterFrom ? `&from=${rosterFrom}` : ''}`, picked!.membershipId),
  });

  const reportQ = useQuery({
    queryKey: ['report', picked?.membershipId, range],
    enabled: Boolean(picked) && tab === 'report' && canReport,
    queryFn: () => apiGet<ReportData>(
      `/v1/desk/reports${range ? `?from=${range.from}&to=${range.to}` : ''}`,
      picked!.membershipId),
  });
  const setQ = useQuery({
    queryKey: ['settings', picked?.membershipId],
    enabled: Boolean(picked) && canManage,
    queryFn: () => apiGet<SettingsData>('/v1/desk/settings', picked!.membershipId),
  });

  const signOut = () => { localStorage.removeItem(LS_LOC); void supabase.auth.signOut(); };

  // ⚠️ data 未就绪时一律当「还在加载/失败」处理。
  // 绝不能让请求失败落到 LocationPicker 的空列表分支 ——
  // 那会显示「你还没有任何门店的身份，请联系店主」，
  // 前台会照着去找老板，而真正的问题是网络。
  if (locs.isPending) return <div className="center-page muted">{t('common.loading')}</div>;
  if (locs.isError || !locs.data) {
    return (
      <div className="center-page">
        <div className="card stack" style={{ padding: 24, gap: 12 }}>
          <div>{t('common.error')}</div>
          <button className="btn" onClick={() => locs.refetch()}>{t('common.retry')}</button>
          <button className="btn btn-ghost" onClick={signOut}>{t('auth.signOut')}</button>
        </div>
      </div>
    );
  }

  const list = locs.data?.locations ?? [];

  if (!picked) {
    return (
      <LocationPicker
        locations={list} locale={locale} t={t}
        onPick={(m) => { localStorage.setItem(LS_LOC, m.membershipId); setPicked(m); }}
        onSignOut={signOut}
      />
    );
  }

  const shopName = picked.locationName[locale] ?? picked.locationName['zh-Hans']
    ?? picked.locationName['en'] ?? '—';

  return (
    <div style={{ minHeight: '100%' }}>
      <header className="row" style={{
        padding: '10px 16px', background: 'var(--surface)',
        borderBottom: '1px solid var(--line)', gap: 14, position: 'sticky', top: 0, zIndex: 10,
      }}>
        <strong className="truncate" style={{ fontSize: 'var(--text-lg)' }}>{shopName}</strong>
        {picked.roleKeys.map((r) => (
          <span key={r} className="badge badge-soft">{t(`role.${r}`)}</span>
        ))}
        <span className="grow" />
        <select
          className="btn" style={{ minHeight: 44, padding: '0 12px' }}
          value={locale}
          onChange={(e) => {
            const v = e.target.value as Locale;
            setLocale(v); localStorage.setItem(LS_LOCALE, v);
          }}
          aria-label="语言"
        >
          {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_LABEL[l]}</option>)}
        </select>
        {list.length > 1 && (
          <button className="btn" style={{ minHeight: 44 }} onClick={() => setPicked(null)}>
            {t('loc.switch')}
          </button>
        )}
        <button className="btn btn-ghost" style={{ minHeight: 44 }} onClick={signOut}>
          {t('auth.signOut')}
        </button>
      </header>

      {net === 'offline' && <OfflineBanner since={netSince} cachedAt={cached?.at ?? null} />}

      <nav className="row" style={{ padding: '10px 16px', gap: 10 }}>
        {([
          ...(['turn', 'day', 'ticket', 'earn'] as const),
          ...(canDesk ? ['close'] as const : []),
          ...(['roster'] as const),
          ...(canReport ? ['report'] as const : []),
          ...(['find'] as const),
          ...(canManage ? ['setup'] as const : []),
        ]).map((k) => (
          <button key={k} className="btn" onClick={() => setTab(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: tab === k ? 'var(--brand)' : 'var(--line)',
                    background: tab === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            {k === 'turn' ? '轮牌板' : k === 'day' ? '今日日程'
              : k === 'ticket' ? `在做的单${tktQ.data?.tickets.length ? ` (${tktQ.data.tickets.length})` : ''}`
              : k === 'earn' ? '💰 今日收入'
              : k === 'close' ? '🌙 打烊日结'
              : k === 'roster' ? '📅 排班'
              : k === 'report' ? '📊 报表'
              : k === 'setup' ? '⚙ 开店配置'
              : t('cust.title')}
          </button>
        ))}
        <span className="grow" />
        {chosen !== undefined && (
          <span className="badge badge-soft">
            已选：{chosen ? chosen.displayName : '临时客人'} · 点空白处排单
          </span>
        )}
      </nav>

      {tab === 'turn' ? (
        rotQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : rotQ.data ? (
          <TurnBoard data={net === 'offline' && cached?.rot ? cached.rot : rotQ.data}
                     membershipId={picked.membershipId}
                     readOnly={net === 'offline'}
                     canOverride={net === 'online' && picked.roleKeys.some((r) =>
                       ['owner', 'manager', 'front_desk'].includes(r))}
                     services={dayQ.data?.services ?? []}
                     onChanged={async () => {
                       await rotQ.refetch(); await dayQ.refetch(); await tktQ.refetch();
                     }} />
        ) : (
          <div className="card" style={{ margin: 16, padding: 20 }}>
            <div className="row">
              <span className="grow">{t('common.error')}</span>
              <button className="btn" onClick={() => rotQ.refetch()}>{t('common.retry')}</button>
            </div>
          </div>
        )
      ) : tab === 'ticket' ? (
        <div className="stack" style={{ padding: '0 16px 24px', gap: 12 }}>
          {(tktQ.data?.tickets ?? []).length === 0 && (
            <div className="card" style={{ padding: 28, textAlign: 'center' }}>
              <div className="muted">现在没有在做的单</div>
              <div className="tiny" style={{ marginTop: 6 }}>从轮牌板派单会自动开单</div>
            </div>
          )}

          {/* ⭐ 归组：一起来的客人。这个动作往往发生在结账台 ——
              「我请客」是掏钱那一刻才说的，所以对已经开着的单也能用 */}
          {grouping.length > 0 && (
            <div className="card row" style={{
              padding: '14px 18px', gap: 12, position: 'sticky', top: 64, zIndex: 5,
              background: 'var(--brand-soft)', borderColor: 'var(--brand)' }}>
              <strong className="grow">已选 {grouping.length} 张单</strong>
              <button className="btn" onClick={() => setGrouping([])}>取消</button>
              <button className="btn btn-primary" disabled={grouping.length < 2 || groupBusy}
                      onClick={async () => {
                        setGroupBusy(true);
                        try {
                          await runCommand('ticket.group', { ticketIds: grouping },
                                           picked.membershipId);
                          setGrouping([]);
                          await tktQ.refetch();
                        } finally { setGroupBusy(false); }
                      }}>
                {groupBusy ? <span className="spin" /> : '归为一组（可以一起付）'}
              </button>
            </div>
          )}

          {(tktQ.data?.tickets ?? []).map((tk) => (
            <div key={tk.ticketId} className="card row"
                 style={{ padding: '16px 18px', gap: 14, textAlign: 'left' }}>
              <button aria-label="选中"
                      onClick={() => setGrouping(grouping.includes(tk.ticketId)
                        ? grouping.filter((x) => x !== tk.ticketId)
                        : [...grouping, tk.ticketId])}
                      style={{ background: 'none', border: 0, cursor: 'pointer',
                               fontSize: 'var(--text-xl)', padding: 0 }}>
                {grouping.includes(tk.ticketId) ? '☑' : '☐'}
              </button>
              <button className="grow stack" onClick={() => setCheckout(tk)}
                      style={{ gap: 4, background: 'none', border: 0, textAlign: 'left',
                               cursor: 'pointer', padding: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <strong style={{ fontSize: 'var(--text-xl)' }}>{tk.customerName}</strong>
                  {tk.groupId && (
                    <span className="badge badge-soft">
                      {tk.groupLabel ?? '同组'}
                    </span>
                  )}
                </div>
                <div className="tiny truncate">
                  {tk.items.map((i) => `${i.staffName} · ${i.name}`).join(' ／ ')}
                </div>
              </button>
              <span style={{ fontSize: 'var(--text-xl)', fontWeight: 700,
                             fontVariantNumeric: 'tabular-nums' }}>
                ${(tk.subtotalCents / 100).toFixed(2)}
              </span>
              <button className="badge badge-soft" onClick={() => setCheckout(tk)}
                      style={{ border: 0, cursor: 'pointer' }}>结账 ›</button>
            </div>
          ))}
        </div>
      ) : tab === 'earn' ? (
        earnQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : earnQ.data ? <Earnings data={earnQ.data} />
        : <Retry onRetry={() => earnQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'close' ? (
        closeQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : closeQ.data ? (
          <DayClose data={closeQ.data} membershipId={picked.membershipId}
                    canPayTips={canDesk}
                    onChanged={async () => {
                      await closeQ.refetch(); await earnQ.refetch(); await tktQ.refetch();
                    }} />
        ) : <Retry onRetry={() => closeQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'roster' ? (
        rosterQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : rosterQ.data ? (
          <Roster data={rosterQ.data} membershipId={picked.membershipId}
                  canWrite={canManage}
                  onDateChange={setRosterFrom}
                  onChanged={async () => { await rosterQ.refetch(); }} />
        ) : <Retry onRetry={() => rosterQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'report' ? (
        reportQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : reportQ.data ? (
          <Reports data={reportQ.data} membershipId={picked.membershipId}
                   onRange={(from, to) => setRange({ from, to })} />
        ) : <Retry onRetry={() => reportQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'setup' ? (
        setQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : setQ.data ? (
          <Settings data={setQ.data} membershipId={picked.membershipId}
                    onChanged={async () => {
                      await setQ.refetch(); await dayQ.refetch(); await rotQ.refetch();
                    }} />
        ) : (
          <div className="card" style={{ margin: 16, padding: 20 }}>
            <div className="row">
              <span className="grow">{t('common.error')}</span>
              <button className="btn" onClick={() => setQ.refetch()}>{t('common.retry')}</button>
            </div>
          </div>
        )
      ) : tab === 'find' ? (
        <CustomerSearch membershipId={picked.membershipId} t={t}
                        onPick={(c) => { setChosen(c); setTab('day'); }}
                        onApiError={onApiError} />
      ) : dayQ.isPending ? (
        <div className="center-page muted">{t('common.loading')}</div>
      ) : (net === 'offline' && cached?.day) || dayQ.data ? (
        <DaySchedule day={(net === 'offline' && cached?.day ? cached.day : dayQ.data)!} t={t}
                     readOnly={net === 'offline'}
                     onSlotClick={(staffId, startMin) => setSlot({ staffId, startMin })} />
      ) : (
        <div className="card" style={{ margin: 16, padding: 20 }}>
          <div className="row">
            <span className="grow">{t('common.error')}</span>
            <button className="btn" onClick={() => dayQ.refetch()}>{t('common.retry')}</button>
          </div>
        </div>
      )}

      {checkout && (
        <Checkout ticket={checkout} membershipId={picked.membershipId}
                  groupTickets={checkout.groupId
                    ? (tktQ.data?.tickets ?? []).filter((x) => x.groupId === checkout.groupId)
                    : undefined}
                  onCancel={() => setCheckout(null)}
                  onDone={async () => {
                    await tktQ.refetch(); await rotQ.refetch(); await earnQ.refetch();
                  }} />
      )}

      {slot && dayQ.data && (
        <BookSheet
          day={dayQ.data} membershipId={picked.membershipId}
          staffId={slot.staffId} startMin={slot.startMin}
          customer={chosen ? { id: chosen.id, displayName: chosen.displayName } : null}
          t={t}
          onCancel={() => setSlot(null)}
          onDone={async () => {
            setSlot(null); setChosen(undefined);
            // ⚠️ 必须 await：不等刷新完就关弹窗，前台看到日程表上没有这一单，
            // 会以为没开成而再开一次 —— 重复建单在门店里是实打实的事故。
            await dayQ.refetch();
          }}
        />
      )}
    </div>
  );
}

/** 查询失败时的统一重试块 —— 四个新页签都要用，写四遍会漂移 */
function Retry({ onRetry, label, retry }: {
  onRetry: () => void; label: string; retry: string;
}) {
  return (
    <div className="card" style={{ margin: 16, padding: 20 }}>
      <div className="row">
        <span className="grow">{label}</span>
        <button className="btn" onClick={onRetry}>{retry}</button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [locale] = useState<Locale>(() => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');

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
