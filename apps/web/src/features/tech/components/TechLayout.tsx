import { useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import {
  Sparkles,
  TrendingUp,
  User,
  Coffee,
  Play,
  Store,
  Globe,
  ChevronDown,
} from 'lucide-react';
import { pickText } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { UI_LANGUAGES } from '@/i18n';
import { useErrorMessage } from '@/lib/errorMessage';
import { useTechLocaleMutation, useTechTodayQuery } from '../api';
import { useTechRealtime } from '../lib/useTechRealtime';

export function TechLayout() {
  const { t, language, setLanguage } = useLanguage();
  const errorMessage = useErrorMessage();
  const { membership, locations, clearMembership, isTechCapable, isOnline } = useSession();
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const todayQuery = useTechTodayQuery();
  const localeMutation = useTechLocaleMutation();
  const { connection, assignmentFlash } = useTechRealtime();

  const onDuty = todayQuery.data?.onDuty ?? false;
  const onBreak = todayQuery.data?.rotation.onBreak ?? false;

  if (!isTechCapable) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-slate-100 flex justify-center font-sans text-slate-900">
      {/* 居中移动端 App 容器 (无论在手机或电脑打开都保持优雅的 App 质感) */}
      <div className="w-full max-w-md min-h-screen bg-slate-50 shadow-2xl flex flex-col relative border-x border-slate-200/80">
        {/* 顶部白色导航栏 */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-4 py-3 flex items-center justify-between shadow-2xs pt-[env(safe-area-inset-top,12px)]">
          {/* 左侧：店铺名称 */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={locations.length > 1 ? clearMembership : undefined}
              className={`flex items-center gap-2 px-2 py-1 rounded-xl text-left transition-all ${
                locations.length > 1
                  ? 'bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-800'
                  : 'text-slate-900 cursor-default'
              }`}
            >
              <div className="w-7 h-7 rounded-lg bg-teal-600 text-white flex items-center justify-center shrink-0 shadow-2xs">
                <Store className="w-4 h-4" />
              </div>
              <span className="text-sm font-bold truncate max-w-[150px] tracking-tight">
                {membership ? pickText(membership.locationName, language) : 'GenieFront Spa'}
              </span>
              {locations.length > 1 && <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
            </button>
          </div>

          {/* 右侧：在岗/暂休状态与多语言 */}
          <div className="flex items-center gap-2 shrink-0">
            {onDuty && (
              <div
                role="status"
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold transition-all active:scale-95 ${
                  onBreak
                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                    : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                }`}
              >
                <span className="relative flex h-2 w-2">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                      onBreak ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                  />
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      onBreak ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                  />
                </span>
                {onBreak ? <Coffee className="w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
                <span>{onBreak ? t('onBreak') : t('onDuty')}</span>
              </div>
            )}

            {/* 语言切换菜单 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setLangMenuOpen(!langMenuOpen)}
                className="p-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors border border-slate-200"
                aria-label={t('preferredLanguage')}
              >
                <Globe className="w-4 h-4" />
              </button>

              {langMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setLangMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-36 bg-white rounded-2xl shadow-2xl border border-slate-200 py-1.5 z-50 text-slate-800 text-sm overflow-hidden animate-in zoom-in-95 duration-150">
                    <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      {t('preferredLanguage')}
                    </div>
                    {UI_LANGUAGES.map((l) => (
                      <button
                        key={l.code}
                        type="button"
                        onClick={() => {
                          const previousLanguage = language;
                          setLanguage(l.code);
                          localeMutation.mutate(l.code, {
                            onError: () => setLanguage(previousLanguage),
                          });
                          setLangMenuOpen(false);
                        }}
                        className={`w-full px-3.5 py-2 text-left text-xs flex items-center justify-between hover:bg-slate-50 transition-colors ${
                          language === l.code ? 'font-bold text-teal-700 bg-teal-50' : 'text-slate-700'
                        }`}
                      >
                        <span>{l.label}</span>
                        {language === l.code && <span className="w-2 h-2 rounded-full bg-teal-600" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {localeMutation.isError && (
          <div role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-center text-[11px] font-semibold text-rose-800">
            {errorMessage(localeMutation.error)}
          </div>
        )}

        {!isOnline && (
          <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-[11px] font-semibold text-amber-900">
            {t('offlineBanner')}
          </div>
        )}
        {isOnline && connection !== 'live' && (
          <div role="status" className="border-b border-slate-200 bg-slate-100 px-4 py-2 text-center text-[11px] font-semibold text-slate-600">
            {connection === 'connecting' ? t('techRealtimeConnecting') : t('techRealtimeDown')}
          </div>
        )}
        {assignmentFlash && (
          <div role="alert" className="border-b border-teal-300 bg-teal-600 px-4 py-3 text-center text-sm font-extrabold text-white shadow-sm">
            {t('techNewAssignment')}
          </div>
        )}

        {/* 页面主内容区域 (底部留出足够空间，确保不被底栏遮挡) */}
        <main className="p-4 flex-1 flex flex-col pb-28">
          <Outlet />
        </main>

        {/* 底部触控导航栏 */}
        <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200/80 shadow-lg pb-[env(safe-area-inset-bottom,8px)]">
          <div className="max-w-md mx-auto px-6 grid grid-cols-3 gap-2 py-2">
            <NavLink
              to="/tech/today"
              className={({ isActive }) =>
                `flex flex-col items-center justify-center py-1.5 rounded-2xl text-xs font-bold transition-all active:scale-95 ${
                  isActive
                    ? 'text-teal-700 bg-teal-50 shadow-2xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`
              }
            >
              <Sparkles className="w-5 h-5 mb-0.5" />
              <span>{t('navToday')}</span>
            </NavLink>

            <NavLink
              to="/tech/summary"
              className={({ isActive }) =>
                `flex flex-col items-center justify-center py-1.5 rounded-2xl text-xs font-bold transition-all active:scale-95 ${
                  isActive
                    ? 'text-teal-700 bg-teal-50 shadow-2xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`
              }
            >
              <TrendingUp className="w-5 h-5 mb-0.5" />
              <span>{t('navSummary')}</span>
            </NavLink>

            <NavLink
              to="/tech/profile"
              className={({ isActive }) =>
                `flex flex-col items-center justify-center py-1.5 rounded-2xl text-xs font-bold transition-all active:scale-95 ${
                  isActive
                    ? 'text-teal-700 bg-teal-50 shadow-2xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`
              }
            >
              <User className="w-5 h-5 mb-0.5" />
              <span>{t('navProfile')}</span>
            </NavLink>
          </div>
        </nav>
      </div>
    </div>
  );
}
