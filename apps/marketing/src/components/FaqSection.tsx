import React, { useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { uiText } from '../translations/ui';
import { 
  HelpCircle, 
  ChevronDown, 
  Sparkles, 
  MessageSquare, 
  CreditCard, 
  ShieldCheck, 
  RotateCw, 
  Smartphone
} from 'lucide-react';

export const FaqSection: React.FC = () => {
  const { t, currentLang } = useLanguage();
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const [selectedCategory, setSelectedCategory] = useState<string>('__all__');
  const allCategory = uiText[currentLang].all;

  const faqItems = t.faq.items;

  // Extract unique categories
  const categories = [{ value: '__all__', label: allCategory }, ...Array.from(new Set(faqItems.map((item) => item.category))).map((category) => ({ value: category, label: category }))];

  const filteredFaqs = selectedCategory === '__all__'
    ? faqItems
    : faqItems.filter((item) => item.category === selectedCategory);

  const toggleAccordion = (idx: number) => {
    setOpenIndex(openIndex === idx ? null : idx);
  };

  return (
    <section id="faq" className="py-20 bg-slate-50/70 border-t border-slate-200">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#edf8f3] border border-[#b9d6cc] text-[#096b61] text-xs font-bold uppercase tracking-wider mb-3">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>{t.faq.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.faq.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.faq.subtitle}
          </p>
        </div>

        {/* Category Filter Pills */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-8">
          {categories.map((cat) => (
            <button
              key={`${t.meta.title}-${cat.value}`}
              onClick={() => {
                setSelectedCategory(cat.value);
                setOpenIndex(null);
              }}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all border ${
                selectedCategory === cat.value
                  ? 'bg-[#096b61] text-white border-[#096b61] shadow-xs'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Accordion List */}
        <div className="space-y-3.5">
          {filteredFaqs.map((faq, index) => {
            const isOpen = openIndex === index;
            return (
              <div
                key={faq.question}
                className="rounded-2xl bg-white border border-slate-200 overflow-hidden transition-all shadow-xs"
              >
                <button
                  id={`faq-toggle-${index}`}
                  onClick={() => toggleAccordion(index)}
                  className="w-full p-5 sm:p-6 text-left flex items-start justify-between gap-4 focus:outline-none focus:bg-slate-50"
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${index}`}
                >
                  <div>
                    <span className="inline-block px-2.5 py-0.5 rounded-md text-[10px] font-bold bg-[#edf8f3] text-[#096b61] border border-[#d9f2e8] mb-1.5 uppercase">
                      {faq.category}
                    </span>
                    <h3 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
                      {faq.question}
                    </h3>
                  </div>
                  <div className={`p-1.5 rounded-lg bg-slate-100 text-slate-500 shrink-0 mt-1 transition-transform duration-200 ${isOpen ? 'rotate-180 bg-[#edf8f3] text-[#096b61]' : ''}`}>
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </button>

                {isOpen && (
                  <div id={`faq-panel-${index}`} role="region" aria-labelledby={`faq-toggle-${index}`} className="faq-panel-enter px-5 pb-5 sm:px-6 sm:pb-6 pt-0 text-xs sm:text-sm text-slate-600 leading-relaxed border-t border-slate-100 mt-1 bg-slate-50/50">
                    <p className="pt-3">{faq.answer}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
