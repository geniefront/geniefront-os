import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, CheckCircle2, FileImage, ScanLine, Sparkles, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';

type ScanPhase = 'idle' | 'scanning' | 'review' | 'imported';

const copy = {
  en: { source: 'Source menu', extracted: 'Structured results', scan: 'Scan menu', scanning: 'Reading menu…', import: 'Import approved items', imported: 'Menu imported', confidence: 'confidence', approved: 'approved', hint: 'Click a row to include or exclude it before import.', items: ['Deep Tissue Massage', 'Hot Stone Upgrade', 'Foot Reflexology'] },
  'zh-CN': { source: '原始价目表', extracted: '结构化识别结果', scan: '开始扫描价目表', scanning: '正在识别价目表…', import: '导入已确认项目', imported: '菜单已成功导入', confidence: '识别置信度', approved: '项已确认', hint: '导入前可点击项目，将其纳入或移出本次导入。', items: ['深层组织按摩', '热石升级服务', '足底反射疗法'] },
  vi: { source: 'Bảng giá gốc', extracted: 'Kết quả có cấu trúc', scan: 'Quét bảng giá', scanning: 'Đang đọc bảng giá…', import: 'Nhập mục đã duyệt', imported: 'Đã nhập menu', confidence: 'độ tin cậy', approved: 'mục đã duyệt', hint: 'Chọn từng dòng để thêm hoặc bỏ trước khi nhập.', items: ['Massage mô sâu', 'Nâng cấp đá nóng', 'Bấm huyệt bàn chân'] },
  ko: { source: '원본 메뉴', extracted: '구조화된 결과', scan: '메뉴 스캔', scanning: '메뉴 인식 중…', import: '승인 항목 가져오기', imported: '메뉴를 가져왔습니다', confidence: '신뢰도', approved: '개 승인', hint: '가져오기 전에 항목을 눌러 포함 여부를 정하세요.', items: ['딥티슈 마사지', '핫스톤 업그레이드', '발 반사요법'] },
  es: { source: 'Menú original', extracted: 'Resultados estructurados', scan: 'Escanear menú', scanning: 'Leyendo el menú…', import: 'Importar aprobados', imported: 'Menú importado', confidence: 'confianza', approved: 'aprobados', hint: 'Selecciona cada fila para incluirla o excluirla antes de importar.', items: ['Masaje de tejido profundo', 'Mejora con piedras calientes', 'Reflexología podal'] },
} as const;

