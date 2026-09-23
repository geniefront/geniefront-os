import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useLanguage } from '@/LanguageContext';
import { useDeskSettingsQuery } from '@/features/settings/api';
import { bookingPageOrigin, hostedBookingUrl } from '@/features/settings/hostedBookingUrl';
import { Button } from '@/components/ui/Button';

export function PublicBookingLink() {
  const { t } = useLanguage();
  const query = useDeskSettingsQuery();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = hostedBookingUrl(bookingPageOrigin(), query.data?.location.slug ?? '');
  if (query.isLoading) return <p><LoadingSpinner label={t('setupReadinessLoading')} /></p>;
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
    <h2 className="font-bold">{t('settings.hostedTitle')}</h2>
    <p className="mt-1 text-sm text-slate-600">{t('settings.hostedDesc')}</p>
    {url ? <div className="mt-4 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
      <QRCodeSVG value={url} size={112} title={t('settings.hostedQr')} />
      <div className="min-w-0 w-full flex-1">
        <a className="break-all text-sm text-teal-800 underline" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setFailed(false); } catch { setFailed(true); } }}>{t(copied ? 'settings.hostedCopied' : 'settings.hostedCopy')}</Button>
          <a className="rounded-xl border px-4 py-2 text-sm" href={url} target="_blank" rel="noopener noreferrer">{t('settings.hostedOpen')}</a>
        </div>
        {failed && <p role="alert">{t('genericFailure')}</p>}
      </div>
    </div> : <p className="mt-3">{t(query.isError ? 'genericFailure' : 'settings.hostedUrlMissing')}</p>}
  </section>;
}
