import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { PlatformSessionProvider, usePlatformSession } from './lib/session';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { AccessDenied } from './pages/AccessDenied';
import { Dashboard } from './pages/Dashboard';
import { Stores } from './pages/Stores';
import { StoreDetail } from './pages/StoreDetail';
import { Support } from './pages/Support';
import { SupportDetail } from './pages/SupportDetail';
import { TenDlc } from './pages/TenDlc';
import { TenDlcDetail } from './pages/TenDlcDetail';
import { WebsiteRequests } from './pages/WebsiteRequests';
import { WebsiteRequestDetail } from './pages/WebsiteRequestDetail';
import { Audit } from './pages/Audit';

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
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