export const MenuScannerModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const { t, currentLang } = useLanguage();
  const ui = uiText[currentLang];
  const labels = copy[currentLang];
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [approved, setApproved] = useState([true, true, false]);
  const items = useMemo(() => [
    { name: labels.items[0], price: '$75', time: '60 min', confidence: 98 },
    { name: labels.items[1], price: '$25', time: '15 min', confidence: 94 },
    { name: labels.items[2], price: '$55', time: '45 min', confidence: 89 },
  ], [labels]);

  useEffect(() => {
    if (!isOpen) return;
    setPhase('idle'); setProgress(0); setApproved([true, true, false]);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (phase !== 'scanning') return;
    const timer = window.setInterval(() => setProgress((value) => Math.min(96, value + 8)), 90);
    const finish = window.setTimeout(() => { setProgress(100); setPhase('review'); }, 1250);
    return () => { window.clearInterval(timer); window.clearTimeout(finish); };
  }, [phase]);

  if (!isOpen) return null;
  const approvedCount = approved.filter(Boolean).length;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#0c292d]/72 p-3 backdrop-blur-md sm:p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="demo-window relative my-auto w-full max-w-4xl overflow-hidden bg-[#f7f8f3] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <header className="demo-window-bar pr-16"><div className="flex items-center gap-3"><span className="demo-icon bg-[#102a2e] text-white"><Camera className="h-4 w-4" /></span><div><h2 id="scanner-title" className="text-sm font-extrabold text-[#20383b]">{t.aiSection.menuOnboarding.title}</h2><p className="text-[10px] font-semibold text-[#708184]">{t.aiSection.menuOnboarding.badge}</p></div></div><span className="demo-status"><span className="demo-status-dot" />AI OCR</span></header>
        <button ref={closeButtonRef} type="button" onClick={onClose} className="absolute right-4 top-3.5 z-10 grid h-9 w-9 place-items-center rounded-xl border border-[#dfe5df] bg-white text-[#53676a] hover:text-[#102a2e]" aria-label={ui.close}><X className="h-4 w-4" /></button>
        <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
          <section className="border-b border-[#dfe5df] bg-[#eef1ec] p-5 lg:border-b-0 lg:border-r sm:p-7">
            <div className="mb-3 flex items-center justify-between"><h3 className="demo-panel-title"><FileImage className="h-4 w-4" />{labels.source}</h3><span className="demo-chip">IMG_2048.JPG</span></div>
            <div className="scan-document relative mx-auto aspect-[4/5] max-w-[310px] overflow-hidden rounded-[20px] border border-[#d5d9d2] bg-[#fffdf6] p-6 shadow-[0_18px_38px_rgba(20,52,54,.12)]">
              <div className="text-center text-[9px] font-bold tracking-[.24em] text-[#9b7656]">GOLDEN LOTUS SPA</div><div className="mt-3 border-y border-[#dcc9ad] py-3 text-center text-lg font-semibold text-[#543f30]">MASSAGE MENU</div>
              {items.map((item) => <div key={item.name} className="mt-5 flex items-end gap-2 text-[#6b5749]"><div className="min-w-0 flex-1"><div className="truncate text-[10px] font-bold">{item.name}</div><div className="mt-1 text-[8px] opacity-60">{item.time}</div></div><div className="mb-1 flex-1 border-b border-dotted border-[#bfa98d]" /><div className="text-xs font-bold">{item.price}</div></div>)}
              <div className="mt-7 text-center text-[8px] leading-4 text-[#9b866f]">Walk-ins welcome · Open daily<br />Please tell us about allergies</div>
              {phase === 'scanning' && <><div className="scan-beam" /><div className="absolute inset-0 bg-[#096b61]/5" /></>}
            </div>
            <button type="button" onClick={() => { setProgress(0); setPhase('scanning'); }} disabled={phase === 'scanning'} className="secondary-button mt-5 w-full"><ScanLine className="h-4 w-4 text-[#e86f37]" />{phase === 'scanning' ? labels.scanning : labels.scan}</button>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-[#096b61] transition-[width] duration-200" style={{ width: `${progress}%` }} /></div>
          </section>
          <section className="p-5 sm:p-7" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="demo-panel-title"><Sparkles className="h-4 w-4 text-[#e86f37]" />{labels.extracted}</h3><p className="mt-1 text-[10px] font-semibold text-[#708184]">{labels.hint}</p></div><span className="demo-chip">{approvedCount}/3 {labels.approved}</span></div>
            {phase === 'idle' && <div className="demo-empty-state"><ScanLine className="h-7 w-7" /><p>{labels.scan}</p></div>}
            {phase === 'scanning' && <div className="demo-empty-state"><span className="h-9 w-9 animate-spin rounded-full border-[3px] border-[#096b61] border-t-transparent" /><p>{labels.scanning} {progress}%</p></div>}
            {(phase === 'review' || phase === 'imported') && <div className="mt-5 space-y-2.5">{items.map((item, index) => <button key={item.name} type="button" onClick={() => phase !== 'imported' && setApproved((states) => states.map((value, i) => i === index ? !value : value))} className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl border p-3 text-left transition-all ${approved[index] ? 'border-[#80b9a8] bg-[#edf8f3]' : 'border-[#dfe5df] bg-white opacity-65'}`}><span className={`grid h-9 w-9 place-items-center rounded-xl ${approved[index] ? 'bg-[#096b61] text-white' : 'bg-[#e8ece8] text-[#8a9998]'}`}><Check className="h-4 w-4" /></span><span className="min-w-0"><span className="block truncate text-xs font-extrabold text-[#20383b]">{item.name}</span><span className="mt-1 block text-[9px] font-bold text-[#708184]">{item.time} · {item.confidence}% {labels.confidence}</span></span><span className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-extrabold text-[#096b61] shadow-sm">{item.price}</span></button>)}</div>}
            {phase === 'imported' && <div role="status" className="mt-4 flex items-center gap-3 rounded-2xl border border-[#a9d7c7] bg-[#e3f5ed] p-4 text-xs font-extrabold text-[#096b61]"><CheckCircle2 className="h-5 w-5" />{labels.imported} · {approvedCount} {labels.approved}</div>}
            <div className="mt-6 flex flex-col gap-2 border-t border-[#dfe5df] pt-5 sm:flex-row sm:justify-end"><button type="button" onClick={onClose} className="secondary-button">{ui.close}</button><button type="button" onClick={() => phase === 'review' ? setPhase('imported') : phase === 'imported' ? onClose() : setPhase('scanning')} disabled={phase === 'scanning'} className="primary-button"><Check className="h-4 w-4" />{phase === 'imported' ? ui.confirmed : phase === 'review' ? labels.import : labels.scan}</button></div>
          </section>
        </div>
      </div>
    </div>
  );
};
