import { ShieldAlert, Sparkles, Store, Wrench, ArrowRight, LogOut } from 'lucide-react';
import { pickText } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

/**
 * 工作台选择页 (Dual-Role Portal Picker)。
 *
 * 当用户在此门店兼备管理身份 (owner/manager/front_desk) 与做工技师身份 (tech/senior_tech) 时，
 * 登录后引导用户自主选择本次进入的工作台模式。用户亦可在顶栏随时切换。
 */
export function PortalPicker() {
  const { t, language } = useLanguage();
  const { membership, setPortal, clearMembership, locations, signOut } = useSession();

  return (
    <div className="w-full max-w-lg space-y-6 animate-in fade-in duration-200">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-teal-50 border border-teal-200 text-teal-700 text-xs font-semibold">
          <Store className="w-3.5 h-3.5" />
          <span>{membership ? pickText(membership.locationName, language) : ''}</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{t('choosePortalTitle')}</h1>
        <p className="text-sm text-slate-500 max-w-md mx-auto">{t('choosePortalDesc')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {/* 卡片 1: 技师工作台 */}
        <Card className="overflow-hidden border-2 border-transparent hover:border-teal-500 transition-all hover:shadow-lg group">
          <button
            type="button"
            onClick={() => setPortal('tech')}
            className="w-full p-5 text-left flex items-start gap-4 transition-colors hover:bg-slate-50"
          >
            <div className="w-12 h-12 rounded-2xl bg-teal-600 text-white flex items-center justify-center shrink-0 shadow-md group-hover:scale-105 transition-transform">
              <Sparkles className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-lg font-bold text-slate-900 group-hover:text-teal-700 transition-colors">
                  {t('enterTech')}
                </span>
                <ArrowRight className="w-5 h-5 text-teal-600 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
              </div>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{t('enterTechDesc')}</p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="text-[11px] font-medium text-teal-700 bg-teal-50 px-2 py-0.5 rounded-md">
                  {t('navToday')}
                </span>
                <span className="text-[11px] font-medium text-teal-700 bg-teal-50 px-2 py-0.5 rounded-md">
                  {t('safetyAlerts')}
                </span>
                <span className="text-[11px] font-medium text-teal-700 bg-teal-50 px-2 py-0.5 rounded-md">
                  {t('navLedger')}
                </span>
              </div>
            </div>
          </button>
        </Card>

        {/* 卡片 2: 后台管理 */}
        <Card className="overflow-hidden border-2 border-transparent hover:border-indigo-500 transition-all hover:shadow-lg group">
          <button
            type="button"
            onClick={() => setPortal('admin')}
            className="w-full p-5 text-left flex items-start gap-4 transition-colors hover:bg-slate-50"
          >
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-md group-hover:scale-105 transition-transform">
              <Wrench className="w-6 h-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-lg font-bold text-slate-900 group-hover:text-indigo-700 transition-colors">
                  {t('enterAdmin')}
                </span>
                <ArrowRight className="w-5 h-5 text-indigo-600 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
              </div>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{t('enterAdminDesc')}</p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                <span className="text-[11px] font-medium text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">
                  {t('schedule')}
                </span>
                <span className="text-[11px] font-medium text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">
                  {t('queue')}
                </span>
                <span className="text-[11px] font-medium text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">
                  {t('checkout')}
                </span>
              </div>
            </div>
          </button>
        </Card>
      </div>

      <div className="flex items-center justify-between pt-2">
        {locations.length > 1 && (
          <Button variant="ghost" size="sm" onClick={clearMembership} className="text-xs text-slate-500">
            {t('selectLocation')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void signOut()} className="text-xs text-slate-500 ml-auto flex items-center gap-1.5">
          <LogOut className="w-3.5 h-3.5" />
          <span>{t('signOut')}</span>
        </Button>
      </div>
    </div>
  );
}
