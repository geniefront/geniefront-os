import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import {
  ApiError, apiGet, apiGetCached, runCommand, API_BASE, type LocationMembership,
} from './lib/api';
import { watchNetwork, type NetState } from './lib/offline';
import { watchLocation, type ConnState } from './lib/presence';
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
import { PhotoSetup } from './screens/PhotoSetup';
import { CallQueue, type CallQueueData, type CallDraft } from './screens/CallQueue';
import { YelpFill } from './screens/YelpFill';
import { QueueBoard, type QueueData } from './screens/QueueBoard';
import { Billing, type BillingResponse } from './screens/Billing';
import { Copilot } from './screens/Copilot';

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
    'turn' | 'day' | 'ticket' | 'earn' | 'close' | 'roster' | 'report' | 'find' | 'setup'
    | 'calls' | 'queue' | 'billing'>('turn');
  const [rosterFrom, setRosterFrom] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<string[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [copilot, setCopilot] = useState(false);
  const [photoSetup, setPhotoSetup] = useState(false);
  const [yelpFill, setYelpFill] = useState(false);
  const [callDraft, setCallDraft] = useState<CallDraft | null>(null);
  const [net, setNet] = useState<NetState>('online');
  const [online, setOnline] = useState<Set<string> | undefined>(undefined);
  const [rtState, setRtState] = useState<ConnState>('connecting');
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

  /**
   * ⭐ 实时长连接（Phase 1c）。前台这一端拿它做两件事：
   *   1. 技师在线绿点 —— 回答「派给她，她手机会响吗」
   *   2. 领域事件到达就刷新看板，不用等 20 秒的轮询
   *
   * ⚠️ 它挂了也只是退化：轮询还在，前台照样能把一天跑完（宪法第 14 条）。
   */
  useEffect(() => {
    if (!picked || net === 'offline') return;
    const h = watchLocation({
      locationId: picked.locationId,
      accessToken: session.access_token,
      onPresence: setOnline,
      onState: setRtState,
      onEvent: (type) => {
        if (type.startsWith('ticket')) { void tktQ.refetch(); void rotQ.refetch(); }
        else if (type.startsWith('rotation')) void rotQ.refetch();
        else if (type.startsWith('appointment')) void dayQ.refetch();
        // 客人还在电话里，前台这时候看到才有意义（决策 6 的「1 秒复核队列」）
        else if (type.startsWith('call')) void callQ.refetch();
        // 客人在门口签到，前台这块屏要当场跳
        else if (type.startsWith('queue')) void queueQ.refetch();
      },
    });
    return h.close;
  }, [picked?.locationId, net, session.access_token]);

  const canManage = picked?.roleKeys.some((r) => ['owner', 'manager'].includes(r)) ?? false;
  // 权限判断按角色近似（后端才是权威）：前台能日结、能发现金小费，
  // 但历史营业报表只给老板和店长（决策 19 极致隐私）
  const canDesk = picked?.roleKeys.some((r) =>
    ['owner', 'manager', 'front_desk'].includes(r)) ?? false;
  const canReport = canManage;
  /**
   * ⭐ 账单只给老板 —— 店长都不给（决策 19 的极致隐私，后端才是权威：
   * `billing.manage` 只在 owner 的预设里）。前端这一层只是别把页签摆出来
   * 让人点了看到「没有权限」。
   */
  const canBill = picked?.roleKeys.includes('owner') ?? false;
  // 副驾要 ai.use。技师端没有 —— 它是前台的调度助手（后端才是权威）
  const canUseAi = picked?.roleKeys.some((r) =>
    ['owner', 'manager', 'front_desk'].includes(r)) ?? false;

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
  /**
   * 来电待复核队列（决策 6）。
   *
   * 和别的页签不同，它**一直在拉** —— 角标要显示「有 N 条等着你」，
   * 而前台不会主动去点一个看起来是空的页签。轮询兜底 30 秒，
   * 实时推送到了就当场刷（下面的 onEvent）。
   */
  const callQ = useQuery({
    queryKey: ['call-drafts', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<CallQueueData>('/v1/desk/call-drafts', picked!.membershipId),
    refetchInterval: 30_000,
  });

  /**
   * 走单队列。和待复核队列一样**一直在拉** —— 角标要显示「几个人在等」，
   * 而前台不会主动去点一个看起来是空的页签。
   * 等位时长要跳，所以刷得比别的勤一点。
   */
  const queueQ = useQuery({
    queryKey: ['queue', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<QueueData>('/v1/desk/queue', picked!.membershipId),
    refetchInterval: 20_000,
  });

  /**
   * 订阅与余额。
   *
   * ⚠️ **只在老板点开这个页签时才拉** —— 这条查询顺带会触发一次
   * 自动续充检查（server.ts 的 /v1/desk/billing），而那可能真的从卡上扣钱。
   * 挂成常驻轮询的话，一台开着不动的电脑会一直在敲这条路。
   */
  const billQ = useQuery({
    queryKey: ['billing', picked?.membershipId],
    enabled: Boolean(picked) && tab === 'billing' && canBill,
    queryFn: () => apiGet<BillingResponse>('/v1/desk/billing', picked!.membershipId),
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
        {/* 技师端能不能收到派单，前台得看得见 —— 不然会一直等一个不会响的铃 */}
        {net === 'online' && (
          <span className={`badge ${rtState === 'live' ? 'badge-ok' : 'badge-mute'}`}
                title={rtState === 'live'
                  ? '实时推送正常，派单会让技师手机响'
                  : '实时推送未连接，派单不会响铃 —— 口头叫号'}>
            {rtState === 'live' ? `● 实时 ${online?.size ?? 0} 人在线` : '○ 实时未连接'}
          </span>
        )}
        <span className="grow" />
        {/*
          ⭐ 副驾做成抽屉、按钮放在顶栏：它是「在别的屏上顺手问一句」的东西。
          做成页签的话，前台正看着日程表说「把 Lisa 五点那单挪到六点」，
          得先离开日程表 —— 而离开的那一刻她就看不到自己在说哪一单了。
        */}
        {canUseAi && (
          <button className="btn" style={{ minHeight: 44 }} onClick={() => setCopilot(true)}
                  title="用说话的方式让副驾帮你查和改">🤖 副驾</button>
        )}
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
          ...(['turn', 'queue', 'day', 'ticket', 'calls', 'earn'] as const),
          ...(canDesk ? ['close'] as const : []),
          ...(['roster'] as const),
          ...(canReport ? ['report'] as const : []),
          ...(['find'] as const),
          ...(canManage ? ['setup'] as const : []),
          ...(canBill ? ['billing'] as const : []),
        ]).map((k) => (
          <button key={k} className="btn" onClick={() => setTab(k)}
                  style={{
                    borderWidth: 2,
                    borderColor: tab === k ? 'var(--brand)' : 'var(--line)',
                    background: tab === k ? 'var(--brand-soft)' : 'var(--surface)',
                  }}>
            {k === 'turn' ? '轮牌板' : k === 'day' ? '今日日程'
              : k === 'ticket' ? `在做的单${tktQ.data?.tickets.length ? ` (${tktQ.data.tickets.length})` : ''}`
              : k === 'queue' ? `🎫 等位${queueQ.data?.summary.waiting ? ` (${queueQ.data.summary.waiting})` : ''}`
              : k === 'calls' ? `☎️ 待复核${callQ.data?.pendingCount ? ` (${callQ.data.pendingCount})` : ''}`
              : k === 'earn' ? '💰 今日收入'
              : k === 'close' ? '🌙 打烊日结'
              : k === 'roster' ? '📅 排班'
              : k === 'report' ? '📊 报表'
              : k === 'setup' ? '⚙ 开店配置'
              : k === 'billing' ? '💳 订阅与余额'
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
                     onlineStaff={rtState === 'live' ? online : undefined}
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
      ) : tab === 'queue' ? (
        queueQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : queueQ.data ? (
          <QueueBoard data={queueQ.data} membershipId={picked.membershipId}
                      onChanged={async () => { await queueQ.refetch(); }} />
        ) : <Retry onRetry={() => queueQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'calls' ? (
        callQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : callQ.data ? (
          <CallQueue data={callQ.data} membershipId={picked.membershipId}
                     onChanged={async () => { await callQ.refetch(); }}
                     onBook={(d) => {
                       // ⭐ 建单不在这一屏做：要走前台自己身份下的 appointment.create，
                       // 容量检查、软约束放行一样不少（09 §4.2）。
                       // 这里只是把草案的三要素带到日程表上，前台在那儿落最后一锤。
                       setCallDraft(d);
                       if (d.customer) setChosen({ id: d.customer.id!, displayName: d.customer.displayName ?? '' } as CustomerHit);
                       setTab('day');
                     }} />
        ) : <Retry onRetry={() => callQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
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
        yelpFill ? (
          <YelpFill membershipId={picked.membershipId}
                    onCancel={() => setYelpFill(false)}
                    onDone={async () => {
                      setYelpFill(false);
                      // 时区可能刚被改过 —— 营业日边界跟着变，日程和轮牌都得重拉
                      await setQ.refetch(); await dayQ.refetch(); await rotQ.refetch();
                    }} />
        ) :
        photoSetup ? (
          <PhotoSetup membershipId={picked.membershipId} locationId={picked.locationId}
                      onCancel={() => setPhotoSetup(false)}
                      onDone={async () => {
                        setPhotoSetup(false);
                        // 必须 await：不等刷新完就退回项目列表，老板看不到刚建的项目，
                        // 会以为没建成而再跑一遍整个流程
                        await setQ.refetch(); await dayQ.refetch();
                      }} />
        ) :
        setQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : setQ.data ? (
          <Settings data={setQ.data} membershipId={picked.membershipId}
                    onPhotoSetup={() => setPhotoSetup(true)}
                    onYelpFill={() => setYelpFill(true)}
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
      ) : tab === 'billing' ? (
        billQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : billQ.data ? (
          <Billing data={billQ.data.billing} autoTopup={billQ.data.autoTopup}
                   membershipId={picked.membershipId}
                   onChanged={async () => { await billQ.refetch(); }} />
        ) : <Retry onRetry={() => billQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
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

      {copilot && (
        <Copilot membershipId={picked.membershipId}
                 onClose={() => setCopilot(false)}
                 onExecuted={async () => {
                   // 副驾执行完不知道动了什么，把几块看板都刷一遍 ——
                   // 前台关掉抽屉时看到的必须已经是新的
                   await Promise.all([
                     dayQ.refetch(), rotQ.refetch(), tktQ.refetch(), queueQ.refetch(),
                   ]);
                 }} />
      )}

      {slot && dayQ.data && (
        <BookSheet
          day={dayQ.data} membershipId={picked.membershipId}
          staffId={slot.staffId} startMin={slot.startMin}
          customer={chosen ? { id: chosen.id, displayName: chosen.displayName } : null}
          t={t}
          fromCallDraft={callDraft ? {
            draftId: callDraft.draftId,
            serviceId: callDraft.service.matchedId,
            serviceHeard: callDraft.service.heard,
            timeHeard: callDraft.time.heard,
          } : undefined}
          onCancel={() => setSlot(null)}
          onDone={async () => {
            // 建成了就把那条来电草案标记掉，否则它会一直挂在待复核里，
            // 前台第二天还会照着它再建一次
            if (callDraft) {
              await runCommand('call.reviewDraft',
                { draftId: callDraft.draftId, decision: 'confirmed' },
                picked.membershipId).catch(() => {});
              setCallDraft(null);
              await callQ.refetch();
            }
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
