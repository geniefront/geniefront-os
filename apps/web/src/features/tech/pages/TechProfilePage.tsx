import { useState } from 'react';
import {
  User,
  Globe,
  Volume2,
  Moon,
  LogOut,
  Store,
  Clock,
  CalendarDays,
  Save,
  Check,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { UI_LANGUAGES } from '@/i18n';
import { pickText } from '@gf/contracts';
import {
  getMockStore,
  mockUpdateWorkHours,
  type MockTechStore,
} from '../lib/mockData';

export function TechProfilePage() {
  const { t, language, setLanguage } = useLanguage();
  const { membership, locations, clearMembership, signOut } = useSession();

  const [mockStore, setMockStore] = useState<MockTechStore>(getMockStore);
  const [expectedStart, setExpectedStart] = useState(mockStore.profile.expectedStart);
  const [expectedEnd, setExpectedEnd] = useState(mockStore.profile.expectedEnd);
  const [prefSaved, setPrefSaved] = useState(false);

  const [soundEnabled, setSoundEnabled] = useState(mockStore.profile.soundEnabled);
  const [wakeLockEnabled, setWakeLockEnabled] = useState(mockStore.profile.wakeLockEnabled);

  const { profile, weeklyShifts } = mockStore;

  const handleLanguageChange = (code: typeof language) => {
    setLanguage(code);
  };

  const handleSavePref = (e: React.FormEvent) => {
    e.preventDefault();
    const next = mockUpdateWorkHours(expectedStart, expectedEnd);
    setMockStore({ ...next });
    setPrefSaved(true);
    setTimeout(() => setPrefSaved(false), 2000);
  };

  return (
    <div className="space-y-3.5">
      {/* 技师名片卡 */}
      <div className="p-5 bg-white rounded-3xl border border-slate-200/80 shadow-xs">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-teal-600 text-white flex items-center justify-center font-black text-2xl shadow-sm shrink-0">
            {profile.name.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-slate-900 truncate">{profile.name}</h2>
              <Badge variant="success" className="text-[10px] px-2 py-0.5 font-bold">
                {profile.employeeNo}
              </Badge>
            </div>
            <p className="text-xs text-teal-700 mt-0.5 font-bold">{profile.level}</p>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1.5 font-medium">
              <Store className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">{membership ? pickText(membership.locationName, language) : 'GenieFront Spa'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 排班日程卡片 */}
      <div className="p-4 bg-white rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center font-bold">
            <CalendarDays className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-slate-900">{t('navSchedule')}</h3>
            <p className="text-[11px] text-slate-500">{t('viewPublishedRosterSub')}</p>
          </div>
        </div>

        {/* 7 日排班日历网格 */}
        <div className="grid grid-cols-7 gap-1.5 pt-1">
          {weeklyShifts.map((shift, idx) => {
            const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
            const isOff = shift.status === 'off';
            return (
              <div
                key={shift.dateStr}
                className={`p-2 rounded-2xl text-center flex flex-col items-center justify-between min-h-[70px] transition-all ${
                  isOff
                    ? 'bg-slate-50 border border-dashed border-slate-200 text-slate-400'
                    : 'bg-teal-50/70 border border-teal-200/80 text-teal-950 font-semibold shadow-2xs'
                }`}
              >
                <span className="text-[10px] text-slate-500 font-bold">{weekdays[idx]}</span>
                <span className="text-xs font-black font-mono">{shift.dateStr.slice(8, 10)}</span>
                <span className="text-[9px] font-bold">
                  {isOff ? t('restBadge') : `${Math.floor(shift.startMin / 60)}h`}
                </span>
              </div>
            );
          })}
        </div>

        {/* 期望上下班时间设置 */}
        <form onSubmit={handleSavePref} className="pt-3 border-t border-slate-100 space-y-2.5">
          <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-teal-600" />
            <span>{t('expectedHours')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">{t('expectedStartTime')}</label>
              <input
                type="time"
                value={expectedStart}
                onChange={(e) => setExpectedStart(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-800 bg-slate-50 focus:bg-white focus:border-teal-500 focus:outline-none transition-colors"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">{t('expectedEndTime')}</label>
              <input
                type="time"
                value={expectedEnd}
                onChange={(e) => setExpectedEnd(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-800 bg-slate-50 focus:bg-white focus:border-teal-500 focus:outline-none transition-colors"
              />
            </div>
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="w-full rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 py-2.5 active:scale-98"
          >
            <Save className="w-3.5 h-3.5 mr-1 text-teal-600" />
            {prefSaved ? t('savedPreferencesSuccess') : t('saveExpectedHours')}
          </Button>
        </form>
      </div>

      {/* 5 种语言切换卡片 */}
      <div className="p-4 bg-white rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center font-bold">
            <Globe className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-slate-900">{t('preferredLanguage')}</h3>
            <p className="text-[11px] text-slate-500">界面多语言支持 (中 / 英 / 西 / 越 / 韩)</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
          {UI_LANGUAGES.map((l) => {
            const isSelected = language === l.code;
            return (
              <button
                key={l.code}
                type="button"
                onClick={() => handleLanguageChange(l.code)}
                className={`p-3 rounded-2xl border text-xs font-bold flex items-center justify-between transition-all active:scale-95 ${
                  isSelected
                    ? 'border-teal-600 bg-teal-50 text-teal-800 ring-1 ring-teal-600 shadow-2xs'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 hover:border-slate-300'
                }`}
              >
                <span>{l.label}</span>
                {isSelected && <Check className="w-3.5 h-3.5 text-teal-600" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* 实用开关 (声音提醒 & 倒计时常亮) */}
      <div className="p-4 bg-white rounded-3xl border border-slate-200/80 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center font-bold">
              <Volume2 className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-xs text-slate-800">{t('soundEnabled')}</div>
              <div className="text-[11px] text-slate-400">{t('soundEnabledDesc')}</div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={(e) => setSoundEnabled(e.target.checked)}
            className="w-5 h-5 accent-teal-600 rounded cursor-pointer"
          />
        </div>

        <div className="border-t border-slate-100 pt-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-teal-50 text-teal-700 flex items-center justify-center font-bold">
              <Moon className="w-4 h-4" />
            </div>
            <div>
              <div className="font-bold text-xs text-slate-800">{t('wakeLockEnabled')}</div>
              <div className="text-[11px] text-slate-400">{t('wakeLockDesc')}</div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={wakeLockEnabled}
            onChange={(e) => setWakeLockEnabled(e.target.checked)}
            className="w-5 h-5 accent-teal-600 rounded cursor-pointer"
          />
        </div>
      </div>

      {/* 多店选择切换 */}
      {locations.length > 1 && (
        <div className="p-4 bg-white rounded-3xl border border-slate-200/80 shadow-xs">
          <button
            type="button"
            onClick={clearMembership}
            className="w-full flex items-center justify-between text-left active:scale-98 transition-transform"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center font-bold">
                <Store className="w-4 h-4" />
              </div>
              <div>
                <div className="font-bold text-xs text-slate-800">{t('switchShop')}</div>
                <div className="text-[11px] text-slate-400">
                  {t('heldLocationsCount').replace('{n}', String(locations.length))}
                </div>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400" />
          </button>
        </div>
      )}

      {/* 退出登录 */}
      <Button
        variant="ghost"
        className="w-full text-rose-600 hover:bg-rose-50 rounded-2xl py-3.5 text-xs font-bold border border-rose-200/80 active:scale-98"
        onClick={() => void signOut()}
      >
        <LogOut className="w-4 h-4 mr-1.5" />
        {t('signOut')}
      </Button>
    </div>
  );
}
