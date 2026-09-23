import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { StaffSettings } from '@/features/staff/StaffSettings';
import { SaveLocationProfile } from '@gf/contracts';
import { useSession } from '@/lib/session';
import { PageError } from '@/components/ui/QueryState';
import {StoreMediaEditor} from './StoreMediaEditor';
import {BookingImagePicker} from '@/components/ui/BookingImagePicker';
import {HoursPeriodsEditor} from './HoursPeriodsEditor';
import { useCan } from '@/lib/permissions';
import { StaffEditor } from './StaffEditor';
import { SetupBookingCapacity } from './BookingCapacity';
import { CategoryManager, CategoryPicker, ServiceEditor } from './CatalogFields';
import { SaveStatus, useSetupDraft, useSetupNewRecordGuard } from './autosave';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@heroui/react';
import { useFieldErrors } from '@/lib/formFeedback';
import { parseDurationMinutes, parseMoney } from '@/lib/validation';
import { useValidationMessage } from '@/lib/validationMessage';
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

export function StoreStepForm({ onSaved, stepNumber = 1, settingsMode = false }: { onSaved: () => void; stepNumber?: number; settingsMode?: boolean }) {
  const { t, language } = useLanguage();
  const [editingEmail, setEditingEmail] = useState(false);
  const emailMessage = language.startsWith('zh') ? '请输入完整有效的联系邮箱，或留空。' : 'Enter a complete, valid contact email or leave it empty.';
  const { membershipId } = useSession();
  const settingsQuery = useDeskSettingsQuery();
  const { data } = settingsQuery;
  const saveProfile = useSaveLocationProfile();
  const saveHours = useSaveBusinessHours();
  const location = data?.location;
  const draft = useSetupDraft(location ? {
    form: { name: location.name ?? '', businessType: location.businessType ?? 'mixed', phone: location.phone ?? '', email: location.email ?? '',
      addressStreet: location.addressStreet ?? '', addressCity: location.addressCity ?? '', addressState: location.addressState ?? '', addressZip: location.addressZip ?? '',
      timezone: location.timezone ?? 'America/New_York', businessDayCutoff: (location.businessDayCutoff ?? '04:00').slice(0, 5) },
    hours: location.businessHours ?? {},
  } : null, async ({ form, hours }) => {
    if (form.email.trim() && !SaveLocationProfile.input.shape.email.safeParse(form.email.trim()).success) throw new Error(emailMessage);
    if (!form.name.trim()) throw new Error(t('setupStep1MissingName'));
    await saveProfile.mutateAsync({ ...form, hours, name: form.name.trim(), businessType: form.businessType as any,
      phone: form.phone.trim() || null, email: form.email.trim() || null });
  }, `setup-store:${membershipId}`, { autoSavePaused: editingEmail });
  const storeForm = useFieldErrors<'name'>();
  if (settingsQuery.isError) return <PageError title={t('genericFailure')} error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />;
  if (!draft.value) return <p><LoadingSpinner label={t('setupReadinessLoading')} /></p>;
  const { form, hours } = draft.value;
  const update = (key: keyof typeof form, value: string) => draft.set(old => ({ ...old, form: { ...old.form, [key]: value } }));
  const setHours = (next: typeof hours | ((old: typeof hours) => typeof hours)) => draft.set(old => ({ ...old,
    hours: typeof next === 'function' ? next(old.hours) : next }));

  return (
    <div className="space-y-6">
      {!settingsMode && <><ImportWorkspace mode="store" initialName={form.name} initialPlace={form.addressZip || form.addressCity} /><p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{t('setupImportOrManual')}</p></>}
      <section className={settingsMode ? 'rounded-2xl border border-slate-200 bg-white p-4 sm:p-6' : ''}>
      {settingsMode && <h3 className="mb-5 font-semibold text-slate-900">{t('settings.stStoreInfoTitle')}</h3>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t('setupFieldStoreName')}><Input {...storeForm.bind('name')} className={fieldClass} value={form.name} onChange={(e) => { update('name', e.target.value); storeForm.clearField('name'); }} /></Field>
        <Field label={t('setupFieldBusinessType')}>
          <select className={selectClass} value={form.businessType} onChange={(e) => update('businessType', e.target.value)}>
            <option value="nail">{t('setupBizNail')}</option><option value="massage">{t('setupBizMassage')}</option>
            <option value="foot_spa">{t('setupBizFootSpa')}</option><option value="lash">{t('setupBizLash')}</option>
            <option value="scalp">{t('setupBizScalp')}</option><option value="hair">{t('setupBizHair')}</option><option value="mixed">{t('setupBizMixed')}</option>
          </select>
        </Field>
        <Field label={t('setupFieldPhone')}><Input type="tel" className={fieldClass} value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+12125551234" /></Field>
        <Field label={t('setupFieldEmail')}><Input className={fieldClass} type="email" onFocus={() => setEditingEmail(true)} onBlur={() => setEditingEmail(false)} error={draft.state === 'error' && form.email.trim() && !SaveLocationProfile.input.shape.email.safeParse(form.email.trim()).success ? emailMessage : undefined} value={form.email} onChange={(e) => update('email', e.target.value)} /></Field>
        <Field label={t('setupFieldStreet')}><Input className={fieldClass} value={form.addressStreet} onChange={(e) => update('addressStreet', e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_80px_100px]">
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
      <SaveStatus {...draft} />
      </section>
      <section className={settingsMode ? 'rounded-2xl border border-slate-200 bg-white p-4 sm:p-6' : ''}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
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
              <div key={key} className="grid grid-cols-2 items-center gap-3 px-3 py-3 sm:grid-cols-[64px_72px_minmax(0,1fr)] [&>div]:col-span-2 sm:[&>div]:col-span-1">
                <span className="text-sm font-semibold text-slate-800">{t(labelKey)}</span>
                <button type="button" onClick={() => setHours((h) => ({ ...h, [key]: value ? null : { open: '09:00', close: '20:00' } }))} className={cn('text-left text-xs font-semibold', value ? 'text-teal-700' : 'text-slate-400')}>{value ? t('setupDayOpen') : t('setupDayClosed')}</button>
                {value ? <HoursPeriodsEditor label={t(labelKey)} value={value} onChange={next=>setHours(h=>({...h,[key]:next}))}/> : <span className="text-sm text-slate-400">{t('setupDayNoBooking')}</span>}
              </div>
            );
          })}
        </div>
        <SaveStatus {...draft} />
      </section>
      <StoreMediaEditor />
      {settingsMode && <details className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6"><summary className="cursor-pointer font-semibold">{t('voiceImportTools')}</summary><div className="mt-4"><ImportWorkspace mode="store" initialName={form.name} initialPlace={form.addressZip || form.addressCity} /></div></details>}
    </div>
  );
}

