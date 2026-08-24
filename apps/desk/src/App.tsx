import { useEffect, useMemo, useState } from 'react';
import {
  ListOrdered, Armchair, CalendarDays, DoorOpen, Receipt, PhoneCall, Users,
  MessageSquareWarning,
  Wallet, Moon, FileWarning, BarChart3, CalendarClock, Settings2, Percent,
  CreditCard, AlertTriangle, Bot, LogOut, Menu, LayoutDashboard, type LucideIcon,
} from 'lucide-react';
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
import { Activate } from './screens/Activate';
import { SetupWizard } from './screens/SetupWizard';
import { CustomerSearch, type CustomerHit } from './screens/CustomerSearch';
import { DaySchedule, type DaySnapshot, type DayItem } from './screens/DaySchedule';
import { BookSheet } from './screens/BookSheet';
import { EditBookingSheet } from './screens/EditBookingSheet';
import { AddItemSheet } from './screens/AddItemSheet';
import { PayrollPlans, type PayrollPlansData } from './screens/PayrollPlans';
import { TurnBoard, type RotationSnapshot } from './screens/TurnBoard';
import { Checkout, type OpenTicket } from './screens/Checkout';
import { Settings, type SettingsData } from './screens/Settings';
import { Earnings, type EarningsBoard } from './screens/Earnings';
import { DayClose, type DayCloseData } from './screens/DayClose';
import { Roster, type RosterData } from './screens/Roster';
import { Reports, type ReportData } from './screens/Reports';
import { PhotoSetup } from './screens/PhotoSetup';
import { CallQueue, type CallQueueData, type CallDraft } from './screens/CallQueue';
import { SmsInbox, type SmsInboxData } from './screens/SmsInbox';
import { YelpFill } from './screens/YelpFill';
import { QueueBoard, type QueueData } from './screens/QueueBoard';
import { FloorBoard } from './screens/FloorBoard';
import { Overview } from './screens/Overview';
import { GapDays, type GapsData } from './screens/GapDays';
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
  // 页签类型定义在下面的 Sidebar 那一节 —— 两处各写一份必然漂移
  // ⭐ 默认落地在总览：开门第一眼要回答「现在店里什么情况」，
  // 而不是「该谁接下一个客人」（那是轮牌板要回答的）
  const [tab, setTab] = useState<Tab>('overview');
  const [rosterFrom, setRosterFrom] = useState<string | null>(null);
  /**
   * 「先进店看看，晚点再配」。
   *
   * 只活在这一次会话里 —— 刷新之后还没配完的话，向导会再出来一次。
   * 存进 localStorage 的话，一个配到一半的老板会再也找不到那张清单，
   * 而他要找的正是它（规矩 1 说的是「跳过不拦着他用」，不是「跳过就藏起来」）。
   */
  const [wizardSkipped, setWizardSkipped] = useState(false);
  /** 从向导跳进「⚙ 开店配置」时要落在哪个页签 */
  const [settingsPane, setSettingsPane] = useState<
    'service' | 'staff' | 'hours' | 'device' | 'phone' | null>(null);
  const [grouping, setGrouping] = useState<string[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [copilot, setCopilot] = useState(false);
  const [photoSetup, setPhotoSetup] = useState(false);
  const [yelpFill, setYelpFill] = useState(false);
  const [callDraft, setCallDraft] = useState<CallDraft | null>(null);
  /**
   * 现在是门店本地时间的第几分钟。
   * 房态看板拿它判断「此刻谁在房里」—— 按时间算而不是按 status 算，
   * 因为技师忘了点「开始」是常事，而墙上的钟不会忘。
   */
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  /** 「去封这一天的账」带过来的日期。null = 今天 */
  const [closeDate, setCloseDate] = useState<string | null>(null);
  /** 窄屏侧栏抽屉。宽屏常驻，这个状态不起作用 */
  const [navOpen, setNavOpen] = useState(false);

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
  /** 点开的那一单（改时间 / 换人 / 取消） */
  const [editing, setEditing] = useState<DayItem | null>(null);
  /** 要加项目的那一单（客人做到一半说「再加个 gel」） */
  const [adding, setAdding] = useState<OpenTicket | null>(null);

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

  /**
   * ⚠️ 「现在几点」必须按**门店时区**算，不能用浏览器的。
   *
   * 老板在加州用手机看纽约那家店，浏览器时区差三小时 ——
   * 房态看板会告诉他「VIP1 现在空着」，而那间房其实正在做客人。
   * 多店老板是这个产品的常见画像（决策 10），不是边缘情况。
   */
  const nowMin = useMemo(() => {
    const tz = dayQ.data?.timezone;
    const d = new Date(nowTick);
    if (!tz) return d.getHours() * 60 + d.getMinutes();
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0);
    return g('hour') * 60 + g('minute');
  }, [nowTick, dayQ.data?.timezone]);

  const tktQ = useQuery({
    queryKey: ['tickets', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<{ businessDate: string; tickets: OpenTicket[]; staleCount: number }>(
      '/v1/desk/tickets', picked!.membershipId),
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

  /** 提成方案。只有能配薪酬的人（owner/manager）才查 —— 后端才是权威 */
  const planQ = useQuery({
    queryKey: ['payrollPlans', picked?.membershipId],
    enabled: Boolean(picked) && tab === 'payroll' && canManage,
    queryFn: () => apiGet<PayrollPlansData>('/v1/desk/payroll/plans', picked!.membershipId),
  });

  const closeQ = useQuery({
    // ⭐ closeDate 进 queryKey：从「没记完的日子」点「去封这一天的账」跳过来时，
    // 不带日期的话会拉到今天那一份，然后人对着今天的数去封昨天的账
    queryKey: ['dayclose', picked?.membershipId, closeDate],
    enabled: Boolean(picked) && tab === 'close' && canDesk,
    queryFn: () => apiGet<DayCloseData>(
      closeDate ? `/v1/desk/dayclose?date=${closeDate}` : '/v1/desk/dayclose',
      picked!.membershipId),
  });

  /**
   * ⭐ 没记完的日子（0032）。**它不拦任何东西** ——
   * 前台可以一天不理它，照样开单结账封账。
   * 只在真有断档时侧栏才出现这一项（见 Sidebar）：
   * 一个常年挂着 0 的入口，前台第二周就不看了。
   */
  const gapQ = useQuery({
    queryKey: ['gaps', picked?.membershipId],
    enabled: Boolean(picked) && canDesk,
    queryFn: () => apiGet<GapsData>('/v1/desk/gaps', picked!.membershipId),
    // 断档说的是「昨天以前」，不用跟着今天的动作刷
    staleTime: 5 * 60_000,
  });

  /**
   * ⭐ 总览的同比。复用报表接口取最近 8 天，客户端挑出「今天」与「上周同一天」。
   *
   * 不新增接口：这份数据报表页本来就在拉，多一个端点就多一份会跟报表对不上的数。
   * 对比对象是**上周同一星期几**而不是昨天 —— 门店生意按星期几波动，
   * 拿周四跟周三比只会得出「今天生意差」这种没有信息量的结论。
   */
  const trendQ = useQuery({
    queryKey: ['trend', picked?.membershipId, dayQ.data?.businessDate],
    enabled: Boolean(picked) && tab === 'overview' && Boolean(dayQ.data),
    queryFn: () => {
      const to = dayQ.data!.businessDate;
      const from = new Date(Date.parse(`${to}T00:00:00Z`) - 7 * 86_400_000)
        .toISOString().slice(0, 10);
      return apiGet<ReportData>(`/v1/desk/reports?from=${from}&to=${to}`, picked!.membershipId);
    },
    staleTime: 5 * 60_000,
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
   * 客人发进来的短信（docs/09 §5.3）。
   *
   * 和来电复核一样**一直在拉** —— 角标要显示「有几个人可能以为自己取消了」。
   * 刷得慢一点（2 分钟）：短信不像来电那样要秒级响应，
   * 而这一页平时是空的，白刷没意义。
   */
  const smsQ = useQuery({
    queryKey: ['sms-inbound', picked?.membershipId],
    enabled: Boolean(picked),
    queryFn: () => apiGet<SmsInboxData>('/v1/desk/sms-inbound', picked!.membershipId),
    refetchInterval: 120_000,
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

  /**
   * 新店进来先看开店清单。
   *
   * ⭐ 依据是**门店自己的状态**（`locations.status = 'setup'`），
   * 不是浏览器里记的一个标记 —— 老板在家用手机看过一眼、第二天到店里
   * 用前台电脑打开，看到的必须是同一件事（docs/12 §3 C 规矩 2）。
   */
  const signOut = () => { localStorage.removeItem(LS_LOC); void supabase.auth.signOut(); };

  // ⚠️ data 未就绪时一律当「还在加载/失败」处理。
  // 绝不能让请求失败落到 LocationPicker 的空列表分支 ——
  // 那会显示「你还没有任何门店的身份，请联系店主」，
  // 前台会照着去找老板，而真正的问题是网络。
  /*
   * ⚠️ 这个 useMemo 必须待在**所有早退之前**。
   *
   * 第一版放在 `if (!picked) return <LocationPicker/>` 后面，结果是
   * 「Rendered more hooks than during the previous render」——
   * 没选店那一次渲染少调一个 hook，选完店多出一个，React 直接崩。
   * 早退多的组件里，这类错误只在特定路径上出现，平时测不到。
   */
  const overviewTotals = useMemo(() => {
    const today = dayQ.data?.businessDate;
    const byDay = trendQ.data?.byDay ?? [];
    const cur = byDay.find((d) => d.key === today);
    const prev = today
      ? byDay.find((d) => d.key === new Date(
          Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10))
      : undefined;
    // 上周那天没记录或没营业时不显示同比 —— 拿 0 当基数会算出「↑ 100%」这种假信号
    const comparable = prev && prev.status !== 'no_record' && prev.status !== 'paper_only';

    const gross = cur?.grossCents ?? 0;
    const count = cur?.ticketCount ?? 0;
    const openTickets = tktQ.data?.tickets ?? [];

    return {
      grossCents: gross,
      ticketCount: count,
      avgTicketCents: count > 0 ? Math.round(gross / count) : 0,
      openTicketCount: openTickets.length,
      openTicketCents: openTickets.reduce((sum, t) => sum + t.subtotalCents, 0),
      grossDeltaBp: comparable && prev!.grossCents > 0
        ? Math.round(((gross - prev!.grossCents) / prev!.grossCents) * 10_000) : null,
      guestsDeltaCount: comparable ? count - prev!.ticketCount : null,
      avgDeltaCents: comparable && prev!.ticketCount > 0 && count > 0
        ? Math.round(gross / count) - Math.round(prev!.grossCents / prev!.ticketCount) : null,
    };
  }, [dayQ.data?.businessDate, trendQ.data, tktQ.data]);

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

  /**
   * ⭐ 开通门店（docs/12 §3 B）。
   *
   * 两种情况走到这里：
   *   · 老板点了激活邮件里的链接（落在 `/activate`）
   *   · 他登录了，但名下一家店都没有 —— 多半是链接点过一次没成，
   *     或者他先去登录页登进来了。**这时候不该给他一句
   *    「你还没有任何门店的身份，请联系店主」** —— 他就是店主，
   *     而且刚付过钱
   */
  const fromActivationLink = window.location.pathname.startsWith('/activate');
  if (fromActivationLink || list.length === 0) {
    return (
      <Activate onClaimed={async (membershipId) => {
        // 认领成功后把地址栏那一截去掉：刷新时不会再跑一遍认领
        window.history.replaceState({}, '', '/');
        const fresh = await locs.refetch();
        /**
         * ⭐ 直接进刚开通的那一家。
         *
         * 不这么做的话，一个在别的店已经有身份的人（比如多店老板）
         * 会被 localStorage 里存的上一家店接管 —— 他刚开通完一家新店，
         * 看到的却是旧店的轮牌板，而新店要自己去「切换门店」里找。
         */
        const hit = (fresh.data?.locations ?? []).find((m) => m.membershipId === membershipId);
        if (hit) { localStorage.setItem(LS_LOC, hit.membershipId); setPicked(hit); }
      }} />
    );
  }

  if (!picked) {
    return (
      <LocationPicker
        locations={list} locale={locale} t={t}
        onPick={(m) => { localStorage.setItem(LS_LOC, m.membershipId); setPicked(m); }}
        onSignOut={signOut}
      />
    );
  }

  /**
   * ⚠️ `picked` 是**选店那一刻的快照**。
   *
   * 店名被改了、门店状态从 `setup` 变成 `active` —— 这些只会更新
   * `locs` 那一份。所以凡是要显示或要判断的，一律读列表里的最新那条：
   * 不这么做的话，「配好了，开张」点完之后命令成功了、数据也刷新了，
   * 而那张开店清单纹丝不动，他只能以为按钮坏了。
   */
  const current = list.find((m) => m.membershipId === picked.membershipId) ?? picked;

  const setupPending = current.locationStatus === 'setup' && canManage;
  /**
   * 清单占的是**首页那一格**（轮牌板那个页签），不是一层盖住全屏的东西。
   *
   * 这样「跳去配项目」是真的跳走了，配完点回轮牌板又能看到清单 ——
   * 而不需要在向导里再实现一遍项目、员工、营业时间那几屏。
   */
  const showWizard = setupPending && !wizardSkipped && tab === 'overview';

  const shopName = current.locationName[locale] ?? current.locationName['zh-Hans']
    ?? current.locationName['en'] ?? '—';

  /**
   * 总览的四个指标。
   *
   * ⚠️ 客单价用**已结工单**算，不含在做的单 —— 在做的单还会加项目，
   * 拿它算出来的客单价一整天都在跳，看不出趋势。
   */
  return (
    <div className="shell">
      {/*
        ⭐ 分组侧边栏，换掉原来那排 13 个平铺页签。
        平铺的问题不是难看，是没有层次：一天按几百次的「轮牌板」
        和一天按一次的「打烊日结」在屏幕上一样大 —— 前台每次都得扫一遍全部。
      */}
      <Sidebar
        open={navOpen}
        onClose={() => setNavOpen(false)}
        tab={tab}
        setTab={(k) => {
          // 换页签时把「去封哪一天」清掉 —— 不清的话，下次点「打烊日结」
          // 还停在上次从断档跳过来的那一天，而他要封的是今天
          if (k !== 'close') setCloseDate(null);
          setTab(k);
        }}
        canDesk={canDesk} canReport={canReport} canManage={canManage} canBill={canBill}
        counts={{
          ticket: tktQ.data?.tickets.length ?? 0,
          stale: tktQ.data?.staleCount ?? 0,
          queue: queueQ.data?.summary.waiting ?? 0,
          calls: callQ.data?.pendingCount ?? 0,
          sms: smsQ.data?.needsAttention ?? 0,
          gaps: gapQ.data?.unhandled ?? 0,
        }}
      />

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {/*
        顶栏。原来是店名 + 角色徽章 + 实时徽章 + 四个按钮平铺一排 ——
        七八个同等重量的元素挤在一起，这是「乱」的另一半。

        现在只留两样东西：**你在哪家店**（左），**你能干什么**（右）。
        角色和实时状态降级成一行灰色小字 —— 它们是要能查到的，
        不是要一直喊的。
      */}
      <header className="topbar">
        {/* 窄屏（iPad 竖向）下才出现。宽屏侧栏常驻，不需要它 */}
        <button className="btn btn-sm btn-ghost btn-icon side-toggle"
                onClick={() => setNavOpen(true)}
                aria-label="打开导航" title="导航">
          <Menu size={20} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="title truncate">{shopName}</div>
          <div className="tiny truncate" style={{ marginTop: 1 }}>
            {picked.roleKeys.map((r) => t(`role.${r}`)).join(' · ')}
            {net === 'online' && (
              <>
                {' · '}
                {/* 技师端能不能收到派单，前台得看得见 —— 不然会一直等一个不会响的铃 */}
                <span title={rtState === 'live'
                  ? '实时推送正常，派单会让技师手机响'
                  : '实时推送未连接，派单不会响铃 —— 口头叫号'}
                  style={{ color: rtState === 'live' ? 'var(--ok)' : 'var(--ink-3)' }}>
                  {rtState === 'live' ? `实时 · ${online?.size ?? 0} 人在线` : '实时未连接'}
                </span>
              </>
            )}
          </div>
        </div>

        <span className="grow" />

        {/*
          ⭐ 副驾做成抽屉、按钮放在顶栏：它是「在别的屏上顺手问一句」的东西。
          做成页签的话，前台正看着日程表说「把 Lisa 五点那单挪到六点」，
          得先离开日程表 —— 而离开的那一刻她就看不到自己在说哪一单了。
        */}
        {canUseAi && (
          <button className="btn btn-sm" onClick={() => setCopilot(true)}
                  title="用说话的方式让副驾帮你查和改">
            <Bot size={17} /> 副驾
          </button>
        )}
        <select
          className="btn btn-sm" style={{ padding: '0 10px' }}
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
          <button className="btn btn-sm" onClick={() => setPicked(null)}>{t('loc.switch')}</button>
        )}
        <button className="btn btn-sm btn-ghost btn-icon" onClick={signOut}
                title={t('auth.signOut')} aria-label={t('auth.signOut')}>
          <LogOut size={17} />
        </button>
      </header>

      {net === 'offline' && <OfflineBanner since={netSince} cachedAt={cached?.at ?? null} />}

      {/*
        配到一半跑去别的页签的时候，得有一条路回得来 ——
        不然他配完项目会楞在那里想「刚才那张清单去哪了」。
      */}
      {setupPending && !showWizard && (
        <button className="row" onClick={() => { setWizardSkipped(false); setSettingsPane(null); setTab('overview'); }}
                style={{
                  margin: '10px 16px 0', padding: '12px 16px', gap: 10, width: 'calc(100% - 32px)',
                  minHeight: 'var(--tap)', textAlign: 'left', cursor: 'pointer',
                  background: 'var(--warn-soft)', color: 'var(--warn)',
                  border: '1px solid var(--warn)', borderRadius: 'var(--r)',
                }}>
          <span className="grow" style={{ fontWeight: 600 }}>○ 开店清单还没走完</span>
          <span>回到清单 →</span>
        </button>
      )}


      {/*
        ⭐ 新店进来先看这张清单（docs/12 §3 C）。
        判断依据是 `locations.status`，不是本地记的一个标记 ——
        换台设备登录看到的必须是同一件事。

        ⚠️ 它盖在页签之上，但**没有拦住任何东西**：清单里那个
        「先进店看看」按钮一点就进去了，上面的页签也照常能点。
        一个出不去的向导比没有向导糟得多。
      */}
      {showWizard && setQ.data && (
        <SetupWizard
          data={setQ.data} membershipId={picked.membershipId}
          onPhotoSetup={() => { setTab('setup'); setPhotoSetup(true); }}
          onYelpFill={() => { setTab('setup'); setYelpFill(true); }}
          onOpenSettings={(pane) => { setTab('setup'); setSettingsPane(pane); }}
          onEnterShop={() => setWizardSkipped(true)}
          onChanged={async () => {
            // 门店状态可能刚从 setup 变成 active —— 选店器那一份也要跟着更新，
            // 不然「开张」点完之后向导还在原地
            await setQ.refetch(); await locs.refetch();
            await dayQ.refetch(); await rotQ.refetch();
          }} />
      )}
      {showWizard && setQ.isPending && (
        <div className="center-page muted">{t('common.loading')}</div>
      )}

      {!showWizard && (tab === 'overview' ? (
        dayQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : (net === 'offline' && cached?.day) || dayQ.data ? (
          <Overview
            day={(net === 'offline' && cached?.day ? cached.day : dayQ.data)!}
            nowMin={nowMin}
            totals={overviewTotals}
            todo={{
              calls: callQ.data?.pendingCount ?? 0,
              waiting: queueQ.data?.summary.waiting ?? 0,
              longestWaitMin: queueQ.data?.summary.longestWaitMin ?? 0,
              stale: tktQ.data?.staleCount ?? 0,
            }}
            onGo={(w) => setTab(w)}
            onCheckIn={(it) => setEditing(it)}
            onEditBooking={(it) => setEditing(it)}
            onAssign={() => setTab('turn')}
            onToggleBreak={() => setTab('turn')}
          />
        ) : <Retry onRetry={() => dayQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'turn' ? (
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

          {/*
            ⭐ 隔夜单单独成组（0032）。
            以前它们混在今天的单里，前台看不出哪张是哪天的 —— 而封账会以
            「还有单没结」为由被拦下，老板不知道拦他的是三天前的一张幽灵单。
            放在最上面而不是最下面：它挡着今天的路，就得先看见它。
          */}
          {(tktQ.data?.staleCount ?? 0) > 0 && (
            <div className="card stack" style={{
              padding: '14px 18px', gap: 4,
              background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
              <strong style={{ color: 'var(--warn)' }}>
                ⚠️ 有 {tktQ.data!.staleCount} 张单不是今天的
              </strong>
              <span className="tiny" style={{ color: 'var(--warn)' }}>
                下面标了日期的那几张是前几天开的。它们会挡住封账 ——
                该结的结掉，结不了的作废（记录会留着，不算营业额）。
              </span>
            </div>
          )}

          {(tktQ.data?.tickets ?? []).map((tk) => (
            <div key={tk.ticketId} className="card row"
                 style={{ padding: '16px 18px', gap: 14, textAlign: 'left',
                          borderColor: tk.daysAgo > 0 ? 'var(--warn)' : undefined }}>
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
                  {/* 「几天前」比日期本身好用：前台不用心算今天几号 */}
                  {tk.daysAgo > 0 && (
                    <span className="badge badge-warn">
                      ⚠️ {tk.daysAgo === 1 ? '昨天' : `${tk.daysAgo} 天前`}开的
                      （{tk.businessDate}）
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
              <button className="badge badge-soft" onClick={() => setAdding(tk)}
                      style={{ border: 0, cursor: 'pointer' }}>➕ 加项目</button>
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
      ) : tab === 'floor' ? (
        // ⭐ 房态看板不发新请求：全部从已经在拉的 day 快照里算（见 FloorBoard 文件头）
        dayQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : (net === 'offline' && cached?.day) || dayQ.data ? (
          <FloorBoard day={(net === 'offline' && cached?.day ? cached.day : dayQ.data)!}
                      nowMin={nowMin} />
        ) : <Retry onRetry={() => dayQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'gaps' ? (
        gapQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : gapQ.data ? (
          <GapDays data={gapQ.data} membershipId={picked.membershipId}
                   onOpenDayClose={(d) => { setCloseDate(d); setTab('close'); }}
                   onChanged={async () => {
                     // 补录会改报表和日结那两块的数，一起刷
                     await Promise.all([gapQ.refetch(), reportQ.refetch(), closeQ.refetch()]);
                   }} />
        ) : <Retry onRetry={() => gapQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
      ) : tab === 'sms' ? (
        smsQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : smsQ.data ? (
          <SmsInbox data={smsQ.data} timezone={dayQ.data?.timezone ?? 'America/New_York'} />
        ) : <Retry onRetry={() => smsQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
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
                    // ⚠️ key 让它在页签变化时重新挂载 —— 不重挂的话，
                    // 从向导第二次跳进来（比如先点员工再点项目）会停在上一个页签
                    key={settingsPane ?? 'default'}
                    initialPane={settingsPane}
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
      ) : tab === 'payroll' ? (
        planQ.isPending ? <div className="center-page muted">{t('common.loading')}</div>
        : planQ.data ? (
          <div style={{ padding: '0 16px 24px' }}>
            <PayrollPlans data={planQ.data} membershipId={picked.membershipId}
                          onChanged={async () => { await planQ.refetch(); }} />
          </div>
        ) : <Retry onRetry={() => planQ.refetch()} label={t('common.error')} retry={t('common.retry')} />
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
                     onSlotClick={(staffId, startMin) => setSlot({ staffId, startMin })}
                     onItemClick={(it) => setEditing(it)} />
      ) : (
        <div className="card" style={{ margin: 16, padding: 20 }}>
          <div className="row">
            <span className="grow">{t('common.error')}</span>
            <button className="btn" onClick={() => dayQ.refetch()}>{t('common.retry')}</button>
          </div>
        </div>
      ))}

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

      {adding && dayQ.data && (
        <AddItemSheet
          ticket={adding} day={dayQ.data} membershipId={picked.membershipId}
          onCancel={() => setAdding(null)}
          onDone={async () => {
            // 加项改了单的金额，也可能给另一位技师派了活 ——
            // 单子、轮牌、今日收入三块都要刷
            await Promise.all([tktQ.refetch(), rotQ.refetch(), earnQ.refetch()]);
            setAdding(null);
          }} />
      )}

      {editing && dayQ.data && (
        <EditBookingSheet
          day={dayQ.data} item={editing} membershipId={picked.membershipId} t={t}
          onCancel={() => setEditing(null)}
          onDone={async () => {
            // 改单会同时影响日程、轮牌和在做的单 —— 三块一起刷，
            // 关掉抽屉时看到的必须已经是新的
            await Promise.all([dayQ.refetch(), rotQ.refetch(), tktQ.refetch()]);
            setEditing(null);
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
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════════════
   侧边栏
   ═══════════════════════════════════════════════════════════════════════════ */

type Tab =
  | 'overview' | 'turn' | 'day' | 'ticket' | 'earn' | 'close' | 'roster' | 'report'
  | 'find' | 'setup' | 'calls' | 'queue' | 'billing' | 'payroll' | 'floor' | 'gaps'
  | 'sms';

interface NavItem {
  key: Tab;
  /** lucide 组件。⚠️ 不用 emoji —— 见 styles.css 开头那段 */
  Icon: LucideIcon;
  label: string;
  /** 角标取哪个数；undefined = 不显示角标 */
  count?: number;
  /** 角标用警示色（等着的客人、没记完的日子这类「再不管就出事」的） */
  warn?: boolean;
  show: boolean;
}

/**
 * 四组，按**按的频率**分，不按功能分类分。
 *
 * 「当班」是一天按几百次的；「钱」是收工时按的；「管理」是一周按一次的；
 * 「客人」单独一组因为它是随时会插进来的横向动作（电话进来查个人）。
 *
 * 这个分法的检验标准很简单：前台上午十点最忙的时候，
 * 眼睛只需要在第一组里找 —— 后面三组那天可能一次都不点。
 */
function Sidebar({ tab, setTab, canDesk, canReport, canManage, canBill, counts, open, onClose }: {
  tab: Tab;
  setTab: (t: Tab) => void;
  canDesk: boolean; canReport: boolean; canManage: boolean; canBill: boolean;
  counts: { ticket: number; stale: number; queue: number; calls: number; gaps: number; sms: number };
  /** 窄屏（iPad 竖向）下侧栏是抽屉。宽屏常驻，这两个参数不起作用 */
  open: boolean;
  onClose: () => void;
}) {
  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: '运营',
      items: [
        { key: 'overview', Icon: LayoutDashboard, label: '总览', show: true },
        { key: 'turn',   Icon: ListOrdered,   label: '轮牌',     show: true },
        { key: 'queue',  Icon: Armchair,      label: '候客',     count: counts.queue, warn: true, show: true },
        { key: 'day',    Icon: CalendarDays,  label: '日程',     show: true },
        { key: 'floor',  Icon: DoorOpen,      label: '房态',     show: true },
        { key: 'ticket', Icon: Receipt,       label: '进行中工单', count: counts.ticket, show: true },
        { key: 'calls',  Icon: PhoneCall,     label: '来电复核', count: counts.calls, warn: true, show: true },
      ],
    },
    {
      title: '客户',
      items: [
        { key: 'find', Icon: Users, label: '客户档案', show: true },
        // ⚠️ 平时藏起来。这一页只在「有人回了 STOP/CANCEL 而预约还在」时
        // 才有意义 —— 常驻一个永远是 0 的页签只会让侧边栏更长
        { key: 'sms', Icon: MessageSquareWarning, label: '客人短信',
          count: counts.sms, warn: true, show: counts.sms > 0 },
      ],
    },
    {
      title: '财务',
      items: [
        { key: 'earn',   Icon: Wallet, label: '今日营收', show: true },
        { key: 'close',  Icon: Moon,   label: '日结对账', show: canDesk },
        // ⭐ 断档补录（0032）。只在真有没记完的日子时才出现 ——
        // 一个常年挂着 0 的入口，前台第二周就不看了
        { key: 'gaps',   Icon: FileWarning, label: '待补录',  count: counts.gaps, warn: true, show: canDesk && counts.gaps > 0 },
        { key: 'report', Icon: BarChart3,   label: '经营报表', show: canReport },
      ],
    },
    {
      title: '设置',
      items: [
        { key: 'roster',  Icon: CalendarClock, label: '排班',     show: true },
        { key: 'setup',   Icon: Settings2,     label: '门店设置', show: canManage },
        { key: 'payroll', Icon: Percent,       label: '薪酬方案', show: canManage },
        { key: 'billing', Icon: CreditCard,    label: '订阅账户', show: canBill },
      ],
    },
  ];

  return (
    <>
      <div className={`side-scrim${open ? ' open' : ''}`} onClick={onClose} aria-hidden />
      <aside className={`side${open ? ' open' : ''}`}>
      <div className="side-brand">
        <div className="mark">G</div>
        <strong className="name" style={{ fontSize: 'var(--text-lg)', letterSpacing: '-.02em' }}>
          GenieFront
        </strong>
      </div>

      {groups.map((g) => {
        const items = g.items.filter((i) => i.show);
        if (items.length === 0) return null;
        return (
          <div key={g.title}>
            <div className="side-group">{g.title}</div>
            {items.map((i) => (
              <button
                key={i.key}
                className={`side-item${tab === i.key ? ' on' : ''}`}
                onClick={() => { setTab(i.key); onClose(); }}
                title={i.label}
                aria-current={tab === i.key ? 'page' : undefined}
              >
                <i.Icon size={22} aria-hidden />
                <span className="lbl">{i.label}</span>
                {/* 角标只在有数时出现。写死的角标处理完不会变，比没有更糟 */}
                {!!i.count && (
                  <span className={`n${i.warn ? ' n-warn' : ''}`}>{i.count}</span>
                )}
              </button>
            ))}
          </div>
        );
      })}

      {/* 隔夜单是「挡住封账的那个东西」，挂在「在做的单」下面说清楚 */}
      {counts.stale > 0 && (
        <div className="side-foot">
          <button className="btn btn-sm btn-block" onClick={() => { setTab('ticket'); onClose(); }}
                  title={`${counts.stale} 张跨日未结工单，会阻断日结`}
                  style={{
                    background: 'var(--warn-soft)', color: 'var(--warn)',
                    borderColor: 'transparent', justifyContent: 'flex-start',
                  }}>
            <AlertTriangle size={17} aria-hidden />
            <span className="lbl">{counts.stale} 张跨日未结</span>
          </button>
        </div>
      )}
      </aside>
    </>
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
