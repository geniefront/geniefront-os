import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useState, useMemo, useCallback } from 'react';
import { useStoreTime } from '@/lib/time';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell,
  Calendar,
  CreditCard,
  Users,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Info,
  Check,
  Trash2,
  ExternalLink,
  Search,
  SlidersHorizontal,
  Clock,
  Sparkles,
  RefreshCw,
  Eye,
  DollarSign,
  ChevronRight,
  Filter,
  Volume2,
  VolumeX,
  Layers,
  X,
  AlertOctagon,
  ArrowUpRight,
  Copy,
} from 'lucide-react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoading, SectionError } from '@/components/ui/QueryState';
import { ConfirmDialog } from '@/components/ui/Modal';
import {
  useNotificationsQuery,
  useNotificationStatsQuery,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useDeleteNotification,
  useClearReadNotifications,
} from '@/features/notifications/api';
import type { NotificationCategory, NotificationItem, NotificationLevel } from '@/features/notifications/types';

/** Web Audio API 合成清脆愉悦的通知提示音（无需加载外部 mp3） */
function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(880, now + 0.08); // A5
    osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.28); // D6

    gainNode.gain.setValueAtTime(0.2, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now + 0.08);
    osc1.stop(now + 0.3);
    osc2.stop(now + 0.45);
  } catch {
    // ignore
  }
}

type NotifConfirmType =
  | 'mark_all_read'
  | 'clear_read'
  | 'delete_single'
  | 'batch_mark_read'
  | 'batch_delete';

