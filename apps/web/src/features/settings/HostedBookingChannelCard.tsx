import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Check, ExternalLink, QrCode } from 'lucide-react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { QRCodeZoomModal } from '@/components/QRCodeZoomModal';
import { hostedBookingUrl } from './hostedBookingUrl';

export function HostedBookingChannelCard({
  origin,
  slug,
  bookableCount,
  onSaveSlug,
  saving,
  slugError,
}: {
  origin: string;
  slug: string;
  bookableCount: number;
  onSaveSlug: (slug: string) => Promise<void>;
  saving: boolean;
  slugError: string | null;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(slug);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const url = hostedBookingUrl(origin, slug);

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success(t('settings.hostedCopied'));
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="hosted-booking-channel">
      <h2 className="text-sm font-bold text-slate-900">{t('settings.hostedTitle')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('settings.hostedDesc')}</p>

      {url ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="font-mono text-xs break-all" data-testid="hosted-url">{url}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" className="text-xs" onClick={() => void copy()} data-testid="hosted-copy">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="ml-1">{t('settings.hostedCopy')}</span>
            </Button>
            <Button type="button" className="text-xs" onClick={() => window.open(url, '_blank')} data-testid="hosted-open">
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="ml-1">{t('settings.hostedOpen')}</span>
            </Button>
            <Button type="button" className="text-xs" onClick={() => setQrOpen(true)} data-testid="hosted-qr">
              <QrCode className="h-3.5 w-3.5" />
              <span className="ml-1">{t('settings.hostedQr')}</span>
            </Button>
          </div>
          <div className="mt-3 hidden sm:block">
            <QRCodeSVG value={url} size={120} />
          </div>
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t('settings.hostedUrlMissing')}
        </p>
      )}

      <div className="mt-4 max-w-md space-y-1">
        <label className="text-[11px] font-bold text-slate-600">{t('settings.hostedSlug')}</label>
        <div className="flex gap-2">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-xs" />
          <Button
            type="button"
            disabled={saving || draft.trim() === slug}
            onClick={() => void onSaveSlug(draft.trim())}
            className="bg-teal-600 text-white text-xs"
          >
            {t('settings.hostedSaveSlug')}
          </Button>
        </div>
        {slugError && <p className="text-xs text-rose-600">{slugError}</p>}
      </div>

      <p className="mt-4 text-xs text-slate-600">
        {t('settings.hostedBookableCount', { p0: String(bookableCount) })}
      </p>
      <p className="mt-2 text-xs text-slate-500">{t('settings.hostedKeepManage')}</p>
      <p className="mt-2 text-xs text-slate-500">{t('settings.hostedPlacements')}</p>

      {url && (
        <QRCodeZoomModal
          isOpen={qrOpen}
          onClose={() => setQrOpen(false)}
          title={t('settings.hostedQr')}
          url={url}
          description={t('settings.hostedDesc')}
        />
      )}
    </section>
  );
}
