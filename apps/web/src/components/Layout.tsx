import { planAllowsPath } from '@gf/contracts';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { lazy, Suspense, useState, useRef, useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate, Outlet } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Spinner } from '@heroui/react';
import { 
  LayoutDashboard, 
  BarChart, 
  CreditCard,
  CalendarDays, 
  ListOrdered, 
  Clock, 
  BedDouble,
  Receipt,
  CircleDollarSign,
  FileCheck,
  Users, 
  Gift,
  TrendingUp,
  PhoneCall,
  MessageSquare,
  History,
  Menu,
  ChevronLeft,
  Bell,
  Search,
  ChevronDown,
  Sparkles,
  Globe,
  Plus,
  ClipboardList,
  Settings,
  UserCircle,
  LifeBuoy,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { UI_LANGUAGES as LANGUAGES } from '@/i18n/types';
import { pickText } from '@gf/contracts';
import { useSession } from '@/lib/session';
import { roleLabelKey } from '@/lib/roles';
import { WifiOff } from 'lucide-react';
import type { Language, TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/Modal';
import { useSchedule } from '@/context/ScheduleContext';
import { instantToWallDate } from '@/lib/time';
import { isTypingTarget } from '@/lib/keyboard';
import {
  useNotificationsQuery,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
} from '@/features/notifications/api';
import {
  getSavedUserAvatar,
  getSavedStoreAvatar,
  PRESET_USER_AVATARS,
  PRESET_AVATAR_GRADIENTS,
} from '@/lib/avatarPresets';
import { useBusinessDay } from '@/lib/time';

const AppointmentDrawer = lazy(() => import('./AppointmentDrawer').then((module) => ({ default: module.AppointmentDrawer })));
const CopilotDrawer = lazy(() => import('./CopilotDrawer').then((module) => ({ default: module.CopilotDrawer })));
const CreateAppointmentModal = lazy(() => import('./CreateAppointmentModal').then((module) => ({ default: module.CreateAppointmentModal })));

/**
 * 全局搜索（⌘K）命令面板的路由索引。
 *
 * ⚠️ 标题与副标题只存词典键，不存字符串。这里以前是
 * `{ label: 中文, en: 英文 }` 各写一份、再在渲染处按
 * `language === 'en' ? cmd.en : cmd.label` 二选一 —— 韩语/西语/越南语
 * 用户看到的标题是中文，而副标题从来没有分语言，**所有语言**看到的
 * 都是中文。标题复用侧栏导航已有的词条键，保证同一个页面在两处
 * 叫法一致；副标题另建一套 `cmdDesc*` 键补上缺的四种语言。
 * `keywords` 是本地模糊搜索用的拼音/英文别名，不面向用户展示，
 * 不需要跟着界面语言走。
 */
const GLOBAL_COMMANDS: Array<{
  path: string; titleKey: TranslationKey; descKey: TranslationKey; keywords: string;
}> = [
  { path: '/dashboard', titleKey: 'dashboard', descKey: 'cmdDescDashboard', keywords: 'overview home yibiaopan 仪表盘' },
  { path: '/schedule', titleKey: 'schedule', descKey: 'cmdDescSchedule', keywords: 'appointment calendar paiban yuyue 日程 预约' },
  { path: '/queue', titleKey: 'queue', descKey: 'cmdDescQueue', keywords: 'kanban waiting walkin houke jiaohao 看板 候客 叫号' },
  { path: '/checkout', titleKey: 'checkout', descKey: 'cmdDescCheckout', keywords: 'pos shouyin jiezhang payment 收银 结账 开单' },
  { path: '/tickets', titleKey: 'tickets', descKey: 'cmdDescTickets', keywords: 'dingdan jilu orders receipts 订单 记录' },
  { path: '/rotation', titleKey: 'rotation', descKey: 'cmdDescRotation', keywords: 'lunpai jishi technician staff 轮牌 技师' },
  { path: '/rooms', titleKey: 'rooms', descKey: 'cmdDescRooms', keywords: 'fangjian room bed baojian 房间 包厢 床位' },
  { path: '/customers', titleKey: 'customers', descKey: 'cmdDescCustomers', keywords: 'kehu customer vip profile 客户 会员 档案' },
  { path: '/marketing', titleKey: 'marketing', descKey: 'cmdDescMarketing', keywords: 'yingxiao coupon package giftcard cika 营销 优惠券 次卡 Gift Card' },
  { path: '/employee-performance', titleKey: 'employeePerformance', descKey: 'cmdDescEmployeePerformance', keywords: 'yuangong staff performance jineng 员工 技师 技能' },
  { path: '/day-close', titleKey: 'dayClose', descKey: 'cmdDescDayClose', keywords: 'rijie dayclose endofday 日结 打烊' },
  { path: '/business-data', titleKey: 'businessData', descKey: 'cmdDescBusinessData', keywords: 'shuju fenxi reports 数据 报表' },
  { path: '/payouts', titleKey: 'payouts', descKey: 'cmdDescPayouts', keywords: 'xinzi payroll commission 薪资 提成' },
  { path: '/settings', titleKey: 'settings', descKey: 'cmdDescSettings', keywords: 'shezhi settings config 设置 门店' },
  { path: '/support', titleKey: 'support', descKey: 'cmdDescSupport', keywords: 'support bangzhu help 支持 帮助' },
  { path: '/profile', titleKey: 'profile', descKey: 'cmdDescProfile', keywords: 'profile gerenziliao mima pin 个人资料 密码' },
  { path: '/notifications', titleKey: 'notificationCenter', descKey: 'cmdDescNotificationCenter', keywords: 'tongzhi notifications alerts 消息 通知' },
];

/** 侧栏常驻的下界：iPad 横屏（1024–1194px）必须落在常驻侧。 */
const SIDEBAR_QUERY = "(min-width: 1024px)";
/** 常驻但只给图标轨的宽度区间：平板横屏。 */
const RAIL_QUERY = "(min-width: 1024px) and (max-width: 1279.98px)";

export function Layout() {
  const entitlements = useEntitlements();
  const plan = entitlements.data?.plan;
  const navigate = useNavigate();
  const { setCurrentDate, timezone } = useSchedule();
  /*
   * ── 导航外壳的两道断点 ──────────────────────────────────────────────────────
   *
   * 侧栏此前以 1280px 为界，而门店 iPad 横屏只有 1024–1194px，于是**所有 iPad
   * 都落进了手机分支**：主导航、门店名与账号入口一并收进汉堡抽屉，前台每次换
   * 页都要先开抽屉。前台终端属于常驻设备，导航必须常驻。
   *
   * 现按两道断点组织：
   *   - `SIDEBAR_QUERY`（≥1024px）决定侧栏是否常驻。iPad 横屏由此获得常驻导航，
   *     竖屏（820px）仍用抽屉 —— 竖屏宽度不足以同时容纳导航与看板列。
   *   - `RAIL_QUERY`（1024–1279px）决定常驻时的默认形态。该区间只有平板宽度，
   *     展开态侧栏会吃掉近四分之一横向空间，因此默认收成 64px 图标轨；用户手动
   *     展开后 `sidebarPinnedByUser` 置位，后续旋转与窗口变化不再覆盖其选择。
   */
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => window.matchMedia(RAIL_QUERY).matches);
  const [sidebarPinnedByUser, setSidebarPinnedByUser] = useState(false);
  const [wideLayout, setWideLayout] = useState(() => window.matchMedia(SIDEBAR_QUERY).matches);
  const collapsed = wideLayout && desktopCollapsed;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  /** 侧栏展开/收起由用户显式切换，记下这一点以免后续断点变化把它改回默认。 */
  const setCollapsed = (next: boolean) => {
    setSidebarPinnedByUser(true);
    setDesktopCollapsed(next);
  };

  useEffect(() => {
    const sidebarQuery = window.matchMedia(SIDEBAR_QUERY);
    const railQuery = window.matchMedia(RAIL_QUERY);
    const update = () => {
      setWideLayout(sidebarQuery.matches);
      setMobileNavOpen(false);
      if (!sidebarPinnedByUser) setDesktopCollapsed(railQuery.matches);
    };
    sidebarQuery.addEventListener("change", update);
    railQuery.addEventListener("change", update);
    return () => {
      sidebarQuery.removeEventListener("change", update);
      railQuery.removeEventListener("change", update);
    };
  }, [sidebarPinnedByUser]);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [activeAppointmentId, setActiveAppointmentId] = useState<string | null>(null);
  const [activeAppointmentStatus, setActiveAppointmentStatus] = useState<'booked' | 'checked_in' | 'in_service' | 'done'>('booked');
  const [globalQuery, setGlobalQuery] = useState('');
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const globalSearchRef = useRef<HTMLDivElement>(null);
  const globalInputRef = useRef<HTMLInputElement>(null);

  const [createModalOptions, setCreateModalOptions] = useState<{
    isOpen: boolean;
    defaultDate?: string;
    defaultStaffId?: string;
    defaultTime?: string;
    defaultCustomerName?: string;
    defaultPhone?: string;
    defaultServiceId?: string;
  }>({ isOpen: false });

  const openCreateAppointment = (options?: {
    defaultDate?: string;
    defaultStaffId?: string;
    defaultTime?: string;
    defaultCustomerName?: string;
    defaultPhone?: string;
    defaultServiceId?: string;
  }) => {
    setCreateModalOptions({
      isOpen: true,
      ...options,
    });
  };
  const [isCopilotOpen, setIsCopilotOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);

  // 响应式头像与门店品牌标识
  const [userAvatar, setUserAvatar] = useState(getSavedUserAvatar());
  const [storeAvatar, setStoreAvatar] = useState(getSavedStoreAvatar());

  useEffect(() => {
    const handleUserAvatarUpdate = (e: any) => {
      setUserAvatar(e.detail || getSavedUserAvatar());
    };
    const handleStoreAvatarUpdate = (e: any) => {
      setStoreAvatar(e.detail || getSavedStoreAvatar());
    };
    window.addEventListener('gf-avatar-updated', handleUserAvatarUpdate);
    window.addEventListener('gf-store-avatar-updated', handleStoreAvatarUpdate);
    return () => {
      window.removeEventListener('gf-avatar-updated', handleUserAvatarUpdate);
      window.removeEventListener('gf-store-avatar-updated', handleStoreAvatarUpdate);
    };
  }, []);

  useEffect(() => {
    const handleOpenCopilot = () => setIsCopilotOpen(true);
    window.addEventListener('open-copilot', handleOpenCopilot);
    return () => window.removeEventListener('open-copilot', handleOpenCopilot);
  }, []);

  const { data: notificationList = [] } = useNotificationsQuery();
  const markNotificationReadMutation = useMarkNotificationRead();
  const markAllNotificationsReadMutation = useMarkAllNotificationsRead();

  const notifications = useMemo(() => notificationList.slice(0, 5), [notificationList]);
  const unreadCount = useMemo(() => notificationList.filter((n) => !n.read).length, [notificationList]);

  const prefersReducedMotion = useReducedMotion();

  const langMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const notifMenuRef = useRef<HTMLDivElement>(null);
  
  const location = useLocation();
  const { t, language, setLanguage } = useLanguage();
  const { membership, locations, session, isOnline, clearMembership, signOut, isTechCapable, switchPortal, can } = useSession();
  const { today: businessToday } = useBusinessDay();
  const canManageSettings = can('settings.manage') || can('staff.manage');

  useEffect(() => {
    if (plan && !planAllowsPath(plan, location.pathname)) navigate('/schedule', { replace: true });
  }, [plan, location.pathname, navigate]);

  const storeName = membership ? pickText(membership.locationName, language) : '—';
  /** 多店账号才提供切店入口；单店账号不暴露该概念。 */
  const canSwitchLocation = locations.length > 1;

  // 全局容错模糊搜索命令
  // ⚠️ 匹配用的 title/desc 必须是**当前语言下用户实际看到的文字**，
  // 不能拿词典键本身去比对 —— 否则搜索框里打中文，命中的却是英文界面。
  const searchResults = useMemo(() => {
    const commands = GLOBAL_COMMANDS
      .filter((item) => (item.path !== '/settings' || canManageSettings) && planAllowsPath(plan, item.path))
      .map((item) => ({ ...item, title: t(item.titleKey), desc: t(item.descKey) }));
    if (!globalQuery.trim()) return commands.slice(0, 6);
    return fuzzySearch(commands, globalQuery, {
      keys: [
        { name: 'title', weight: 0.6 },
        { name: 'desc', weight: 0.2 },
        { name: 'keywords', weight: 0.4 },
      ],
      threshold: 0.45,
    });
  }, [globalQuery, canManageSettings, plan, t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setGlobalSearchOpen(false);
        setMobileNavOpen(false);
        return;
      }
      const disabled = localStorage.getItem('desk_shortcuts_enabled') === 'false';
      if (disabled) return;

      const isInput = isTypingTarget(e.target);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        globalInputRef.current?.focus();
        setGlobalSearchOpen(true);
        return;
      }

      // 仅在非输入状态下触发前台高频快捷键（宪法第 12 条键盘流）
      if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '/') {
          e.preventDefault();
          globalInputRef.current?.focus();
          setGlobalSearchOpen(true);
        } else if (e.key.toLowerCase() === 'c') {
          e.preventDefault();
          navigate('/checkout');
        } else if (e.key.toLowerCase() === 'r') {
          e.preventDefault();
          navigate('/rotation');
        } else if (e.key.toLowerCase() === 'q') {
          e.preventDefault();
          navigate('/queue');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  useEffect(() => {
    function handleClickOutside(event: PointerEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(event.target as Node)) {
        setLangOpen(false);
      }
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setProfileOpen(false);
      }
      if (notifMenuRef.current && !notifMenuRef.current.contains(event.target as Node)) {
        setNotifOpen(false);
      }
      if (globalSearchRef.current && !globalSearchRef.current.contains(event.target as Node)) {
        setGlobalSearchOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleClickOutside);
    return () => document.removeEventListener("pointerdown", handleClickOutside);
  }, []);

  // 换页时收起所有浮层 —— 不然点了侧栏，菜单还悬在新页面上
  useEffect(() => {
    setLangOpen(false);
    setProfileOpen(false);
    setNotifOpen(false);
    setGlobalSearchOpen(false);
    setGlobalQuery('');
    setMobileNavOpen(false);
  }, [location.pathname]);

  const navGroups = [
    {
      group: t('groupCore') || '核心前台',
      items: [
        { name: t('dashboard') || '概览看板', icon: LayoutDashboard, path: '/dashboard' },
        { name: t('schedule') || '排班日程', icon: CalendarDays, path: '/schedule' },
        { name: t('queue') || '候客大厅', icon: ListOrdered, path: '/queue' },
        { name: t('checkout') || '开单收银', icon: CreditCard, path: '/checkout' },
        { name: t('tickets') || '订单流水', icon: Receipt, path: '/tickets' },
      ],
    },
    {
      group: plan === 'voice_booking' ? t('customers') : t('groupCrm') || '客户与运营',
      items: [
        { name: t('customers') || '客户档案 CRM', icon: Users, path: '/customers' },
        { name: t('marketing') || '营销中心', icon: Gift, path: '/marketing' },
        { name: t('rotation') || '技师轮牌', icon: Clock, path: '/rotation' },
        { name: t('rooms') || '包厢工位', icon: BedDouble, path: '/rooms' },
        { name: t('employeePerformance') || '员工中心', icon: TrendingUp, path: '/employee-performance' },
      ],
    },
    {
      group: t('groupFinance') || '财务与报表',
      items: [
        { name: t('businessData') || '经营分析', icon: BarChart, path: '/business-data' },
        { name: t('dayClose') || '打烊日结', icon: FileCheck, path: '/day-close' },
        { name: t('payouts') || '提成结算', icon: CircleDollarSign, path: '/payouts' },
      ],
    },
    {
      // U07：沟通三页（AI 语音 / 消息 / 沟通日志）从「AI 与系统配置」里拆出来单独成组
      group: t('groupComms') || '沟通与客服',
      items: [
        { name: t('calls') || 'AI 语音助手', icon: PhoneCall, path: '/calls' },
        { name: t('messages') || '消息沟通', icon: MessageSquare, path: '/messages' },
        { name: plan === 'voice_booking' ? t('voiceDeliveryTitle') : t('communicationLogs') || '沟通日志', icon: History, path: '/communication-logs' },
      ],
    },
    {
      group: t('groupConfig') || '系统与配置',
      items: [
        { name: t('storefrontBuilder') || '微店建站', icon: Globe, path: '/storefront-builder' },
        { name: t('settings.healthForms'), icon: ClipboardList, path: '/health-forms' },
        // 系统设置进侧栏（此前只在头像菜单里）；可见性与路由权限一致
        ...(canManageSettings
          ? [{ name: t('settings') || '系统设置', icon: Settings, path: '/settings' }]
          : []),
      ],
    },
    {
      // U07：账号入口不再只藏在头像菜单里
      group: t('groupAccount') || '账号与帮助',
      items: [
        { name: t('profile') || '个人资料', icon: UserCircle, path: '/profile' },
        { name: t('support') || '支持', icon: LifeBuoy, path: '/support' },
      ],
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className={cn('gf-app-shell flex h-dvh w-full overflow-hidden bg-slate-50 font-sans text-slate-900', plan === 'voice_booking' && 'gf-voice-shell')}>
      {mobileNavOpen && <button type="button" className="fixed inset-0 z-[89] bg-slate-950/40 lg:hidden" aria-label={t('close')} onClick={() => setMobileNavOpen(false)} />}
      {/* Sidebar */}
      <aside
        id="desk-navigation"
        inert={!wideLayout && !mobileNavOpen}
        className={cn(
          "fixed inset-y-0 left-0 z-[90] flex w-72 max-w-[86vw] flex-col border-r border-slate-200 bg-white transition-transform duration-300 lg:relative lg:z-nav lg:max-w-none lg:translate-x-0",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "lg:w-16" : "lg:w-60"
        )}
      >
        <div className="h-14 flex items-center gap-2.5 px-3.5 border-b border-slate-100 shrink-0">
          {storeAvatar?.customLogoUrl ? (
            <img
              src={storeAvatar.customLogoUrl}
              alt="Logo"
              className="w-7 h-7 rounded-lg object-cover shadow-sm shrink-0"
              onError={() => setStoreAvatar((prev: any) => ({ ...prev, customLogoUrl: '' }))}
            />
          ) : (
            <div
              className={`w-7 h-7 ${storeAvatar?.bg || 'bg-teal-600'} rounded-lg flex items-center justify-center text-white text-sm shadow-sm shrink-0 select-none`}
            >
              {storeAvatar?.icon || <img src="/brand/geniefront-icon-white.svg" alt="" className="h-4 w-4" />}
            </div>
          )}

          {!collapsed && (
            <button
              type="button"
              disabled={!canSwitchLocation}
              onClick={canSwitchLocation ? clearMembership : undefined}
              title={canSwitchLocation ? t('switchLocation') : undefined}
              className={cn(
                "flex flex-1 items-center justify-between p-1 rounded-lg border border-transparent transition-colors text-left",
                canSwitchLocation
                  ? "cursor-pointer hover:bg-slate-50 hover:border-slate-200"
                  : "cursor-default"
              )}
            >
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-slate-900 leading-tight truncate">{storeName}</span>
                {canSwitchLocation && (
                  <span className="text-[10px] text-slate-400">{t('switchLocation')}</span>
                )}
              </div>
              {canSwitchLocation && <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
            </button>
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label={t('collapseSidebar')}
            onClick={() => setCollapsed(!collapsed)}
            className={cn("hidden h-7 w-7 shrink-0 lg:flex", collapsed && "lg:hidden")}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-3 custom-scrollbar">
          {navGroups.map(group => ({ ...group, items: group.items.filter(item => planAllowsPath(plan, item.path) && (plan !== 'voice_booking' || item.path !== '/messages')) })).filter(group => group.items.length > 0).map((group, idx) => (
            <div key={idx} className={plan === 'voice_booking' ? 'mb-1' : 'mb-4'}>
              {!collapsed && plan !== 'voice_booking' && (
                <div className="mb-1 px-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {group.group}
                </div>
              )}
              <ul className="space-y-0.5 px-2">
                {group.items.map((item) => {
                  const isActive = location.pathname.startsWith(item.path);
                  return (
                    <li key={item.path}>
                      <Link
                        to={item.path}
                        onClick={() => {
                          setMobileNavOpen(false);
                          if (item.path === '/schedule') {
                            // 营业日的今天，不是日历日（AUD-13）
                            if (businessToday) setCurrentDate(businessToday);
                          }
                        }}
                        className={cn(
                          "group relative flex items-center rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-teal-50 text-teal-800 font-semibold"
                            : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                        )}
                        title={collapsed ? item.name : undefined}
                      >
                        <item.icon
                          className={cn(
                            "w-4 h-4 shrink-0",
                            collapsed ? "mx-auto" : "mr-2.5",
                            isActive ? "text-teal-600" : "text-slate-400 group-hover:text-slate-600"
                          )}
                        />
                        {!collapsed && <span className="truncate">{item.name}</span>}
                        {isActive && !collapsed && plan !== 'voice_booking' && (
                          <div className="absolute right-2 w-1.5 h-1.5 rounded-full bg-teal-600"></div>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Sidebar Footer */}
        <div className="mt-auto p-4 border-t border-slate-100 bg-slate-50/50 shrink-0 relative" ref={profileMenuRef}>
          <div 
            className="flex items-center gap-3 cursor-pointer hover:bg-white p-2 -m-2 rounded-xl border border-transparent hover:border-slate-200 transition-colors"
            onClick={() => !collapsed && setProfileOpen(!profileOpen)}
          >
            {(() => {
              const activeEmoji =
                PRESET_USER_AVATARS.find((a) => a.id === userAvatar?.presetId) || PRESET_USER_AVATARS[0];
              const activeGrad =
                PRESET_AVATAR_GRADIENTS.find((g) => g.id === userAvatar?.gradientId) || PRESET_AVATAR_GRADIENTS[0];

              if (userAvatar?.mode === 'custom' && userAvatar.customImageUrl) {
                return (
                  <img
                    src={userAvatar.customImageUrl}
                    alt="Avatar"
                    className="w-8 h-8 rounded-full object-cover border border-slate-200 shrink-0"
                    onClick={() => collapsed && setProfileOpen(!profileOpen)}
                    onError={() => setUserAvatar((prev: any) => ({ ...prev, mode: 'emoji' }))}
                  />
                );
              }
              if (userAvatar?.mode === 'emoji' && activeEmoji) {
                return (
                  <div
                    className={`w-8 h-8 rounded-full bg-gradient-to-br ${activeEmoji.bg} shrink-0 flex items-center justify-center text-sm shadow-2xs select-none`}
                    onClick={() => collapsed && setProfileOpen(!profileOpen)}
                  >
                    {activeEmoji.icon}
                  </div>
                );
              }
              return (
                <div
                  className={`w-8 h-8 rounded-full bg-gradient-to-br ${activeGrad?.bg || 'from-teal-500 to-emerald-600'} ${activeGrad?.text || 'text-white'} shrink-0 flex items-center justify-center text-xs font-bold uppercase shadow-2xs`}
                  onClick={() => collapsed && setProfileOpen(!profileOpen)}
                >
                  {(session?.user.email ?? '?').slice(0, 1)}
                </div>
              );
            })()}
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-800 truncate">{session?.user.email ?? '—'}</p>
                <p className="truncate text-xs text-slate-500">
                  {membership?.roleKeys
                    .map((r) => { const k = roleLabelKey(r); return k ? t(k) : r; })
                    .join(' · ') || '—'}
                </p>
              </div>
            )}
          </div>
          
          {profileOpen && (
            <div className={cn("absolute bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-dropdown", collapsed ? "left-full ml-2 bottom-0 w-48" : "bottom-full mb-2 left-4 right-4")}>
              <Link to="/profile" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 font-medium" onClick={() => setProfileOpen(false)}>{t('profile')}</Link>
              {canManageSettings && (
                <Link to="/settings" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 font-medium" onClick={() => setProfileOpen(false)}>{t('settings')}</Link>
              )}
              <Link to="/support" className="block px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 font-medium" onClick={() => setProfileOpen(false)}>{t('support')}</Link>
              <div className="h-px bg-slate-100 my-1"></div>
              <button
                type="button"
                className="w-full text-left block px-4 py-2 text-sm text-red-600 hover:bg-red-50 font-medium transition-colors"
                onClick={() => { setProfileOpen(false); setSignOutConfirmOpen(true); }}
              >
                {t('signOut')}
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Wrapper */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Header */}
        <header className="relative z-nav flex h-14 shrink-0 items-center border-b border-slate-200 bg-white px-3 sm:px-4 lg:h-16 lg:px-6">
          <div className="flex shrink-0 items-center gap-2 lg:gap-3">
            <Button variant="ghost" size="icon" aria-label={t('openNavigation')} aria-expanded={mobileNavOpen} aria-controls="desk-navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)} className="h-9 w-9 shrink-0 lg:hidden">
              <Menu className="h-5 w-5" />
            </Button>
            {collapsed && (
              <Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsed)} className="h-8 w-8 -ml-2 mr-2 shrink-0">
                <Menu className="w-5 h-5" />
              </Button>
            )}

            {/*
              门店身份条。展开态侧栏顶部已经写着门店名，此处只在侧栏收成图标轨
              或退成抽屉时补位 —— 也就是 iPad 的全部形态。多店运营者据此确认
              「当前操作的是哪一家店」，并在有权限时就地切店；缺了它，前台在
              平板上无法从任何常驻位置读到门店身份。
            */}
            {(collapsed || !wideLayout) && (
              <button
                type="button"
                disabled={!canSwitchLocation}
                onClick={canSwitchLocation ? clearMembership : undefined}
                title={canSwitchLocation ? t('switchLocation') : storeName}
                className={cn(
                  "flex min-w-0 max-w-[9rem] items-center gap-1 rounded-lg border border-transparent px-1.5 py-1 text-left transition-colors sm:max-w-[14rem]",
                  canSwitchLocation ? "hover:border-slate-200 hover:bg-slate-50" : "cursor-default",
                )}
              >
                <span className="truncate text-sm font-bold text-slate-900">{storeName}</span>
                {canSwitchLocation && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
              </button>
            )}
          </div>
          
          {/* Global Search Bar - Dead Center with Fuzzy Search Dropdown */}
          <div ref={globalSearchRef} className="group relative mx-3 hidden max-w-xl flex-1 md:flex lg:mx-5">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-teal-600 transition-colors" />
            <input 
              ref={globalInputRef}
              type="text" 
              value={globalQuery}
              onChange={(e) => {
                setGlobalQuery(e.target.value);
                setGlobalSearchOpen(true);
              }}
              onFocus={() => setGlobalSearchOpen(true)}
              placeholder={t('searchPlaceholder')}
              className="w-full h-10 bg-slate-100 hover:bg-slate-200/50 focus:bg-white border border-transparent focus:border-teal-500/30 focus:ring-4 focus:ring-teal-500/10 rounded-xl pl-10 pr-12 text-sm transition-all outline-none text-slate-700 placeholder:text-slate-500 font-medium"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-bold text-slate-400 bg-white border border-slate-200 rounded shadow-sm">⌘K</kbd>
            </div>

            {/* 容错模糊搜索实时建议弹层 */}
            {globalSearchOpen && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl shadow-xl border border-slate-200 py-2 z-dropdown overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150 max-h-96 overflow-y-auto">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <span>{t('search')} ({searchResults.length})</span>
                  <span className="font-normal font-mono">ESC</span>
                </div>
                {searchResults.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-400">{t('noData')}</div>
                ) : (
                  searchResults.map((cmd) => (
                    <button
                      key={cmd.path}
                      type="button"
                      onClick={() => {
                        navigate(cmd.path);
                        setGlobalSearchOpen(false);
                        setGlobalQuery('');
                      }}
                      className="group/item flex w-full items-center justify-between px-3.5 py-3 text-left transition-colors hover:bg-teal-50/70"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <strong className="text-sm font-semibold text-slate-900 group-hover/item:text-teal-800">
                            {cmd.title}
                          </strong>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">{cmd.desc}</p>
                      </div>
                      <span className="text-xs text-teal-600 opacity-0 group-hover/item:opacity-100 transition-opacity font-bold">
                        →
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center justify-end gap-1 sm:gap-2">
            <div className="relative" ref={langMenuRef}>
              <Button variant="ghost" size="icon" aria-label={t('language')} className="relative text-slate-500 hover:text-slate-700" onClick={() => setLangOpen(!langOpen)}>
                <Globe className="w-5 h-5" />
              </Button>
              
              {langOpen && (
                <div className="absolute top-full right-0 mt-2 w-32 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-dropdown">
                  {LANGUAGES.map(({ code, label }) => (
                    <button
                      key={code}
                      onClick={() => {
                        setLanguage(code);
                        setLangOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-4 py-2 text-sm transition-colors",
                        language === code
                          ? "text-teal-600 font-bold bg-teal-50"
                          : "text-slate-600 hover:bg-slate-50 font-medium"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative" ref={notifMenuRef}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('notifications')}
                className="relative text-slate-500 hover:text-slate-700"
                onClick={() => setNotifOpen(!notifOpen)}
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border-2 border-white" />
                )}
              </Button>

              {notifOpen && (
                <div className="absolute right-0 top-full mt-2 w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xl z-dropdown animate-in fade-in slide-in-from-top-2 duration-150">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50/50">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900">{t('notifications')}</span>
                      {unreadCount > 0 && (
                        <span className="px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[10px] font-extrabold">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                    {unreadCount > 0 && (
                      <button
                        onClick={() => markAllNotificationsReadMutation.mutate()}
                        className="text-xs font-bold text-teal-600 hover:text-teal-700 transition-colors"
                      >
                        {t('markAllRead')}
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto divide-y divide-slate-50 custom-scrollbar">
                    {notifications.length === 0 ? (
                      <p className="px-4 py-8 text-center text-xs text-slate-400">{t('noNotifications')}</p>
                    ) : (
                      notifications.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => {
                            if (!n.read) markNotificationReadMutation.mutate({ notificationId: n.id });
                            if (n.actionUrl) {
                              navigate(n.actionUrl);
                              setNotifOpen(false);
                            }
                          }}
                          className={cn(
                            'w-full text-left px-4 py-3 transition-colors hover:bg-slate-50 flex items-start gap-2.5',
                            !n.read && 'bg-teal-50/40',
                          )}
                        >
                          <span
                            className={cn(
                              'w-2 h-2 rounded-full mt-1.5 shrink-0',
                              !n.read ? 'bg-teal-500' : 'bg-transparent',
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <p className={cn('text-xs truncate', !n.read ? 'font-bold text-slate-900' : 'font-medium text-slate-700')}>
                              {n.titleKey ? t(n.titleKey) : n.title}
                            </p>
                            <p className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">{n.message}</p>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="p-2 border-t border-slate-100 bg-slate-50/50">
                    <Link
                      to="/notifications"
                      onClick={() => setNotifOpen(false)}
                      className="block w-full py-2 text-center text-xs font-bold text-teal-700 hover:text-teal-800 hover:bg-white rounded-xl transition-colors"
                    >
                      {t('viewAllNotifications')} →
                    </Link>
                  </div>
                </div>
              )}
            </div>

            <div className="h-6 w-px bg-slate-200 mx-1 hidden sm:block"></div>
            
            <Button
              onClick={() => openCreateAppointment()}
              className="hidden sm:flex bg-teal-600 hover:bg-teal-700 text-white rounded-xl shadow-md gap-2 font-semibold transition-all hover:shadow-lg hover:-translate-y-0.5"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span className="truncate">{t('newAppointment')}</span>
            </Button>
          </div>
        </header>

        {!isOnline && (
          <div
            role="status"
            className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 sm:px-4 lg:px-6"
          >
            <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="text-xs font-medium leading-relaxed">{t('offlineBanner')}</p>
          </div>
        )}

        {/*
          Page Content

          ⚠️ `isolate` 不是可有可无的：header 是 `relative z-nav`，自己开了层叠上下文，
          如果 main 不隔离，页面里随手写个 `z-20`（比如 Schedule 的列头、Queue 的浮层）
          就会直接盖到顶栏和侧栏上面。开了 isolate，页面内的数字只在 main 内部比大小。
        */}
        <main
          tabIndex={-1}
          className="isolate min-h-0 flex-1 overflow-auto bg-[var(--gf-canvas)] p-3 focus:outline-none sm:p-4 lg:p-6"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: prefersReducedMotion ? 1 : 0, y: prefersReducedMotion ? 0 : -4 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: 'easeOut' }}
              className="h-full"
            >
              {/* Inject drawer helpers into nested routes via Outlet Context */}
              {entitlements.data && planAllowsPath(plan, location.pathname) && <Outlet
                context={{
                  setRightDrawerOpen,
                  setActiveAppointmentId,
                  openAppointment: (id?: string | null, status?: 'booked' | 'checked_in' | 'in_service' | 'done') => {
                    setActiveAppointmentId(id ?? null);
                    if (status) {
                      setActiveAppointmentStatus(status);
                    }
                    setRightDrawerOpen(true);
                  },
                  openCreateAppointment,
                }}
              />}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Global Create Appointment Modal */}
        {createModalOptions.isOpen && <Suspense fallback={null}>
          <CreateAppointmentModal
            isOpen
            onClose={() => setCreateModalOptions((prev) => ({ ...prev, isOpen: false }))}
            defaultDate={createModalOptions.defaultDate}
            defaultStaffId={createModalOptions.defaultStaffId}
            defaultTime={createModalOptions.defaultTime}
            defaultCustomerName={createModalOptions.defaultCustomerName}
            defaultPhone={createModalOptions.defaultPhone}
            defaultServiceId={createModalOptions.defaultServiceId}
          />
        </Suspense>}

        {/* Global Right-Side Drawer (Appointment Details) */}
        {rightDrawerOpen && (
          <div className="fixed inset-0 z-drawer flex justify-end overflow-hidden">
            <div
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity"
              onClick={() => {
                setRightDrawerOpen(false);
                setActiveAppointmentId(null);
              }}
            />
            <div className="relative z-10 h-full">
              <Suspense fallback={<div className="grid h-full w-full place-items-center bg-white sm:w-[600px]"><Spinner /></div>}><AppointmentDrawer
                appointmentId={activeAppointmentId}
                initialStatus={activeAppointmentStatus}
                onClose={() => {
                  setRightDrawerOpen(false);
                  setActiveAppointmentId(null);
                }}
              /></Suspense>
            </div>
          </div>
        )}

        {/* Global Right-Side AI Copilot Drawer */}
        {plan !== 'voice_booking' && isCopilotOpen && (
          <div className="fixed inset-0 z-drawer flex justify-end overflow-hidden">
            <div
              className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity"
              onClick={() => setIsCopilotOpen(false)}
            />
            <div className="relative z-10 h-full">
              <Suspense fallback={<div className="grid h-full w-full place-items-center bg-white sm:w-[480px]"><Spinner /></div>}><CopilotDrawer onClose={() => setIsCopilotOpen(false)} /></Suspense>
            </div>
          </div>
        )}

        {/* Floating Copilot AI Button */}
        {plan !== 'voice_booking' && <button
          onClick={() => setIsCopilotOpen(true)}
          aria-label={t('openCopilot')}
          className="absolute bottom-4 right-4 flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-white shadow-xl shadow-slate-900/20 transition-all hover:scale-105 active:scale-95 z-fab group sm:bottom-6 sm:right-6 sm:h-14 sm:w-14 pointer-events-auto"
        >
          <Sparkles className="w-6 h-6 group-hover:text-teal-400 transition-colors" />
          <span className="absolute -top-1 -right-1 flex h-4 w-4">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-4 w-4 bg-teal-500 border-2 border-slate-900"></span>
          </span>
        </button>}

        {/* 退出登录两步确认弹窗 */}
        <ConfirmDialog
          isOpen={signOutConfirmOpen}
          onOpenChange={setSignOutConfirmOpen}
          title={t('settings.signOutConfirmTitle')}
          description={t('settings.signOutConfirmBody')}
          tone="danger"
          confirmLabel={t('settings.signOutConfirmAction')}
          onConfirm={() => void signOut()}
        />
      </div>
    </div>
  );
}
