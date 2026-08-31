import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { languageOptions } from '../translations';

export const Footer: React.FC = () => {
  const { t, currentLang, setLanguage } = useLanguage();

  return (
    <footer className="border-t border-[#26494c] bg-[#0c292d] text-white">
      <div className="site-shell py-14 sm:py-16">
        <div className="grid gap-10 border-b border-white/10 pb-12 lg:grid-cols-[1.2fr_0.8fr_0.8fr]">
          <div>
            <div className="flex items-center gap-3">
              <span className="brand-mark bg-white font-serif-brand text-xl font-semibold text-[#0c292d]" aria-hidden="true">G</span>
              <div><div className="text-base font-extrabold">GenieFront OS</div><div className="mt-1 text-[9px] font-bold uppercase tracking-[0.18em] text-white/45">Shop operating system</div></div>
            </div>
            <p className="mt-5 max-w-md text-sm font-medium leading-6 text-white/60">{t.footer.brandBio}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              {languageOptions.map((language) => (
                <button key={language.code} type="button" onClick={() => setLanguage(language.code)} className={`rounded-full border px-3 py-1.5 text-[10px] font-bold ${currentLang === language.code ? 'border-[#55c3a5] bg-[#55c3a5]/15 text-[#7de0c3]' : 'border-white/15 text-white/55 hover:border-white/35 hover:text-white'}`}>
                  {language.nativeLabel}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#7de0c3]">{t.footer.productCol.title}</h3>
            <ul className="mt-4 space-y-3 text-xs font-bold text-white/60">
              {t.footer.productCol.items.slice(0, 6).map((item) => <li key={item}><a href="#product" className="hover:text-white">{item}</a></li>)}
            </ul>
          </div>

          <div>
            <h3 className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#7de0c3]">Jaysen Labs LLC</h3>
            <ul className="mt-4 space-y-3 text-xs font-bold text-white/60">
              <li><a href="/privacy/" className="inline-flex items-center gap-1 hover:text-white">Privacy Policy<ArrowUpRight className="h-3 w-3" /></a></li>
              <li><a href="/terms/" className="inline-flex items-center gap-1 hover:text-white">Terms of Service<ArrowUpRight className="h-3 w-3" /></a></li>
              <li><a href="/sms/" className="inline-flex items-center gap-1 hover:text-white">SMS Terms<ArrowUpRight className="h-3 w-3" /></a></li>
              <li><a href="mailto:privacy@geniefront.com" className="hover:text-white">privacy@geniefront.com</a></li>
              <li><a href="mailto:legal@geniefront.com" className="hover:text-white">legal@geniefront.com</a></li>
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-4 pt-7 text-[10px] font-semibold leading-5 text-white/40 md:flex-row md:items-end md:justify-between">
          <p className="max-w-2xl">{t.footer.disclaimer}</p>
          <p className="shrink-0">© 2026 Jaysen Labs LLC · GenieFront</p>
        </div>
      </div>
    </footer>
  );
};
