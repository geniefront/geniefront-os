import React, { useState } from 'react';
import { Activity, ArrowRight, BedDouble, Eye, Footprints, Hand, RotateCw, Sparkles } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

const icons: Record<string, React.ElementType> = {
  nail: Hand,
  massage: Activity,
  footspa: Footprints,
  headspa: Sparkles,
  lash: Eye,
};

export const IndustryGrid: React.FC = () => {
  const { t, openTrialModal } = useLanguage();
  const [active, setActive] = useState(t.industries.items[0]?.id || 'nail');
  const selected = t.industries.items.find((item) => item.id === active) || t.industries.items[0];
  const SelectedIcon = icons[selected.id] || Activity;

  return (
    <section id="industries" className="border-y border-[#dfe5df] bg-white py-20 sm:py-24">
      <div className="site-shell">
        <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:gap-16">
          <div className="min-w-0">
            <div className="eyebrow"><Sparkles className="h-3.5 w-3.5" />{t.industries.badge}</div>
            <h2 className="font-serif-brand mt-5 text-4xl font-medium leading-[1.03] tracking-[-0.04em] text-[#102a2e] sm:text-5xl">{t.industries.title}</h2>
            <p className="mt-5 text-sm font-medium leading-7 text-[#647679]">{t.industries.subtitle}</p>

            <div className="mt-7 flex gap-2 overflow-x-auto pb-2 lg:flex-col">
              {t.industries.items.map((item) => {
                const Icon = icons[item.id] || Activity;
                const isActive = item.id === active;
                return (
                  <button key={item.id} type="button" onClick={() => setActive(item.id)} className={`flex min-w-max items-center gap-3 rounded-2xl border px-4 py-3 text-left text-xs font-extrabold transition-all lg:w-full ${isActive ? 'border-[#80b9a8] bg-[#edf8f3] text-[#096b61]' : 'border-[#e4eae5] bg-white text-[#53676a] hover:border-[#b9d6cc]'}`} aria-pressed={isActive}>
                    <Icon className="h-4 w-4" />{item.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 overflow-hidden rounded-[28px] border border-[#dfe5df] bg-[#f7f8f3]">
            <div className="flex items-center gap-4 border-b border-[#dfe5df] bg-[#0c292d] px-6 py-5 text-white sm:px-8">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/10"><SelectedIcon className="h-5 w-5 text-[#7de0c3]" /></span>
              <div><h3 className="text-lg font-extrabold">{selected.name}</h3><p className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">{selected.enName}</p></div>
            </div>

            <div className="p-6 sm:p-8">
              <p className="text-sm font-medium leading-7 text-[#53676a]">{selected.desc}</p>
              <div className="mt-7 grid gap-3 sm:grid-cols-3">
                <article className="metric-card p-4">
                  <BedDouble className="h-5 w-5 text-[#096b61]" />
                  <h4 className="mt-3 text-xs font-extrabold text-[#20383b]">{t.staffAndKiosk.kiosk.title}</h4>
                  <p className="mt-2 text-[10px] font-semibold leading-5 text-[#708184]">{selected.resourceType}</p>
                </article>
                <article className="metric-card p-4">
                  <RotateCw className="h-5 w-5 text-[#e86f37]" />
                  <h4 className="mt-3 text-xs font-extrabold text-[#20383b]">{t.rotationSection.features[0]?.title}</h4>
                  <p className="mt-2 text-[10px] font-semibold leading-5 text-[#708184]">{selected.rotationRule}</p>
                </article>
                <article className="metric-card p-4">
                  <Sparkles className="h-5 w-5 text-[#7b61a8]" />
                  <h4 className="mt-3 text-xs font-extrabold text-[#20383b]">{t.security.items[0]?.title}</h4>
                  <p className="mt-2 text-[10px] font-semibold leading-5 text-[#708184]">{selected.intakeHighlight}</p>
                </article>
              </div>

              <button type="button" onClick={() => openTrialModal(selected.id)} className="primary-button mt-7">{t.hero.primaryCta}<ArrowRight className="h-4 w-4" /></button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
