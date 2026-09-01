import React, { useEffect, useState } from 'react';
import { Camera, Check, Sparkles, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';

export const MenuScannerModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const { t, currentLang } = useLanguage();
  const ui = uiText[currentLang];
  const [scanning, setScanning] = useState(false);
  const [approved, setApproved] = useState([true, true, false]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const items = [
    { name: t.aiSection.menuOnboarding.points[0], price: '$75', time: '60' },
    { name: t.aiSection.menuOnboarding.points[1], price: '$85', time: '75' },
    { name: t.aiSection.menuOnboarding.points[2], price: '$45', time: '30' },
  ];

  const scan = () => {
    setScanning(true);
    window.setTimeout(() => setScanning(false), 900);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#0c292d]/65 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="relative w-full max-w-2xl overflow-hidden rounded-[26px] bg-[#fbfcf9] p-6 shadow-2xl sm:p-8" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <button type="button" onClick={onClose} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl border border-[#dfe5df] bg-white" aria-label={ui.close}><X className="h-4 w-4" /></button>
        <div className="eyebrow"><Camera className="h-3.5 w-3.5" />{t.aiSection.menuOnboarding.badge}</div>
        <h2 id="scanner-title" className="font-serif-brand mt-5 pr-10 text-4xl font-medium tracking-[-0.04em] text-[#102a2e]">{t.aiSection.menuOnboarding.title}</h2>
        <p className="mt-3 max-w-xl text-sm font-medium leading-6 text-[#647679]">{t.aiSection.menuOnboarding.desc}</p>

        {scanning ? (
          <div className="my-12 text-center" role="status">
            <span className="mx-auto block h-12 w-12 animate-spin rounded-full border-[3px] border-[#096b61] border-t-transparent" />
            <p className="mt-4 text-xs font-extrabold text-[#20383b]">{t.aiSection.menuOnboarding.points[0]}</p>
          </div>
        ) : (
          <div className="mt-7 space-y-2">
            {items.map((item, index) => (
              <button key={index} type="button" onClick={() => setApproved((states) => states.map((value, itemIndex) => itemIndex === index ? !value : value))} className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left ${approved[index] ? 'border-[#80b9a8] bg-[#edf8f3]' : 'border-[#dfe5df] bg-white'}`}>
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl ${approved[index] ? 'bg-[#096b61] text-white' : 'bg-[#e4eae5] text-[#708184]'}`}><Check className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold text-[#20383b]">{item.name}</span>
                <span className="text-[10px] font-bold text-[#708184]">{item.time} min</span>
                <span className="text-xs font-extrabold text-[#096b61]">{item.price}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2 border-t border-[#dfe5df] pt-5 sm:flex-row sm:justify-end">
          <button type="button" onClick={scan} className="secondary-button"><Sparkles className="h-4 w-4 text-[#e86f37]" />{t.aiSection.menuOnboarding.tryScanBtn}</button>
          <button type="button" onClick={onClose} className="primary-button">{t.rotationSection.demo.saveLog}</button>
        </div>
      </div>
    </div>
  );
};
