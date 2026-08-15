import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { ApiError, apiGet, type LocationMembership } from './lib/api';
import { makeT, LOCALE_LABEL, LOCALES, type Locale } from './i18n';
import { Login } from './screens/Login';
import { LocationPicker } from './screens/LocationPicker';
import { CustomerSearch, type CustomerHit } from './screens/CustomerSearch';
import { DaySchedule, type DaySnapshot } from './screens/DaySchedule';
import { BookSheet } from './screens/BookSheet';
import { TurnBoard, type RotationSnapshot } from './screens/TurnBoard';
import { Checkout, type OpenTicket } from './screens/Checkout';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const LS_LOC = 'gf.lastMembership';
const LS_LOCALE = 'gf.locale';

function Shell({ session }: { session: Session }) {
  // 界面语言按【人】记，不是按店
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');
  const t = makeT(locale);
  const [picked, setPicked] = useState<LocationMembership | null>(null);
  const [tab, setTab] = useState<'turn' | 'day' | 'ticket' | 'find'>('turn');
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

      <nav className="row" style={{ padding: '10px 16px', gap: 10 }}>
        {(['turn', 'day', 'ticket', 'find'] as const).map((k) => (
          <button key={k} className="btn" onClick={() => setTab(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: tab === k ? 'var(--brand)' : 'var(--line)',
                    background: tab === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            {k === 'turn' ? '轮牌板' : k === 'day' ? '今日日程'
              : k === 'ticket' ? `在做的单${tktQ.data?.tickets.length ? ` (${tktQ.data.tickets.length})` : ''}`
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
          <TurnBoard data={rotQ.data} membershipId={picked.membershipId}
                     canOverride={picked.roleKeys.some((r) =>
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
          {(tktQ.data?.tickets ?? []).map((tk) => (
            <button key={tk.ticketId} className="card row" onClick={() => setCheckout(tk)}
                    style={{ padding: '16px 18px', gap: 14, textAlign: 'left', cursor: 'pointer' }}>
              <div className="grow stack" style={{ gap: 4 }}>
                <strong style={{ fontSize: 'var(--text-xl)' }}>{tk.customerName}</strong>
                <div className="tiny truncate">
                  {tk.items.map((i) => `${i.staffName} · ${i.name}`).join(' ／ ')}
                </div>
              </div>
              <span style={{ fontSize: 'var(--text-xl)', fontWeight: 700,
                             fontVariantNumeric: 'tabular-nums' }}>
                ${(tk.subtotalCents / 100).toFixed(2)}
              </span>
              <span className="badge badge-soft">结账 ›</span>
            </button>
          ))}
        </div>
      ) : tab === 'find' ? (
        <CustomerSearch membershipId={picked.membershipId} t={t}
                        onPick={(c) => { setChosen(c); setTab('day'); }}
                        onApiError={onApiError} />
      ) : dayQ.isPending ? (
        <div className="center-page muted">{t('common.loading')}</div>
      ) : dayQ.data ? (
        <DaySchedule day={dayQ.data} t={t}
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
                  onCancel={() => setCheckout(null)}
                  onDone={async () => { await tktQ.refetch(); await rotQ.refetch(); }} />
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
