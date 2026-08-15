import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { apiGet, type LocationMembership } from './lib/api';
import { makeT, LOCALE_LABEL, LOCALES, type Locale } from './i18n';
import { Login } from './screens/Login';
import { LocationPicker } from './screens/LocationPicker';
import { CustomerSearch, type CustomerHit } from './screens/CustomerSearch';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const LS_LOC = 'gf.lastMembership';
const LS_LOCALE = 'gf.locale';

function Shell({ session }: { session: Session }) {
  // 界面语言按【人】记，不是按店
  const [locale, setLocale] = useState<Locale>(
    () => (localStorage.getItem(LS_LOCALE) as Locale) ?? 'zh-Hans');
  const t = makeT(locale);
  const [picked, setPicked] = useState<LocationMembership | null>(null);
  const [chosen, setChosen] = useState<CustomerHit | null | undefined>(undefined);

  const locs = useQuery({
    queryKey: ['me-locations', session.user.id],
    queryFn: () => apiGet<{ locations: LocationMembership[] }>('/v1/me/locations'),
  });

  // 只有一家店就直接进；多店记住上次选择（02 §2 user_last_location 的前端侧）
  useEffect(() => {
    const list = locs.data?.locations;
    if (!list || picked) return;
    if (list.length === 1) { setPicked(list[0]!); return; }
    const last = localStorage.getItem(LS_LOC);
    const hit = list.find((m) => m.membershipId === last);
    if (hit) setPicked(hit);
  }, [locs.data, picked]);

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

      {chosen === undefined ? (
        <CustomerSearch membershipId={picked.membershipId} t={t} onPick={setChosen} />
      ) : (
        <div className="stack" style={{ maxWidth: 760, margin: '0 auto', padding: 20 }}>
          <div className="card stack" style={{ padding: 24, gap: 10 }}>
            <div className="tiny">已选客人</div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800 }}>
              {chosen ? chosen.displayName : '新客人 / Walk-in'}
            </div>
            <div className="muted">下一步：选项目 → 派技师 → 开单（建设中）</div>
          </div>
          <button className="btn" onClick={() => setChosen(undefined)}>‹ {t('common.back')}</button>
        </div>
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
