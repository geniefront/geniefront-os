import { PageError } from '@/components/ui/QueryState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Store, Scissors, Users, PhoneCall, CreditCard, ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PublicBookingLink } from './PublicBookingLink';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@heroui/react';
import { formatPhoneDisplay } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { useCan } from '@/lib/permissions';
import { useErrorMessage } from '@/lib/errorMessage';
import { runCommand } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BillingPanel } from '@/features/billing/BillingPanel';
import { useDeskSettingsQuery, useSetupReadinessQuery, settingsKeys } from '@/features/settings/api';
import { StoreStepForm, CatalogStepForm, TeamStepForm } from '@/features/setup/StepForms';
import { DirectoryStepForm } from '@/features/setup/steps';
import { SetupSaveProvider, useSetupSave, SaveStatus, useSetupDraft } from '@/features/setup/autosave';
import { Field, selectClass } from '@/features/setup/primitives';
import type { TranslationKey } from '@/i18n';

export function VoiceSettings() { return <SetupSaveProvider><SettingsBody /></SetupSaveProvider>; }
function SettingsBody() {
  const { t } = useLanguage(); const [params, setParams] = useSearchParams();
  const navigate = useNavigate(); const saves = useSetupSave();
  const manage = useCan('settings.manage'), catalog = useCan('catalog.manage'), staff = useCan('staff.manage'), billing = useCan('billing.manage');
  const tabs = [
    { id: 'store', label: 'voiceStoreTab', enabled: manage },
    { id: 'services', label: 'voiceServicesTab', enabled: catalog },
    { id: 'staff', label: 'voiceTeamTab', enabled: staff },
    { id: 'phone', label: 'voicePhoneTab', enabled: manage },
    { id: 'billing', label: 'voiceBillingTab', enabled: billing },
  ].filter(tab => tab.enabled);
  const icons = { store: Store, services: Scissors, staff: Users, phone: PhoneCall, billing: CreditCard };
  const aliases: Record<string, string> = { hours:'store', booking:'staff', ai_phone:'phone', notifications:'phone', '10dlc':'phone' };
  const requested = params.get('tab') ?? 'phone';
  const current = tabs.find(tab => tab.id === (aliases[requested] ?? requested))?.id ?? tabs[0]?.id;
  const switchTab = async (id: string) => { if (await saves?.flush()) setParams({ tab:id }); };
  // Keep sidebar links from discarding a pending edit while this autosave page is mounted.
  useEffect(() => {
    const onLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || link.origin !== window.location.origin || link.pathname === window.location.pathname) return;
      event.preventDefault(); event.stopPropagation();
      void saves?.flush().then(ok => { if (ok) navigate(link.pathname + link.search + link.hash); });
    };
    document.addEventListener('click', onLink, true);
    return () => document.removeEventListener('click', onLink, true);
  }, [saves, navigate]);
  return <div className="gf-service-page mx-auto max-w-6xl space-y-6 pb-12">
    <PageHeader title={t('settings')} description={t('voiceSettingsIntro')} />
    <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
    <nav aria-label={t('voiceSettingsTitle')} className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap">{tabs.map(tab => {
      const Icon = icons[tab.id as keyof typeof icons];
      return <Button key={tab.id} variant="ghost" aria-current={current === tab.id ? 'page' : undefined}
        className={`shrink-0 justify-start gap-3 rounded-lg px-3 text-sm ${current === tab.id ? 'bg-teal-50 text-teal-800' : 'text-slate-500'}`}
        onClick={() => void switchTab(tab.id)}><Icon className="size-4" />{t(tab.label as TranslationKey)}</Button>;
    })}</nav>
    <div className="min-w-0 space-y-4">
    {!current && <p>{t('errorPERMISSION_DENIED')}</p>}
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      {current === 'store' && <><PublicBookingLink /><StoreStepForm onSaved={() => undefined} /></>}
      {current === 'services' && <CatalogStepForm onSaved={() => undefined} />}
      {current === 'staff' && <div className="space-y-6"><TeamStepForm settingsMode onSaved={() => undefined} />{manage && <BookingRules />}<details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{t('voiceStaffAdvanced')}</summary><div className="mt-4"><DirectoryStepForm /></div></details></div>}
      {current === 'phone' && <PhoneSettings />}
      {current === 'billing' && <BillingPanel />}
    </section>
    {manage && <Button variant="ghost" onClick={async () => { if (await saves?.flush()) navigate('/communication-logs'); }}>{t('voiceDeliveryTitle')}<ArrowUpRight className="size-3.5" /></Button>}
    </div></div>
  </div>;
}
function PhoneSettings() {
  const { t } = useLanguage(); const { membershipId } = useSession(); const qc = useQueryClient(); const message = useErrorMessage();
  const settings = useDeskSettingsQuery(); const readiness = useSetupReadinessQuery(); const [switching, setSwitching] = useState(false);
  const data = settings.data;
  const routing = useSetupDraft(data ? {
    storefrontE164: data.phone.storefrontE164 ?? data.location.phone ?? '',
    transferTargetE164: data.phone.transferTargetE164 ?? '',
    forwardingMode: data.phone.forwardingMode === 'all' ? 'all' as const : 'busy_no_answer' as const,
  } : null, async value => {
    await runCommand('location.requestAiVoice', value, membershipId!);
    await qc.invalidateQueries({queryKey:settingsKeys.desk(membershipId)});
  }, `setup-phone-routing:${membershipId}`);
  const recipients = useSetupDraft(data ? { email: data.voiceNotifications?.email ?? '', phone: data.voiceNotifications?.phone ?? '' } : null, async value => {
    await runCommand('settings.saveVoiceNotifications', { email:value.email.trim() || null, phone:value.phone.trim() || null }, membershipId!);
    await qc.invalidateQueries({queryKey:settingsKeys.desk(membershipId)});
  }, `setup-notification-recipients:${membershipId}`);
  const ai = readiness.data?.aiVoice;
  const stateKeys = { unconfigured:'setupAiVoiceStateUnconfigured', requested:'setupAiVoiceStateRequested', ready_off:'setupAiVoiceStateReadyOff', on:'setupAiVoiceStateOn', suspended:'setupAiVoiceStateSuspended' } as const;
  const toggle = async () => {
    if (!ai) return;
    setSwitching(true);
    try { await runCommand('location.savePhoneAssistantLine', {aiAnswer:!ai.effectiveAiAnswer}, membershipId!); await readiness.refetch(); }
    catch(e) { toast.danger(message(e)); } finally { setSwitching(false); }
  };
  if (settings.isError || readiness.isError) return <p role="alert">{t('genericFailure')} <Button onClick={() => { void settings.refetch(); void readiness.refetch(); }}>{t('setupRetry')}</Button></p>;
  if (!data || !routing.value || !recipients.value || !ai) return <p>{t('setupReadinessLoading')}</p>;
  return <div className="space-y-7">
    <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-5"><h2 className="font-semibold">{t('voiceLineStatus')} · {t(stateKeys[ai.state])}</h2>
      {data.phone.aiVoiceE164 && <p className="font-mono">{formatPhoneDisplay(data.phone.aiVoiceE164)}</p>}
      <p className="text-sm text-slate-600">{t('voiceLineHint')}</p>
      <label className="flex items-center gap-3 font-semibold"><input type="checkbox" checked={ai.effectiveAiAnswer} disabled={switching || (!ai.ready && !ai.effectiveAiAnswer)} onChange={() => void toggle()} />{t('voiceAnswerEnabled')}</label>
    </section>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('voicePublicPhone')}><Input type="tel" value={routing.value.storefrontE164} onChange={e => routing.set(old => ({...old,storefrontE164:e.target.value}))} /></Field>
      <Field label={t('voiceTransferPhone')}><Input type="tel" value={routing.value.transferTargetE164} onChange={e => routing.set(old => ({...old,transferTargetE164:e.target.value}))} /></Field>
      <Field label={t('voiceForwarding')}><select className={selectClass} value={routing.value.forwardingMode} onChange={e => routing.set(old => ({...old,forwardingMode:e.target.value as 'all' | 'busy_no_answer'}))}><option value="busy_no_answer">{t('voiceForwardBusy')}</option><option value="all">{t('voiceForwardAll')}</option></select></Field>
    </div><p className="text-sm text-slate-500">{t('voiceForwardHint')}</p><SaveStatus {...routing} />
    <section className="space-y-4 border-t pt-6"><h2 className="font-semibold">{t('voiceSummaryRecipients')}</h2><p className="text-sm text-slate-500">{t('voiceRecipientsHint')}</p>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={t('voiceEmail')}><Input type="email" value={recipients.value.email} onChange={e => recipients.set(old => ({...old,email:e.target.value}))} /></Field><Field label={t('voiceSms')}><Input type="tel" value={recipients.value.phone} onChange={e => recipients.set(old => ({...old,phone:e.target.value}))} /></Field></div>
      <SaveStatus {...recipients} />
    </section>
  </div>;
}

