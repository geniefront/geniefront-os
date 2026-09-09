import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@heroui/react';
import {
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Plus,
  Rocket,
  ShieldCheck,
  Store,
  UserRoundPlus,
  UsersRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import {
  useDeskSettingsQuery,
  useFinishSetup,
  useSaveBusinessHours,
  useSaveLocationProfile,
  useSaveService,
  useSaveStaffProfile,
  useSetupReadinessQuery,
} from '@/features/settings/api';
import { ImportWorkspace } from '@/features/setup/ImportWorkspace';
import { CatalogPresetPicker } from '@/features/setup/CatalogPresetPicker';
import { Field, SaveBar, StepHeading, Toggle, fieldClass, selectClass } from '@/features/setup/primitives';
import type { SetupStepId } from '@/features/setup/flow';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';


const DAY_KEYS: ReadonlyArray<readonly [string, TranslationKey]> = [
  ['mon', 'mon'], ['tue', 'tue'], ['wed', 'wed'], ['thu', 'thu'],
  ['fri', 'fri'], ['sat', 'sat'], ['sun', 'sun'],
];

export function StoreStepForm({ onSaved, stepNumber = 1 }: { onSaved: () => void; stepNumber?: number }) {
  const { t } = useLanguage();
  const { data } = useDeskSettingsQuery();
  const saveProfile = useSaveLocationProfile();
  const saveHours = useSaveBusinessHours();
  const [form, setForm] = useState({
    name: '', businessType: 'mixed', phone: '', email: '', addressStreet: '', addressCity: '',
    addressState: '', addressZip: '', timezone: 'America/New_York', businessDayCutoff: '04:00',
  });
  const [hours, setHours] = useState<Record<string, { open: string; close: string } | null>>({});

  useEffect(() => {
    if (!data) return;
    const l = data.location;
    setForm({
      name: l.name ?? '', businessType: l.businessType ?? 'mixed', phone: l.phone ?? '', email: l.email ?? '',
      addressStreet: l.addressStreet ?? '', addressCity: l.addressCity ?? '', addressState: l.addressState ?? '',
      addressZip: l.addressZip ?? '', timezone: l.timezone ?? 'America/New_York', businessDayCutoff: l.businessDayCutoff ?? '04:00',
    });
    setHours(l.businessHours ?? {});
  }, [data]);

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (!form.name.trim() || !form.timezone.trim()) {
      toast.danger(t('setupStep1MissingName'));
      return;
    }
    if (!Object.values(hours).some(Boolean)) {
      toast.danger(t('setupStep1MissingHours'));
      return;
    }
    try {
      await saveProfile.mutateAsync({
        name: form.name.trim(), businessType: form.businessType as any, phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined, addressStreet: form.addressStreet.trim(), addressCity: form.addressCity.trim(),
        addressState: form.addressState.trim(), addressZip: form.addressZip.trim(), timezone: form.timezone,
        businessDayCutoff: form.businessDayCutoff,
      });
      await saveHours.mutateAsync({ hours });
      toast.success(t('setupStep1Saved'));
      onSaved();
    } catch (error) {
      toast.danger(t('setupSaveFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' }));
    }
  };

  return (
    <div className="space-y-6">
      <StepHeading eyebrow={t('setupStepLabel', { number: stepNumber })} title={t('setupStepStoreTitle')} description={t('setupStepStoreDesc')} />
      <ImportWorkspace mode="store" initialName={form.name} initialPlace={form.addressZip || form.addressCity} />
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{t('setupImportOrManual')}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('setupFieldStoreName')}><Input className={fieldClass} value={form.name} onChange={(e) => update('name', e.target.value)} /></Field>
        <Field label={t('setupFieldBusinessType')}>
          <select className={selectClass} value={form.businessType} onChange={(e) => update('businessType', e.target.value)}>
            <option value="nail">{t('setupBizNail')}</option><option value="massage">{t('setupBizMassage')}</option>
            <option value="foot_spa">{t('setupBizFootSpa')}</option><option value="lash">{t('setupBizLash')}</option>
            <option value="scalp">{t('setupBizScalp')}</option><option value="hair">{t('setupBizHair')}</option><option value="mixed">{t('setupBizMixed')}</option>
          </select>
        </Field>
        <Field label={t('setupFieldPhone')}><Input className={fieldClass} value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+12125551234" /></Field>
        <Field label={t('setupFieldEmail')}><Input className={fieldClass} type="email" value={form.email} onChange={(e) => update('email', e.target.value)} /></Field>
        <Field label={t('setupFieldStreet')}><Input className={fieldClass} value={form.addressStreet} onChange={(e) => update('addressStreet', e.target.value)} /></Field>
        <div className="grid grid-cols-[1fr_80px_100px] gap-2">
          <Field label={t('setupFieldCity')}><Input className={fieldClass} value={form.addressCity} onChange={(e) => update('addressCity', e.target.value)} /></Field>
          <Field label={t('setupFieldState')}><Input className={fieldClass} value={form.addressState} onChange={(e) => update('addressState', e.target.value.toUpperCase())} /></Field>
          <Field label={t('setupFieldZip')}><Input className={fieldClass} value={form.addressZip} onChange={(e) => update('addressZip', e.target.value)} /></Field>
        </div>
        <Field label={t('setupFieldTimezone')} hint={t('setupTimezoneHint')}>
          <select className={selectClass} value={form.timezone} onChange={(e) => update('timezone', e.target.value)}>
            <option value="America/New_York">{t('setupTzEastern')}</option><option value="America/Chicago">{t('setupTzCentral')}</option>
            <option value="America/Denver">{t('setupTzMountain')}</option><option value="America/Phoenix">{t('setupTzArizona')}</option>
            <option value="America/Los_Angeles">{t('setupTzPacific')}</option><option value="America/Anchorage">{t('setupTzAlaska')}</option>
            <option value="Pacific/Honolulu">{t('setupTzHawaii')}</option>
          </select>
        </Field>
        <Field label={t('setupFieldCutoff')} hint={t('setupCutoffHint')}><Input className={fieldClass} type="time" value={form.businessDayCutoff} onChange={(e) => update('businessDayCutoff', e.target.value)} /></Field>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-bold text-slate-900">{t('setupWeeklyHoursTitle')}</h3>
          <Button variant="ghost" size="sm" onClick={() => {
            const monday = hours.mon ?? { open: '09:00', close: '20:00' };
            setHours(Object.fromEntries(DAY_KEYS.map(([key]) => [key, monday])));
          }}>{t('setupCopyMondayToAll')}</Button>
        </div>
        <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
          {DAY_KEYS.map(([key, labelKey]) => {
            const value = hours[key] ?? null;
            return (
              <div key={key} className="grid grid-cols-[70px_70px_1fr] items-center gap-3 px-4 py-3 sm:grid-cols-[80px_90px_1fr]">
                <span className="text-sm font-semibold text-slate-800">{t(labelKey)}</span>
                <button type="button" onClick={() => setHours((h) => ({ ...h, [key]: value ? null : { open: '09:00', close: '20:00' } }))} className={cn('text-left text-xs font-semibold', value ? 'text-teal-700' : 'text-slate-400')}>{value ? t('setupDayOpen') : t('setupDayClosed')}</button>
                {value ? <div className="flex items-center gap-2"><Input type="time" className="h-9 text-sm" value={value.open} onChange={(e) => setHours((h) => ({ ...h, [key]: { ...value, open: e.target.value } }))} /><span className="text-slate-400">—</span><Input type="time" className="h-9 text-sm" value={value.close} onChange={(e) => setHours((h) => ({ ...h, [key]: { ...value, close: e.target.value } }))} /></div> : <span className="text-sm text-slate-400">{t('setupDayNoBooking')}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <SaveBar permission="settings.manage" saving={saveProfile.isPending || saveHours.isPending} onSave={save} />
    </div>
  );
}

export function CatalogStepForm({ onSaved, stepNumber = 4 }: { onSaved: () => void; stepNumber?: number }) {
  const { t } = useLanguage();
  const { data } = useDeskSettingsQuery();
  const saveService = useSaveService();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('60');
  const active = data?.services.filter((service) => service.active) ?? [];
  const existingNames = (data?.services ?? []).map((service) => service.displayName);

  const add = async () => {
    const priceMatch = price.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    const priceCents = priceMatch
      ? Number.parseInt(priceMatch[1]!, 10) * 100 + Number.parseInt((priceMatch[2] ?? '').padEnd(2, '0') || '0', 10)
      : null;
    const durationValue = Number.parseInt(duration, 10);
    if (!name.trim() || priceCents === null || !Number.isFinite(durationValue) || durationValue < 5) {
      toast.danger(t('setupStep2MissingFields')); return;
    }
    try {
      const displayName = name.trim();
      await saveService.mutateAsync({
        name: { en: displayName, 'zh-Hans': displayName },
        basePriceCents: priceCents,
        durationMin: durationValue,
        active: true,
      });
      setName(''); setPrice('');
      toast.success(t('setupStep2Saved'));
      onSaved();
    } catch (error) { toast.danger(t('setupAddFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' })); }
  };

  return (
    <div className="space-y-6">
      <StepHeading eyebrow={t('setupStepLabel', { number: stepNumber })} title={t('setupStepCatalogTitle')} description={t('setupStepCatalogDesc')} />
      <CatalogPresetPicker
        businessType={data?.location.businessType ?? null}
        existingNames={existingNames}
        onAdded={onSaved}
      />
      <ImportWorkspace mode="catalog" />
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{t('setupImportOrManual')}</p>
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 md:grid-cols-[1.4fr_.7fr_.7fr_auto]">
        <Field label={t('setupFieldServiceName')}><Input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('setupFieldServiceNamePlaceholder')} /></Field>
        <Field label={t('setupFieldPriceUsd')}><Input className={fieldClass} type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="65.00" /></Field>
        <Field label={t('setupFieldDurationMin')}><Input className={fieldClass} type="number" min="5" step="5" value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        <GuardedButton permission="catalog.manage" onClick={add} isDisabled={saveService.isPending} className="h-11 self-end gap-2"><Plus className="size-4" />{t('setupAddService')}</GuardedButton>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-900">{t('setupCurrentServices')}</h3><Badge variant={active.length ? 'success' : 'warning'}>{t('setupServicesEnabledCount', { p0: active.length })}</Badge></div>
        {active.length ? <div className="grid gap-3 sm:grid-cols-2">{active.map((service) => <div key={service.id} className="flex items-center justify-between rounded-xl border border-slate-200 p-4"><div><p className="font-semibold text-slate-900">{service.displayName}</p><p className="mt-1 text-xs text-slate-500">{service.durationMin} {t('setupMinutesUnit')} · ${(service.basePriceCents / 100).toFixed(2)}</p></div>{service.onlineBookable && <Badge>{t('setupOnlineBookable')}</Badge>}</div>)}</div> : <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-6 text-center text-sm text-amber-900">{t('setupNoServicesHint')}</div>}
      </div>
    </div>
  );
}

export function TeamStepForm({ onSaved, stepNumber = 5 }: { onSaved: () => void; stepNumber?: number }) {
  const { t } = useLanguage();
  const { data } = useDeskSettingsQuery();
  const saveStaff = useSaveStaffProfile();
  const [name, setName] = useState('');
  const [bookable, setBookable] = useState(true);
  const [rotation, setRotation] = useState(true);
  const add = async () => {
    if (!name.trim()) { toast.danger(t('setupStep3MissingName')); return; }
    try {
      await saveStaff.mutateAsync({ name: name.trim(), isBookable: bookable, inRotation: rotation, maxConcurrentAppointments: 1 });
      setName(''); toast.success(t('setupStep3Saved')); onSaved();
    } catch (error) { toast.danger(t('setupAddFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' })); }
  };
  const staff = data?.staff ?? [];
  return (
    <div className="space-y-6">
      <StepHeading eyebrow={t('setupStepLabel', { number: stepNumber })} title={t('setupStepTeamTitle')} description={t('setupStepTeamDesc')} />
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 md:grid-cols-2">
        <Field label={t('setupFieldStaffName')}><Input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Amy" /></Field>
        <div className="flex items-end"><GuardedButton permission="staff.manage" onClick={add} isDisabled={saveStaff.isPending} className="h-11 w-full gap-2"><UserRoundPlus className="size-4" />{t('setupAddStaff')}</GuardedButton></div>
        <Toggle checked={bookable} onChange={setBookable} label={t('setupToggleBookableLabel')} description={t('setupToggleBookableDesc')} />
        <Toggle checked={rotation} onChange={setRotation} label={t('setupToggleRotationLabel')} description={t('setupToggleRotationDesc')} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{staff.map((member) => <div key={member.membershipId} className="flex items-center gap-3 rounded-xl border border-slate-200 p-4"><span className="grid size-10 place-items-center rounded-full bg-teal-50 font-bold text-teal-700">{member.name.slice(0, 1)}</span><div className="min-w-0 flex-1"><p className="truncate font-semibold text-slate-900">{member.name}</p><p className="text-xs text-slate-500">{member.isBookable ? t('setupStaffBookable') : t('setupStaffNotBookable')} · {member.inRotation ? t('setupStaffInRotation') : t('setupStaffNotInRotation')}</p></div>{member.hasAccount ? <Badge variant="success">{t('setupStaffAccountReady')}</Badge> : <Badge variant="secondary">{t('setupStaffAccountPending')}</Badge>}</div>)}</div>
      {!staff.some((member) => member.isBookable) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t('setupStaffMinBookableHint')}</div>}
      <div className="rounded-xl border border-teal-100 bg-teal-50/60 p-4 text-sm leading-6 text-teal-900">
        {t('setupStep3Footer')}
      </div>
    </div>
  );
}

