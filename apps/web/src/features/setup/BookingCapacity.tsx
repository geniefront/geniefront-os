import { PageError } from '@/components/ui/QueryState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BookingPolicy } from '@gf/scheduling';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { BookingCapacityFields } from './BookingCapacityFields';
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
  return <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
    <BookingCapacityFields policy={p} onChange={next => draft.set(() => next)} />
    <SaveStatus {...draft} />
  </section>;
}
