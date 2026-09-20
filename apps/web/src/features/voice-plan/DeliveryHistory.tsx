import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPhoneDisplay } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';
import { useCan } from '@/lib/permissions';
import { useStoreTime } from '@/lib/time';
import { apiGet } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { TranslationKey } from '@/i18n';
interface Delivery { id: string; channel: 'sms' | 'email'; recipient: string; subject: string; body: string; status: string; delivery_state: string | null; created_at: string; sent_at: string | null }
export function deliveryStatusKey(message: Pick<Delivery, 'status' | 'delivery_state'>): TranslationKey {
  if (message.status === 'captured') return 'voiceCaptured';
  if (message.status === 'suppressed') return 'voiceSuppressed';
  if (['failed', 'bounced', 'rejected'].includes(message.status) || ['bounced', 'failed', 'rejected', 'hard_bounce', 'soft_bounce', 'complained'].includes(message.delivery_state ?? '')) return 'voiceFailed';
  if (message.delivery_state === 'delayed') return 'voicePending';
  if (['delivered', 'opened', 'clicked'].includes(message.delivery_state ?? '')) return 'voiceDelivered';
  return message.status === 'sent' ? 'voiceSent' : 'voicePending';
}
export function DeliveryHistory() {
  const { t } = useLanguage(); const time = useStoreTime();
  const { membershipId } = useSession(); const canRead = useCan('settings.manage');
  const [channel, setChannel] = useState('all'); const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['delivery-history', membershipId], enabled: Boolean(membershipId) && canRead,
    queryFn: () => apiGet<{ messages: Delivery[] }>('/v1/desk/communications/deliveries'), refetchInterval: 30000 });
  if (!canRead) return <p className="p-6">{t('errorPERMISSION_DENIED')}</p>;
  const messages = (query.data?.messages ?? []).filter(m => (channel === 'all' || m.channel === channel)
    && `${m.recipient} ${m.subject} ${m.body}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <main className="mx-auto max-w-5xl space-y-5 p-5 sm:p-8">
    <h1 className="text-2xl font-bold">{t('voiceDeliveryTitle')}</h1><p className="text-sm text-slate-500">{t('voiceDeliveryIntro')}</p>
    <div className="flex flex-wrap gap-3"><select aria-label={t('voiceAllChannels')} className="rounded-xl border p-2" value={channel} onChange={e => setChannel(e.target.value)}>
      <option value="all">{t('voiceAllChannels')}</option><option value="sms">{t('voiceSms')}</option><option value="email">{t('voiceEmail')}</option>
    </select><Input className="max-w-sm" aria-label={t('search')} placeholder={t('search')} value={search} onChange={e => setSearch(e.target.value)} /><Button variant="secondary" onClick={() => void query.refetch()}>{t('refresh')}</Button></div>
    {query.isError ? <p role="alert">{t('genericFailure')}</p> : query.isLoading ? <p>{t('setupReadinessLoading')}</p> : !messages.length ? <p>{t('voiceNoDeliveries')}</p> : messages.map(m => <details key={`${m.channel}:${m.id}`} className="rounded-xl border bg-white p-4">
      <summary className="cursor-pointer space-y-1"><div className="flex flex-wrap justify-between gap-2"><strong>{m.channel === 'sms' ? formatPhoneDisplay(m.recipient) : m.recipient}</strong><span className="text-sm">{t(deliveryStatusKey(m))}</span></div><p className="text-sm text-slate-600">{t(m.channel === 'sms' ? 'voiceSms' : 'voiceEmail')} · {m.channel === 'email' ? m.subject : m.body.slice(0, 70)} · {time.dateTime(m.sent_at ?? m.created_at)}</p></summary>
      <pre className="mt-4 whitespace-pre-wrap break-words border-t pt-4 font-sans text-sm">{m.body}</pre>
    </details>)}
  </main>;
}