/** 开店硬门槛步骤 → 检查项文案。完成度一律来自后端 readiness。 */
const LAUNCH_CHECK_LABEL: Partial<Record<SetupStepId, TranslationKey>> = {
  store: 'setupCheckProfileConfirmed',
  rooms: 'setupCheckRoomActive',
  catalog: 'setupCheckServiceActive',
  team: 'setupCheckStaffBookable',
};

const WARNING_LABEL: Record<string, TranslationKey> = {
  directory_recommended: 'setupWarnDirectoryRecommended',
  active_room_repair: 'setupWarnActiveRoomRepair',
  ai_voice_pending: 'setupWarnAiVoicePending',
};

export function LaunchStep({ onGoToStep, stepNumber = 7 }: {
  onGoToStep: (step: SetupStepId) => void; stepNumber?: number;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { data: readiness, refetch, isFetching, isError, isLoading } = useSetupReadinessQuery();
  const finish = useFinishSetup();

  const checks = (readiness?.steps ?? [])
    .filter((step): step is { id: SetupStepId; complete: boolean } => step.id in LAUNCH_CHECK_LABEL)
    .map((step) => ({ stepId: step.id, label: t(LAUNCH_CHECK_LABEL[step.id]!), ok: step.complete }));
  const ready = Boolean(readiness?.canLaunch);
  const blockers = readiness?.missing ?? [];
  const warnings = readiness?.warnings ?? [];

  const launch = async () => {
    try {
      await refetch();
      await finish.mutateAsync();
      toast.success(t('setupLaunched'));
      // 只有服务端把 locations.status 改为 active 后，才允许离开 setup。
      navigate('/dashboard', { replace: true });
    }
    catch (error) { toast.danger(t('setupLaunchFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' })); }
  };

  if (isLoading) {
    return <div className="py-10 text-center text-sm text-slate-500">{t('setupReadinessLoading')}</div>;
  }
  if (isError || !readiness) {
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-slate-600">{t('setupReadinessError')}</p>
        <Button variant="outline" onClick={() => void refetch()}>{t('setupRetry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StepHeading eyebrow={t('setupStepLabel', { number: stepNumber })} title={t('setupStepLaunchTitle')} description={t('setupStepLaunchDesc')} />
      <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
        {checks.map((check) => (
          <div key={check.stepId} className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="flex items-center gap-3">
              {check.ok ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Clock3 className="size-5 text-amber-500" />}
              <span className="text-sm font-semibold text-slate-800">{check.label}</span>
            </div>
            {check.ok
              ? <Badge variant="success">{t('setupCheckDone')}</Badge>
              : <button type="button" onClick={() => onGoToStep(check.stepId)} className="text-xs font-semibold text-teal-700 underline underline-offset-2">{t('setupFixInStep')}</button>}
          </div>
        ))}
      </div>

      {blockers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {blockers.map((item) => (
            <Button key={item.code} variant="outline" onClick={() => onGoToStep(item.stepId as SetupStepId)}>
              <CircleDollarSign className="size-4" />
              {t(LAUNCH_CHECK_LABEL[item.stepId as SetupStepId] ?? 'setupFixInStep')}
            </Button>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          {warnings.map((w) => (
            <button key={w.code} type="button" onClick={() => onGoToStep(w.stepId as SetupStepId)} className="flex w-full items-start gap-2 text-left text-sm text-amber-900">
              <Clock3 className="mt-0.5 size-4 shrink-0" />
              <span>{t(WARNING_LABEL[w.code] ?? 'setupWarnDirectoryRecommended')}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-teal-100 bg-teal-50/60 p-5">
        <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-700" /><div><h3 className="font-bold text-teal-950">{t('setupTrialRunTitle')}</h3><ol className="mt-2 space-y-1 text-sm leading-6 text-teal-900"><li>1. {t('setupTrialStep1')}</li><li>2. {t('setupTrialStep2')}</li><li>3. {t('setupTrialStep3')}</li></ol></div></div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p className="text-xs leading-5 text-slate-500 sm:mr-auto">{t('setupStep4Footer')}</p>
        <GuardedButton permission="settings.manage" onClick={launch} isDisabled={!ready || finish.isPending || isFetching} className="gap-2"><Rocket className="size-4" />{finish.isPending ? t('setupLaunching') : t('setupLaunchNow')}</GuardedButton>
      </div>
    </div>
  );
}
