import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowRight, Bot, CheckCircle2, Headphones, PhoneCall, Store, Ticket, UserRound } from 'lucide-react';
import { formatPhoneDisplay } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import { useCan } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PageError, PageLoading } from '@/components/ui/QueryState';
import { useDeskSettingsQuery, useSetupReadinessQuery } from '@/features/settings/api';
import { useSubmitSupportRequest } from '@/features/support/api';
import { voiceRoutingSnapshot, type VoiceRoutingMode, type VoiceChangeTarget } from './voiceRouting';

const modes: VoiceRoutingMode[] = [1, 2, 3];
const stateKeys = { unconfigured: 'setupAiVoiceStateUnconfigured', requested: 'setupAiVoiceStateRequested', ready_off: 'setupAiVoiceStateReadyOff', on: 'setupAiVoiceStateOn', suspended: 'setupAiVoiceStateSuspended' } as const;
const surface = 'rounded-2xl border border-slate-200 bg-white p-4 sm:p-6';

export function VoiceRoutingSettings() {
  const { membershipId } = useSession();
  return <VoiceRoutingSettingsBody key={membershipId} />;
}

function VoiceRoutingSettingsBody() {
  const { t } = useLanguage();
  const settings = useDeskSettingsQuery();
  const readiness = useSetupReadinessQuery();
  const canRequest = useCan('settings.manage');
  const { membershipId } = useSession();
  const qc = useQueryClient();
  const submit = useSubmitSupportRequest();
  const errorMessage = useErrorMessage();
  const [preview, setPreview] = useState<VoiceRoutingMode | null>(null);
  const [target, setTarget] = useState<VoiceChangeTarget | null>(null);
  const [requestedMode, setRequestedMode] = useState<VoiceRoutingMode | null>(null);
  const [notes, setNotes] = useState('');
  const [requestSnapshot, setRequestSnapshot] = useState('');
  const [error, setError] = useState('');
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const locked = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);

  if (settings.isError || readiness.isError) return <PageError error={settings.error || readiness.error} onRetry={() => { void settings.refetch(); void readiness.refetch(); }} />;
  if (!settings.data || !readiness.data) return <PageLoading title={t('setupReadinessLoading')} />;
  const data = settings.data;
  const current = voiceRoutingSnapshot(data);
  const shownMode = preview ?? current.mode ?? 2;
  const isCurrent = shownMode === current.mode;
  const ai = readiness.data.aiVoice;
  const phone = (value: string) => formatPhoneDisplay(value) || t('voiceRouteMissing');
  const modeName = (mode: VoiceRoutingMode | null) => mode ? t(`voiceRouteMode${mode}`) : t('voiceRouteUnknown');
  const targetName = (value: VoiceChangeTarget) => t(`voiceRouteTarget_${value}`);
  const currentSummary = [
    `${t('voiceRouteCurrent')}: ${modeName(current.mode)}`,
    `${t('voiceRouteTarget_store')}: ${phone(current.store)}`,
    `${t('voiceRouteTarget_ai')}: ${phone(current.ai)}`,
    `${t('voiceRouteTarget_human')}: ${phone(current.human)}`,
    `${t('voiceLineStatus')}: ${t(stateKeys[ai.state])}`,
    `${t('voiceEmail')}: ${data.voiceNotifications?.email || '—'}`,
    `${t('voiceSms')}: ${phone(data.voiceNotifications?.phone || '')}`,
  ].join('\n');

  function openRequest(value: VoiceChangeTarget) {
    if (!canRequest) return;
    setTarget(value);
    setRequestSnapshot(currentSummary);
    setRequestedMode(value === 'routing' || !isCurrent ? shownMode : null);
    setNotes(''); setError(''); setSubmittedId(null);
  }

  async function sendRequest() {
    if (!target || !notes.trim() || locked.current || !canRequest) return;
    const subject = `${t('voiceRouteTicketTitle')} · ${targetName(target)}`;
    const description = [
      requestSnapshot,
      `\n${t('voiceRouteRequestTarget')}: ${targetName(target)}`,
      ...(requestedMode ? [`${t('voiceRouteRequestedMode')}: ${modeName(requestedMode)}`] : []),
      `\n${t('voiceRouteRequestDetails')}:\n${notes.trim()}`,
    ].join('\n');
    const payload = JSON.stringify({ membershipId, subject, description });
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
    locked.current = true;
    setError('');
    try {
      const result = await submit.mutateAsync({ category: 'technical', subject, description, idempotencyKey: attempt.current.key });
      setSubmittedId(result.requestId);
      attempt.current = null;
      void qc.invalidateQueries({ queryKey: ['support', 'requests', membershipId] });
    } catch (err) { setError(errorMessage(err)); }
    finally { locked.current = false; }
  }

  const lineNode = (value: 'store' | 'ai' | 'human', label: string, detail: string, Icon: typeof Store) => (
    <button type="button" disabled={!canRequest} onClick={() => openRequest(value)}
      aria-label={`${t('voiceRouteRequestChange')}: ${label}`}
      className="group flex min-w-0 flex-1 flex-col items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-teal-400 hover:bg-teal-50/40 focus-visible:outline-2 focus-visible:outline-teal-600 disabled:cursor-default disabled:opacity-70">
      <Icon className="size-5 text-teal-700" aria-hidden="true" />
      <span className="font-semibold text-slate-900">{label}</span>
      <span className="break-all font-mono text-sm text-slate-700">{detail}</span>
      {canRequest && <span className="mt-auto flex items-center gap-1 text-xs text-teal-700"><Ticket className="size-3.5" />{t('voiceRouteRequestChange')}</span>}
    </button>
  );
  const connector = (label: string) => <div className="flex shrink-0 flex-col items-center justify-center gap-1 py-1 text-center text-xs text-slate-500 xl:w-24"><span>{label}</span><ArrowDown className="size-4 xl:hidden" aria-hidden="true" /><ArrowRight className="hidden size-4 xl:block" aria-hidden="true" /></div>;

  return <div className="space-y-6">
    <section className={surface}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2"><h3 className="text-lg font-semibold text-slate-950">{t('voiceRouteCurrent')}</h3><p className="text-sm font-medium text-teal-800">{modeName(current.mode)}</p></div>
        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">{t('voiceLineStatus')} · {t(stateKeys[ai.state])}</span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-500">{t('voiceRouteManaged')}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => openRequest('routing')} disabled={!canRequest}><Ticket className="size-4" />{t('voiceRouteRequestChange')}</Button>
        <Button variant="secondary" onClick={() => openRequest('answering')} disabled={!canRequest}>{t('voiceRouteTarget_answering')}</Button>
      </div>
    </section>

    <section className={`${surface} space-y-5`} aria-label={t('voiceRouteDiagram')}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">{t('voiceRouteDiagram')}</h3><span className="text-xs text-slate-500">{t('voiceRoutePreviewHint')}</span></div>
      <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label={t('voiceRouteModes')}>
        {modes.map(mode => <button key={mode} type="button" aria-pressed={shownMode === mode} onClick={() => setPreview(mode)} className={`rounded-xl border p-3 text-left text-sm leading-6 ${shownMode === mode ? 'border-teal-500 bg-teal-50 text-teal-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
          <span className="block font-semibold">{t(`voiceRouteMode${mode}`)}</span>{current.mode === mode && <span className="text-xs">{t('voiceRouteCurrentBadge')}</span>}
        </button>)}
      </div>
      <p role="status" className="text-sm text-slate-600">{t(isCurrent ? 'voiceRouteLiveView' : 'voiceRoutePreviewOnly')}</p>
      <div className="rounded-2xl bg-slate-50 p-4 sm:p-5">
        <p className="mb-4 flex items-center justify-center gap-2 text-sm text-slate-600"><UserRound className="size-4" />{t('voiceRouteCaller')}<ArrowDown className="size-4" /></p>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-stretch">
          {shownMode !== 2 && <>{lineNode('store', t('voiceRouteStoreNode'), current.mode === 2 ? t('voiceRouteNewStoreNumber') : phone(current.store), Store)}{connector(t(shownMode === 1 ? 'voiceRouteAllCalls' : 'voiceRouteBusyCalls'))}</>}
          {lineNode('ai', t(shownMode === 2 ? 'voiceRouteDirectNode' : 'voiceRouteAiNode'), phone(current.ai), Bot)}
          {connector(t('voiceRouteFallback'))}
          {lineNode('human', t('voiceRouteHumanNode'), phone(current.human), Headphones)}
        </div>
        <div className="mt-4 space-y-2 text-sm text-slate-600">
          {shownMode === 3 && <p className="flex items-start gap-2"><PhoneCall className="mt-0.5 size-4 shrink-0" />{t('voiceRouteNormalAnswer')}</p>}
          <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-teal-600" />{t('voiceRouteAiSuccess')}</p>
        </div>
      </div>
      {!isCurrent && <Button variant="secondary" disabled={!canRequest} onClick={() => openRequest('routing')}>{t('voiceRouteRequestMode')}</Button>}
    </section>

    <section className={`${surface} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{t('voiceRouteTarget_behavior')}</h3><Button variant="secondary" disabled={!canRequest} onClick={() => openRequest('behavior')}>{t('voiceRouteRequestChange')}</Button></div>
      <dl className="grid gap-4 sm:grid-cols-2 text-sm">
        <div className="sm:col-span-2"><dt className="text-slate-500">{t('voiceRouteGreeting')}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-slate-800">{data.phoneAssistant?.greetingPrompt || t('voiceRouteMissing')}</dd></div>
        <div><dt className="text-slate-500">{t('voiceRouteTone')}</dt><dd className="mt-1 text-slate-800">{({ warm:t('settings.stVoiceWarm'), professional:t('settings.stVoiceProfessional'), concise:t('settings.stVoiceEfficient') } as Record<string,string>)[data.phoneAssistant?.voiceTone || data.phoneAssistant?.tone || ''] || t('voiceRouteMissing')}</dd></div>
        <div><dt className="text-slate-500">{t('voiceRouteBooking')}</dt><dd className="mt-1 text-slate-800">{t(data.phoneAssistant?.autoBookEnabled === undefined ? 'voiceRouteMissing' : data.phoneAssistant.autoBookEnabled ? 'voiceRouteEnabled' : 'voiceRouteDisabled')}</dd></div>
        <div><dt className="text-slate-500">{t('voiceRouteVoicemail')}</dt><dd className="mt-1 text-slate-800">{t(data.phoneAssistant?.afterHoursVoicemail === undefined ? 'voiceRouteMissing' : data.phoneAssistant.afterHoursVoicemail ? 'voiceRouteEnabled' : 'voiceRouteDisabled')}</dd></div>
      </dl>
    </section>
    <section className={`${surface} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{t('voiceSummaryRecipients')}</h3><Button variant="secondary" disabled={!canRequest} onClick={() => openRequest('notifications')}>{t('voiceRouteRequestChange')}</Button></div>
      <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">{t('voiceEmail')}</dt><dd className="mt-1 break-all text-slate-800">{data.voiceNotifications?.email || t('voiceRouteMissing')}</dd></div><div><dt className="text-slate-500">{t('voiceSms')}</dt><dd className="mt-1 text-slate-800">{phone(data.voiceNotifications?.phone || '')}</dd></div></dl>
    </section>

    <Modal isOpen={target !== null} onOpenChange={open => { if (!open) setTarget(null); }} title={t('voiceRouteTicketTitle')} description={t('voiceRouteManaged')} isDismissDisabled={submit.isPending} size="lg"
      footer={submittedId ? <Link className="font-medium text-teal-700 underline" to="/support">{t('voiceRouteViewTicket')}</Link> : <><Button variant="secondary" disabled={submit.isPending} onClick={() => setTarget(null)}>{t('cancel')}</Button><Button disabled={!notes.trim() || submit.isPending || !canRequest} isPending={submit.isPending} onClick={() => void sendRequest()}>{t('support.submit')}</Button></>}>
      {submittedId ? <div role="status" className="space-y-3 py-4"><CheckCircle2 className="size-8 text-teal-600" /><p className="font-semibold">{t('voiceRouteSubmitted')}</p><p className="text-sm text-slate-600">{t('voiceRouteAwaiting')}</p><p className="break-all font-mono text-xs text-slate-500">{submittedId}</p></div> : <div className="space-y-4">
        <pre className="whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-4 font-sans text-sm leading-6 text-slate-600">{requestSnapshot}</pre>
        <p className="text-sm font-semibold">{t('voiceRouteRequestTarget')}: {target && targetName(target)}</p>
        {(target === 'routing' || requestedMode !== null) && <label className="block space-y-2 text-sm font-medium">{t('voiceRouteRequestedMode')}<select disabled={submit.isPending} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3" value={requestedMode ?? ''} onChange={e => setRequestedMode(e.target.value ? Number(e.target.value) as VoiceRoutingMode : null)}><option value="">{t('voiceRouteKeepMode')}</option>{modes.map(mode => <option key={mode} value={mode}>{modeName(mode)}</option>)}</select></label>}
        <label className="block space-y-2 text-sm font-medium">{t('voiceRouteRequestDetails')}<textarea disabled={submit.isPending} value={notes} onChange={e => setNotes(e.target.value)} maxLength={4000} rows={5} placeholder={t('voiceRouteDetailsPlaceholder')} className="w-full rounded-xl border border-slate-200 p-3 font-normal outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100" /></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>}
    </Modal>
  </div>;
}