export function Notifications() {
  const storeTime = useStoreTime();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeCategory = (searchParams.get('category') as NotificationCategory | 'all') || 'all';
  const unreadOnly = searchParams.get('unread') === 'true';
  const [searchQuery, setSearchQuery] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Multi-select batch state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // ── 两步确认状态机 ──────────────────────────────────────────────────────────
  const [confirmDialogState, setConfirmDialogState] = useState<{
    isOpen: boolean;
    type: NotifConfirmType | null;
    title: string;
    description: string;
    tone?: 'default' | 'danger';
    confirmLabel?: string;
    payload?: any;
  }>({
    isOpen: false,
    type: null,
    title: '',
    description: '',
  });

  const { data: stats, isLoading: isStatsLoading } = useNotificationStatsQuery();
  const { data: notifications, isLoading, isError, error, refetch, isFetching } = useNotificationsQuery({
    category: activeCategory,
    unreadOnly,
    searchQuery,
  });

  const markReadMutation = useMarkNotificationRead();
  const markAllReadMutation = useMarkAllNotificationsRead();
  const deleteMutation = useDeleteNotification();
  const clearReadMutation = useClearReadNotifications();

  const handleCategoryChange = (cat: NotificationCategory | 'all') => {
    const params = new URLSearchParams(searchParams);
    if (cat === 'all') params.delete('category');
    else params.set('category', cat);
    setSearchParams(params);
    setSelectedIds([]);
  };

  const handleToggleUnreadOnly = (checked: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (checked) params.set('unread', 'true');
    else params.delete('unread');
    setSearchParams(params);
    setSelectedIds([]);
  };

  // ── 两步确认请求 ──────────────────────────────────────────────────────────
  const requestMarkAllRead = () => {
    const unreadNum = stats?.unread ?? 0;
    setConfirmDialogState({
      isOpen: true,
      type: 'mark_all_read',
      title: t('notifConfirmMarkAllTitle'),
      description: unreadNum > 0
        ? t('notifConfirmMarkAllDescUnread', { p0: unreadNum })
        : t('notifConfirmMarkAllDescAll'),
      tone: 'default',
      confirmLabel: t('notifConfirmMarkAllButton'),
    });
  };

  const requestClearRead = () => {
    setConfirmDialogState({
      isOpen: true,
      type: 'clear_read',
      title: t('notifConfirmClearTitle'),
      description: t('notifConfirmClearDesc'),
      tone: 'danger',
      confirmLabel: t('notifConfirmClearButton'),
    });
  };

  const requestDeleteSingle = (notif: NotificationItem) => {
    setConfirmDialogState({
      isOpen: true,
      type: 'delete_single',
      title: t('notifConfirmDeleteTitle'),
      description: t('notifConfirmDeleteDesc', { p0: notif.title }),
      tone: 'danger',
      confirmLabel: t('notifConfirmDeleteButton'),
      payload: { id: notif.id },
    });
  };

  const requestBatchMarkRead = () => {
    setConfirmDialogState({
      isOpen: true,
      type: 'batch_mark_read',
      title: t('notifConfirmBatchTitle', { p0: selectedIds.length }),
      description: t('notifConfirmBatchDesc'),
      tone: 'default',
      confirmLabel: t('notifConfirmBatchButton'),
    });
  };

  const requestBatchDelete = () => {
    setConfirmDialogState({
      isOpen: true,
      type: 'batch_delete',
      title: t('notifConfirmBatchDeleteTitle', { p0: selectedIds.length }),
      description: t('notifConfirmBatchDeleteDesc'),
      tone: 'danger',
      confirmLabel: t('notifConfirmBatchDeleteButton'),
    });
  };

  /*
   * 执行二次确认操作。
   *
   * ⚠️ 不要在这里先关弹窗。批量删除可能要逐条发几十个请求，此前一按确认弹窗
   * 就消失，整个过程界面上没有任何痕迹 —— 用户不知道在跑、也不知道跑到哪了。
   * 交给 `ConfirmDialog`：它在 `onConfirm` 兑现之前保持打开、确认键转圈并锁住，
   * 兑现后自行关闭，失败则留在原地让 toast 有处可依。
   */
  const executeConfirmedAction = async () => {
    const { type, payload } = confirmDialogState;

    try {
      switch (type) {
        case 'mark_all_read':
          await markAllReadMutation.mutateAsync(activeCategory);
          toast.success(t('markAllRead'));
          if (soundEnabled) playNotificationChime();
          break;
        case 'clear_read':
          await clearReadMutation.mutateAsync();
          toast.success(t('crm.clearedRead'));
          setSelectedIds([]);
          break;
        case 'delete_single':
          if (payload?.id) {
            await deleteMutation.mutateAsync({ notificationId: payload.id });
            toast.success(t('crm.deleted'));
            setSelectedIds((prev) => prev.filter((x) => x !== payload.id));
          }
          break;
        case 'batch_mark_read':
          for (const id of selectedIds) {
            await markReadMutation.mutateAsync({ notificationId: id });
          }
          toast.success(t('crm.bulkMarkedRead', { p0: selectedIds.length }));
          setSelectedIds([]);
          break;
        case 'batch_delete':
          for (const id of selectedIds) {
            await deleteMutation.mutateAsync({ notificationId: id });
          }
          toast.success(t('crm.bulkDeleted', { p0: selectedIds.length }));
          setSelectedIds([]);
          break;
      }
    } catch {
      toast.danger(t('crm.actionFailed'));
    }
  };

  const handleToggleSelectAll = () => {
    if (!notifications) return;
    if (selectedIds.length === notifications.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(notifications.map((n) => n.id));
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleActionClick = (notif: NotificationItem) => {
    if (!notif.read) {
      markReadMutation.mutate({ notificationId: notif.id });
    }
    if (notif.actionUrl) {
      navigate(notif.actionUrl);
    }
  };

  const formatRelativeTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const diffMs = Date.now() - date.getTime();
      const diffMins = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffMins < 1) return t('relativeJustNow');
      if (diffMins < 60) return t('relativeMinutesAgo', { p0: diffMins });
      if (diffHours < 24) return t('relativeHoursAgo', { p0: diffHours });
      if (diffDays < 7) return t('relativeDaysAgo', { p0: diffDays });
      return storeTime.date(date);
    } catch {
      return isoString;
    }
  };

  const categoryTabs = [
    { id: 'all', label: t('notifCategoryAll'), icon: Bell, unreadCount: stats?.unread ?? 0 },
    { id: 'bookings', label: t('notifCategoryBookings'), icon: Calendar, unreadCount: stats?.bookingsUnread ?? 0 },
    { id: 'operations', label: t('notifCategoryOperations'), icon: CreditCard, unreadCount: stats?.operationsUnread ?? 0 },
    { id: 'customers', label: t('notifCategoryCustomers'), icon: Users, unreadCount: stats?.customersUnread ?? 0 },
    { id: 'system', label: t('notifCategorySystem'), icon: Shield, unreadCount: stats?.systemUnread ?? 0 },
  ];

  const getLevelBadge = (level?: NotificationLevel) => {
    switch (level) {
      case 'warning':
        return <Badge variant="warning">{t('crm.levelWarning')}</Badge>;
      case 'error':
        return <Badge variant="destructive">{t('crm.levelError')}</Badge>;
      case 'success':
        return <Badge variant="success">{t('crm.levelSuccess')}</Badge>;
      default:
        return <Badge variant="secondary">{t('crm.levelInfo')}</Badge>;
    }
  };

  const getCategoryBorderColor = (category: string) => {
    switch (category) {
      case 'bookings':
        return 'border-l-teal-500';
      case 'operations':
        return 'border-l-amber-500';
      case 'customers':
        return 'border-l-purple-500';
      case 'system':
        return 'border-l-blue-500';
      default:
        return 'border-l-slate-300';
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'bookings':
        return <Calendar className="w-4 h-4 text-teal-600" />;
      case 'operations':
        return <CreditCard className="w-4 h-4 text-amber-600" />;
      case 'customers':
        return <Users className="w-4 h-4 text-purple-600" />;
      case 'system':
        return <Shield className="w-4 h-4 text-blue-600" />;
      default:
        return <Bell className="w-4 h-4 text-slate-600" />;
    }
  };

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      {/* 顶部标题与操作栏 */}
      <PageHeader
        title={
          <div className="flex items-center gap-3">
            <span>{t('notificationCenter')}</span>
            {stats && stats.unread > 0 ? (
              <Badge variant="error" className="animate-pulse font-bold">
                {stats.unread}  {t('crm.unreadSuffix')}
              </Badge>
            ) : (
              <Badge variant="success" className="font-bold">{t('crm.allHandled')}</Badge>
            )}
          </div>
        }
        description={t('crm.pageDesc')}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                if (next) playNotificationChime();
                toast.success(next ? t('crm.soundOn') : t('crm.soundOff'));
              }}
              className={`p-2 rounded-xl border transition-colors ${
                soundEnabled
                  ? 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100'
                  : 'bg-white text-slate-400 border-slate-200 hover:bg-slate-50'
              }`}
              title={soundEnabled ? t('crm.soundOnHint') : t('crm.soundOffHint')}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              className="gap-1.5 rounded-xl border-slate-200 text-slate-700 hover:bg-slate-50"
              disabled={isFetching}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              <span>{t('crm.refresh')}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={requestClearRead}
              disabled={clearReadMutation.isPending}
              className="gap-1.5 rounded-xl border-slate-200 text-slate-700 hover:bg-slate-50 text-xs"
            >
              <Trash2 className="w-3.5 h-3.5 text-slate-400" />
              <span>{t('clearAllNotifications')}</span>
            </Button>

            <Button
              size="sm"
              onClick={requestMarkAllRead}
              disabled={markAllReadMutation.isPending || (stats?.unread ?? 0) === 0}
              className="gap-1.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-bold"
            >
              <Check className="w-3.5 h-3.5" />
              <span>{t('markAllRead')}</span>
            </Button>
          </div>
        }
      />

      {/* 4 大核心统计看板卡片 */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          {
            key: 'all',
            label: t('crm.pendingUnreadTotal'),
            count: stats?.unread ?? 0,
            icon: Bell,
            color: 'text-rose-600 bg-rose-50 border-rose-100',
            sub: t('crm.historyCount', { p0: stats?.total ?? 0 }),
          },
          {
            key: 'bookings',
            label: t('crm.catBookings'),
            count: stats?.bookingsUnread ?? 0,
            icon: Calendar,
            color: 'text-teal-600 bg-teal-50 border-teal-100',
            sub: t('crm.catBookingsDesc'),
          },
          {
            key: 'operations',
            label: t('crm.catFinance'),
            count: stats?.operationsUnread ?? 0,
            icon: CreditCard,
            color: 'text-amber-600 bg-amber-50 border-amber-100',
            sub: t('crm.catFinanceDesc'),
          },
          {
            key: 'customers',
            label: t('crm.catCustomers'),
            count: stats?.customersUnread ?? 0,
            icon: Users,
            color: 'text-purple-600 bg-purple-50 border-purple-100',
            sub: t('crm.catCustomersDesc'),
          },
        ].map((item) => {
          const isSelected = activeCategory === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => handleCategoryChange(item.key as any)}
              className={`p-4 rounded-2xl border text-left transition-all relative overflow-hidden group ${
                isSelected
                  ? 'bg-white border-teal-500 shadow-md ring-2 ring-teal-500/20'
                  : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">{item.label}</span>
                <div className={`p-2 rounded-xl ${item.color}`}>
                  <item.icon className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-black text-slate-900">{item.count}</span>
                <span className="text-[11px] text-slate-400 font-medium">{item.sub}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* 筛选与搜索工具条 */}
      <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
        <div className="p-4 flex flex-col xl:flex-row items-center justify-between gap-4 border-b border-slate-100">
          {/* 分类 Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto w-full xl:w-auto custom-scrollbar">
            {categoryTabs.map((tab) => {
              const isActive = activeCategory === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleCategoryChange(tab.id as any)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
                    isActive
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                  }`}
                >
                  <tab.icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                  {tab.unreadCount > 0 && (
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-black ${
                        isActive ? 'bg-red-500 text-white' : 'bg-red-100 text-red-700'
                      }`}
                    >
                      {tab.unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* 搜索与仅看未读过滤 */}
          <div className="flex items-center gap-3 w-full xl:w-auto justify-end">
            <div className="relative flex-1 xl:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('crm.searchPlaceholder')}
                className="w-full h-9 pl-8 pr-8 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-teal-500 focus:bg-white transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs font-bold text-slate-700 shrink-0 cursor-pointer select-none bg-slate-50 px-3 py-2 rounded-xl border border-slate-200">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => handleToggleUnreadOnly(e.target.checked)}
                className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
              />
              <span>{t('onlyUnread')}</span>
            </label>
          </div>
        </div>

        {/* 批量操作工具栏（当选中通知时展示） */}
        {selectedIds.length > 0 && (
          <div className="bg-teal-50 border-b border-teal-100 px-4 py-2.5 flex items-center justify-between animate-in fade-in slide-in-from-top-1">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-teal-900">
                
                {t('crm.selectedPrefix')} <strong className="text-teal-700">{selectedIds.length}</strong>  {t('crm.selectedSuffix')}
              </span>
              <button
                type="button"
                onClick={handleToggleSelectAll}
                className="text-xs font-semibold text-teal-700 hover:underline"
              >
                {selectedIds.length === (notifications?.length ?? 0) ? t('crm.clearSelection') : t('crm.selectPage')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={requestBatchMarkRead}
                className="text-xs bg-white font-bold text-slate-800"
              >
                <Check className="w-3 h-3" />
                <span>{t('crm.bulkMarkRead')}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={requestBatchDelete}
                className="text-xs font-bold text-red-600 hover:bg-red-100/50"
              >
                <Trash2 className="w-3 h-3" />
                <span>{t('crm.bulkDelete')}</span>
              </Button>
            </div>
          </div>
        )}

        {/* 列表渲染 */}
        <div className="divide-y divide-slate-100">
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3">
              <p className="text-xs text-slate-400"><LoadingSpinner label={t('crm.loading')} /></p>
            </div>
          ) : isError ? (
            /*
              加载失败必须与「暂无通知」分开呈现。合在一起时，请求挂掉的界面
              与真的没有通知的界面完全相同，用户据此认为今天没有任何通知。
            */
            <SectionError error={error} onRetry={() => void refetch()} />
          ) : !notifications || notifications.length === 0 ? (
            <EmptyState
              icon={<Bell className="w-8 h-8 text-slate-300" />}
              title={<span className="text-base font-bold text-slate-700">{t('noNotificationsFound')}</span>}
              description={t('crm.emptyDesc')}
              className="py-16"
            />
          ) : (
            <AnimatePresence>
              {notifications.map((notif) => {
                const isSelected = selectedIds.includes(notif.id);
                return (
                  <motion.div
                    key={notif.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, height: 0 }}
                    className={`p-5 transition-colors border-l-4 ${getCategoryBorderColor(notif.category)} ${
                      !notif.read ? 'bg-teal-50/20 hover:bg-teal-50/40' : 'bg-white hover:bg-slate-50/80'
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      {/* 多选勾选框 */}
                      <div className="pt-0.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelect(notif.id)}
                          className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
                        />
                      </div>

                      {/* 分类图标徽标 */}
                      <div className="p-2 rounded-xl bg-slate-100 shrink-0">
                        {getCategoryIcon(notif.category)}
                      </div>

                      {/* 内容主干 */}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3
                              className={`text-sm tracking-tight ${
                                !notif.read ? 'font-black text-slate-900' : 'font-bold text-slate-700'
                              }`}
                            >
                              {notif.titleKey ? t(notif.titleKey) : notif.title}
                            </h3>
                            {getLevelBadge(notif.level)}
                            {!notif.read && (
                              <span className="w-2 h-2 rounded-full bg-teal-500 animate-ping"></span>
                            )}
                          </div>

                          <span className="text-xs text-slate-400 font-medium flex items-center gap-1 shrink-0">
                            <Clock className="w-3 h-3 text-slate-300" />
                            <span>{formatRelativeTime(notif.createdAt)}</span>
                          </span>
                        </div>

                        <p className="text-xs text-slate-600 leading-relaxed font-normal">{notif.message}</p>

                        {/* 元数据标签胶囊 */}
                        {notif.meta && (
                          <div className="flex items-center gap-2 flex-wrap pt-1">
                            {notif.meta.customerName && (
                              <span className="px-2.5 py-0.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold">
                                
                                {t('crm.metaCustomer')} {String(notif.meta.customerName)}
                              </span>
                            )}
                            {notif.meta.serviceName && (
                              <span className="px-2.5 py-0.5 rounded-lg bg-teal-50 text-teal-800 text-[11px] font-bold">
                                
                                {t('crm.metaService')} {String(notif.meta.serviceName)}
                              </span>
                            )}
                            {notif.meta.staffName && (
                              <span className="px-2.5 py-0.5 rounded-lg bg-purple-50 text-purple-800 text-[11px] font-bold">
                                
                                {t('crm.metaStaff')} {String(notif.meta.staffName)}
                              </span>
                            )}
                            {notif.meta.amountDollars !== undefined && (
                              <span className="px-2.5 py-0.5 rounded-lg bg-amber-50 text-amber-900 text-[11px] font-bold">
                                Amount: ${notif.meta.amountDollars.toFixed(2)}
                              </span>
                            )}
                            {notif.meta.ticketId && (
                              <span className="px-2.5 py-0.5 rounded-lg bg-slate-100 text-slate-600 text-[11px] font-mono">
                                #{String(notif.meta.ticketId)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 右侧快捷操作按钮区 */}
                      <div className="flex items-center gap-1.5 shrink-0 pl-2">
                        {notif.actionUrl && (
                          <Button
                            size="sm"
                            onClick={() => handleActionClick(notif)}
                            className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold gap-1 px-3"
                          >
                            <span>
                              {notif.actionType === 'appointment'
                                ? t('viewAppointment')
                                : notif.actionType === 'ticket'
                                ? t('goToCheckout')
                                : notif.actionType === 'queue'
                                ? t('goToQueue')
                                : notif.actionType === 'customer'
                                ? t('viewCustomer')
                                : 'Take Action'}
                            </span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </Button>
                        )}

                        <button
                          type="button"
                          onClick={() => markReadMutation.mutate({ notificationId: notif.id })}
                          className={`p-2 rounded-xl transition-colors ${
                            !notif.read
                              ? 'text-teal-700 bg-teal-50 hover:bg-teal-100'
                              : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                          }`}
                          title={!notif.read ? t('crm.markRead') : t('crm.alreadyRead')}
                        >
                          <Check className="w-4 h-4" />
                        </button>

                        <button
                          type="button"
                          onClick={() => requestDeleteSingle(notif)}
                          className="p-2 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title={t('crm.deleteNotification')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          )}
        </div>
      </Card>

      {/* ── 全局两步确认弹窗 (Two-Step Confirmation Dialog) ───────────────── */}
      <ConfirmDialog
        isOpen={confirmDialogState.isOpen}
        onOpenChange={(open) => !open && setConfirmDialogState((prev) => ({ ...prev, isOpen: false }))}
        title={confirmDialogState.title}
        description={confirmDialogState.description}
        tone={confirmDialogState.tone || 'default'}
        confirmLabel={confirmDialogState.confirmLabel || t('confirm')}
        onConfirm={executeConfirmedAction}
      />
    </div>
  );
}
