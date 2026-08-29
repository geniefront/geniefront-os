import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, CalendarClock, FileHeart, Plus, QrCode, X } from 'lucide-react';
import { Spinner, toast } from '@heroui/react';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '@/LanguageContext';
import { useSchedule, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { useAppointmentDetailQuery, useHealthFormSubmissionQuery } from '@/features/schedule/appointmentDetail';
import { useCancelAppointment, useRescheduleAppointment } from '@/features/schedule/api';
import { useCustomerDetail, useSaveCustomerPreferences } from '@/features/customers/api';
import { useAddTicketItem, useSaveServiceNote, useTicketsList } from '@/features/tickets/api';
import { useShareForm, type FormShareResult } from '@/features/forms/api';
import type { CancelReason } from '@/features/schedule/types';
import { Button } from './ui/Button';
import { GuardedButton } from './ui/GuardedButton';
import { Modal } from './ui/Modal';
import { useErrorMessage } from '@/lib/errorMessage';
import { instantToWallDate, instantToWallMinutes, useStoreTime, wallMinutesToInstant } from '@/lib/time';

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

export function AppointmentDrawer({ onClose, appointmentId }: AppointmentDrawerProps) {
  const { t, language } = useLanguage();
  const errorMessage = useErrorMessage();
  const storeTime = useStoreTime();
  const { currentDate, services, staff, resources, timezone, refetch: refetchSchedule } = useSchedule();
  const appointmentQ = useAppointmentDetailQuery(appointmentId ?? null);
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

  const cancelM = useCancelAppointment(currentDate);
  const rescheduleM = useRescheduleAppointment(currentDate);
  const addItemM = useAddTicketItem();
  const savePreferencesM = useSaveCustomerPreferences();
  const saveNoteM = useSaveServiceNote();
  const shareM = useShareForm();
  const healthQ = useHealthFormSubmissionQuery(appointment?.customer.healthFormSubmissionId ?? null, healthRequested);

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
  useEffect(() => {
    if (!noteItemId && activeTicket?.items[0]) setNoteItemId(activeTicket.items[0].ticketItemId);
  }, [activeTicket?.items, noteItemId]);

  const refresh = async () => {
    await Promise.all([appointmentQ.refetch(), ticketsQ.refetch()]);
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
    <div className="fixed inset-0 z-[200] flex justify-end bg-slate-950/30" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="flex h-full w-full max-w-[600px] flex-col bg-white shadow-2xl" aria-label={t('schedule.adDrawerLabel')}>
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-6">
          <h2 className="text-lg font-semibold">{t('schedule.adAppointmentTitle')}</h2>
          <Button size="icon" variant="ghost" aria-label={t('close')} onPress={onClose}><X size={20} /></Button>
        </header>
        {body}
      </aside>
    </div>
  );

  if (!appointmentId) return shell(<div className="m-auto p-8 text-center text-slate-500">{t('schedule.adNoAppointmentSelected')}</div>);
  if (appointmentQ.isLoading) return shell(<div className="m-auto flex flex-col items-center gap-3"><Spinner />{t('schedule.adLoadingAll')}</div>);
  if (appointmentQ.isError || !appointment) return shell(<div className="m-auto flex max-w-sm flex-col items-center gap-3 p-8 text-center"><AlertCircle className="text-rose-500" /><p className="font-semibold">{t('schedule.adLoadFailed')}</p><p className="text-sm text-slate-500">{errorMessage(appointmentQ.error)}</p><Button variant="outline" onPress={() => void appointmentQ.refetch()}>{t('retry')}</Button></div>);

  const tabs: Array<[Tab, string]> = [['service', t('schedule.adTabService')], ['health', t('schedule.adTabHealth')], ['preferences', t('schedule.adTabPrefs')], ['notes', t('schedule.adTabNotes')]];

  return shell(<>
    <section className="border-b border-slate-200 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap justify-between gap-3"><div><h3 className="text-xl font-semibold">{appointment.customer.name}</h3><p className="text-sm text-slate-500">{appointment.customer.phone ?? t('schedule.adNoPhone')}</p></div><span className="h-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase">{appointment.status}</span></div>
      <div className="mt-4 flex gap-1 overflow-x-auto" role="tablist">{tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${tab === id ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}</div>
    </section>
    <main className="flex-1 overflow-y-auto p-4 sm:p-6">
      {tab === 'service' && <div className="space-y-4">
        {appointment.items.map((item) => <article key={item.itemId} className="rounded-xl border border-slate-200 p-4"><div className="flex justify-between gap-3"><div><h4 className="font-semibold">{item.serviceName}</h4><p className="text-sm text-slate-500">{storeTime.dateTime(item.startsAt)}</p></div><span className="font-semibold">${(item.priceCents / 100).toFixed(2)}</span></div><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">{t('schedule.adStaffLabel')}</dt><dd>{item.staffName ?? t('schedule.adUnassignedStaff')}</dd></div><div><dt className="text-slate-500">{t('schedule.adRoomType')}</dt><dd>{item.resourceName ?? t('schedule.adNoRoom')}</dd></div><div><dt className="text-slate-500">{t('schedule.apptDurationMin')}</dt><dd>{item.durationMin}</dd></div></dl></article>)}
        {appointment.notes && <p className="rounded-xl bg-slate-50 p-4 text-sm">{appointment.notes}</p>}
        <div className="flex flex-wrap gap-2"><GuardedButton permission="appointment.write" variant="outline" onPress={() => setRescheduleOpen(true)}><CalendarClock size={16} />{t('schedule.adReschedule')}</GuardedButton>{activeTicket && <GuardedButton permission="ticket.write" variant="outline" onPress={() => setAddOpen(true)}><Plus size={16} />{t('schedule.adAddOn')}</GuardedButton>}<GuardedButton permission="appointment.cancel" variant="danger" onPress={() => setCancelOpen(true)}>{t('schedule.adConfirmCancelAppt')}</GuardedButton></div>
        {!activeTicket && <p className="text-xs text-slate-500">{t('schedule.adAddOnNeedsTicket')}</p>}
      </div>}

      {tab === 'health' && <div className="space-y-4"><section className="rounded-xl border border-slate-200 p-4"><div className="flex gap-3"><FileHeart className="text-primary-600" /><div><h4 className="font-semibold">{t('schedule.adHealthRecord')}</h4><p className="text-sm text-slate-500">{appointment.customer.hasHealthForm ? t('schedule.adHealthAvailable') : t('schedule.adHealthMissing')}</p></div></div>{appointment.customer.healthFormSubmissionId && !healthRequested && <Button className="mt-4" variant="outline" onPress={() => setHealthRequested(true)}>{t('schedule.adViewHealth')}</Button>}</section>{healthRequested && healthQ.isLoading && <Spinner />}{healthQ.isError && <p className="text-sm text-rose-600">{errorMessage(healthQ.error)}</p>}{healthQ.data && <section className="space-y-3 rounded-xl border border-slate-200 p-4">{(healthQ.data.answers ?? Object.entries(healthQ.data.data ?? {}).map(([question, answer]) => ({ question, answer }))).map((answer, index) => <div key={`${answer.question}-${index}`}><p className="text-xs font-medium text-slate-500">{answer.question}</p><p className="break-words text-sm">{display(answer.answer)}</p></div>)}</section>}<GuardedButton permission="form.submit" onPress={() => void runShare()} isPending={shareM.isPending}><QrCode size={16} />{t('schedule.adCreateFormLink')}</GuardedButton>{share && <section className="rounded-xl border border-slate-200 p-4 text-center"><QRCodeSVG value={share.url} size={180} className="mx-auto max-w-full" /><p className="mt-3 break-all text-xs text-slate-500">{share.url}</p><div className="mt-3 flex justify-center gap-2"><Button variant="outline" onPress={() => void navigator.clipboard.writeText(share.url)}>{t('schedule.adCopy')}</Button><Button variant="outline" onPress={() => window.open(share.url, '_blank', 'noopener,noreferrer')}>{t('schedule.adOpen')}</Button></div><p className="mt-3 text-xs text-slate-500">{t('schedule.adExpiresAt')} {storeTime.dateTime(share.expiresAt)}</p></section>}</div>}

      {tab === 'preferences' && <div className="space-y-4">{!appointment.customer.id ? <p className="text-sm text-slate-500">{t('schedule.adGuestNoProfile')}</p> : <><label className="block text-sm font-medium" htmlFor="appointment-preferences">{t('schedule.adPreferenceNotes')}</label><textarea id="appointment-preferences" value={preferences} onChange={(event) => setPreferences(event.target.value)} maxLength={2000} rows={8} className="w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder={t('schedule.adNotesPlaceholder')} /><GuardedButton permission="customer.write" onPress={() => void runSavePreferences()} isPending={savePreferencesM.isPending}>{t('schedule.adSavePrefs')}</GuardedButton></>}</div>}

      {tab === 'notes' && <div className="space-y-4">{!activeTicket ? <p className="text-sm text-slate-500">{t('schedule.adNoteNeedsTicket')}</p> : <><label className="block text-sm font-medium" htmlFor="service-note-item">{t('schedule.adServiceItem')}</label><select id="service-note-item" value={noteItemId} onChange={(event) => setNoteItemId(event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">{activeTicket.items.map((item) => <option key={item.ticketItemId} value={item.ticketItemId}>{item.name} · {item.staffName}</option>)}</select><label className="block text-sm font-medium" htmlFor="service-note">{t('schedule.adSoapTitle')}</label><textarea id="service-note" value={serviceNote} onChange={(event) => setServiceNote(event.target.value)} maxLength={2000} rows={10} className="w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder={t('schedule.adSoapSPlaceholder')} /><p className="text-xs text-slate-500">{t('schedule.adSensitiveNoteWarning')}</p><GuardedButton permission="ticket.write" onPress={() => void runSaveNote()} isPending={saveNoteM.isPending} isDisabled={!serviceNote.trim()}>{t('schedule.adSoapSave')}</GuardedButton></>}</div>}
    </main>

    <Modal isOpen={cancelOpen} onOpenChange={setCancelOpen} title={t('schedule.adCancelConfirmTitle')} size="sm" footer={<Actions cancel={() => setCancelOpen(false)} submit={<GuardedButton permission="appointment.cancel" variant="danger" onPress={() => void runCancel()} isPending={cancelM.isPending}>{t('schedule.adConfirmCancelAppt')}</GuardedButton>} />}><div className="space-y-4"><select value={cancelReason} onChange={(event) => setCancelReason(event.target.value as CancelReason)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm">{CANCEL_REASONS.map((reason) => <option key={reason} value={reason}>{t(`schedule.adCancel.${reason}`)}</option>)}</select><label className="flex gap-2 text-sm"><input type="checkbox" checked={keepStaffTurn} onChange={(event) => setKeepStaffTurn(event.target.checked)} />{t('schedule.adKeepStaffTurn')}</label></div></Modal>
    <Modal isOpen={rescheduleOpen} onOpenChange={setRescheduleOpen} title={t('schedule.adReschedule')} size="sm" footer={<Actions cancel={() => setRescheduleOpen(false)} submit={<GuardedButton permission="appointment.write" onPress={() => void runReschedule()} isPending={rescheduleM.isPending}>{t('schedule.adConfirmUpdate')}</GuardedButton>} />}><div className="grid gap-3 sm:grid-cols-2"><input aria-label={t('schedule.adDate')} type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5" /><input aria-label={t('schedule.adTime')} type="time" value={time} onChange={(event) => setTime(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5" /><StaffSelect value={staffId} onChange={setStaffId} includeUnassigned /><select aria-label={t('schedule.adRoomType')} value={roomId} onChange={(event) => setRoomId(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5"><option value="">{t('schedule.adNoRoom')}</option>{resources.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></div></Modal>
    <Modal isOpen={addOpen} onOpenChange={setAddOpen} title={t('schedule.adAddOn')} size="sm" footer={<Actions cancel={() => setAddOpen(false)} submit={<GuardedButton permission="ticket.write" onPress={() => void runAddItem()} isPending={addItemM.isPending} isDisabled={!serviceId || !addStaffId}>{t('schedule.adAddOn')}</GuardedButton>} />}><div className="grid gap-3"><select aria-label={t('schedule.adServiceItem')} value={serviceId} onChange={(event) => setServiceId(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5"><option value="">{t('schedule.adChooseService')}</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name} · ${(service.priceCents / 100).toFixed(2)}</option>)}</select><StaffSelect value={addStaffId} onChange={setAddStaffId} /></div></Modal>
  </>);

  function StaffSelect({ value, onChange, includeUnassigned = false }: { value: string; onChange: (value: string) => void; includeUnassigned?: boolean }) {
    return <select aria-label={t('schedule.adStaffLabel')} value={value} onChange={(event) => onChange(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2.5"><option value="">{t('schedule.adChooseStaff')}</option>{includeUnassigned && <option value={UNASSIGNED_STAFF_ID}>{t('schedule.adUnassignedStaff')}</option>}{staff.filter((member) => member.membershipId !== UNASSIGNED_STAFF_ID).map((member) => <option key={member.membershipId} value={member.membershipId}>{member.name}</option>)}</select>;
  }

  function Actions({ cancel, submit }: { cancel: () => void; submit: ReactNode }) {
    return <div className="flex w-full justify-end gap-2"><Button variant="outline" onPress={cancel}>{t('cancel')}</Button>{submit}</div>;
  }
}