function BookingRules() {
  const { t } = useLanguage(); const { membershipId } = useSession(); const qc = useQueryClient();
  const query = useDeskSettingsQuery();
  const { data } = query;
  const draft = useSetupDraft(data?.voiceBookingRules ?? null, async value => {
    await runCommand('settings.saveVoiceBookingRules',value,membershipId!);
    await qc.invalidateQueries({queryKey:settingsKeys.desk(membershipId)});
  }, `setup-booking-rules:${membershipId}`);
  if (query.isError) return <PageError error={query.error} onRetry={() => query.refetch()} />;
  if (!draft.value) return <p>{t('setupReadinessLoading')}</p>;
  return <section className="space-y-4 rounded-xl border p-4"><h2 className="font-semibold">{t('voiceBookingWindow')}</h2><div className="grid gap-4 sm:grid-cols-2">
    <Field label={t('voiceBookingMaxDays')}><Input type="number" min="1" max="365" value={draft.value.maxDaysAhead} onChange={e => draft.set(old=>({...old,maxDaysAhead:Number(e.target.value)}))} /></Field>
    <Field label={t('voiceBookingMinMinutes')}><Input type="number" min="0" max="1440" value={draft.value.minMinutesAhead} onChange={e => draft.set(old=>({...old,minMinutesAhead:Number(e.target.value)}))} /></Field>
  </div><SaveStatus {...draft} /></section>;
}
