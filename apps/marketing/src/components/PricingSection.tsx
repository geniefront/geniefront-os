import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { 
  CreditCard, 
  Check, 
  Sparkles, 
  ArrowRight, 
  ShieldCheck, 
  Layers, 
  Globe, 
  PhoneCall,
  Flame,
  Info
} from 'lucide-react';

export const PricingSection: React.FC = () => {
  const { t, openTrialModal } = useLanguage();
  const plans = t.pricing.plans;

  return (
    <section id="pricing" className="py-20 bg-white border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#edf8f3] border border-[#b9d6cc] text-[#096b61] text-xs font-bold uppercase tracking-wider mb-3">
            <CreditCard className="w-3.5 h-3.5" />
            <span>{t.pricing.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.pricing.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.pricing.subtitle}
          </p>

          <div className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-50 border border-slate-200 text-xs font-semibold text-slate-700 shadow-2xs">
            <ShieldCheck className="w-4 h-4 text-[#096b61]" />
            <span>{t.pricing.perLocationNotice}</span>
          </div>
        </div>

        {/* 2 Main SaaS Pricing Cards */}
        <div className="bg-slate-50/70 p-4 sm:p-8 rounded-3xl border border-slate-200 mb-12">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto items-stretch">
            {/* Plan 1: Essential ($99/mo) */}
            <div data-testid="plan-essential" className="flex flex-col justify-between bg-white p-8 rounded-2xl border-t-4 border-t-slate-400 border border-slate-200 shadow-xs">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-slate-600 font-bold text-xs uppercase tracking-wider">
                    {plans.essential.name}
                  </span>
                </div>

                <div className="flex items-baseline gap-1 mb-3">
                  <span className="text-4xl sm:text-5xl font-extrabold text-slate-900">{plans.essential.price}</span>
                  <span className="text-sm font-semibold text-slate-500">{plans.essential.period}</span>
                </div>

                <p className="text-xs sm:text-sm text-slate-600 mb-6 leading-relaxed">
                  {plans.essential.desc}
                </p>

                <div className="space-y-3 pt-4 border-t border-slate-100">
                  <ul className="space-y-3 text-xs sm:text-sm text-slate-600">
                    {plans.essential.features.map((feat, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <Check className="w-4 h-4 text-[#096b61] shrink-0 mt-0.5" />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-slate-100">
                <button
                  id="pricing-essential-trial-btn"
                  data-testid="cta-essential"
                  onClick={() => openTrialModal('nail', 'essential')}
                  className="w-full py-3 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-sm flex items-center justify-center gap-2 transition-all active:scale-98"
                >
                  <span>{plans.essential.cta}</span>
                  <ArrowRight className="w-4 h-4 text-slate-700" />
                </button>
              </div>
            </div>

            {/* Plan 2: Growth ($199/mo) - Highlighted with Blue Brand Border */}
            <div data-testid="plan-growth" className="flex flex-col justify-between bg-white p-8 rounded-2xl border-2 border-[#096b61] shadow-md relative">
              {/* Badge */}
              <div className="absolute -top-3 right-6 px-3.5 py-1 rounded-full bg-[#096b61] text-white text-xs font-extrabold tracking-wider uppercase shadow-md flex items-center gap-1.5">
                <Flame className="w-3.5 h-3.5 text-amber-300 fill-amber-300" />
                <span>{plans.growth.badge}</span>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[#096b61] font-bold text-xs uppercase tracking-wider">
                    {plans.growth.name}
                  </span>
                </div>

                <div className="flex items-baseline gap-1 mb-3">
                  <span className="text-4xl sm:text-5xl font-extrabold text-slate-900">{plans.growth.price}</span>
                  <span className="text-sm font-semibold text-slate-500">{plans.growth.period}</span>
                </div>

                <p className="text-xs sm:text-sm text-slate-600 mb-6 leading-relaxed">
                  {plans.growth.desc}
                </p>

                <div className="space-y-3 pt-4 border-t border-slate-100">
                  <ul className="space-y-3 text-xs sm:text-sm text-slate-700">
                    {plans.growth.features.map((feat, i) => (
                      <li key={i} className="flex items-start gap-2.5">
                        <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        <span className="font-medium">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-slate-100">
                <button
                  id="pricing-growth-trial-btn"
                  data-testid="cta-growth"
                  onClick={() => openTrialModal('nail', 'growth')}
                  className="w-full py-3 px-4 rounded-xl bg-[#096b61] hover:bg-[#064b46] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-[#096b61]/20 transition-all active:scale-98"
                >
                  <span>{plans.growth.cta}</span>
                  <ArrowRight className="w-4 h-4 text-white" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Add-ons & Flat-Fee Value Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto mb-12">
          {/* Top-up Credits */}
          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-xs">
            <div className="flex items-center gap-2.5 mb-2 text-slate-900">
              <Layers className="w-5 h-5 text-[#096b61]" />
              <h4 className="font-bold text-base">{t.pricing.additions.topupTitle}</h4>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-2">
              {t.pricing.additions.topupDesc}
            </p>
            <div className="text-[11px] text-slate-400 font-medium italic">
              {t.pricing.additions.independentQuotas}
            </div>
          </div>

          {/* No Per-Seat Value */}
          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-xs">
            <div className="flex items-center gap-2.5 mb-2 text-slate-900">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
              <h4 className="font-bold text-base">{t.pricing.additions.noSeatFeeTitle}</h4>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              {t.pricing.additions.noSeatFeeDesc}
            </p>
          </div>
        </div>

        {/* Custom Salon Storefront Website Service Banner */}
        <div className="max-w-5xl mx-auto bg-slate-50/80 border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-xs">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="space-y-2 max-w-2xl">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#edf8f3] text-[#096b61] text-xs font-bold border border-[#b9d6cc]">
                <Globe className="w-3.5 h-3.5" />
                <span>{t.pricing.storefront.badge}</span>
              </div>
              <h4 className="text-xl sm:text-2xl font-bold text-slate-900">
                {t.pricing.storefront.title} — <span className="text-[#096b61]">{t.pricing.storefront.price}</span>
                <span className="text-xs font-normal text-slate-500 ml-2">{t.pricing.storefront.hosting}</span>
              </h4>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                {t.pricing.storefront.desc}
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 text-xs text-slate-700">
                {t.pricing.storefront.points.map((pt, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5 text-[#096b61] shrink-0" />
                    <span>{pt}</span>
                  </div>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 italic pt-1">
                {t.pricing.storefront.disclaimer}
              </div>
            </div>

            <button
              onClick={() => openTrialModal('storefront')}
              className="shrink-0 px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs sm:text-sm shadow-md transition-all active:scale-98"
            >
              {t.pricing.storefront.cta}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
