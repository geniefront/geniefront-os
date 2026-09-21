import { PageError } from '@/components/ui/QueryState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BookingPolicy } from '@gf/scheduling';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { Input } from '@/components/ui/Input';
import { Field, Toggle } from './primitives';
import { SaveStatus, useSetupDraft } from './autosave';
export function SetupBookingCapacity() {
  const { membershipId } = useSession();
  const { t } = useLanguage();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['booking-policy', membershipId], queryFn: () => apiGet<BookingPolicy>('/v1/desk/settings/booking-policy'), enabled: Boolean(membershipId) });
  const draft = useSetupDraft(query.data ?? null, async policy => {
    await runCommand('settings.saveVoiceCapacity', {baseCapacity:policy.baseCapacity,extraSlots:policy.bufferEnabled?policy.bufferExtra:0}, membershipId!);
    await qc.invalidateQueries({ queryKey: ['booking-policy', membershipId] });
  }, `setup-capacity:${membershipId}`);
  if (query.isError) return <PageError error={query.error} onRetry={() => query.refetch()} />;
  if (!draft.value) return <p>{t(query.isError ? 'setupReadinessError' : 'setupReadinessLoading')}</p>;
  const p = draft.value;
  return <section className="space-y-3 rounded-xl border p-5">
    <h3 className="font-bold">{t('settings.bookingCapacityTitle')}</h3><p className="text-sm text-slate-500">{t('voiceScheduledCapacityHint')}</p>
    <Field label={t('voiceScheduledCapacityBase')}><Input type="number" min="1" max="100" value={p.baseCapacity ?? ''} onChange={e => draft.set(old => ({ ...old, baseCapacity: e.target.value === '' ? null : Number(e.target.value), mode: 'staff' }))} /></Field>
    <Toggle checked={p.bufferEnabled} onChange={bufferEnabled => draft.set(old => ({ ...old, bufferEnabled }))} label={t('settings.bookingBuffer')} description="" />
    {p.bufferEnabled && <Field label={t('settings.bookingExtraCount')}><Input type="number" min="1" max="10" value={p.bufferExtra} onChange={e => draft.set(old => ({ ...old, bufferExtra: Number(e.target.value) }))} /></Field>}
    <SaveStatus {...draft} />
  </section>;
}