export function CatalogStepForm({ onSaved, stepNumber = 4, settingsMode = false }: { onSaved: () => void; stepNumber?: number; settingsMode?: boolean }) {
  const { t } = useLanguage();
  const canImportImages = useCan('ai.use');
  const settingsQuery = useDeskSettingsQuery();
  const { data } = settingsQuery;
  const saveService = useSaveService();
  const [name, setName] = useState('');
  const [presentation,setPresentation]=useState({imageUrl:'',description:''});
  const [price, setPrice] = useState('');
  const [duration, setDuration] = useState('60');
  const [categoryId, setCategoryId] = useState('');
  const [isAddon, setIsAddon] = useState(false);
  const [onlineBookable, setOnlineBookable] = useState(true);
  useSetupNewRecordGuard(Boolean(name.trim() || price || presentation.imageUrl || presentation.description || categoryId || duration !== '60' || isAddon || !onlineBookable));
  const active = data?.services.filter((service) => service.active) ?? [];
  const existingNames = (data?.services ?? []).map((service) => service.displayName);

  /** 项目录入表单的字段级校验。 */
  const serviceForm = useFieldErrors<'name' | 'price' | 'duration'>();
  const invalid = useValidationMessage();

  const add = async () => {
    serviceForm.clear();
    /*
     * 原先三个字段共用一句「请补全项目信息」，而且价格与时长各自有一套行内
     * 正则。现在改为逐项判定，每一项说清自己的问题落在自己那一格上 ——
     * 判定规则统一来自 `lib/validation`，与设置页的目录编辑完全一致。
     */
    if (!name.trim()) { serviceForm.fail('name', t('setupStep2MissingFields')); return; }
    const parsedPrice = parseMoney(price);
    if (!parsedPrice.ok) { serviceForm.fail('price', invalid.money(parsedPrice.reason)); return; }
    const parsedDuration = parseDurationMinutes(duration, { min: 5, max: 600 });
    if (!parsedDuration.ok) {
      serviceForm.fail('duration', invalid.duration(parsedDuration.reason, { min: 5, max: 600 }));
      return;
    }
    const priceCents = parsedPrice.value;
    const durationValue = parsedDuration.value;
    try {
      const displayName = name.trim();
      await saveService.mutateAsync({
        presentation,
        name: { en: displayName, 'zh-Hans': displayName },
        categoryId: categoryId || null, isAddon, onlineBookable: !isAddon && onlineBookable,
        basePriceCents: priceCents,
        durationMin: durationValue,
        active: true,
      });
      setName(''); setPrice(''); setPresentation({imageUrl:'',description:''});
      setDuration('60'); setCategoryId(''); setIsAddon(false); setOnlineBookable(true);
      toast.success(t('setupStep2Saved'));
      onSaved();
    } catch (error) { toast.danger(t('setupAddFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' })); }
  };

  if (settingsQuery.isError) return <PageError title={t('genericFailure')} error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />;
  if (!data) return <p><LoadingSpinner label={t('setupReadinessLoading')} /></p>;
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <div className="mb-3 flex flex-wrap gap-2 items-center justify-between"><h3 className="font-bold text-slate-900">{t('setupCurrentServices')}</h3><Badge variant={active.length ? 'success' : 'warning'}>{t('setupServicesEnabledCount', { p0: active.length })}</Badge></div>
        {(data?.services ?? []).map(service => <ServiceEditor key={service.id} service={service} categories={data?.serviceCategories ?? []} />)}
        {!active.length && <p className="p-4 text-amber-800">{t('setupNoServicesHint')}</p>}
      </div>
      <details open={settingsMode ? undefined : true} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6"><summary className="cursor-pointer font-semibold">{t('voiceImportTools')}</summary><div className="mt-4 space-y-4">
      <CatalogPresetPicker
        businessType={data?.location.businessType ?? null}
        existingNames={existingNames}
        onAdded={onSaved}
      />
      {canImportImages && <ImportWorkspace mode="catalog" />}
      </div></details>
      <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
      <CategoryManager categories={data?.serviceCategories ?? []} />
      <h3 className="font-semibold text-slate-900">{t('setupAddService')}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <CategoryPicker value={categoryId} onChange={setCategoryId} categories={data?.serviceCategories ?? []} />
        <Toggle checked={isAddon} onChange={setIsAddon} label={t('settings.stAddOnTag')} description={t('setupAddonHint')} />
        {!isAddon && <Toggle checked={onlineBookable} onChange={setOnlineBookable} label={t('setupOnlineBookable')} description="" />}
      </div>
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-5 sm:grid-cols-2 2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,.7fr)_minmax(0,.7fr)_auto]">
        <Field label={t('setupFieldServiceName')}><Input {...serviceForm.bind('name')} className={fieldClass} value={name} onChange={(e) => { setName(e.target.value); serviceForm.clearField('name'); }} placeholder={t('setupFieldServiceNamePlaceholder')} /></Field>

        <Field label={t('setupFieldPriceUsd')}><Input {...serviceForm.bind('price')} className={fieldClass} type="number" min="0" step="0.01" value={price} onChange={(e) => { setPrice(e.target.value); serviceForm.clearField('price'); }} placeholder="65.00" /></Field>
        <Field label={t('setupFieldDurationMin')}><Input {...serviceForm.bind('duration')} className={fieldClass} type="number" min="5" step="5" value={duration} onChange={(e) => { setDuration(e.target.value); serviceForm.clearField('duration'); }} /></Field>
        <GuardedButton
      isPending={saveService.isPending} permission="catalog.manage" onClick={add} isDisabled={saveService.isPending} className="h-11 self-end gap-2"><Plus className="size-4" />{t('setupAddService')}</GuardedButton>
        <details className="col-span-full"><summary className="cursor-pointer text-sm font-semibold">图片与简介 / Photo and description</summary><div className="mt-3 max-w-lg"><BookingImagePicker value={presentation.imageUrl} serviceName={name} onChange={imageUrl=>setPresentation(v=>({...v,imageUrl}))}/><textarea aria-label="Service description / 项目简介" placeholder="Service description / 项目简介" className="mt-3 w-full rounded-xl border p-3" maxLength={5000} value={presentation.description} onChange={e=>setPresentation(v=>({...v,description:e.target.value}))}/></div></details>
      </div>
      </section>

    </div>
  );
}

