import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import { useLanguage } from '../context/LanguageContext';
import { UI_LANGUAGES } from '../i18n/dict';
import type { Language } from '../types';
import { Globe, Calendar, RotateCcw, AlertTriangle } from 'lucide-react';

export const Header: React.FC = () => {
  const { storeInfo, isPaired } = useDeviceAuth();
  const { language, setLanguage, t, pickText } = useLanguage();
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isHome = location.pathname === '/';
  const isPairing = location.pathname === '/pair';
  const locationName = storeInfo ? pickText(storeInfo.locationName, 'GenieFront') : 'GenieFront Kiosk';

  const handleResetToHome = () => {
    setShowResetConfirm(false);
    navigate('/', { replace: true });
  };

  return (
    <>
      <header className="w-full bg-white/95 backdrop-blur-md border-b border-slate-200/90 px-6 sm:px-8 py-3.5 flex items-center justify-between z-30 shrink-0 select-none shadow-xs">
        {/* 门店名称与状态 */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#F2FAF3] flex items-center justify-center shadow-sm border border-[#d8eadb]">
            <img src="/brand/geniefront-icon.svg" alt="" className="h-7 w-7" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                {locationName}
              </h1>
              {isPaired && (
                <span className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2.5 py-0.5 text-xs font-bold text-teal-700">
                  Kiosk
                </span>
              )}
            </div>
            {storeInfo?.businessDate && (
              <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-0.5 font-medium">
                <Calendar className="w-3.5 h-3.5 text-teal-600" />
                <span>
                  {t('header.businessDate')}: {storeInfo.businessDate}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 右侧操作区：重置与多语言切换；离线状态由全局 OfflineNotice 统一提示 */}
        <div className="flex items-center gap-2.5 sm:gap-3">
          {/* 单独的重置/返回首页按钮 (仅在子流程页面显示) */}
          {!isHome && !isPairing && (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="kiosk-touch-target px-3.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 active:bg-rose-200 border border-rose-200 text-rose-700 font-bold text-xs sm:text-sm flex items-center gap-1.5 transition-colors active:scale-95 shadow-2xs"
            >
              <RotateCcw className="w-4 h-4 text-rose-600" />
              <span>{t('header.resetHome')}</span>
            </button>
          )}

          {/* 语言选择下拉/切换 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsLangOpen(!isLangOpen)}
              className="kiosk-touch-target px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 active:bg-slate-300 border border-slate-200 text-slate-800 font-bold text-xs sm:text-sm flex items-center gap-2 transition-colors active:scale-95 shadow-2xs"
            >
              <Globe className="w-4 h-4 text-teal-600" />
              <span>{UI_LANGUAGES.find((l) => l.code === language)?.label || 'Language'}</span>
            </button>

            {isLangOpen && (
              <>
                <div
                  className="fixed inset-0 z-40 bg-black/20"
                  onClick={() => setIsLangOpen(false)}
                />
                <div className="absolute right-0 mt-2 w-48 rounded-2xl bg-white border border-slate-200 shadow-xl p-2 z-50 space-y-1 animate-scale-in">
                  {UI_LANGUAGES.map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      onClick={() => {
                        setLanguage(item.code as Language);
                        setIsLangOpen(false);
                      }}
                      className={`w-full text-left px-4 py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-between ${
                        language === item.code
                          ? 'bg-teal-600 text-white shadow-sm'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span>{item.label}</span>
                      {language === item.code && <span className="text-xs font-black">✓</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* 重置清空确认弹窗 */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-xs animate-fade-in select-none">
          <div className="w-full max-w-md rounded-3xl bg-white border border-slate-200 shadow-2xl p-7 space-y-5">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-12 h-12 rounded-2xl bg-rose-100 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">{t('header.resetConfirmTitle')}</h3>
              </div>
            </div>

            <p className="text-sm text-slate-600 leading-relaxed">
              {t('header.resetConfirmDesc')}
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="kiosk-touch-target px-5 py-2.5 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleResetToHome}
                className="kiosk-touch-target px-5 py-2.5 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm shadow-sm transition-colors"
              >
                {t('header.resetHome')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
