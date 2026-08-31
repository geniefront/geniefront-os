import React, { useState } from 'react';
import { ArrowDown, ArrowUp, History, RotateCw, ShieldCheck, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

type Technician = { id: number; name: string; turns: string; code: string };

const initialQueue: Technician[] = [
  { id: 1, name: 'Lily Vu', turns: '1.0', code: 'LV' },
  { id: 2, name: 'Kevin Chen', turns: '1.0', code: 'KC' },
  { id: 3, name: 'Helen Tran', turns: '0.5', code: 'HT' },
  { id: 4, name: 'Tony Kim', turns: '1.5', code: 'TK' },
];

export const RotationWorkflowSection: React.FC = () => {
  const { t } = useLanguage();
  const [queue, setQueue] = useState(initialQueue);
  const [selected, setSelected] = useState<number | null>(null);
  const [reason, setReason] = useState(t.rotationSection.demo.defaultReason);
  const [logs, setLogs] = useState<string[]>([t.rotationSection.demo.defaultReason]);

  const move = (direction: -1 | 1) => {
    if (selected === null) return;
    const from = queue.findIndex((person) => person.id === selected);
    const to = Math.max(0, Math.min(queue.length - 1, from + direction));
    if (from === to) return;
    const next = [...queue];
    const [person] = next.splice(from, 1);
    next.splice(to, 0, person);
    setQueue(next);
    setLogs((items) => [`${person.name}: ${reason}`, ...items]);
    setSelected(null);
  };

  return (
    <section id="product" className="bg-[#f7f8f3] py-20 sm:py-24">
      <div className="site-shell">
        <div className="mx-auto max-w-3xl text-center">
          <div className="eyebrow"><RotateCw className="h-3.5 w-3.5" />{t.rotationSection.badge}</div>
          <h2 className="font-serif-brand mt-5 text-4xl font-medium leading-[1.03] tracking-[-0.04em] text-[#102a2e] sm:text-5xl">{t.rotationSection.title}</h2>
          <p className="mt-5 text-sm font-medium leading-7 text-[#647679]">{t.rotationSection.subtitle}</p>
        </div>

        <div className="mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {t.rotationSection.features.map((feature, index) => (
            <article key={feature.title} className="rounded-2xl border border-[#dfe5df] bg-white p-5">
              <span className="text-[10px] font-extrabold tracking-[0.16em] text-[#e86f37]">0{index + 1}</span>
              <h3 className="mt-4 text-sm font-extrabold text-[#20383b]">{feature.title}</h3>
              <p className="mt-2 text-xs font-medium leading-5 text-[#708184]">{feature.desc}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 overflow-hidden rounded-[28px] border border-[#dfe5df] bg-white shadow-[0_24px_60px_rgba(20,52,54,0.08)]">
          <div className="flex flex-col gap-2 border-b border-[#dfe5df] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div><h3 className="text-sm font-extrabold text-[#20383b]">{t.rotationSection.demo.interactiveTitle}</h3><p className="mt-1 text-[10px] font-semibold text-[#708184]">{t.rotationSection.demo.dragTip}</p></div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-[#edf8f3] px-3 py-1.5 text-[10px] font-extrabold text-[#096b61]"><ShieldCheck className="h-3.5 w-3.5" />{t.rotationSection.demo.logTitle}</span>
          </div>

          <div className="grid lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-2 border-b border-[#dfe5df] p-5 lg:border-b-0 lg:border-r sm:p-7">
              {queue.map((person, index) => (
                <button key={person.id} type="button" onClick={() => { setSelected(person.id); setReason(t.rotationSection.demo.defaultReason); }} className="flex w-full items-center gap-3 rounded-2xl border border-[#e4eae5] bg-[#fbfcf9] p-3 text-left transition hover:border-[#80b9a8] hover:bg-[#edf8f3]">
                  <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#102a2e] text-[10px] font-extrabold text-white">{index + 1}</span>
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#d9f2e8] text-[10px] font-extrabold text-[#096b61]">{person.code}</span>
                  <span className="min-w-0 flex-1"><span className="block text-xs font-extrabold text-[#20383b]">{person.name}</span><span className="mt-1 block text-[9px] font-bold text-[#708184]">{t.heroPreview.turnLabel}: {person.turns}</span></span>
                  <RotateCw className="h-4 w-4 text-[#8a9998]" />
                </button>
              ))}
            </div>

            <div className="bg-[#f4f6f2] p-5 sm:p-7">
              <div className="flex items-center gap-2 text-xs font-extrabold text-[#20383b]"><History className="h-4 w-4 text-[#e86f37]" />{t.rotationSection.demo.logTitle}</div>
              <div className="mt-4 space-y-2">
                {logs.slice(0, 4).map((log, index) => (
                  <div key={`${log}-${index}`} className="rounded-xl border border-[#e4eae5] bg-white p-3 text-[10px] font-semibold leading-5 text-[#647679]">
                    <span className="mr-2 font-extrabold text-[#096b61]">{index === 0 ? '10:24' : `10:${14 - index * 2}`}</span>{log}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {selected !== null && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[#0c292d]/65 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-md rounded-[24px] bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="rotation-reason-title">
            <button type="button" onClick={() => setSelected(null)} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl border border-[#dfe5df]" aria-label="Close"><X className="h-4 w-4" /></button>
            <h3 id="rotation-reason-title" className="pr-12 text-lg font-extrabold text-[#20383b]">{t.rotationSection.demo.reasonPrompt}</h3>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} className="mt-4 w-full resize-none rounded-xl border border-[#dfe5df] bg-[#f7f8f3] p-3 text-xs font-semibold outline-none focus:border-[#80b9a8]" />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => move(-1)} className="secondary-button"><ArrowUp className="h-4 w-4" />{t.rotationSection.demo.saveLog}</button>
              <button type="button" onClick={() => move(1)} className="primary-button"><ArrowDown className="h-4 w-4" />{t.rotationSection.demo.saveLog}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
