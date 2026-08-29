import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import { CalendarCheck, UserPlus, Sparkles, ChevronRight } from 'lucide-react';
import { UI_LANGUAGES } from '../i18n/dict';
import type { Language } from '../types';

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { t, pickText, language, setLanguage } = useLanguage();
  const { storeInfo } = useDeviceAuth();

  const storeName = storeInfo ? pickText(storeInfo.locationName, 'GenieFront') : 'GenieFront';

  return (
    <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 max-w-6xl w-full mx-auto select-none overflow-y-auto">
      {/* 欢迎标语区 */}
      <div className="text-center space-y-3 pt-4 sm:pt-8 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-teal-50 border border-teal-200 text-teal-800 text-xs sm:text-sm font-bold shadow-2xs">
          <Sparkles className="w-4 h-4 text-teal-600" />
          <span>{storeName}</span>
        </div>
        <h2 className="text-3xl sm:text-5xl font-black text-slate-900 tracking-tight">
          {t('home.welcome')}
        </h2>
        <p className="text-base sm:text-lg text-slate-500 font-medium max-w-2xl mx-auto">
          {t('home.subtitle')}
        </p>
      </div>

      {/* 核心两大入口卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 my-6 sm:my-10">
        {/* 卡片 1: 有预约 · 签到 */}
        <button
          type="button"
          onClick={() => navigate('/check-in')}
          className="group relative flex flex-col justify-between p-8 sm:p-10 rounded-3xl bg-white border-2 border-teal-200/90 hover:border-teal-600 active:scale-[0.98] shadow-sm hover:shadow-lg transition-all text-left overflow-hidden min-h-[260px]"
        >
          <div className="w-16 h-16 rounded-2xl bg-teal-50 border border-teal-200 text-teal-600 flex items-center justify-center shadow-xs mb-6 group-hover:scale-105 transition-transform">
            <CalendarCheck className="w-9 h-9" />
          </div>

          <div className="space-y-2 z-10">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-slate-900 group-hover:text-teal-700 transition-colors">
              {t('home.hasAppointmentTitle')}
            </h3>
            <p className="text-sm sm:text-base text-slate-500 leading-relaxed font-normal">
              {t('home.hasAppointmentDesc')}
            </p>
          </div>

          <div className="pt-6 flex items-center gap-2 text-teal-600 font-bold text-base group-hover:translate-x-1 transition-transform">
            <span>{t('common.next')}</span>
            <ChevronRight className="w-5 h-5" />
          </div>
        </button>

        {/* 卡片 2: 无预约 · 现场排队取号 */}
        <button
          type="button"
          onClick={() => navigate('/walk-in')}
          className="group relative flex flex-col justify-between p-8 sm:p-10 rounded-3xl bg-white border-2 border-slate-200/90 hover:border-teal-600 active:scale-[0.98] shadow-sm hover:shadow-lg transition-all text-left overflow-hidden min-h-[260px]"
        >
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center shadow-xs mb-6 group-hover:scale-105 transition-transform">
            <UserPlus className="w-9 h-9" />
          </div>

          <div className="space-y-2 z-10">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-slate-900 group-hover:text-teal-700 transition-colors">
              {t('home.walkInTitle')}
            </h3>
            <p className="text-sm sm:text-base text-slate-500 leading-relaxed font-normal">
              {t('home.walkInDesc')}
            </p>
          </div>

          <div className="pt-6 flex items-center gap-2 text-teal-600 font-bold text-base group-hover:translate-x-1 transition-transform">
            <span>{t('common.next')}</span>
            <ChevronRight className="w-5 h-5" />
          </div>
        </button>
      </div>

      {/* 底部语言快捷切换器 */}
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 py-4">
        {UI_LANGUAGES.map((item) => (
          <button
            key={item.code}
            type="button"
            onClick={() => setLanguage(item.code as Language)}
            className={`kiosk-touch-target px-5 py-2.5 rounded-2xl font-bold text-sm transition-all active:scale-95 border ${
              language === item.code
                ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
};
