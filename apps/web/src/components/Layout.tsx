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
  Wallet,
  CircleDollarSign,
  FileCheck,
  Users, 
  Gift,
  TrendingUp,
  PhoneCall,
  MessageSquare,
  History,
  Settings, 
  Server,
  Menu,
  ChevronLeft,
  Bell,
  Search,
  ChevronDown,
  Sparkles,
  Globe,
  MessageCircle,
  Plus,
  Package,
  User,
  ClipboardList,
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

const GLOBAL_COMMANDS = [
  { path: '/dashboard', label: '概览仪表盘', en: 'Dashboard Overview', desc: '实时业绩与客流口碑分析', keywords: 'overview home yibiaopan 仪表盘' },
  { path: '/schedule', label: '日程排班安排', en: 'Schedule & Appointments', desc: '技师排班、新建预约与改期', keywords: 'appointment calendar paiban yuyue 日程 预约' },
  { path: '/queue', label: '运营候客看板', en: 'Live Queue Operations', desc: '进店排查、排队叫号与服务派位', keywords: 'kanban waiting walkin houke jiaohao 看板 候客 叫号' },
  { path: '/checkout', label: '收银结账与开单', en: 'Checkout & POS Register', desc: '工单结算、小费分账与次卡核销', keywords: 'pos shouyin jiezhang payment 收银 结账 开单' },
  { path: '/tickets', label: '订单流水记录', en: 'Tickets & Order History', desc: '历史流水查询、作废与重打小票', keywords: 'dingdan jilu orders receipts 订单 记录' },
  { path: '/rotation', label: '技师轮牌调度', en: 'Staff Rotation & Dispatch', desc: '头牌派位、轮牌规则与请假顶班', keywords: 'lunpai jishi technician staff 轮牌 技师' },
  { path: '/rooms', label: '房间与床位状态', en: 'Room & Bed Management', desc: '包厢工位占用、翻台与清洁倒计时', keywords: 'fangjian room bed baojian 房间 包厢 床位' },
  { path: '/customers', label: '客户管理 CRM', en: 'Customer 360 CRM', desc: '档案画像、健康禁忌、消费力与短信', keywords: 'kehu customer vip profile 客户 会员 档案' },
  { path: '/marketing', label: '营销中心与次卡', en: 'Marketing & Loyalty', desc: '发售次卡、活动优惠券与Gift Card', keywords: 'yingxiao coupon package giftcard cika 营销 优惠券 次卡 Gift Card' },
  { path: '/employee-performance', label: '员工中心与技能', en: 'Staff Directory & Skills', desc: '员工技能等级、可接项目与档案', keywords: 'yuangong staff performance jineng 员工 技师 技能' },
  { path: '/day-close', label: '打烊日结封账', en: 'Day Close & Reconciliation', desc: '点钞对账、差异平账与生成 Z 报表', keywords: 'rijie dayclose endofday 日结 打烊' },
  { path: '/business-data', label: '经营数据分析', en: 'Business Analytics', desc: '全店营收、客单价与技师工时报表', keywords: 'shuju fenxi reports 数据 报表' },
  { path: '/payouts', label: '薪资与提成核算', en: 'Payroll & Commissions', desc: '业绩提成计算与薪资账单明细', keywords: 'xinzi payroll commission 薪资 提成' },
  { path: '/settings', label: '门店系统设置', en: 'Store Settings', desc: '营业时间、硬件设备与权限配置', keywords: 'shezhi settings config 设置 门店' },
  { path: '/support', label: '支持请求', en: 'Support request', desc: '向 GenieFront 提交支持请求', keywords: 'support bangzhu help 支持 帮助' },
  { path: '/profile', label: '个人资料与安全', en: 'Personal Profile & Security', desc: '修改密码、POS PIN码与个人信息', keywords: 'profile gerenziliao mima pin 个人资料 密码' },
  { path: '/notifications', label: '通知中心与动态', en: 'Notification Center', desc: '查看全部业务通知、排班与对账提醒', keywords: 'tongzhi notifications alerts 消息 通知' },
];

