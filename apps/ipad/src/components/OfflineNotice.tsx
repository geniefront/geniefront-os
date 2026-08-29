import React, { useState, useEffect } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useDeviceAuth } from '../context/DeviceAuthContext';

export const OfflineNotice: React.FC = () => {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const { t, pickText } = useLanguage();
  const { storeInfo } = useDeviceAuth();

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  const locationName = storeInfo ? pickText(storeInfo.locationName, 'Store') : 'Kiosk';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/70 backdrop-blur-xs select-none">
      <div className="w-full max-w-lg rounded-3xl bg-white border border-slate-200 shadow-2xl p-8 space-y-6 text-center">
        <div className="w-20 h-20 rounded-3xl bg-rose-50 border border-rose-200 text-rose-600 mx-auto flex items-center justify-center">
          <WifiOff className="w-10 h-10" />
        </div>

        <div className="space-y-2">
          <h3 className="text-2xl font-bold text-slate-900">{t('offline.title')}</h3>
          <p className="text-sm font-bold text-teal-700">{locationName}</p>
          <p className="text-sm text-slate-500 leading-relaxed max-w-md mx-auto">
            {t('offline.message')}
          </p>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="kiosk-touch-target px-8 py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white font-bold text-base shadow-sm inline-flex items-center gap-2 transition-transform active:scale-95"
          >
            <RefreshCw className="w-5 h-5" />
            <span>{t('common.retry')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
