import { ServiceCatalog } from '@/features/settings/ServiceCatalog';
import { VoiceRoutingSettings } from './VoiceRoutingSettings';
import { PageError } from '@/components/ui/QueryState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Store, Scissors, Users, PhoneCall, CreditCard, ArrowUpRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { PublicBookingLink } from './PublicBookingLink';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { useCan } from '@/lib/permissions';
import { runCommand } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BillingPanel } from '@/features/billing/BillingPanel';
import { useDeskSettingsQuery, settingsKeys } from '@/features/settings/api';
import { StoreStepForm, TeamStepForm } from '@/features/setup/StepForms';
import { DirectoryStepForm } from '@/features/setup/steps';
import { SetupSaveProvider, useSetupSave, SaveStatus, useSetupDraft } from '@/features/setup/autosave';
import { Field } from '@/features/setup/primitives';
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
  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const current = tabs.find(tab => tab.id === (aliases[requested] ?? requested))?.id ?? tabs[0]?.id;
  const switchTab = async (id: string) => { if (await saves?.flush()) setParams({ tab:id }); };
  useEffect(() => {
    panelRef.current?.closest('main')?.scrollTo({ top: 0, left: 0 });
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active) nav.scrollLeft = Math.max(0, active.offsetLeft - nav.offsetLeft - 8);
  }, [current]);
  const descriptions: Record<string, TranslationKey> = { store: 'voiceStoreDescription', services: 'voiceServicesDescription', staff: 'voiceTeamDescription', phone: 'voicePhoneDescription', billing: 'voiceBillingDescription' };
  const selectedTab = tabs.find(tab => tab.id === current);
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
  return <div className="gf-service-page mx-auto max-w-7xl space-y-6 pb-12">
    <PageHeader title={t('settings')} description={t(current === 'phone' ? 'voiceRouteManaged' : current === 'services' ? 'catalogPageHint' : 'voiceSettingsIntro')} />
    <div className="grid items-start gap-6 xl:grid-cols-[192px_minmax(0,1fr)]">
    <nav ref={navRef} aria-label={t('voiceSettingsTitle')} className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 xl:sticky xl:top-0 xl:flex-col">{tabs.map(tab => {
      const Icon = icons[tab.id as keyof typeof icons];
      return <Button key={tab.id} variant="ghost" aria-current={current === tab.id ? 'page' : undefined}
        className={`min-h-11 shrink-0 justify-start gap-3 whitespace-nowrap rounded-xl px-3 text-sm ${current === tab.id ? 'bg-teal-50 text-teal-800' : 'text-slate-500'}`}
        onClick={() => void switchTab(tab.id)}><Icon className="size-4" />{t(tab.label as TranslationKey)}</Button>;
    })}</nav>
    <div ref={panelRef} className="min-w-0 space-y-5">
    {selectedTab && <header className="space-y-1 px-1"><h2 className="text-xl font-semibold text-slate-950">{t(selectedTab.label as TranslationKey)}</h2><p className="text-sm leading-6 text-slate-500">{t(descriptions[current!])}</p></header>}
    {!current && <p>{t('errorPERMISSION_DENIED')}</p>}
    <section aria-label={selectedTab ? t(selectedTab.label as TranslationKey) : undefined} className="min-w-0 space-y-6">
      {current === 'store' && <><StoreStepForm settingsMode onSaved={() => undefined} /><PublicBookingLink /></>}
      {current === 'services' && <ServiceCatalog />}
      {current === 'staff' && <div className="space-y-6"><TeamStepForm settingsMode onSaved={() => undefined} />{manage && <BookingRules />}<details className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6"><summary className="cursor-pointer font-semibold">{t('voiceStaffAdvanced')}</summary><div className="mt-4"><DirectoryStepForm /></div></details></div>}
      {current === 'phone' && <VoiceRoutingSettings />}
      {current === 'billing' && <BillingPanel />}
    </section>
    {manage && <Button variant="ghost" onClick={async () => { if (await saves?.flush()) navigate('/communication-logs'); }}>{t('voiceDeliveryTitle')}<ArrowUpRight className="size-3.5" /></Button>}
    </div></div>
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
  return <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6"><h2 className="font-semibold">{t('voiceBookingWindow')}</h2><div className="grid gap-4 sm:grid-cols-2">
    <Field label={t('voiceBookingMaxDays')}><Input type="number" min="1" max="365" value={draft.value.maxDaysAhead} onChange={e => draft.set(old=>({...old,maxDaysAhead:Number(e.target.value)}))} /></Field>
    <Field label={t('voiceBookingMinMinutes')}><Input type="number" min="0" max="1440" value={draft.value.minMinutesAhead} onChange={e => draft.set(old=>({...old,minMinutesAhead:Number(e.target.value)}))} /></Field>
  </div><SaveStatus {...draft} /></section>;
}
