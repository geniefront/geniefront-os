import React, { useState, useEffect } from 'react';
import { Share, PlusSquare, Smartphone, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

export const InstallGuideModal: React.FC = () => {
  const { t } = useLanguage();
  const [isStandalone, setIsStandalone] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('gf_kiosk_pwa_dismissed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // 检测是否在 iOS / iPadOS PWA 独立窗口中运行
    const standalone =
      (window.navigator as any).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    setIsStandalone(standalone);
  }, []);

  const handleDismiss = () => {
    setIsDismissed(true);
    try {
      sessionStorage.setItem('gf_kiosk_pwa_dismissed', '1');
    } catch {
      // Ignore
    }
  };

  if (isStandalone || isDismissed) return null;

  return (
    <>
      {/* 底部悬浮提示条 */}
      <div className="fixed bottom-6 left-6 right-6 sm:left-auto sm:right-6 sm:max-w-md z-40 flex items-center justify-between gap-3 p-3 sm:p-3.5 rounded-2xl bg-white/95 border border-teal-200 backdrop-blur-md shadow-xl text-xs text-slate-800 animate-slide-up">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-teal-50 border border-teal-200 text-teal-600 flex items-center justify-center shrink-0">
            <Smartphone className="w-4 h-4" />
          </div>
          <span className="font-bold text-slate-800 truncate">
            {t('pwa.installPrompt')}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="kiosk-touch-target px-3.5 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-700 active:bg-teal-800 text-white font-bold text-xs shadow-2xs transition-colors"
          >
            {t('common.next')}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Close"
            className="w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-700 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 安装步骤引导弹窗 */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-xs animate-fade-in select-none">
          <div className="w-full max-w-lg rounded-3xl bg-white border border-slate-200 shadow-2xl p-7 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <Smartphone className="w-6 h-6 text-teal-600" />
                <span>{t('pwa.installPrompt')}</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3.5 text-slate-700 text-sm">
              <div className="flex items-start gap-3 p-4 rounded-2xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-xl bg-teal-50 border border-teal-200 text-teal-600 flex items-center justify-center shrink-0">
                  <Share className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold">{t('pwa.step1')}</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-4 rounded-2xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-xl bg-teal-50 border border-teal-200 text-teal-600 flex items-center justify-center shrink-0">
                  <PlusSquare className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold">{t('pwa.step2')}</p>
                </div>
              </div>

              <div className="flex items-start gap-3 p-4 rounded-2xl bg-slate-50 border border-slate-200">
                <div className="w-8 h-8 rounded-xl bg-teal-50 border border-teal-200 text-teal-600 flex items-center justify-center shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-semibold">{t('pwa.step3')}</p>
                </div>
              </div>
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  handleDismiss();
                }}
                className="kiosk-touch-target px-6 py-3 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm shadow-xs transition-colors"
              >
                {t('pwa.gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
