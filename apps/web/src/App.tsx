import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useOutletContext } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toast, Spinner } from '@heroui/react';
import { SessionProvider, useSession } from './lib/session';
import { queryClient } from './lib/queryClient';
import { LanguageProvider } from './LanguageContext';
import { ScheduleProvider } from './context/ScheduleContext';
import { AuthLayout } from './components/AuthLayout';

/*
 * 登录页与主壳层静态引入 —— 二者是每次访问的必经路径，
 * 拆分出去只会在首屏多一次往返并导致可见的白屏。
 */
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { LocationPicker } from './pages/LocationPicker';
import { NoMembership } from './pages/NoMembership';

/*
 * 业务页面按路由懒加载。
 *
 * ⚠️ 此前全部页面在 App.tsx 顶部静态引入，构建产物为单个 4.0 MB 的 JS
 * （gzip 后 912 KB），即登录页也要先下载整个后台。门店前台终端与网络条件
 * 普遍不佳，该体积直接表现为开店时的长时间白屏。
 */
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const BusinessData = lazy(() => import('./pages/BusinessData').then((m) => ({ default: m.BusinessData })));
const Schedule = lazy(() => import('./pages/Schedule').then((m) => ({ default: m.Schedule })));
const Queue = lazy(() => import('./pages/Queue').then((m) => ({ default: m.Queue })));
const Rotation = lazy(() => import('./pages/Rotation').then((m) => ({ default: m.Rotation })));
const Rooms = lazy(() => import('./pages/Rooms').then((m) => ({ default: m.Rooms })));
const Tickets = lazy(() => import('./pages/Tickets').then((m) => ({ default: m.Tickets })));
const Checkout = lazy(() => import('./pages/Checkout').then((m) => ({ default: m.Checkout })));
const Payouts = lazy(() => import('./pages/Payouts').then((m) => ({ default: m.Payouts })));
const DayClose = lazy(() => import('./pages/DayClose').then((m) => ({ default: m.DayClose })));
const Customers = lazy(() => import('./pages/Customers').then((m) => ({ default: m.Customers })));
const Marketing = lazy(() => import('./pages/Marketing').then((m) => ({ default: m.Marketing })));
const EmployeePerformance = lazy(() => import('./pages/EmployeePerformance').then((m) => ({ default: m.EmployeePerformance })));
const Calls = lazy(() => import('./pages/Calls').then((m) => ({ default: m.Calls })));
const Messages = lazy(() => import('./pages/Messages').then((m) => ({ default: m.Messages })));
const CommunicationLogs = lazy(() => import('./pages/CommunicationLogs').then((m) => ({ default: m.CommunicationLogs })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const StorefrontBuilder = lazy(() => import('./pages/StorefrontBuilder').then((m) => ({ default: m.StorefrontBuilder })));
const HardwareServer = lazy(() => import('./pages/HardwareServer').then((m) => ({ default: m.HardwareServer })));
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })));
const Notifications = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.Notifications })));
const UnderConstruction = lazy(() => import('./pages/UnderConstruction').then((m) => ({ default: m.UnderConstruction })));

/**
 * 懒加载页面的过渡态。与 SessionGate 的加载态保持一致的视觉表现。
 *
 * ⚠️ **必须把 outlet context 原样透传下去。**
 * `Layout` 通过 `<Outlet context={...}>` 向页面注入抽屉控制函数
 * （`Queue`、`Schedule`、`Calls` 依赖它打开预约抽屉）。此处若渲染裸的
 * `<Outlet />`，最近一层 outlet 便不带 context，子页面的
 * `useOutletContext()` 会取到 undefined 并在解构时直接抛错整页崩溃。
 */
function SuspendedOutlet() {
  const outletContext = useOutletContext();
  return (
    <Suspense
      fallback={
        <div className="min-h-[60vh] grid place-items-center">
          <Spinner />
        </div>
      }
    >
      <Outlet context={outletContext} />
    </Suspense>
  );
}

/**
 * 会话门禁。
 *
 * 应用的可达范围由服务端返回的会话状态决定，而非由路由本身控制 ——
 * 未认证或未选定门店时，主应用的路由树不会被挂载，因此不存在
 * 「直接输入 URL 绕过登录」的路径，也不会出现组件在无 membership 的情况下
 * 发起带店请求。
 */
function SessionGate() {
  const { status } = useSession();

  if (status === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50">
        <Spinner />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="*" element={<Login />} />
        </Route>
      </Routes>
    );
  }

  // 选店、无门店、加载失败三种状态共用认证外壳；LocationPicker 自行呈现错误态。
  if (status === 'selecting' || status === 'no-membership' || status === 'error') {
    return (
      <Routes>
        <Route element={<AuthLayout />}>
          <Route
            path="*"
            element={status === 'no-membership' ? <NoMembership /> : <LocationPicker />}
          />
        </Route>
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Main Application (Dashboard Layout) */}
      <Route path="/" element={<Layout />}>
        {/*
          懒加载页面的挂起边界置于 Layout 之内 —— 置于外层会令侧边栏与顶栏
          在每次切换页面时一并消失，视觉上等同于整页重载。
        */}
        <Route element={<SuspendedOutlet />}>
          <Route index element={<Navigate to="/dashboard" replace />} />

          {/* Group 1: Dashboard & Analytics */}
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="business-data" element={<BusinessData />} />
          <Route path="community" element={<UnderConstruction titleKey="community" />} />
          <Route path="subscription" element={<Navigate to="/settings?tab=billing" replace />} />

          {/* Group 2: Front-Desk Operations */}
          <Route path="schedule" element={<Schedule />} />
          <Route path="queue" element={<Queue />} />
          <Route path="rotation" element={<Rotation />} />
          <Route path="rooms" element={<Rooms />} />

          {/* Group 3: Finance & Checkout */}
          <Route path="tickets" element={<Tickets />} />
          <Route path="checkout" element={<Checkout />} />
          <Route path="payouts" element={<Payouts />} />
          <Route path="day-close" element={<DayClose />} />

          {/* Group 4: CRM & Marketing */}
          <Route path="customers/*" element={<Customers />} />
          <Route path="marketing" element={<Marketing />} />
          <Route path="employee-performance" element={<EmployeePerformance />} />

          {/* Group 5: Communications */}
          <Route path="calls" element={<Calls />} />
          <Route path="messages" element={<Messages />} />
          <Route path="communication-logs" element={<CommunicationLogs />} />

          {/* Group 6: System Settings & Hardware */}
          <Route path="settings" element={<Settings />} />
          <Route path="storefront-builder" element={<StorefrontBuilder />} />
          <Route path="hardware-server" element={<HardwareServer />} />
          <Route path="profile" element={<Profile />} />
          <Route path="notifications" element={<Notifications />} />

          {/* 未知路径回落到概览，避免深链失效后停留在空白页 */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <SessionProvider>
        <ScheduleProvider>
          <BrowserRouter>
            <SessionGate />
          </BrowserRouter>

          {/*
            全局提示条。放在路由外面 —— 提示不该跟着页面一起被卸载
            （比如「Refunded」弹出来的同时前台就切走了，那条提示还得让她看见）。
          */}
          <Toast.Provider placement="bottom" />
        </ScheduleProvider>
        </SessionProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}
