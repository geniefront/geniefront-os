import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { QrCode, Copy, Check, ExternalLink, Printer, ShieldCheck, Smartphone, Tablet } from 'lucide-react';

export interface QRCodeZoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  url: string;
  customerName?: string;
  phone?: string;
  serviceName?: string;
  description?: string;
}

export function QRCodeZoomModal({
  isOpen,
  onClose,
  title,
  url,
  customerName,
  phone,
  serviceName,
  description,
}: QRCodeZoomModalProps) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const normalizedUrl = (() => {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      const isPageRemote = !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
      if (isLoopback && isPageRemote) {
        return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {}
    return url;
  })();

  const modalTitle = title || t('customerHealthForms') || 'Digital Waiver & Intake Form';
  const modalDesc = description || 'Scan with smartphone camera or open directly on iPad.';

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(normalizedUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = normalizedUrl;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      toast.success(t('copied') || 'Copied to clipboard');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.danger(t('error') || 'Failed to copy');
    }
  };

  const handleOpenLink = () => {
    window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={
        <div className="flex items-center gap-2 text-sky-800 font-bold">
          <QrCode className="w-5 h-5 text-sky-600" />
          <span>{modalTitle}</span>
        </div>
      }
      size="md"
      footer={
        <div className="flex justify-between items-center w-full">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="text-xs font-bold gap-1 text-slate-700 hover:bg-slate-100"
              onClick={handlePrint}
            >
              <Printer className="w-3.5 h-3.5 text-slate-500" />
              <span>{t('print')}</span>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              className="bg-sky-600 hover:bg-sky-700 text-white font-bold gap-1.5 shadow-md shadow-sky-600/20"
              onClick={handleOpenLink}
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open on iPad</span>
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 py-2 text-xs text-slate-700 text-center">
        {/* 顾客与服务信息卡片 */}
        {(customerName || phone || serviceName) && (
          <div className="p-3 bg-sky-50/70 border border-sky-200 rounded-2xl flex items-center justify-between text-left">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900 text-sm">{customerName || t('customer')}</span>
                {phone && (
                  <Badge variant="secondary" className="text-[10px] bg-white text-slate-700 border-sky-300 font-mono">
                    {phone}
                  </Badge>
                )}
              </div>
              {serviceName && (
                <span className="text-[11px] text-sky-900 font-medium block mt-0.5">
                  {t('service')}: {serviceName}
                </span>
              )}
            </div>
            <Badge variant="success" className="text-[10px] font-bold px-2 py-0.5 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              <span>QR Pass</span>
            </Badge>
          </div>
        )}

        {/* 真实高清 SVG 二维码展示区 */}
        <div className="flex flex-col items-center justify-center p-6 bg-white rounded-3xl border-2 border-dashed border-sky-200 shadow-sm relative group">
          <div className="p-4 bg-white rounded-2xl shadow-md border border-slate-100 transition-transform group-hover:scale-105 duration-200">
            <QRCodeSVG
              value={normalizedUrl}
              size={240}
              level="H"
              includeMargin={true}
              className="rounded-lg"
            />
          </div>
          <div className="mt-3.5 flex items-center gap-4 text-[11px] text-slate-500 font-medium">
            <span className="flex items-center gap-1">
              <Smartphone className="w-3.5 h-3.5 text-sky-600" />
              <span>Smartphone Camera</span>
            </span>
            <span>•</span>
            <span className="flex items-center gap-1">
              <Tablet className="w-3.5 h-3.5 text-sky-600" />
              <span>iPad Kiosk</span>
            </span>
          </div>
        </div>

        {/* 描述与扫码提示 */}
        <p className="text-[11px] text-slate-600 leading-relaxed max-w-sm mx-auto">
          {modalDesc}
        </p>

        {/* 真实 URL 显示与一键复制 */}
        <div className="space-y-1.5 text-left">
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            URL
          </label>
          <div className="flex items-center gap-1.5 p-1 bg-slate-50 border border-slate-200 rounded-xl">
            <input
              type="text"
              readOnly
              value={normalizedUrl}
              className="flex-1 px-2.5 py-1 text-xs font-mono bg-transparent text-slate-700 outline-none select-all"
            />
            <Button
              size="sm"
              variant={copied ? 'secondary' : 'secondary'}
              className="h-7 px-3 text-xs font-bold gap-1 bg-white hover:bg-slate-100 border border-slate-200 shrink-0"
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-emerald-700">{t('copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-600" />
                  <span>{t('copy')}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
