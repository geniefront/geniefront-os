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

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const LS_LOC = 'gf.lastMembership';
const LS_LOCALE = 'gf.locale';

function Shell({ session }: { session: Session }) {
  // 界面语言按【人】记，不是按店
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');
  const t = makeT(locale);
  const [picked, setPicked] = useState<LocationMembership | null>(null);
  const [tab, setTab] = useState<'day' | 'find'>('day');
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
        {(['day', 'find'] as const).map((k) => (
          <button key={k} className="btn" onClick={() => setTab(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: tab === k ? 'var(--brand)' : 'var(--line)',
                    background: tab === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            {k === 'day' ? '今日日程' : t('cust.title')}
          </button>
        ))}
        <span className="grow" />
        {chosen !== undefined && (
          <span className="badge badge-soft">
            已选：{chosen ? chosen.displayName : '临时客人'} · 点空白处排单
          </span>
        )}
      </nav>

      {tab === 'find' ? (
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
