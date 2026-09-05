import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Users,
  DollarSign,
  CalendarCheck,
  Activity,
  Receipt,
  ArrowRight,
  Clock,
  RefreshCw,
  Star,
  Sparkles,
  BedDouble,
  AlertTriangle,
  Award,
  MessageSquare,
  Bot,
  ThumbsUp,
  Search,
  PhoneCall,
  ArrowUpRight,
  Plus,
  CreditCard,
  UserCheck,
  Play,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  TrendingUp,
  Shield,
  HelpCircle,
  Copy,
  Check,
} from 'lucide-react';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { useDayCloseQuery } from '@/features/dayclose/api';
import { useRotationQuery } from '@/features/rotation/api';
import { useQueue } from '@/features/queue/api';
import { useDaySnapshot } from '@/features/schedule/api';
import { useRoomsQuery } from '@/features/rooms/api';
import { useReviewsSummaryQuery } from '@/features/analytics/api';
import { useNotificationsQuery, useMarkNotificationRead } from '@/features/notifications/api';
import { useCallsQuery } from '@/features/comms/api';
import { useTicketsList } from '@/features/tickets/api';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { EmptyState } from '@/components/ui/EmptyState';
import { ReviewConfidenceBadge } from '@/features/reviews/ReviewSourcesPanel';
import { formatI18n } from '@/lib/utils';
import { pickText } from '@gf/contracts';
import { useSession } from '@/lib/session';
import { instantToWallDate, shiftDate, formatIsoWallClock } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { CustomerReviewItem } from './DashboardReviewsData';
import { useBusinessDay } from '@/lib/time';