export function Layout() {
  const navigate = useNavigate();
  const { setCurrentDate, timezone } = useSchedule();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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

  const storeName = membership ? pickText(membership.locationName, language) : '—';
  /** 多店账号才提供切店入口；单店账号不暴露该概念。 */
  const canSwitchLocation = locations.length > 1;

  // 全局容错模糊搜索命令
  const searchResults = useMemo(() => {
    const commands = GLOBAL_COMMANDS.filter((item) => item.path !== '/settings' || canManageSettings);
    if (!globalQuery.trim()) return commands.slice(0, 6);
    return fuzzySearch(commands, globalQuery, {
      keys: [
        { name: 'label', weight: 0.5 },
        { name: 'en', weight: 0.3 },
        { name: 'desc', weight: 0.2 },
        { name: 'keywords', weight: 0.4 },
      ],
      threshold: 0.45,
    });
  }, [globalQuery, canManageSettings]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        globalInputRef.current?.focus();
        setGlobalSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setGlobalSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
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
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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
      group: t('groupCrm') || '客户与运营',
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
      group: t('groupAdmin') || 'AI 与系统配置',
      items: [
        { name: t('notificationCenter') || '通知中心', icon: Bell, path: '/notifications', badge: unreadCount },
        { name: t('calls') || 'AI 语音助手', icon: PhoneCall, path: '/calls' },
        { name: t('messages') || '消息沟通', icon: MessageSquare, path: '/messages' },
        { name: t('communicationLogs') || '沟通日志', icon: History, path: '/communication-logs' },
        { name: t('storefrontBuilder') || '微店建站', icon: Globe, path: '/storefront-builder' },
        { name: t('settings.healthForms'), icon: ClipboardList, path: '/health-forms' },
        { name: t('support') || 'Support', icon: LifeBuoy, path: '/support' },
        ...(canManageSettings
          ? [{ name: t('settings') || '系统设置', icon: Settings, path: '/settings' }]
          : []),
        { name: t('profile') || '个人资料', icon: User, path: '/profile' },
      ],
    },
  ];

  let pageTitle = 'Dashboard';
  if (location.pathname.startsWith('/profile')) {
    pageTitle = t('profile') || '个人资料';
  } else if (location.pathname.startsWith('/notifications')) {
    pageTitle = t('notificationCenter') || '通知中心';
  } else {
    for (const group of navGroups) {
      const activeItem = group.items.find((item) => location.pathname.startsWith(item.path));
      if (activeItem) {
        pageTitle = activeItem.name;
        break;
      }
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-slate-50 font-sans text-slate-900">
      {mobileNavOpen && <button type="button" className="fixed inset-0 z-[89] bg-slate-950/40 lg:hidden" aria-label={t('close')} onClick={() => setMobileNavOpen(false)} />}
      {/* Sidebar */}
      <aside
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
          {navGroups.map((group, idx) => (
            <div key={idx} className="mb-4">
              {!collapsed && (
                <div className="px-4 mb-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
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
                          "flex items-center px-2.5 py-1.5 rounded-lg transition-all group relative text-xs font-semibold",
                          isActive
                            ? "bg-teal-50 text-teal-800 font-bold shadow-xs"
                            : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900"
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
                        {!collapsed && (item as any).badge !== undefined && (item as any).badge > 0 && (
                          <span className="ml-auto shrink-0 px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[10px] font-black">
                            {(item as any).badge}
                          </span>
                        )}
                        {isActive && !collapsed && (
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
                <p className="text-[10px] text-slate-500 truncate">
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
        <header className="relative z-nav flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 shadow-sm sm:px-4 lg:h-16 lg:px-6">
          <div className="flex min-w-0 items-center gap-2 lg:w-48 lg:shrink-0 lg:gap-4">
            <Button variant="ghost" size="icon" aria-label={t('openNavigation')} onClick={() => setMobileNavOpen(true)} className="h-9 w-9 shrink-0 lg:hidden">
              <Menu className="h-5 w-5" />
            </Button>
            {collapsed && (
              <Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsed)} className="h-8 w-8 -ml-2 mr-2 shrink-0">
                <Menu className="w-5 h-5" />
              </Button>
            )}
            {/* Breadcrumb / Title */}
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center text-xs text-slate-400 font-medium">
                <span className="hidden sm:inline">App</span>
                <span className="mx-1.5 hidden sm:inline">/</span>
                <span className="max-w-[42vw] truncate text-sm font-semibold text-teal-700 sm:max-w-[120px] sm:text-xs">{pageTitle}</span>
              </div>
            </div>
          </div>
          
          {/* Global Search Bar - Dead Center with Fuzzy Search Dropdown */}
          <div ref={globalSearchRef} className="flex-1 max-w-xl mx-4 hidden md:flex relative group">
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
                <div className="px-3 py-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider flex justify-between items-center border-b border-slate-100">
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
                      className="w-full text-left px-3.5 py-2.5 hover:bg-teal-50/70 transition-colors flex items-center justify-between group/item"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <strong className="text-slate-900 text-xs group-hover/item:text-teal-800 font-bold">
                            {language === 'en' ? cmd.en : cmd.label}
                          </strong>
                          <span className="text-[10px] text-slate-400 font-mono">({cmd.path})</span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">{cmd.desc}</p>
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

          <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2 lg:w-48">
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
          className="isolate min-h-0 flex-1 overflow-auto bg-slate-50/50 p-3 focus:outline-none sm:p-4 lg:p-6"
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
              <Outlet
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
              />
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
        {isCopilotOpen && (
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
        <button 
          onClick={() => setIsCopilotOpen(true)}
          aria-label={t('openCopilot')}
          className="absolute bottom-4 right-4 flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-white shadow-xl shadow-slate-900/20 transition-all hover:scale-105 active:scale-95 z-fab group sm:bottom-6 sm:right-6 sm:h-14 sm:w-14"
        >
          <Sparkles className="w-6 h-6 group-hover:text-teal-400 transition-colors" />
          <span className="absolute -top-1 -right-1 flex h-4 w-4">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-4 w-4 bg-teal-500 border-2 border-slate-900"></span>
          </span>
        </button>

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
