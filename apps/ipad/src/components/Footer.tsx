import React, { useState } from 'react';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import { useLanguage } from '../context/LanguageContext';
import { Tablet, Unlink, AlertTriangle } from 'lucide-react';

export const Footer: React.FC = () => {
  const { storeInfo, isPaired, unpairDevice } = useDeviceAuth();
  const { t, pickText } = useLanguage();
  const [showUnpairModal, setShowUnpairModal] = useState(false);

  if (!isPaired || !storeInfo) return null;

  const locationName = pickText(storeInfo.locationName, 'GenieFront');

  return (
    <>
      <footer className="w-full bg-white border-t border-slate-200/90 px-6 sm:px-8 py-2.5 flex items-center justify-between text-xs text-slate-500 select-none shrink-0 shadow-2xs">
        <div className="flex items-center gap-2 font-medium">
          <Tablet className="w-3.5 h-3.5 text-teal-600" />
          <span className="text-slate-600">{storeInfo.deviceLabel || 'iPad Kiosk Terminal'}</span>
          <span className="text-slate-300">•</span>
          <span>
            {t('footer.pairedStore')}: <strong className="text-slate-800 font-bold">{locationName}</strong>
          </span>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setShowUnpairModal(true)}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600 active:scale-95"
          >
            <Unlink className="w-3 h-3" />
            <span>{t('footer.unpair')}</span>
          </button>
        </div>
      </footer>

      {/* 解除配对确认弹窗 */}
      {showUnpairModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
          <div className="w-full max-w-md rounded-3xl bg-white border border-slate-200 shadow-2xl p-6 space-y-5">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-2xl bg-rose-100 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-lg font-bold text-slate-900">{t('footer.unpairConfirmTitle')}</h3>
            </div>

            <p className="text-sm text-slate-600 leading-relaxed">
              {t('footer.unpairConfirmDesc')}
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowUnpairModal(false)}
                className="kiosk-touch-target px-5 py-2.5 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUnpairModal(false);
                  unpairDevice();
                }}
                className="kiosk-touch-target px-5 py-2.5 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm shadow-sm transition-colors"
              >
                {t('footer.unpair')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
