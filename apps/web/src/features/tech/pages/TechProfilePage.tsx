import { useState } from 'react';
import {
  Check,
  ChevronRight,
  Clock,
  CalendarDays,
  Globe,
  LogOut,
  Moon,
  Store,
  Volume2,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { pickText } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { useUserProfileQuery } from '@/features/profile/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageError, PageLoading } from '@/components/ui/QueryState';
import { UI_LANGUAGES } from '@/i18n';
import { useTechLocaleMutation, useTechRosterQuery, useTechTodayQuery } from '../api';
import {
  readTechSoundEnabled,
  readTechWakeLockEnabled,
  writeTechSoundEnabled,
  writeTechWakeLockEnabled,
} from '../lib/preferences';
import { unlockTechAudio } from '../lib/audio';

function timeLabel(minutes: number): string {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

export function TechProfilePage() {
  const { t, language, setLanguage } = useLanguage();
  const { membership, membershipId, locations, clearMembership, signOut } = useSession();
  const profileQuery = useUserProfileQuery();
  const rosterQuery = useTechRosterQuery();
  const todayQuery = useTechTodayQuery();
  const localeMutation = useTechLocaleMutation();
  const [soundEnabled, setSoundEnabled] = useState(readTechSoundEnabled);
  const [wakeLockEnabled, setWakeLockEnabled] = useState(readTechWakeLockEnabled);

  if (profileQuery.isPending || rosterQuery.isPending || todayQuery.isPending) {
    return <PageLoading title={t('loadingSchedule')} className="min-h-[55vh]" />;
  }
  if (profileQuery.isError || rosterQuery.isError || todayQuery.isError) {
    const error = profileQuery.error ?? rosterQuery.error ?? todayQuery.error;
    return (
      <PageError
        error={error}
        onRetry={() => {
          void profileQuery.refetch();
          void rosterQuery.refetch();
          void todayQuery.refetch();
        }}
        className="min-h-[55vh]"
      />
    );
  }

  const profile = profileQuery.data;
  const roster = rosterQuery.data;
  const displayName = profile?.nickname || profile?.fullName || todayQuery.data?.name || '';
  const staffInfo = profile?.staffInfo;
  const myShifts = roster?.shifts.filter((shift) => shift.membershipId === membershipId) ?? [];
  const operationalStatus = todayQuery.data?.onDuty
    ? (todayQuery.data.rotation.onBreak ? t('onBreak') : t('onDuty'))
    : t('offDuty');

  const changeLanguage = (nextLanguage: typeof language) => {
    const previousLanguage = language;
    setLanguage(nextLanguage);
    localeMutation.mutate(nextLanguage, {
      onError: () => setLanguage(previousLanguage),
    });
  };

  return (
    <div className="space-y-3.5">
      <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-teal-600 text-2xl font-black text-white shadow-sm">
            {displayName.slice(0, 1) || 'G'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-black text-slate-900">{displayName}</h2>
              {staffInfo?.employeeNo && (
                <Badge variant="success" className="px-2 py-0.5 text-[10px] font-bold">
                  {staffInfo.employeeNo}
                </Badge>
              )}
            </div>
            {(staffInfo?.levelName || staffInfo?.jobTitle) && (
              <p className="mt-0.5 text-xs font-bold text-teal-700">
                {staffInfo.levelName || staffInfo.jobTitle}
              </p>
            )}
            <div className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
              <Store className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{membership ? pickText(membership.locationName, language) : 'GenieFront'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">{t('workProfileReadOnly')}</h3>
            <p className="text-[11px] text-slate-500">{t('workProfileManagedByDesk')}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-2xl bg-slate-50 p-3">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{t('staffStatus')}</dt>
            <dd className="mt-1 font-bold text-slate-900">{operationalStatus}</dd>
          </div>
          <div className="rounded-2xl bg-slate-50 p-3">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{t('staffLevel')}</dt>
            <dd className="mt-1 font-bold text-slate-900">{staffInfo?.levelName || staffInfo?.jobTitle || t('notConfigured')}</dd>
          </div>
        </dl>
        <div className="rounded-2xl bg-slate-50 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
            <Tags className="h-3.5 w-3.5" />
            {t('staffSkills')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(staffInfo?.skills ?? []).length > 0
              ? staffInfo?.skills.map((skill) => <Badge key={skill} variant="secondary" className="text-[10px]">{skill}</Badge>)
              : <span className="text-[11px] text-slate-400">{t('notConfigured')}</span>}
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
            <CalendarDays className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">{t('navSchedule')}</h3>
            <p className="text-[11px] text-slate-500">{t('viewPublishedRosterSub')}</p>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1.5 pt-1">
          {(roster?.dates ?? []).map((date) => {
            const shift = myShifts.find((item) => item.businessDate === date);
            const published = shift?.status === 'published';
            return (
              <div
                key={date}
                className={`flex min-h-[78px] flex-col items-center justify-between rounded-2xl p-2 text-center ${
                  published
                    ? 'border border-teal-200/80 bg-teal-50/70 font-semibold text-teal-950 shadow-2xs'
                    : 'border border-dashed border-slate-200 bg-slate-50 text-slate-400'
                }`}
              >
                <span className="text-[9px] font-bold text-slate-500">{date.slice(5)}</span>
                <Clock className="h-3.5 w-3.5" />
                <span className="text-[9px] font-bold leading-tight">
                  {published ? `${timeLabel(shift.startMin)}–${timeLabel(shift.endMin)}` : t('restBadge')}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
            <Globe className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-bold text-slate-900">{t('preferredLanguage')}</h3>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
          {UI_LANGUAGES.map((item) => {
            const selected = language === item.code;
            return (
              <button
                key={item.code}
                type="button"
                disabled={localeMutation.isPending}
                onClick={() => changeLanguage(item.code)}
                className={`flex items-center justify-between rounded-2xl border p-3 text-xs font-bold transition-all active:scale-95 ${
                  selected
                    ? 'border-teal-600 bg-teal-50 text-teal-800 ring-1 ring-teal-600'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span>{item.label}</span>
                {selected && <Check className="h-3.5 w-3.5 text-teal-600" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3 rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs">
        <label className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
              <Volume2 className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-xs font-bold text-slate-800">{t('soundEnabled')}</span>
              <span className="block text-[11px] text-slate-400">{t('soundEnabledDesc')}</span>
            </span>
          </span>
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={(event) => {
              const checked = event.target.checked;
              setSoundEnabled(checked);
              writeTechSoundEnabled(checked);
              if (checked) void unlockTechAudio();
            }}
            className="h-5 w-5 accent-teal-600"
          />
        </label>

        <label className="flex items-center justify-between gap-4 border-t border-slate-100 pt-3">
          <span className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
              <Moon className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-xs font-bold text-slate-800">{t('wakeLockEnabled')}</span>
              <span className="block text-[11px] text-slate-400">{t('wakeLockDesc')}</span>
            </span>
          </span>
          <input
            type="checkbox"
            checked={wakeLockEnabled}
            onChange={(event) => {
              const checked = event.target.checked;
              setWakeLockEnabled(checked);
              writeTechWakeLockEnabled(checked);
            }}
            className="h-5 w-5 accent-teal-600"
          />
        </label>
      </div>

      {locations.length > 1 && (
        <div className="rounded-3xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <button type="button" onClick={clearMembership} className="flex w-full items-center justify-between text-left active:scale-98">
            <span className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
                <Store className="h-4 w-4" />
              </span>
              <span>
                <span className="block text-xs font-bold text-slate-800">{t('switchShop')}</span>
                <span className="block text-[11px] text-slate-400">{t('heldLocationsCount').replace('{n}', String(locations.length))}</span>
              </span>
            </span>
            <ChevronRight className="h-5 w-5 text-slate-400" />
          </button>
        </div>
      )}

      <Button
        variant="ghost"
        className="w-full rounded-2xl border border-rose-200/80 py-3.5 text-xs font-bold text-rose-600 hover:bg-rose-50"
        onClick={() => void signOut()}
      >
        <LogOut className="mr-1.5 h-4 w-4" />
        {t('signOut')}
      </Button>
    </div>
  );
}
