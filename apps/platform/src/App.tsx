import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PlatformSessionProvider, usePlatformSession } from './lib/session';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { AccessDenied } from './pages/AccessDenied';

// The operator console has several data-heavy administration surfaces. Loading
// them with the authentication shell made every visit download the whole app,
// including screens an operator might never open. Keep login and access-denied
// synchronous, then split authenticated pages at route boundaries.
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Stores = lazy(() => import('./pages/Stores').then((m) => ({ default: m.Stores })));
const StoreDetail = lazy(() => import('./pages/StoreDetail').then((m) => ({ default: m.StoreDetail })));
const Support = lazy(() => import('./pages/Support').then((m) => ({ default: m.Support })));
const SupportDetail = lazy(() => import('./pages/SupportDetail').then((m) => ({ default: m.SupportDetail })));
const TenDlc = lazy(() => import('./pages/TenDlc').then((m) => ({ default: m.TenDlc })));
const TenDlcDetail = lazy(() => import('./pages/TenDlcDetail').then((m) => ({ default: m.TenDlcDetail })));
const WebsiteRequests = lazy(() => import('./pages/WebsiteRequests').then((m) => ({ default: m.WebsiteRequests })));
const WebsiteRequestDetail = lazy(() => import('./pages/WebsiteRequestDetail').then((m) => ({ default: m.WebsiteRequestDetail })));
const Audit = lazy(() => import('./pages/Audit').then((m) => ({ default: m.Audit })));
const TestInbox = lazy(() => import('./pages/TestInbox').then((m) => ({ default: m.TestInbox })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function SessionGate() {
  const { status, retry } = usePlatformSession();

  if (status === 'loading') {
    return <div className="min-h-screen grid place-items-center text-slate-500">Loading…</div>;
  }
  if (status === 'unauthenticated') return <Login />;
  if (status === 'denied') return <AccessDenied />;
  if (status === 'error') {
    return (
      <div className="min-h-screen grid place-items-center">
        <button type="button" className="rounded-lg bg-slate-900 text-white px-4 py-2" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="min-h-screen grid place-items-center text-slate-500">Loading…</div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/stores" element={<Stores />} />
          <Route path="/stores/:locationId" element={<StoreDetail />} />
          <Route path="/support" element={<Support />} />
          <Route path="/support/:id" element={<SupportDetail />} />
          <Route path="/10dlc" element={<TenDlc />} />
          <Route path="/10dlc/:locationId" element={<TenDlcDetail />} />
          <Route path="/website-requests" element={<WebsiteRequests />} />
          <Route path="/website-requests/:briefId" element={<WebsiteRequestDetail />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/test-inbox" element={<TestInbox />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PlatformSessionProvider>
        <BrowserRouter>
          <SessionGate />
        </BrowserRouter>
      </PlatformSessionProvider>
    </QueryClientProvider>
  );
}
