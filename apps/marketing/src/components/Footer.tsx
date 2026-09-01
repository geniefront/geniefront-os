import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { languageOptions } from '../translations';

export const Footer: React.FC = () => {
  const { t, currentLang, setLanguage } = useLanguage();

  return (
    <footer className="border-t border-[#26494c] bg-[#0c292d] text-white">
      <div className="site-shell py-14 sm:py-16">
        <div className="grid gap-10 border-b border-white/10 pb-12 md:grid-cols-2 lg:grid-cols-[1.25fr_0.72fr_0.78fr_0.62fr]">
          <div>
            <img src="/brand/geniefront-logo-on-dark.svg" alt="GenieFront" className="h-10 w-auto" />
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

          <div>
            <h3 className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#7de0c3]">WeChat support</h3>
            <div className="mt-4 w-fit rounded-2xl bg-white p-2 shadow-lg">
              <img src="/brand/wechat-qr.jpg" alt="GenieFront WeChat support QR code" className="h-28 w-28 rounded-xl object-cover" />
            </div>
            <p className="mt-3 text-[10px] font-semibold leading-4 text-white/45">Scan to add GenieFront<br />微信扫码联系我们</p>
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
