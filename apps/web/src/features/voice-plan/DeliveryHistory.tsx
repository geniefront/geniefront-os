import { Segment } from '@heroui-pro/react/segment';
import { Mail, MessageSquare, ChevronDown, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
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
  return <div className="gf-service-page mx-auto max-w-6xl space-y-6 pb-12">
    <PageHeader title={t('voiceDeliveryTitle')} actions={
      <Button variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
        <RefreshCw className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`} />{t('refresh')}
      </Button>
    } />
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 p-4">
        <Segment aria-label={t('voiceAllChannels')} selectedKey={channel} onSelectionChange={key => setChannel(String(key))} size="sm">
          <Segment.Item id="all">{t('voiceAllChannels')}</Segment.Item>
          <Segment.Item id="sms">{t('voiceSms')}</Segment.Item>
          <Segment.Item id="email">{t('voiceEmail')}</Segment.Item>
        </Segment>
        <Input className="w-full sm:max-w-xs" aria-label={t('search')} placeholder={t('search')} value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {query.isError ? <div role="alert" className="p-6 text-sm">{t('genericFailure')}</div>
        : query.isLoading ? <p role="status" className="p-6 text-sm text-slate-500">{t('setupReadinessLoading')}</p>
        : !messages.length ? <EmptyState icon={<Mail />} title={t('voiceNoDeliveries')} />
        : <div className="divide-y divide-slate-100">{messages.map(m => {
          const status = deliveryStatusKey(m);
          return <details key={`${m.channel}:${m.id}`} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-3 p-4 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-teal-600 [&::-webkit-details-marker]:hidden sm:px-6">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-slate-200 text-slate-500">{m.channel === 'sms' ? <MessageSquare className="size-4" /> : <Mail className="size-4" />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="break-all text-sm font-medium text-slate-900">{m.channel === 'sms' ? formatPhoneDisplay(m.recipient) : m.recipient}</span>
                  <Badge variant={status === 'voiceFailed' ? 'error' : status === 'voiceDelivered' ? 'success' : 'secondary'}>{t(status)}</Badge>
                </div>
                <p className="mt-1 truncate text-sm text-slate-500">{m.channel === 'email' ? m.subject : m.body}</p>
                <p className="mt-1 text-xs text-slate-400">{t(m.channel === 'sms' ? 'voiceSms' : 'voiceEmail')} · {time.dateTime(m.sent_at ?? m.created_at)}</p>
              </div>
              <ChevronDown className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-slate-100 bg-slate-50/60 px-6 py-5 sm:pl-[76px]"><p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{m.body}</p></div>
          </details>;
        })}</div>}
      <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{t('voiceDeliveryIntro')}</p>
    </Card>
  </div>;
}
