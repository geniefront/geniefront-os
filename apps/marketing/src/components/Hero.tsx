import React from 'react';
import { ArrowRight, Check, PlayCircle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { InteractiveHeroPreview } from './InteractiveHeroPreview';

export const Hero: React.FC = () => {
  const { t, openTrialModal } = useLanguage();

  const proofPoints = [t.hero.resourcePills.rotation, t.hero.resourcePills.singlePc, t.hero.resourcePills.noPerSeat];

  return (
    <section id="top" className="relative overflow-hidden pb-20 pt-32 sm:pt-36 lg:pb-28 lg:pt-44">
      <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute left-[8%] top-24 h-72 w-72 rounded-full bg-[#d9f2e8] opacity-70 blur-3xl" aria-hidden="true" />

      <div className="site-shell relative">
        <div className="grid items-center gap-12 lg:grid-cols-[0.86fr_1.14fr] lg:gap-10">
          <div>
            <div className="eyebrow"><span className="eyebrow-dot" />{t.hero.badge}</div>
            <h1 className="display-title mt-7 text-[#102a2e]">
              {t.hero.headline} <em>{t.hero.headlineHighlight}</em>
            </h1>
            <p className="mt-7 max-w-xl text-base font-medium leading-7 text-[#5b6f72] sm:text-lg">
              {t.hero.subheadline}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button type="button" onClick={() => openTrialModal()} className="primary-button">
                {t.hero.primaryCta}<ArrowRight className="h-4 w-4" />
              </button>
              <a href="#how-it-works" className="secondary-button">
                <PlayCircle className="h-4 w-4 text-[#096b61]" />{t.hero.secondaryCta}
              </a>
            </div>

            <div className="mt-8 grid gap-3 border-t border-[#dfe5df] pt-5 sm:grid-cols-3">
              {proofPoints.map((point) => (
                <div key={point} className="flex items-start gap-2 text-[11px] font-bold leading-4 text-[#53676a]">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[#d9f2e8] text-[#096b61]"><Check className="h-2.5 w-2.5" /></span>
                  <span>{point}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:pl-2">
            <InteractiveHeroPreview />
            <p className="mt-4 text-center text-[11px] font-bold uppercase tracking-[0.16em] text-[#708184]">{t.hero.demoNotice}</p>
          </div>
        </div>
      </div>
    </section>
  );
};
