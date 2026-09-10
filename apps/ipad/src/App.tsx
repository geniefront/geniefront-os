import React, { useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useDeviceAuth } from './context/DeviceAuthContext';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { InactivityTimer } from './components/InactivityTimer';
import { OfflineNotice } from './components/OfflineNotice';
import { InstallGuideModal } from './components/InstallGuideModal';
import { PairingPage } from './pages/PairingPage';
import { HomePage } from './pages/HomePage';
import { CheckInLookupPage } from './pages/CheckInLookupPage';
import { WalkInPage } from './pages/WalkInPage';
import { HealthFormPage } from './pages/HealthFormPage';
import { SuccessTicketPage } from './pages/SuccessTicketPage';
import { Loader2 } from 'lucide-react';

const KioskLayout: React.FC = () => {
  const { isPaired, isLoading, onResetHomeCommand } = useDeviceAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isHome = location.pathname === '/';
  const isPairing = location.pathname === '/pair';

  // 远程后台命令 reset_home
  useEffect(() => {
    if (!onResetHomeCommand) return;
    const unsub = onResetHomeCommand(() => {
      navigate('/');
    });
    return unsub;
  }, [navigate, onResetHomeCommand]);

  const handleInactivityTimeout = useCallback(() => {
    if (!isHome && !isPairing) {
      navigate('/');
    }
  }, [isHome, isPairing, navigate]);

  if (isLoading) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-slate-50 text-slate-500 space-y-4">
        <Loader2 className="w-10 h-10 animate-spin text-teal-600" />
        <p className="text-sm font-bold tracking-wide text-slate-700">Connecting Kiosk Terminal…</p>
      </div>
    );
  }

  // 若设备未配对，强制显示配对页
  if (!isPaired && !isPairing) {
    return <Navigate to="/pair" replace />;
  }

  // 若设备已配对且当前在配对页，自动重定向到主页
  if (isPaired && isPairing) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="h-full w-full flex flex-col bg-slate-50 text-slate-900 overflow-hidden relative font-sans">
      <Header />

      <main className="min-h-0 flex-1 flex flex-col overflow-y-auto relative">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/pair" element={<PairingPage />} />
          <Route path="/check-in" element={<CheckInLookupPage />} />
          <Route path="/walk-in" element={<WalkInPage />} />
          <Route path="/health-form" element={<HealthFormPage />} />
          <Route path="/success" element={<SuccessTicketPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <Footer />

      {/* 无操作超时保护：3 分钟未操作自动重置并清空 */}
      <InactivityTimer
        enabled={!isHome && !isPairing}
        idleTimeoutSeconds={180}
        countdownSeconds={15}
        onTimeout={handleInactivityTimeout}
      />

      {/* 断网提示 */}
      <OfflineNotice />

      {/* PWA 安装引导 */}
      <InstallGuideModal />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <KioskLayout />
    </BrowserRouter>
  );
};
