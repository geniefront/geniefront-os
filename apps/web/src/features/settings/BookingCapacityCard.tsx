import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BookingPolicy } from '@gf/scheduling';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { useEntitlements } from '@/features/billing/useEntitlements';

export function BookingCapacityCard() {
  const { membershipId } = useSession();
  const query = useQuery({ queryKey: ['booking-policy', membershipId],
    queryFn: () => apiGet<BookingPolicy>('/v1/desk/settings/booking-policy'), enabled: Boolean(membershipId) });
  if (!query.data || !membershipId) return null;
  return <PolicyForm key={membershipId} initial={query.data} membershipId={membershipId} />;
}

function PolicyForm({ initial, membershipId }: { initial: BookingPolicy; membershipId: string }) {
  const voiceOnly = useEntitlements().data?.plan === 'voice_booking';
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [policy, setPolicy] = useState({ ...initial, baseCapacity: initial.baseCapacity ?? 2 });
  const save = useMutation({ mutationFn: () => runCommand('location.saveBookingPolicy', policy, membershipId),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['booking-policy', membershipId] }); } });
  const inputClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
  return <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
    <h3 className="font-semibold text-slate-800">{t('settings.bookingCapacityTitle')}</h3>
    <p className="text-sm text-slate-500">{t('settings.bookingCapacityHint')}</p>
    <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-4">
      <input type="checkbox" className="mt-1" checked={policy.autoAssign === true} disabled={save.isPending}
        onChange={e=>setPolicy({...policy,autoAssign:e.target.checked})} />
      <span><span className="block text-sm font-medium">{t('settings.bookingAutoAssign')}</span>
        <span className="mt-1 block text-sm text-slate-500">{t('settings.bookingAutoAssignHint')}</span></span>
    </label>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-2 text-sm">{t('settings.bookingMode')}
        <select className={inputClass} value={policy.mode} onChange={e => setPolicy({ ...policy, mode: e.target.value as BookingPolicy['mode'] })}>
          <option value="location">{t('settings.bookingLocationMode')}</option>
          {!voiceOnly && <option value="staff">{t('settings.bookingStaffMode')}</option>}
        </select>
      </label>
      <label className="grid gap-2 text-sm">{t('settings.bookingBaseCapacity')}
        <input className={inputClass} type="number" min={1} max={100} value={policy.baseCapacity}
          onChange={e => setPolicy({ ...policy, baseCapacity: Number(e.target.value) })} />
      </label>
      <div className="space-y-2">
        <label className="flex min-h-14 items-center gap-2 text-sm"><input type="checkbox" checked={policy.bufferEnabled}
          onChange={e => setPolicy({ ...policy, bufferEnabled: e.target.checked })} />{t('settings.bookingBuffer')}</label>
        <label className="grid gap-2 text-sm">{t('settings.bookingExtraCount')}
          <input className={inputClass} type="number" min={1} max={10} disabled={!policy.bufferEnabled} value={policy.bufferExtra}
            onChange={e => setPolicy({ ...policy, bufferExtra: Number(e.target.value) })} />
        </label>
      </div>
      <div className="space-y-2">
        <label className="flex min-h-14 items-center gap-2 text-sm"><input type="checkbox" checked={policy.requestBufferEnabled}
          onChange={e => setPolicy({ ...policy, requestBufferEnabled: e.target.checked })} />{t('settings.bookingRequestBuffer')}</label>
        <label className="grid gap-2 text-sm">{t('settings.bookingExtraCount')}
          <input className={inputClass} type="number" min={1} max={5} disabled={!policy.requestBufferEnabled} value={policy.requestBufferExtra}
            onChange={e => setPolicy({ ...policy, requestBufferExtra: Number(e.target.value) })} />
        </label>
      </div>
    </div>
    {save.isError && <p role="alert" className="text-sm text-rose-600">{t('settings.bookingPolicyFailed')}</p>}
    {save.isSuccess && <p role="status" className="text-sm text-teal-700">{t('settings.bookingPolicySaved')}</p>}
    <button type="button" disabled={save.isPending} onClick={() => save.mutate()}
      className="min-h-14 rounded-lg bg-teal-600 px-5 text-white disabled:opacity-50">{t('settings.bookingPolicySave')}</button>
  </section>;
}