export function DashboardContent() {
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const { context, membership } = useSession();
  const timezone = context?.timezone || 'America/New_York';

  // 选中的营业日期（默认今天，支持切换查看昨天/明天）。
  // ⚠️ 「今天」是**营业日**，不是日历日 —— 凌晨的单还属于昨晚那一场（AUD-13）。
  const { today: realTodayStr } = useBusinessDay();
  const [selectedDate, setSelectedDate] = useState<string>(realTodayStr);
  useEffect(() => {
    // 会话就绪后把默认日期对齐到营业日；用户已经手动翻过页就不动它
    if (realTodayStr && !selectedDate) setSelectedDate(realTodayStr);
  }, [realTodayStr, selectedDate]);

  const isToday = selectedDate === realTodayStr;

  // 核心业务数据 Query (全部对接后端真实 API)
  const {
    data: dayData,
    isLoading: scheduleLoading,
    isError: scheduleError,
    error: scheduleErr,
    refetch: refetchSchedule,
  } = useDaySnapshot(selectedDate);

  const {
    data: dayCloseData,
    isLoading: dayCloseLoading,
    isError: dayCloseError,
    error: dayCloseErr,
    refetch: refetchDayClose,
  } = useDayCloseQuery(selectedDate);

  const { data: queueData, isLoading: queueLoading, refetch: refetchQueue } = useQueue();
  const { data: rotationData, isLoading: rotationLoading, refetch: refetchRotation } = useRotationQuery();
  const { data: roomsData, refetch: refetchRooms } = useRoomsQuery();
  const { data: reviewsData, refetch: refetchReviews } = useReviewsSummaryQuery();
  const { data: urgentNotifications = [], refetch: refetchNotifs } = useNotificationsQuery({ unreadOnly: true });
  const { data: callsData, refetch: refetchCalls } = useCallsQuery(1);
  const { data: openTicketsData, refetch: refetchTickets } = useTicketsList('open');

  const markNotifReadMutation = useMarkNotificationRead();

  // 中部主工作台 Tab: 'schedule' (预约时间轴) | 'queue' (大堂候客派工) | 'tickets' (Open / Unpaid单)
  const [activeOpsTab, setActiveOpsTab] = useState<'schedule' | 'queue' | 'tickets'>('schedule');

  // 口碑评价弹窗 & 搜索
  const [selectedReviewModal, setSelectedReviewModal] = useState<CustomerReviewItem | null>(null);
  const [reviewSearch, setReviewSearch] = useState('');
  const [copiedReviewId, setCopiedReviewId] = useState<string | null>(null);

  // 快速派工弹窗
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false);
  const [dispatchTargetQueueItem, setDispatchTargetQueueItem] = useState<any | null>(null);

  // 全局两步确认弹窗
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    description: string;
    tone?: 'default' | 'danger';
    confirmLabel?: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    description: '',
    onConfirm: () => {},
  });

  const isInitialLoading =
    scheduleLoading && dayCloseLoading && queueLoading && !dayData && !dayCloseData;

  const currentStoreName = membership ? pickText(membership.locationName, language) : '—';

  // 刷新全部看板
  const handleRefreshAll = async () => {
    await Promise.all([
      refetchSchedule(),
      refetchDayClose(),
      refetchQueue(),
      refetchRotation(),
      refetchRooms(),
      refetchReviews(),
      refetchNotifs(),
      refetchCalls(),
      refetchTickets(),
    ]);
    toast.success(t('finance.dashRefreshed'));
  };

  // 复制好评文案函数（真实写入剪贴板）
  const handleCopyReviewText = async (rev: CustomerReviewItem) => {
    try {
      const stars = '⭐'.repeat(Math.round(rev.rating));
      const technicianPart = rev.technicianName
        ? t('finance.dashReviewShareTechnicianPart', { name: rev.technicianName })
        : '';
      const formattedText = t('finance.dashReviewShareTemplate', {
        stars, platform: rev.platformLabel, timeAgo: rev.timeAgo, customer: rev.customerName,
        service: rev.serviceName, technicianPart, content: rev.content,
        highlights: rev.highlights.join(' · '),
      });
      
      await navigator.clipboard.writeText(formattedText);
      setCopiedReviewId(rev.id);
      toast.success(t('finance.dashReviewCopied'));
      setTimeout(() => setCopiedReviewId(null), 3000);
    } catch {
      toast.danger(t('finance.dashClipboardBlocked'));
    }
  };

  // Staff & Room name lookup maps
  const staffMap = useMemo(() => {
    const map = new Map<string, string>();
    (dayData?.staff ?? []).forEach((s) => map.set(s.membershipId, s.name));
    return map;
  }, [dayData]);

  const resourceMap = useMemo(() => {
    const map = new Map<string, string>();
    (dayData?.resources ?? []).forEach((r) => map.set(r.id, r.name));
    return map;
  }, [dayData]);

  // 数据指标计算
  const apptItems = dayData?.items ?? [];
  const apptCount = apptItems.length;
  const completedAppts = apptItems.filter((i) => i.status === 'done' || i.status === 'completed').length;
  const inServiceAppts = apptItems.filter((i) => i.status === 'in_service').length;
  const bookedAppts = apptItems.filter((i) => i.status === 'booked' || i.status === 'checked_in').length;

  const netCents = dayCloseData?.money?.netCents ?? 0;
  const tipsCents = (dayCloseData?.money?.tipCashCents ?? 0) + (dayCloseData?.money?.tipCardCents ?? 0);

  const waitingQueue = queueData?.waiting ?? [];
  const queueCount = waitingQueue.length;

  const rotationEntries = rotationData?.entries ?? [];
  const activeStaffCount = rotationEntries.filter((s) => s.state === 'available' || s.state === 'in_service').length;
  const nextStaff =
    rotationEntries.find((s) => s.membershipId === rotationData?.nextUpMembershipId) || rotationEntries[0];

  const roomsList = roomsData?.rooms ?? [];
  const availableRoomsCount = roomsList.filter((r) => r.status === 'available').length;
  const occupiedRoomsCount = roomsList.filter((r) => r.status === 'in_service').length;
  const cleaningRoomsCount = roomsList.filter((r) => r.status === 'cleaning').length;

  const openTicketsList = openTicketsData?.tickets ?? [];

  const callsList = callsData?.calls ?? [];
  const autoBookedCalls = callsData?.bookedCount ?? callsList.filter((c) => c.booked).length;

  const centsToDollars = (c: number) => (c / 100).toFixed(2);

  // 评价数据只来自后端；无数据时保留明确空态所需的零值。
  const reviewsSummary = useMemo(() => {
    return {
      overallScore: reviewsData?.overallScore ?? 0,
      totalReviewCount: reviewsData?.totalReviewCount ?? 0,
      satisfactionRate: reviewsData?.satisfactionRate ?? 0,
      aiSummary: {
        overview: formatI18n(reviewsData?.aiSummary?.overview, language),
        /**
         * ⚠️ 可信度必须跟着结论一起显示（05 §8.3）。
         *
         * 一份由三条被平台截断的评价归纳出来的建议，和三十条完整评价归纳出来的
         * 在页面上长得一模一样 —— 老板按前者去改排班，代价是真实的。
         */
        confidence: reviewsData?.aiSummary?.confidence ?? null,
        topKeywords: reviewsData?.aiSummary?.topKeywords ?? [],
        topStaff: reviewsData?.aiSummary?.topStaff ?? [],
        actionableSuggestions: reviewsData?.aiSummary?.actionableSuggestions ?? [],
      },
      recentReviews: (reviewsData?.recentReviews ?? []).map((r: any) => {
        const customerName = formatI18n(r.customerName, language);
        const platform = r.platform === 'yelp' || r.platform === 'in_store' || r.platform === 'redbook'
          ? r.platform
          : 'google';
        return {
          id: r.id,
          customerName,
          avatarText: customerName.slice(0, 2).toUpperCase(),
          rating: r.rating ?? 0,
          platform,
          platformLabel: platform === 'google' ? 'Google' : platform === 'yelp' ? 'Yelp' : platform === 'redbook' ? 'Redbook' : t('finance.dashInStoreReview'),
          timeAgo: formatI18n(r.timeAgo, language),
          technicianName: formatI18n(r.technicianName, language) || undefined,
          serviceName: formatI18n(r.serviceName, language),
          content: formatI18n(r.content, language),
          sentiment: r.rating >= 4 ? 'positive' as const : r.rating >= 3 ? 'neutral' as const : 'suggestion' as const,
          sentimentTag: formatI18n(r.sentimentTag, language),
          highlights: r.highlights ?? [],
        };
      }),
    };
  }, [reviewsData, language]);

  // 评价搜索
  const filteredRecentReviews = useMemo(() => {
    if (!reviewSearch.trim()) return reviewsSummary.recentReviews;
    return fuzzySearch(reviewsSummary.recentReviews, reviewSearch, {
      keys: [
        { name: 'customerName', weight: 0.4 },
        { name: 'content', weight: 0.35 },
        { name: 'serviceName', weight: 0.25 },
        { name: 'technicianName', weight: 0.2 },
      ],
      threshold: 0.45,
    });
  }, [reviewsSummary.recentReviews, reviewSearch]);

  if (isInitialLoading) {
    return <PageLoading title={t('finance.dashLoading')} description={t('finance.dashLoadingDesc')} />;
  }

  if (scheduleError && !dayData) {
    return (
      <PageError
        title={t('finance.dashLoadError')}
        error={scheduleErr}
        onRetry={handleRefreshAll}
      />
    );
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-7xl space-y-5 pb-12">
      {/* ── 1. 顶部营业全景控制条 (Hero Ribbon，无冗余新建预约按钮) ──────────── */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-[var(--gf-shadow)] lg:flex-row lg:items-center">
        <div className="space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
              {currentStoreName}  {t('finance.dashHeaderSuffix')}
            </h1>
            <Badge variant="default" className="gap-1.5 font-bold">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>{t('finance.dashOpenNow')}</span>
            </Badge>
          </div>
          <p className="text-sm text-slate-500">
            <span>{t('finance.dashTimezone')} <strong>{timezone}</strong></span>
          </p>
        </div>

        {/* 日期选择与高频操作 */}
        <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto justify-start lg:justify-end">
          {/* 日期快速切换 */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs font-bold shrink-0">
            <button
              type="button"
              onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}
              className="p-1.5 rounded-lg hover:bg-white text-slate-600 transition-colors"
              title={t('finance.dashPrevDay')}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 text-slate-800 font-mono">
              {isToday ? t('finance.dashToday', { p0: selectedDate }) : selectedDate}
            </span>
            <button
              type="button"
              onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}
              className="p-1.5 rounded-lg hover:bg-white text-slate-600 transition-colors"
              title={t('finance.dashNextDay')}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            {!isToday && (
              <button
                type="button"
                onClick={() => setSelectedDate(realTodayStr)}
                className="ml-1 px-2 py-1 rounded-lg bg-teal-600 text-white text-[10px] font-bold"
              >
                
                {t('finance.dashBackToToday')}
              </button>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent('open-copilot'))}
            className="text-purple-900 bg-purple-50 hover:bg-purple-100 border-purple-200 rounded-xl text-xs font-bold gap-1.5"
          >
            <Sparkles className="w-4 h-4 text-purple-600" />
            <span>{t('finance.dashCopilot')}</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshAll}
            className="rounded-xl text-xs font-bold gap-1.5 border-slate-200"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-600" />
            <span>{t('finance.dashRefresh')}</span>
          </Button>

          <Button
            size="sm"
            onClick={() => navigate('/checkout')}
            className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold gap-1.5 shadow-sm"
          >
            <CreditCard className="w-4 h-4" />
            <span>{t('finance.dashCheckoutDesk')}</span>
          </Button>
        </div>
      </div>

      {/* ── 2. 四大核心经营与履约实时仪表盘 (4 KPI Core Gauges) ───────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 卡片 1: 今日预约与履约率 */}
        <Card
          onClick={() => navigate('/schedule')}
          className="p-5 bg-white border-slate-200 hover:border-teal-400 hover:shadow-md transition-all cursor-pointer rounded-2xl space-y-3 group"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
            <span>{t('finance.dashApptTitle')}</span>
            <div className="p-2 rounded-xl bg-teal-50 text-teal-600 group-hover:scale-110 transition-transform">
              <CalendarCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-3xl font-black text-slate-900 font-mono">{apptCount}</span>
            <span className="text-[11px] font-bold text-teal-800 bg-teal-50 px-2 py-0.5 rounded-full border border-teal-200">
              
              {t('finance.dashFulfilmentRate')} {apptCount > 0 ? Math.round((completedAppts / apptCount) * 100) : 0}%
            </span>
          </div>
          {/* 进度条 */}
          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden flex">
            <div
              style={{ width: `${apptCount > 0 ? (completedAppts / apptCount) * 100 : 0}%` }}
              className="bg-emerald-500 h-full"
              title={`${t('finance.dashDone')}: ${completedAppts}`}
            />
            <div
              style={{ width: `${apptCount > 0 ? (inServiceAppts / apptCount) * 100 : 0}%` }}
              className="bg-sky-500 h-full"
              title={t('finance.dashInServiceCount', { p0: inServiceAppts })}
            />
            <div
              style={{ width: `${apptCount > 0 ? (bookedAppts / apptCount) * 100 : 0}%` }}
              className="bg-amber-400 h-full"
              title={t('finance.dashPendingCount', { p0: bookedAppts })}
            />
          </div>
          <div className="text-[11px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-100">
            <span>{t('finance.dashDone')} <strong className="text-emerald-700 font-mono">{completedAppts}</strong></span>
            <span>{t('finance.dashInService')} <strong className="text-sky-700 font-mono">{inServiceAppts}</strong></span>
            <span>{t('finance.dashExpected')} <strong className="text-amber-700 font-mono">{bookedAppts}</strong></span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-600 transition-colors" />
          </div>
        </Card>

        {/* 卡片 2: 今日营业实收净额 */}
        <Card
          onClick={() => navigate('/checkout')}
          className="p-5 bg-white border-slate-200 hover:border-emerald-400 hover:shadow-md transition-all cursor-pointer rounded-2xl space-y-3 group"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
            <span>{t('finance.dashNetRevenue')}</span>
            <div className="p-2 rounded-xl bg-emerald-50 text-emerald-600 group-hover:scale-110 transition-transform">
              <DollarSign className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-3xl font-black text-emerald-800 font-mono">
              ${centsToDollars(netCents)}
            </span>
            <span className="text-[11px] font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
              
              {t('finance.dashAvgTicket')}{completedAppts > 0 ? centsToDollars(Math.round(netCents / completedAppts)) : '0.00'}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-100">
            <span>{t('finance.dashTips')} <strong className="text-slate-800 font-mono">${centsToDollars(tipsCents)}</strong></span>
            <span>{t('finance.dashUnpaid')} <strong className="text-rose-600 font-mono">{openTicketsList.length}  {t('finance.dashUnpaidUnit')}</strong></span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-600 transition-colors" />
          </div>
        </Card>

        {/* 卡片 3: 大堂候客与包厢周转 */}
        <Card
          onClick={() => navigate('/queue')}
          className="p-5 bg-white border-slate-200 hover:border-amber-400 hover:shadow-md transition-all cursor-pointer rounded-2xl space-y-3 group"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
            <span>{t('finance.dashLobbyTitle')}</span>
            <div className="p-2 rounded-xl bg-amber-50 text-amber-600 group-hover:scale-110 transition-transform">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-3xl font-black text-amber-900 font-mono">
              {queueCount} <span className="text-sm font-bold text-slate-400">{t('finance.dashGroupsWaiting')}</span>
            </span>
            <span className="text-[11px] font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
              
              {t('finance.dashRoomsPrefix')} {availableRoomsCount}/{roomsList.length}  {t('finance.dashRoomsAvailable')}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-100">
            <span>{t('finance.dashRoomsBusy')} <strong className="text-sky-700 font-mono">{occupiedRoomsCount}</strong></span>
            <span>{t('finance.dashRoomsCleaning')} <strong className="text-amber-700 font-mono">{cleaningRoomsCount}</strong></span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-amber-600 transition-colors" />
          </div>
        </Card>

        {/* 卡片 4: 在岗技师与轮牌态势 */}
        <Card
          onClick={() => navigate('/rotation')}
          className="p-5 bg-white border-slate-200 hover:border-blue-400 hover:shadow-md transition-all cursor-pointer rounded-2xl space-y-3 group"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-bold uppercase tracking-wider">
            <span>{t('finance.dashStaffTitle')}</span>
            <div className="p-2 rounded-xl bg-blue-50 text-blue-600 group-hover:scale-110 transition-transform">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-3xl font-black text-slate-900 font-mono">
              {activeStaffCount}{' '}
              <span className="text-sm font-normal text-slate-400">/ {rotationEntries.length}  {t('finance.dashStaffOnDuty')}</span>
            </span>
            <span className="text-[11px] font-bold text-blue-800 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">
              
              {t('finance.dashReadyRate')} {rotationEntries.length > 0 ? Math.round((activeStaffCount / rotationEntries.length) * 100) : 100}%
            </span>
          </div>
          <div className="text-[11px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-100">
            <span>{t('finance.dashNextInRotation')} <strong className="text-teal-800 font-bold">{nextStaff?.name || t('finance.dashNone')}</strong></span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-600 transition-colors" />
          </div>
        </Card>
      </div>

      {/* ── 3. 中部：今日调度流水线 (2/3) + AI/通信/包厢雷达 (1/3) ──────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── 左侧 2/3: 今日业务调度主战台 ───────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="bg-white border-slate-200 shadow-sm rounded-2xl overflow-hidden">
            {/* Ops Sub-Tabs Header */}
            <div className="p-4 bg-slate-50/70 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setActiveOpsTab('schedule')}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
                    activeOpsTab === 'schedule'
                      ? 'bg-teal-600 text-white shadow-xs'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                  }`}
                >
                  <CalendarCheck className="w-3.5 h-3.5" />
                  <span>{t('finance.dashTimelineTab')}{apptCount})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveOpsTab('queue')}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
                    activeOpsTab === 'queue'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>{t('finance.dashLobbyTab')}{queueCount})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveOpsTab('tickets')}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${
                    activeOpsTab === 'tickets'
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                  }`}
                >
                  <Receipt className="w-3.5 h-3.5" />
                  <span>{t('finance.dashTicketsTab')}{openTicketsList.length})</span>
                </button>
              </div>

              <span className="text-xs text-slate-400 font-medium">
                {activeOpsTab === 'schedule' ? t('finance.dashTimelineHint') : activeOpsTab === 'queue' ? t('finance.dashLobbyHint') : t('finance.dashTicketsHint')}
              </span>
            </div>

            <CardContent className="p-5">
              <AnimatePresence mode="wait">
                {/* ── TAB A: 今日预约时间轴 ─────────────────────────────────── */}
                {activeOpsTab === 'schedule' && (
                  <motion.div
                    key="tab-schedule"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-3"
                  >
                    {apptItems.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-400 space-y-2">
                        <CalendarCheck className="w-8 h-8 text-slate-300 mx-auto" />
                        <p>{t('finance.dashNoAppts')}</p>
                        <Button
                          size="sm"
                          onClick={() => navigate('/schedule')}
                          className="bg-teal-600 text-white text-xs font-bold rounded-xl"
                        >
                          
                          {t('finance.dashGoToSchedule')}
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
                        {apptItems.map((item) => {
                          const staffName = item.membershipId ? (staffMap.get(item.membershipId) || t('finance.dashStaffAssigned')) : t('finance.dashStaffPending');
                          const roomName = item.resourceId ? (resourceMap.get(item.resourceId) || t('finance.dashRoomAssigned')) : t('finance.dashRoomLobby');

                          const statusColor =
                            item.status === 'done'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                              : item.status === 'in_service'
                              ? 'bg-sky-50 border-sky-200 text-sky-800'
                              : item.status === 'booked'
                              ? 'bg-white border-slate-200 text-slate-800'
                              : 'bg-slate-100 border-slate-200 text-slate-400';

                          return (
                            <div
                              key={item.itemId}
                              className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-3 ${statusColor} hover:shadow-xs`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="text-center font-mono shrink-0 w-14">
                                  <strong className="text-xs font-bold block text-slate-900">
                                    {item.startsAt ? formatIsoWallClock(item.startsAt, timezone) : '00:00'}
                                  </strong>
                                  <span className="text-[10px] text-slate-400">
                                    {item.endsAt ? formatIsoWallClock(item.endsAt, timezone) : '00:00'}
                                  </span>
                                </div>

                                <div className="h-8 w-px bg-slate-200 shrink-0" />

                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <strong className="text-xs font-bold text-slate-900 truncate">
                                      {item.customerName || t('customer')}
                                    </strong>
                                    {item.isRequest && <Badge variant="warning" className="text-[9px]">{t('requestCount')}</Badge>}
                                    <span className="px-2 py-0.2 rounded-full text-[10px] font-bold bg-white/80 border border-slate-200">
                                      {item.serviceName || t('service')}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-slate-500">
                                    {t('staff')}: <strong className="text-teal-700">{staffName}</strong> · {t('rooms')}: {roomName}
                                  </p>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                {item.status === 'booked' && (
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      setConfirmDialog({
                                        isOpen: true,
                                        title: t('finance.dashCheckInConfirmTitle', { p0: item.customerName }),
                                        description: t('finance.dashCheckInConfirmBody'),
                                        confirmLabel: t('finance.dashCheckInConfirmAction'),
                                        onConfirm: () => {
                                          toast.success(t('finance.dashCheckedIn'));
                                          void refetchSchedule();
                                        },
                                      });
                                    }}
                                    className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold"
                                  >
                                    <UserCheck className="w-3.5 h-3.5" />
                                    <span>{t('checkIn')}</span>
                                  </Button>
                                )}

                                {item.status === 'in_service' && (
                                  <Button
                                    size="sm"
                                    onClick={() => navigate(`/checkout`)}
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold"
                                  >
                                    <CreditCard className="w-3.5 h-3.5" />
                                    <span>{t('goToCheckout')}</span>
                                  </Button>
                                )}

                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => navigate('/schedule')}
                                  className="text-xs text-slate-500 rounded-xl"
                                >{t('details')}</Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* ── TAB B: 大堂候客派工台 ─────────────────────────────────── */}
                {activeOpsTab === 'queue' && (
                  <motion.div
                    key="tab-queue"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-3"
                  >
                    {waitingQueue.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-400 space-y-2">
                        <Users className="w-8 h-8 text-slate-300 mx-auto" />
                        <p>{t('noWaitlistGuests')}</p>
                        <Button
                          size="sm"
                          onClick={() => navigate('/queue')}
                          className="bg-amber-600 text-white text-xs font-bold rounded-xl"
                        >
                          {t('registerWalkin')}
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
                        {waitingQueue.map((q, idx) => (
                          <div
                            key={q.queueId}
                            className="p-4 rounded-2xl border border-amber-200/80 bg-amber-50/40 flex items-center justify-between gap-4"
                          >
                            <div className="flex items-center gap-3">
                              <span className="w-7 h-7 rounded-xl bg-amber-200 text-amber-950 font-black text-xs flex items-center justify-center">
                                #{q.ticketNumber || idx + 1}
                              </span>
                              <div>
                                <div className="flex items-center gap-2">
                                  <strong className="text-xs font-bold text-slate-900">{q.displayName}</strong>
                                  <span className="text-[10px] text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full font-bold">
                                    {q.partySize || 1} {t('guestsCountSuffix')}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  
                                  {t('finance.dashApptService')} <strong>{q.serviceName || t('finance.dashFootTherapy')}</strong>  {t('finance.dashWaitedFor')} <span className="font-mono text-rose-600 font-bold">{q.waitedMin || 6}  {t('finance.dashWaitMinutes')}</span>
                                </p>
                              </div>
                            </div>

                            <Button
                              size="sm"
                              onClick={() => {
                                setDispatchTargetQueueItem(q);
                                setDispatchModalOpen(true);
                              }}
                              className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold gap-1"
                            >
                              <span>{t('assignStation')}</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* ── TAB C: Open / Unpaid单 ───────────────────────────────────────── */}
                {activeOpsTab === 'tickets' && (
                  <motion.div
                    key="tab-tickets"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="space-y-3"
                  >
                    {openTicketsList.length === 0 ? (
                      <div className="py-12 text-center text-xs text-slate-400 space-y-2">
                        <Receipt className="w-8 h-8 text-slate-300 mx-auto" />
                        <p>{t('noPendingTickets')}</p>
                      </div>
                    ) : (
                      <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
                        {openTicketsList.map((tk) => (
                          <div
                            key={tk.ticketId}
                            className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 flex items-center justify-between gap-4 hover:bg-slate-50"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <strong className="text-xs font-bold text-slate-900 font-mono">
                                  #{tk.ticketId.slice(0, 8)}
                                </strong>
                                <span className="text-xs font-bold text-slate-800">{tk.customerName || 'Walk-in Guest'}</span>
                                <Badge variant="warning">{t('pendingPayment')}</Badge>
                              </div>
                              <p className="text-[11px] text-slate-500">
                                
                                {t('finance.dashItemCount')} {tk.items?.length || 1}  {t('finance.dashItemSep')} {tk.items?.map((it) => it.name).join(' + ') || t('finance.dashWalkInSpend')}
                              </p>
                            </div>

                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <span className="text-sm font-black font-mono text-slate-900 block">
                                  ${centsToDollars(tk.subtotalCents || 0)}
                                </span>
                                <span className="text-[10px] text-slate-400">{t('amountDue')}</span>
                              </div>
                              <Button
                                size="sm"
                                onClick={() => navigate('/checkout')}
                                className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold gap-1"
                              >
                                <span>{t('checkoutNow')}</span>
                                <CreditCard className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </CardContent>
          </Card>
        </div>

        {/* ── 右侧 1/3: AI 电话雷达 + 待办预警 + 包厢微缩平面 ─────────────── */}
        <div className="space-y-4">
          {/* AI 电话接待与语音雷达 */}
          <Card className="bg-gradient-to-br from-purple-900 via-indigo-900 to-slate-950 text-white shadow-lg rounded-2xl p-4 space-y-3 relative overflow-hidden">
            <div className="absolute right-0 top-0 opacity-10 pointer-events-none">
              <PhoneCall className="w-48 h-48 text-white transform translate-x-8 -translate-y-8" />
            </div>

            <div className="flex items-center justify-between relative z-10">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-xl bg-purple-500/30 text-purple-200">
                  <Bot className="w-4 h-4" />
                </div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-purple-200">
                  {t('aiPhoneRadar')}
                </h3>
              </div>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            </div>

            <div className="grid grid-cols-2 gap-2 relative z-10">
              <div className="p-2.5 rounded-xl bg-white/10 border border-white/10">
                <span className="text-[10px] text-purple-200 block">{t('todayAiCalls')}</span>
                <span className="text-xl font-black font-mono text-white">{callsList.length}  {t('finance.dashCallsUnit')}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-white/10 border border-white/10">
                <span className="text-[10px] text-purple-200 block">{t('autoBookedCalls')}</span>
                <span className="text-xl font-black font-mono text-emerald-300">{autoBookedCalls}  {t('finance.dashSmsUnit')}</span>
              </div>
            </div>

            <div className="pt-2 border-t border-white/10 flex items-center justify-between text-xs relative z-10">
              <span className="text-[11px] text-purple-200">{t('finance.dashTelnyxRunning')}</span>
              <button
                type="button"
                onClick={() => navigate('/calls')}
                className="text-xs font-bold text-white hover:underline flex items-center gap-1"
              >
                <span>{t('callLogs')}</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </Card>

          {/* 实时高优先级通知预警待办 */}
          <Card className="bg-white border-slate-200 shadow-sm rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  {t('urgentAlerts')} ({urgentNotifications.length})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => navigate('/notifications')}
                className="text-[11px] font-bold text-teal-700 hover:underline"
              >
                {t('allNotifications')} →
              </button>
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
              {urgentNotifications.length === 0 ? (
                <p className="text-center py-6 text-xs text-slate-400">{t('noUrgentAlerts')}</p>
              ) : (
                urgentNotifications.slice(0, 3).map((n) => (
                  <div
                    key={n.id}
                    className="p-2.5 rounded-xl border border-slate-100 bg-slate-50/60 hover:bg-slate-50 transition-colors space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <strong className="text-xs text-slate-900 font-bold truncate">{n.title}</strong>
                      <span className="text-[10px] text-slate-400 font-mono">{t('justNow')}</span>
                    </div>
                    <p className="text-[11px] text-slate-600 line-clamp-2">{n.message}</p>
                    {n.actionUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          markNotifReadMutation.mutate({ notificationId: n.id });
                          navigate(n.actionUrl!);
                        }}
                        className="text-[10px] font-bold text-teal-700 hover:underline flex items-center gap-0.5 pt-0.5"
                      >
                        <span>{t('handleItem')}</span>
                        <ArrowUpRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* 包厢工位微缩平面态势 */}
          <Card className="bg-white border-slate-200 shadow-sm rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BedDouble className="w-4 h-4 text-teal-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  {t('roomStationStatus')} ({roomsList.length})
                </h3>
              </div>
              <button
                type="button"
                onClick={() => navigate('/rooms')}
                className="text-[11px] font-bold text-teal-700 hover:underline"
              >
                {t('viewRoomMap')} →
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {roomsList.map((room) => {
                const isAvail = room.status === 'available';
                const isBusy = room.status === 'in_service';
                const isClean = room.status === 'cleaning';

                return (
                  <div
                    key={room.id}
                    className={`p-2 rounded-xl border text-center space-y-0.5 transition-all ${
                      isAvail
                        ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                        : isBusy
                        ? 'bg-sky-50/70 border-sky-200 text-sky-950'
                        : isClean
                        ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                        : 'bg-slate-100 border-slate-200 text-slate-400'
                    }`}
                  >
                    <strong className="text-xs font-bold block truncate">{room.name}</strong>
                    <span className="text-[10px] block font-medium opacity-80">
                      {isAvail ? t('statusAvail') : isBusy ? t('statusBusy') : isClean ? t('statusCleaning') : t('statusPaused')}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      {/* ── 4. 底部：全渠道顾客口碑评价与 AI 经营洞察 (紧凑无空白排版) ────────── */}
      <Card className="p-6 bg-white border-slate-200 shadow-sm rounded-3xl space-y-5">
        {reviewsSummary.totalReviewCount === 0 ? (
          <EmptyState
            icon={<Star />}
            title={t('finance.dashNoReviews')}
            description={t('finance.dashNoReviewsDesc')}
          />
        ) : (
          <>
        {/* 口碑区 Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-slate-100">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-xl bg-amber-50 text-amber-600">
                <Star className="w-5 h-5 fill-amber-400 text-amber-400" />
              </div>
              <h3 className="text-base font-black text-slate-900 tracking-tight">
                {t('reviewsSummaryTitle')}
              </h3>
              <Badge variant="secondary" className="text-[10px] bg-purple-50 text-purple-900 border-purple-200 font-bold flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-purple-600" />
                <span>{t('finance.dashReviewsTitle')}</span>
              </Badge>
            </div>
            <p className="text-xs text-slate-500">
              
              {t('finance.dashReviewsDesc')}
            </p>
          </div>

          {/* 综合口碑得分 */}
          <div className="flex items-center gap-4 bg-amber-50/70 p-2.5 rounded-2xl border border-amber-200/80 shrink-0">
            <div className="text-right">
              <span className="text-[10px] font-bold text-amber-900 uppercase block">{t('omnichannelScore')}</span>
              <span className="text-[11px] text-amber-700 font-medium">
                
                {t('finance.dashBasedOn')} {reviewsSummary.totalReviewCount}  {t('finance.dashRealReviews')}
              </span>
            </div>
            <div className="flex items-center gap-1.5 pl-3 border-l border-amber-300">
              <span className="text-2xl font-black font-mono text-amber-900">
                {reviewsSummary.overallScore}
              </span>
              <div className="flex flex-col items-start">
                <div className="flex text-amber-400">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className="w-3 h-3 fill-amber-400 text-amber-400" />
                  ))}
                </div>
                <span className="text-[9px] font-bold text-emerald-700 font-mono">
                  
                  {t('finance.dashPositiveRate')} {reviewsSummary.satisfactionRate}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* AI 月度口碑综述横幅 */}
        <div className="p-3.5 bg-gradient-to-r from-purple-50/90 via-purple-50/50 to-teal-50/60 rounded-2xl border border-purple-200/80 space-y-1">
          <div className="flex items-center gap-1.5 font-bold text-purple-950 text-xs">
            <Sparkles className="w-3.5 h-3.5 text-purple-600" />
            <span>{t('finance.dashAiSummary')}</span>
            <ReviewConfidenceBadge confidence={reviewsSummary.aiSummary.confidence} />
          </div>
          <p className="text-xs text-purple-900 leading-relaxed font-medium">
            {reviewsSummary.aiSummary.overview}
          </p>
        </div>

        {/* 紧凑左右 1:1 双列：紧密排版，无任何拉伸空隙 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          {/* 左列：高频词云 + 经营洞察 */}
          <div className="space-y-3.5">
            {/* 高频正向赞誉词云 */}
            <div className="space-y-1.5">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                
                {t('finance.dashTopMentions')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {reviewsSummary.aiSummary.topKeywords.map((kw) => (
                  <span
                    key={kw.tag}
                    className={cn(
                      'px-2.5 py-1 rounded-xl text-xs font-bold transition-all flex items-center gap-1 shadow-xs',
                      kw.sentiment === 'positive'
                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100/70'
                        : 'bg-amber-50 text-amber-900 border border-amber-200 hover:bg-amber-100/70',
                    )}
                  >
                    <span>{kw.tag}</span>
                    <span className="font-mono text-[10px] opacity-80">({kw.count})</span>
                  </span>
                ))}
              </div>
            </div>

            {/* AI 智能经营洞察与优化建议 */}
            <div className="space-y-2 pt-1">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                
                {t('finance.dashActionableInsights')}
              </span>
              <div className="space-y-2">
                {reviewsSummary.aiSummary.actionableSuggestions.map((sug, i) => (
                  <div
                    key={i}
                    className={cn(
                      'p-2.5 rounded-2xl border text-xs flex items-start gap-2.5 transition-all',
                      sug.type === 'warning'
                        ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                        : sug.type === 'tip'
                        ? 'bg-sky-50/70 border-sky-200 text-sky-950'
                        : 'bg-emerald-50/70 border-emerald-200 text-emerald-950',
                    )}
                  >
                    <div className="mt-0.5 shrink-0">
                      {sug.type === 'warning' && <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />}
                      {sug.type === 'tip' && <Sparkles className="w-3.5 h-3.5 text-sky-600" />}
                    </div>
                    <div>
                      <h5 className="font-bold text-xs">{sug.title}</h5>
                      <p className="text-[11px] mt-0.5 leading-relaxed opacity-90">{sug.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 右列：技师好评榜 TOP 3 */}
          <div className="space-y-2.5 bg-slate-50/70 p-3.5 rounded-2xl border border-slate-200">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <Award className="w-4 h-4 text-amber-500" />
                <span>{t('topTechnicians')}</span>
              </span>
              <span className="text-[10px] text-slate-500 font-mono">{t('last30DaysSummary')}</span>
            </div>

            <div className="space-y-2">
              {reviewsSummary.aiSummary.topStaff.slice(0, 3).map((staff, idx) => (
                <div
                  key={staff.membershipId}
                  className="p-2.5 bg-white rounded-xl border border-slate-200 space-y-1 shadow-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px]',
                          idx === 0
                            ? 'bg-amber-400 text-amber-950 font-black'
                            : idx === 1
                            ? 'bg-slate-300 text-slate-800 font-black'
                            : 'bg-amber-700/60 text-white font-bold',
                        )}
                      >
                        {idx + 1}
                      </span>
                      <strong className="text-slate-900 text-xs">{staff.name}</strong>
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-bold">
                        {staff.tier}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 text-amber-600 font-mono font-bold text-xs">
                      <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                      <span>{staff.rating}</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-500">{staff.specialty}</p>
                  <div className="flex justify-between items-center text-[10px] text-slate-400 pt-1 border-t border-slate-100">
                    <span>{t('finance.dashPraised')}</span>
                    <strong className="font-mono text-emerald-700">{staff.reviewCount}  {t('finance.dashPraisedUnit')}</strong>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 最新顾客真实评价动态流 */}
        <div className="space-y-3 pt-3 border-t border-slate-100">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-teal-600" />
              <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider">
                {t('recentReviewsStream')}
              </h4>
            </div>

            <div className="relative w-full sm:w-56">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={reviewSearch}
                onChange={(e) => setReviewSearch(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50/70 text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:bg-white transition-all"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {filteredRecentReviews.map((rev) => (
              <div
                key={rev.id}
                onClick={() => setSelectedReviewModal(rev)}
                className="p-3.5 rounded-2xl border border-slate-200 hover:border-teal-300 hover:bg-slate-50/60 transition-all text-xs space-y-2.5 flex flex-col justify-between shadow-xs cursor-pointer group"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-xl bg-teal-100 text-teal-800 font-bold flex items-center justify-center text-xs">
                        {rev.avatarText}
                      </div>
                      <div>
                        <span className="font-bold text-slate-900 block">{rev.customerName}</span>
                        <span className="text-[10px] text-slate-400 font-mono">{rev.timeAgo}</span>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-bold bg-slate-100">
                      {rev.platformLabel}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-1 text-amber-400">
                    {[...Array(rev.rating)].map((_, i) => (
                      <Star key={i} className="w-3 h-3 fill-amber-400 text-amber-400" />
                    ))}
                    <span className="text-[10px] text-slate-500 font-medium ml-1">
                      
                      {t('finance.dashReviewService')} {rev.serviceName}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-700 line-clamp-3 leading-relaxed">
                    &ldquo;{rev.content}&rdquo;
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[10px]">
                  <span className="text-teal-700 font-bold">{rev.sentimentTag}</span>
                  <span className="text-slate-400 group-hover:text-teal-600 transition-colors">
                    
                    {t('finance.dashViewDetail')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
          </>
        )}
      </Card>

      {/* ── 快速指派 Modal ─────────────────────────────────────────────────── */}
      {dispatchModalOpen && dispatchTargetQueueItem && (
        <Modal
          isOpen={dispatchModalOpen}
          onOpenChange={setDispatchModalOpen}
          title={t('finance.dashAssignTitle', { p0: dispatchTargetQueueItem.displayName })}
        >
          <div className="space-y-4 p-4 text-xs">
            <p className="text-slate-500">
              
              {t('finance.dashAssignBody')}
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="font-bold text-slate-800">{t('assignStaffLabel')}</label>
                <select className="w-full h-10 px-3 bg-white border border-slate-200 rounded-xl text-xs font-semibold">
                  <option value={nextStaff?.membershipId}>
                    {nextStaff?.name}  {t('finance.dashRotationFirstOwed')} {nextStaff?.owed ?? 0}  {t('finance.dashOwedUnit')}
                  </option>
                  {rotationEntries
                    .filter((s) => s.membershipId !== nextStaff?.membershipId && s.state === 'available')
                    .map((s) => (
                      <option key={s.membershipId} value={s.membershipId}>
                        {s.name}  {t('finance.dashIdleReady')}
                      </option>
                    ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-slate-800">{t('assignRoomLabel')}</label>
                <select className="w-full h-10 px-3 bg-white border border-slate-200 rounded-xl text-xs font-semibold">
                  {roomsList
                    .filter((r) => r.status === 'available')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}  {t('finance.dashIdle')}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <Button variant="ghost" onClick={() => setDispatchModalOpen(false)}>
                
                {t('finance.dashAssignCancel')}
              </Button>
              <Button
                onClick={() => {
                  setDispatchModalOpen(false);
                  toast.success(t('finance.dashAssigned'));
                  void refetchQueue();
                  void refetchRotation();
                  void refetchRooms();
                }}
                className="bg-teal-600 text-white font-bold"
              >
                {t('confirmAssignAndStart')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── 评价详情 Modal ─────────────────────────────────────────────────── */}
      {selectedReviewModal && (
        <Modal
          isOpen={Boolean(selectedReviewModal)}
          onOpenChange={(open) => {
            if (!open) setSelectedReviewModal(null);
          }}
          title={t('reviewDetailsModalTitle')}
          size="md"
        >
          <div className="space-y-4 p-4 text-xs text-slate-700">
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-teal-600 text-white font-bold flex items-center justify-center text-xs">
                    {selectedReviewModal.avatarText}
                  </div>
                  <div>
                    <h4 className="font-bold text-slate-900 text-sm">{selectedReviewModal.customerName}</h4>
                    <span className="text-[10px] text-slate-400">
                      {selectedReviewModal.platformLabel} · {selectedReviewModal.timeAgo}
                    </span>
                  </div>
                </div>
                <div className="flex text-amber-400">
                  {[...Array(selectedReviewModal.rating)].map((_, i) => (
                    <Star key={i} className="w-4 h-4 fill-amber-400 text-amber-400" />
                  ))}
                </div>
              </div>

              <div className="text-[11px] text-slate-600 pt-1 border-t border-slate-200/60">
                <span>{t('finance.dashReviewedService')} <strong>{selectedReviewModal.serviceName}</strong></span>
                {selectedReviewModal.technicianName && (
                  <span className="ml-3">{t('finance.dashReviewedBy')}{t('staff')}: <strong>{selectedReviewModal.technicianName}</strong></span>
                )}
              </div>
            </div>

            <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2">
              <span className="font-bold text-slate-800 text-xs block">{t('finance.dashReviewBody')}</span>
              <p className="text-slate-800 leading-relaxed text-xs">
                &ldquo;{selectedReviewModal.content}&rdquo;
              </p>
            </div>

            <div className="space-y-1.5">
              <span className="font-bold text-slate-800 text-xs block">{t('finance.dashReviewTags')}</span>
              <div className="flex flex-wrap gap-1.5">
                {selectedReviewModal.highlights.map((h) => (
                  <span key={h} className="px-2.5 py-1 bg-emerald-50 text-emerald-800 font-bold rounded-xl border border-emerald-200 text-xs">
                    ✓ {h}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <Button
                variant="outline"
                size="sm"
                className="text-xs font-bold gap-1.5 text-teal-700 hover:bg-teal-50 border-teal-200"
                onClick={() => handleCopyReviewText(selectedReviewModal)}
              >
                {copiedReviewId === selectedReviewModal.id ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">{t('finance.dashCopied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t('copyPosterText')}</span>
                  </>
                )}
              </Button>
              <Button variant="ghost" onClick={() => setSelectedReviewModal(null)}>
                
                {t('finance.dashClose')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── 全局两步确认弹窗 ───────────────────────────────────────────────── */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onOpenChange={(open) => !open && setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        tone={confirmDialog.tone || 'default'}
        confirmLabel={confirmDialog.confirmLabel || t('finance.dashConfirmRun')}
        onConfirm={confirmDialog.onConfirm}
      />
    </div>
  );
}

export function Dashboard() {
  return (
    <ErrorBoundary fallbackTitleKey="dashboard">
      <DashboardContent />
    </ErrorBoundary>
  );
}
