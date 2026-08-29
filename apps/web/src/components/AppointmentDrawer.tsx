import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, AlertTriangle, BedDouble, CalendarClock, Check, ChevronRight,
  CreditCard, Edit3, FileHeart, FileText, Gift, HeartPulse, Languages, Plus,
  QrCode, Scissors, Settings, Sparkles, Stethoscope, User, X,
} from 'lucide-react';
import { Spinner, toast } from '@heroui/react';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '@/LanguageContext';
import { useSchedule, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import {
  useAppointmentDetailQuery,
  useAppointmentFormsQuery,
  useHealthFormSubmissionQuery,
  useSaveAppointmentServiceBrief,
} from '@/features/schedule/appointmentDetail';
import { useCancelAppointment, useRescheduleAppointment } from '@/features/schedule/api';
import { useCustomerDetail, useSaveCustomerPreferences } from '@/features/customers/api';
import { useAddTicketItem, useSaveServiceNote, useTicketsList } from '@/features/tickets/api';
import { useShareForm, type FormShareResult } from '@/features/forms/api';
import { generateAiHealthSummary } from '@/features/forms/mockData';
import type { CancelReason } from '@/features/schedule/types';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { GuardedButton } from './ui/GuardedButton';
import { Modal } from './ui/Modal';
import { useErrorMessage } from '@/lib/errorMessage';
import { instantToWallDate, instantToWallMinutes, useStoreTime, wallMinutesToInstant } from '@/lib/time';
import { centsToDollars } from '@/features/checkout/api';
import { cn, formatPhoneDisplay } from '@/lib/utils';

interface AppointmentDrawerProps {
  onClose: () => void;
  appointmentId?: string | null;
  initialStatus?: 'booked' | 'checked_in' | 'in_service' | 'done';
}

type Tab = 'service' | 'health' | 'preferences' | 'notes';
const CANCEL_REASONS: CancelReason[] = ['guest_changed_mind', 'duplicate_booking', 'no_show', 'walk_out', 'input_error', 'other'];

function display(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function AppointmentDrawer({ onClose, appointmentId, initialStatus = 'booked' }: AppointmentDrawerProps) {
  const { t, language } = useLanguage();
  const errorMessage = useErrorMessage();
  const storeTime = useStoreTime();
  const navigate = useNavigate();
  const { currentDate, services, staff, resources, timezone, refetch: refetchSchedule } = useSchedule();
  const appointmentQ = useAppointmentDetailQuery(appointmentId ?? null);
  const appointmentFormsQ = useAppointmentFormsQuery(appointmentId ?? null);
  const appointment = appointmentQ.data;
  const customerQ = useCustomerDetail(appointment?.customer.id ?? null);
  const ticketsQ = useTicketsList();
  const activeTicket = useMemo(
    () => ticketsQ.data?.tickets.find((ticket) => ticket.appointmentId === appointmentId),
    [appointmentId, ticketsQ.data?.tickets],
  );

  const [tab, setTab] = useState<Tab>('service');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState<CancelReason>('guest_changed_mind');
  const [keepStaffTurn, setKeepStaffTurn] = useState(true);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [date, setDate] = useState(currentDate);
  const [time, setTime] = useState('09:00');
  const [staffId, setStaffId] = useState(UNASSIGNED_STAFF_ID);
  const [roomId, setRoomId] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [serviceId, setServiceId] = useState('');
  const [addStaffId, setAddStaffId] = useState('');
  const [preferences, setPreferences] = useState('');
  const [noteItemId, setNoteItemId] = useState('');
  const [serviceNote, setServiceNote] = useState('');
  const [share, setShare] = useState<FormShareResult | null>(null);
  const [healthRequested, setHealthRequested] = useState(false);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [briefEditing, setBriefEditing] = useState(false);
  const [serviceBrief, setServiceBrief] = useState('');

  const cancelM = useCancelAppointment(currentDate);
  const rescheduleM = useRescheduleAppointment(currentDate);
  const addItemM = useAddTicketItem();
  const savePreferencesM = useSaveCustomerPreferences();
  const saveNoteM = useSaveServiceNote();
  const shareM = useShareForm();
  const saveBriefM = useSaveAppointmentServiceBrief(appointmentId ?? null);
  const appointmentForms = appointmentFormsQ.data?.forms.filter((form) => form.isLatest) ?? [];
  const activeForm = appointmentForms.find((form) => form.submissionId === selectedSubmissionId) ?? appointmentForms[0] ?? null;
  const healthQ = useHealthFormSubmissionQuery(activeForm?.submissionId ?? null, healthRequested);
  const aiSummary = useMemo(() => {
    if (!activeForm || !healthQ.data?.answers) return null;
    const answers = healthQ.data.answers;
    return generateAiHealthSummary({
      templateKey: activeForm.templateKey,
      answers,
      avoidAreas: Array.isArray(answers.bodyMapAvoid) ? answers.bodyMapAvoid as string[] : [],
    });
  }, [activeForm, healthQ.data?.answers]);

  useEffect(() => {
    const first = appointment?.items[0];
    if (!first) return;
    setDate(instantToWallDate(first.startsAt, timezone));
    const minutes = instantToWallMinutes(first.startsAt, timezone);
    setTime(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
    setStaffId(first.staffId ?? UNASSIGNED_STAFF_ID);
    setRoomId(first.resourceId ?? '');
  }, [appointment?.appointmentId, appointment?.items, timezone]);

  useEffect(() => setPreferences(customerQ.data?.preferences.freeNotes ?? ''), [customerQ.data?.id, customerQ.data?.preferences.freeNotes]);
  useEffect(() => setServiceBrief(appointment?.notes ?? ''), [appointment?.appointmentId, appointment?.notes]);
  useEffect(() => {
    if (!noteItemId && activeTicket?.items[0]) setNoteItemId(activeTicket.items[0].ticketItemId);
  }, [activeTicket?.items, noteItemId]);

  const refresh = async () => {
    await Promise.all([appointmentQ.refetch(), appointmentFormsQ.refetch(), ticketsQ.refetch()]);
    refetchSchedule();
  };

  const runCancel = async () => {
    if (!appointmentId) return;
    try {
      await cancelM.mutateAsync({ appointmentId, reason: cancelReason, keepStaffTurn });
      toast.success(t('schedule.adCancelled'));
      onClose();
    } catch (error) { toast.danger(`${t('schedule.adCancelFailed')} ${errorMessage(error)}`); }
  };

  const runReschedule = async () => {
    const first = appointment?.items[0];
    const [hours, minutes] = time.split(':').map(Number);
    if (!appointmentId || !first || hours == null || minutes == null) return;
    try {
      await rescheduleM.mutateAsync({
        appointmentId,
        itemId: first.itemId,
        startsAt: wallMinutesToInstant(date, hours * 60 + minutes, timezone),
        membershipId: staffId === UNASSIGNED_STAFF_ID ? null : staffId,
        resourceId: roomId || null,
      });
      setRescheduleOpen(false);
      toast.success(t('schedule.adItemsUpdated'));
      await refresh();
    } catch (error) { toast.danger(`${t('schedule.adItemsFailed')} ${errorMessage(error)}`); }
  };

  const runAddItem = async () => {
    if (!activeTicket || !serviceId || !addStaffId) return;
    try {
      await addItemM.mutateAsync({
        ticketId: activeTicket.ticketId,
        serviceId,
        membershipId: addStaffId,
        kind: 'addon',
        minutes: services.find((item) => item.id === serviceId)?.durationMin,
        idempotencyKey: crypto.randomUUID(),
      });
      setAddOpen(false);
      toast.success(t('schedule.adRealAddOnAdded'));
      await refresh();
    } catch (error) { toast.danger(errorMessage(error)); }
  };

  const runSavePreferences = async () => {
    if (!appointment?.customer.id) return;
    try {
      await savePreferencesM.mutateAsync({ customerId: appointment.customer.id, freeNotes: preferences });
      toast.success(t('schedule.adPrefsSaved'));
    } catch (error) { toast.danger(`${t('schedule.adPrefsSaveFailed')} ${errorMessage(error)}`); }
  };

  const runSaveBrief = async () => {
    try {
      await saveBriefM.mutateAsync(serviceBrief.trim());
      setBriefEditing(false);
      toast.success(t('schedule.adServiceBriefSaved'));
      await refresh();
    } catch (error) { toast.danger(errorMessage(error)); }
  };

  const runSaveNote = async () => {
    if (!noteItemId || !serviceNote.trim()) return;
    try {
      await saveNoteM.mutateAsync({ ticketItemId: noteItemId, content: serviceNote.trim(), visibility: 'management', containsSensitiveData: true });
      setServiceNote('');
      toast.success(t('schedule.adSoapSaved'));
    } catch (error) { toast.danger(errorMessage(error)); }
  };

  const runShare = async () => {
    if (!appointmentId) return;
    try {
      setShare(await shareM.mutateAsync({ customerId: appointment?.customer.id ?? null, appointmentId, locale: language }));
    } catch (error) { toast.danger(errorMessage(error)); }
  };

  const shell = (body: ReactNode) => (
    <div className="fixed inset-0 z-[200] flex justify-end bg-slate-950/35 backdrop-blur-[1px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="flex h-full w-full max-w-[540px] flex-col border-l border-slate-200 bg-white shadow-2xl" aria-label={t('schedule.adDrawerLabel')}>
        {body}
      </aside>
    </div>
  );

  if (!appointmentId) return shell(<div className="m-auto p-8 text-center text-slate-500">{t('schedule.adNoAppointmentSelected')}</div>);
  if (appointmentQ.isLoading) return shell(<div className="m-auto flex flex-col items-center gap-3"><Spinner />{t('schedule.adLoadingAll')}</div>);
  if (appointmentQ.isError || !appointment) return shell(<div className="m-auto flex max-w-sm flex-col items-center gap-3 p-8 text-center"><AlertCircle className="text-rose-500" /><p className="font-semibold">{t('schedule.adLoadFailed')}</p><p className="text-sm text-slate-500">{errorMessage(appointmentQ.error)}</p><Button variant="outline" onPress={() => void appointmentQ.refetch()}>{t('retry')}</Button></div>);

  const tabs: Array<[Tab, string, typeof FileText]> = [
    ['service', t('schedule.adTabService'), FileText],
    ['health', t('schedule.adTabHealth'), HeartPulse],
    ['preferences', t('schedule.adTabPrefs'), Settings],
    ['notes', t('schedule.adTabNotes'), Stethoscope],
  ];
  const customerInitials = appointment.customer.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
  const status: NonNullable<AppointmentDrawerProps['initialStatus']> = appointment.status === 'completed'
    ? 'done'
    : appointment.status === 'booked' || appointment.status === 'checked_in' || appointment.status === 'in_service' || appointment.status === 'done'
      ? appointment.status
      : initialStatus;
  const statusRank = status === 'done' ? 4 : status === 'in_service' ? 3 : status === 'checked_in' ? 2 : 1;
  const totalCents = activeTicket?.subtotalCents ?? appointment.items.reduce((sum, item) => sum + item.priceCents, 0);

  return shell(<>
    <section className="shrink-0 border-b border-slate-200 bg-gradient-to-br from-slate-50 to-white px-5 pb-4 pt-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-teal-600 text-lg font-black text-white shadow-md shadow-teal-600/20">{customerInitials}</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="truncate text-xl font-black text-slate-950">{appointment.customer.name}</h2>{customerQ.data?.vipLevel ? <Badge variant="warning" className="text-[10px] font-black">VIP {customerQ.data.vipLevel}</Badge> : <Badge variant="outline" className="text-[10px]">{appointment.customer.id ? t('schedule.adMemberProfile') : t('schedule.adWalkInTicket')}</Badge>}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs font-semibold text-slate-500"><span className="font-mono">{appointment.customer.phone ? formatPhoneDisplay(appointment.customer.phone) : t('schedule.adNoPhone')}</span>{appointment.customer.id && <><span className="text-slate-300">•</span><button type="button" onClick={() => navigate(`/customers/${appointment.customer.id}`)} className="flex items-center font-bold text-teal-700 hover:underline">{t('schedule.adProfileDetail')}<ChevronRight size={13}/></button></>}</div>
          </div>
        </div>
        <Button size="icon" variant="ghost" aria-label={t('close')} onPress={onClose} className="shrink-0 rounded-full"><X size={20} /></Button>
      </div>
      <div className="grid grid-cols-4 gap-1 border-t border-slate-200/80 pt-3">
        {[t('schedule.adStageBooked'), t('schedule.adStageArrived'), t('schedule.adStageInService'), t('schedule.adStageFinished')].map((label, index) => { const reached = statusRank >= index + 1; return <div key={label} className={cn('flex flex-col items-center gap-1 text-[10px] font-bold', reached ? 'text-teal-700' : 'text-slate-400')}><span className={cn('grid h-5 w-5 place-items-center rounded-full text-[10px]', reached ? 'bg-teal-500 text-white shadow-sm' : 'bg-slate-200 text-slate-500')}>{reached && statusRank > index + 1 ? <Check size={12}/> : index + 1}</span><span>{label}</span></div>; })}
      </div>
    </section>
    <div className="flex shrink-0 border-b border-slate-200 bg-white" role="tablist">{tabs.map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn('flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-3 text-xs font-bold transition', tab === id ? 'border-teal-500 bg-teal-50/50 text-teal-800' : 'border-transparent text-slate-500 hover:bg-slate-50')}><Icon size={14}/>{label}</button>)}</div>
    <main className="flex-1 overflow-y-auto bg-slate-50/70 p-4">
      {tab === 'service' && <div className="space-y-4">
        <section className="grid grid-cols-3 gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <Metric label={t('schedule.adVisitFrequency')} value={`${customerQ.data?.visits.total ?? '—'} ${t('schedule.adVisitUnit')}`} />
          <Metric label={t('schedule.adLastVisit')} value={customerQ.data?.visits.lastAt ? storeTime.dateTime(customerQ.data.visits.lastAt) : t('schedule.adFirstVisitToday')} compact />
          <Metric label={t('schedule.adAvgSpend')} value={customerQ.data?.visits.avgSpendCents == null ? '—' : `$${centsToDollars(customerQ.data.visits.avgSpendCents)}`} accent />
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between gap-2"><SectionTitle icon={<Scissors size={15}/>} label={t('schedule.adBookedServices')} /><div className="flex gap-1.5"><GuardedButton permission="appointment.write" size="sm" variant="secondary" className="h-7 gap-1 bg-teal-50 px-2.5 text-[11px] font-bold text-teal-800" onPress={() => setRescheduleOpen(true)}><Edit3 size={13}/>{t('schedule.adEditItems')}</GuardedButton>{activeTicket && <GuardedButton permission="ticket.write" size="sm" variant="secondary" className="h-7 gap-1 bg-violet-50 px-2.5 text-[11px] font-bold text-violet-800" onPress={() => setAddOpen(true)}><Plus size={13}/>{t('schedule.adAddOn')}</GuardedButton>}</div></div>
          <div className="divide-y divide-slate-100">{appointment.items.map((item) => <article key={item.itemId} className="space-y-2 py-3 first:pt-1 last:pb-1"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><h4 className="font-bold text-slate-900">{item.serviceName}</h4><Badge variant="secondary" className="px-1.5 py-0 font-mono text-[10px]">{item.durationMin}m</Badge></div><span className="font-mono font-black text-teal-700">${centsToDollars(item.priceCents)}</span></div><div className="grid grid-cols-2 gap-2 text-[11px] font-medium text-slate-600"><span className="flex items-center gap-1"><User size={13} className="text-slate-400"/>{item.staffName ?? t('schedule.adUnassignedStaff')}</span><span className="flex items-center gap-1"><BedDouble size={13} className="text-slate-400"/>{item.resourceName ?? t('schedule.adNoRoom')}</span><span className="col-span-2 flex items-center gap-1"><CalendarClock size={13} className="text-slate-400"/>{storeTime.dateTime(item.startsAt)}</span></div></article>)}</div>
          {!activeTicket && <p className="rounded-xl bg-slate-50 p-2.5 text-[11px] text-slate-500">{t('schedule.adAddOnNeedsTicket')}</p>}
        </section>

        <section className="space-y-2.5 rounded-2xl border border-amber-200 bg-amber-50/80 p-3.5 shadow-sm">
          <div className="flex items-center justify-between gap-2"><SectionTitle icon={<AlertTriangle size={15}/>} label={t('schedule.adServiceBriefTitle')} amber />{!briefEditing && <GuardedButton permission="appointment.write" size="sm" variant="secondary" className="h-7 bg-white px-2.5 text-[11px] font-bold text-amber-900" onPress={() => setBriefEditing(true)}><Edit3 size={13}/>{t('schedule.adEditBrief')}</GuardedButton>}</div>
          {briefEditing ? <><textarea value={serviceBrief} onChange={(event) => setServiceBrief(event.target.value)} maxLength={2000} rows={4} autoFocus className="w-full resize-none rounded-xl border border-amber-300 bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-amber-200" placeholder={t('schedule.adServiceBriefPlaceholder')} /><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onPress={() => { setServiceBrief(appointment.notes ?? ''); setBriefEditing(false); }}>{t('cancel')}</Button><GuardedButton permission="appointment.write" size="sm" onPress={() => void runSaveBrief()} isPending={saveBriefM.isPending}>{t('schedule.adSaveBrief')}</GuardedButton></div></> : <p className="rounded-xl border border-amber-200/80 bg-white/90 p-3 text-sm font-medium leading-relaxed text-slate-700">{appointment.notes || t('schedule.adNoServiceBrief')}</p>}
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <SectionTitle icon={<Gift size={15}/>} label={t('schedule.adAvailableBenefits')} />
          <div className="grid grid-cols-2 gap-2"><div className="rounded-xl border border-sky-200 bg-sky-50 p-2.5"><span className="block text-[10px] font-bold text-sky-900">{t('schedule.adGiftCardBalance')}</span><strong className="mt-1 block font-mono text-sm text-slate-900">{customerQ.data?.giftCards[0] ? `$${centsToDollars(customerQ.data.giftCards[0].balanceCents)}` : '—'}</strong><span className="block truncate text-[9px] text-sky-700">{customerQ.data?.giftCards[0]?.code ?? t('schedule.adNoGiftCard')}</span></div><div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5"><span className="block text-[10px] font-bold text-emerald-900">{t('schedule.adVisitFrequency')}</span><strong className="mt-1 block font-mono text-sm text-slate-900">{customerQ.data?.visits.total ?? '—'} {t('schedule.adVisitUnit')}</strong><span className="block truncate text-[9px] text-emerald-700">{customerQ.data?.tags.join(' · ') || t('schedule.adMemberProfile')}</span></div></div>
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm"><SectionTitle icon={<CreditCard size={15}/>} label={t('schedule.adCostSummary')} /><div className="flex items-end justify-between border-t border-slate-100 pt-3"><span className="text-sm font-bold text-slate-800">{t('schedule.adTotalDue')}</span><span className="font-mono text-2xl font-black text-teal-700">${centsToDollars(totalCents)}</span></div></section>

        <div className="flex flex-wrap gap-2"><GuardedButton permission="appointment.write" variant="outline" onPress={() => setRescheduleOpen(true)}><CalendarClock size={16}/>{t('schedule.adReschedule')}</GuardedButton><GuardedButton permission="appointment.cancel" variant="danger" onPress={() => setCancelOpen(true)}>{t('schedule.adConfirmCancelAppt')}</GuardedButton></div>
      </div>}

      {tab === 'health' && <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex gap-3"><FileHeart className="text-teal-600" /><div><h4 className="font-bold">{t('schedule.adHealthRecord')}</h4><p className="text-xs text-slate-500">{appointmentForms.length > 0 ? t('schedule.adHealthAvailable') : t('schedule.adHealthMissing')}</p></div></div>
          {appointmentForms.length > 0 && <div className="mt-4 space-y-2">{appointmentForms.map((form) => <article key={form.submissionId} className="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><div className="flex items-start justify-between gap-3"><span><span className="block text-sm font-bold text-emerald-950">{form.templateTitle[language] ?? form.templateTitle.en ?? 'Health form'}</span><span className="text-xs text-emerald-700">{storeTime.dateTime(form.signedAt ?? form.createdAt)}</span></span><Badge variant="success">v{form.version}</Badge></div><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" className="h-8 bg-white text-xs font-bold text-teal-800" onPress={() => { setSelectedSubmissionId(form.submissionId); setHealthRequested(true); }}><Sparkles size={14}/>{t('schedule.adAiHealthSummary')}</Button><Button size="sm" variant="outline" className="h-8 bg-white text-xs font-bold" onPress={() => window.open(`/forms/submissions/${form.submissionId}`, '_blank', 'noopener,noreferrer')}><FileText size={14}/>{t('schedule.adViewHealth')}</Button></div></article>)}</div>}
        </section>
        {healthRequested && healthQ.isLoading && <Spinner />}
        {healthQ.isError && <p className="text-sm text-rose-600">{errorMessage(healthQ.error)}</p>}
        {healthQ.data?.answers && <>
          {aiSummary && <section className="rounded-xl border border-teal-200 bg-teal-950 p-4 text-white"><div className="mb-3 flex items-center gap-2"><Sparkles size={16} className="text-teal-300"/><h4 className="font-semibold">{t('schedule.adAiHealthSummary')}</h4><Languages size={14} className="ml-auto text-teal-300"/></div><p className="text-sm font-semibold text-teal-50">{aiSummary.headline[language] ?? aiSummary.headline.en}</p>{(aiSummary.keyAlerts[language] ?? aiSummary.keyAlerts.en ?? []).length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-teal-100">{(aiSummary.keyAlerts[language] ?? aiSummary.keyAlerts.en).map((alert) => <li key={alert}>{alert}</li>)}</ul>}<p className="mt-3 text-xs leading-relaxed text-teal-100">{aiSummary.technicianAdvice[language] ?? aiSummary.technicianAdvice.en}</p></section>}
          <section className="space-y-3 rounded-xl border border-slate-200 p-4">{healthQ.data.questions.map((question) => <div key={question.id}><p className="text-xs font-medium text-slate-500">{question.label[language] ?? question.label.en ?? question.id}</p><p className="break-words text-sm">{display(healthQ.data!.answers![question.id])}</p></div>)}</section>
        </>}
        <GuardedButton permission="form.submit" onPress={() => void runShare()} isPending={shareM.isPending}><QrCode size={16} />{t('schedule.adCreateFormLink')}</GuardedButton>
        {share && <section className="rounded-xl border border-slate-200 p-4 text-center"><QRCodeSVG value={share.url} size={180} className="mx-auto max-w-full" /><p className="mt-3 break-all text-xs text-slate-500">{share.url}</p><div className="mt-3 flex justify-center gap-2"><Button variant="outline" onPress={() => void navigator.clipboard.writeText(share.url)}>{t('schedule.adCopy')}</Button><Button variant="outline" onPress={() => window.open(share.url, '_blank', 'noopener,noreferrer')}>{t('schedule.adOpen')}</Button></div><p className="mt-3 text-xs text-slate-500">{t('schedule.adExpiresAt')} {storeTime.dateTime(share.expiresAt)}</p></section>}
      </div>}

      {tab === 'preferences' && <div className="space-y-4">{!appointment.customer.id ? <p className="text-sm text-slate-500">{t('schedule.adGuestNoProfile')}</p> : <><label className="block text-sm font-medium" htmlFor="appointment-preferences">{t('schedule.adPreferenceNotes')}</label><textarea id="appointment-preferences" value={preferences} onChange={(event) => setPreferences(event.target.value)} maxLength={2000} rows={8} className="w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder={t('schedule.adNotesPlaceholder')} /><GuardedButton permission="customer.write" onPress={() => void runSavePreferences()} isPending={savePreferencesM.isPending}>{t('schedule.adSavePrefs')}</GuardedButton></>}</div>}

      {tab === 'notes' && <div className="space-y-4">{!activeTicket ? <p className="text-sm text-slate-500">{t('schedule.adNoteNeedsTicket')}</p> : <><label className="block text-sm font-medium" htmlFor="service-note-item">{t('schedule.adServiceItem')}</label><select id="service-note-item" value={noteItemId} onChange={(event) => setNoteItemId(event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">{activeTicket.items.map((item) => <option key={item.ticketItemId} value={item.ticketItemId}>{item.name} · {item.staffName}</option>)}</select><label className="block text-sm font-medium" htmlFor="service-note">{t('schedule.adSoapTitle')}</label><textarea id="service-note" value={serviceNote} onChange={(event) => setServiceNote(event.target.value)} maxLength={2000} rows={10} className="w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder={t('schedule.adSoapSPlaceholder')} /><p className="text-xs text-slate-500">{t('schedule.adSensitiveNoteWarning')}</p><GuardedButton permission="ticket.write" onPress={() => void runSaveNote()} isPending={saveNoteM.isPending} isDisabled={!serviceNote.trim()}>{t('schedule.adSoapSave')}</GuardedButton></>}</div>}
    </main>

    <Modal isOpen={cancelOpen} onOpenChange={setCancelOpen} title={t('schedule.adCancelConfirmTitle')} size="sm" footer={<Actions cancel={() => setCancelOpen(false)} submit={<GuardedButton permission="appointment.cancel" variant="danger" onPress={() => void runCancel()} isPending={cancelM.isPending}>{t('schedule.adConfirmCancelAppt')}</GuardedButton>} />}><div className="space-y-4"><select value={cancelReason} onChange={(event) => setCancelReason(event.target.value as CancelReason)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">{CANCEL_REASONS.map((reason) => <option key={reason} value={reason}>{t(`schedule.adCancel.${reason}`)}</option>)}</select><label className="flex gap-2 text-sm"><input type="checkbox" checked={keepStaffTurn} onChange={(event) => setKeepStaffTurn(event.target.checked)} />{t('schedule.adKeepStaffTurn')}</label></div></Modal>
    <Modal isOpen={rescheduleOpen} onOpenChange={setRescheduleOpen} title={t('schedule.adReschedule')} size="sm" footer={<Actions cancel={() => setRescheduleOpen(false)} submit={<GuardedButton permission="appointment.write" onPress={() => void runReschedule()} isPending={rescheduleM.isPending}>{t('schedule.adConfirmUpdate')}</GuardedButton>} />}><div className="grid gap-3 sm:grid-cols-2"><input aria-label={t('schedule.adDate')} type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5" /><input aria-label={t('schedule.adTime')} type="time" value={time} onChange={(event) => setTime(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5" /><StaffSelect value={staffId} onChange={setStaffId} includeUnassigned /><select aria-label={t('schedule.adRoomType')} value={roomId} onChange={(event) => setRoomId(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5"><option value="">{t('schedule.adNoRoom')}</option>{resources.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></div></Modal>
    <Modal isOpen={addOpen} onOpenChange={setAddOpen} title={t('schedule.adAddOn')} size="sm" footer={<Actions cancel={() => setAddOpen(false)} submit={<GuardedButton permission="ticket.write" onPress={() => void runAddItem()} isPending={addItemM.isPending} isDisabled={!serviceId || !addStaffId}>{t('schedule.adAddOn')}</GuardedButton>} />}><div className="grid gap-3"><select aria-label={t('schedule.adServiceItem')} value={serviceId} onChange={(event) => setServiceId(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5"><option value="">{t('schedule.adChooseService')}</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name} · ${(service.priceCents / 100).toFixed(2)}</option>)}</select><StaffSelect value={addStaffId} onChange={setAddStaffId} /></div></Modal>
  </>);

  function Metric({ label, value, compact = false, accent = false }: { label: string; value: string; compact?: boolean; accent?: boolean }) {
    return <div className="min-w-0 rounded-xl bg-slate-50 p-2 text-center"><span className="block text-[10px] font-bold text-slate-400">{label}</span><strong className={cn('mt-1 block truncate font-mono font-black', compact ? 'text-[10px]' : 'text-sm', accent ? 'text-teal-700' : 'text-slate-800')}>{value}</strong></div>;
  }

  function SectionTitle({ icon, label, amber = false }: { icon: ReactNode; label: string; amber?: boolean }) {
    return <h3 className={cn('flex items-center gap-1.5 text-xs font-black uppercase tracking-wider', amber ? 'text-amber-950' : 'text-slate-800')}><span className={amber ? 'text-amber-600' : 'text-teal-600'}>{icon}</span>{label}</h3>;
  }

  function StaffSelect({ value, onChange, includeUnassigned = false }: { value: string; onChange: (value: string) => void; includeUnassigned?: boolean }) {
    return <select aria-label={t('schedule.adStaffLabel')} value={value} onChange={(event) => onChange(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5"><option value="">{t('schedule.adChooseStaff')}</option>{includeUnassigned && <option value={UNASSIGNED_STAFF_ID}>{t('schedule.adUnassignedStaff')}</option>}{staff.filter((member) => member.membershipId !== UNASSIGNED_STAFF_ID).map((member) => <option key={member.membershipId} value={member.membershipId}>{member.name}</option>)}</select>;
  }

  function Actions({ cancel, submit }: { cancel: () => void; submit: ReactNode }) {
    return <div className="flex w-full justify-end gap-2"><Button variant="outline" onPress={cancel}>{t('cancel')}</Button>{submit}</div>;
  }
}