export function TeamStepForm({ onSaved, stepNumber = 5, settingsMode = false }: { onSaved: () => void; stepNumber?: number; settingsMode?: boolean }) {
  const { t } = useLanguage();
  const voiceOnly = useEntitlements().data?.plan === 'voice_booking';
  const settingsQuery = useDeskSettingsQuery();
  const { data } = settingsQuery;
  const saveStaff = useSaveStaffProfile();
  const [name, setName] = useState('');
  useSetupNewRecordGuard(Boolean(name.trim()));
  const [bookable, setBookable] = useState(true);
  const [rotation, setRotation] = useState(true);
  /** 员工录入表单的字段级校验。 */
  const staffForm = useFieldErrors<'name'>();
  const add = async () => {
    staffForm.clear();
    if (!name.trim()) { staffForm.fail('name', t('setupStep3MissingName')); return; }
    try {
      await saveStaff.mutateAsync({ name: name.trim(), isBookable: bookable, inRotation: !voiceOnly && rotation, maxConcurrentAppointments: 1 });
      setName(''); toast.success(t('setupStep3Saved')); onSaved();
    } catch (error) { toast.danger(t('setupAddFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' })); }
  };
  if (settingsQuery.isError) return <PageError title={t('genericFailure')} error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />;
  if (!data) return <p><LoadingSpinner label={t('setupReadinessLoading')} /></p>;
  const staff = data?.staff ?? [];
  if(settingsMode)return <><StaffSettings staff={staff} voiceOnly={voiceOnly}/>{voiceOnly && <SetupBookingCapacity/>}</>;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 md:grid-cols-2">
        <Field label={t('setupFieldStaffName')}><Input {...staffForm.bind('name')} className={fieldClass} value={name} onChange={(e) => { setName(e.target.value); staffForm.clearField('name'); }} placeholder="Amy" /></Field>
        <div className="flex items-end"><GuardedButton
        isPending={saveStaff.isPending} permission="staff.manage" onClick={add} isDisabled={saveStaff.isPending} className="h-11 w-full gap-2"><UserRoundPlus className="size-4" />{t('setupAddStaff')}</GuardedButton></div>
        <Toggle checked={bookable} onChange={setBookable} label={t('setupToggleBookableLabel')} description={t('setupToggleBookableDesc')} />
        {!voiceOnly && <Toggle checked={rotation} onChange={setRotation} label={t('setupToggleRotationLabel')} description={t('setupToggleRotationDesc')} />}
      </div>
      <div className="grid gap-3 2xl:grid-cols-2">{staff.map(member => <StaffEditor key={member.membershipId} staff={member} voiceOnly={voiceOnly} />)}</div>
      {voiceOnly && <SetupBookingCapacity />}
      {!staff.some((member) => member.isBookable) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t('setupStaffMinBookableHint')}</div>}
      {!settingsMode && <div className="rounded-xl border border-teal-100 bg-teal-50/60 p-4 text-sm leading-6 text-teal-900">{t('setupStep3Footer')}</div>}
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

  const voiceOnly = useEntitlements().data?.plan === 'voice_booking';
  const checks = (readiness?.steps ?? [])
    .filter((step): step is { id: SetupStepId; complete: boolean } => step.id in LAUNCH_CHECK_LABEL)
    .filter(step => !voiceOnly || step.id !== 'rooms')
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
      navigate(voiceOnly ? '/schedule' : '/dashboard', { replace: true });
    }
    catch (error) { toast.danger(t('setupLaunchFailed', { p0: error instanceof Error ? error.message : 'UNKNOWN' })); }
  };

  if (isLoading) {
    return <div className="py-10 text-center text-sm text-slate-500"><LoadingSpinner label={t('setupReadinessLoading')} /></div>;
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
        <GuardedButton
      isPending={finish.isPending} permission="settings.manage" onClick={launch} isDisabled={!ready || finish.isPending || isFetching} className="gap-2"><Rocket className="size-4" />{finish.isPending ? t('setupLaunching') : t('setupLaunchNow')}</GuardedButton>
      </div>
    </div>
  );
}
