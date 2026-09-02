import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { languageOptions } from '../translations';
import { deskLoginUrl } from '../lib/desk';

export const Footer: React.FC = () => {
  const { t, currentLang, setLanguage } = useLanguage();
  const productHrefs = ['#product', '#single-pc', '#ai-features', '#ai-features', '#staff-kiosk', '#staff-kiosk'];
  const legalCopy = {
    en: ['Privacy Policy', 'Terms of Service', 'SMS Terms', 'WeChat support', 'Scan to add GenieFront'],
    'zh-CN': ['隐私政策', '服务条款', '短信条款', '微信支持', '微信扫码联系我们'],
    vi: ['Chính sách quyền riêng tư', 'Điều khoản dịch vụ', 'Điều khoản SMS', 'Hỗ trợ WeChat', 'Quét để thêm GenieFront'],
    ko: ['개인정보 처리방침', '서비스 약관', 'SMS 약관', 'WeChat 지원', '스캔하여 GenieFront 추가'],
    es: ['Política de privacidad', 'Términos del servicio', 'Términos de SMS', 'Soporte por WeChat', 'Escanea para agregar GenieFront'],
  }[currentLang];

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
              {t.footer.productCol.items.slice(0, 6).map((item, index) => <li key={item}><a href={productHrefs[index]} className="hover:text-white">{item}</a></li>)}
              <li><a href={deskLoginUrl()} data-testid="footer-sign-in" className="hover:text-white">{t.nav.signIn}</a></li>
            </ul>
          </div>

          <div>
            <h3 className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#7de0c3]">Jaysen Labs LLC</h3>
            <ul className="mt-4 space-y-3 text-xs font-bold text-white/60">
              <li><a href="/privacy/" className="inline-flex items-center gap-1 hover:text-white">{legalCopy[0]}<ArrowUpRight className="h-3 w-3" /></a></li>
              <li><a href="/terms/" className="inline-flex items-center gap-1 hover:text-white">{legalCopy[1]}<ArrowUpRight className="h-3 w-3" /></a></li>
              <li><a href="/sms/" className="inline-flex items-center gap-1 hover:text-white">{legalCopy[2]}<ArrowUpRight className="h-3 w-3" /></a></li>
              <li><a href="mailto:privacy@geniefront.com" className="hover:text-white">privacy@geniefront.com</a></li>
              <li><a href="mailto:legal@geniefront.com" className="hover:text-white">legal@geniefront.com</a></li>
            </ul>
          </div>

          <div>
            <h3 className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#7de0c3]">{legalCopy[3]}</h3>
            <div className="mt-4 w-fit rounded-2xl bg-white p-2 shadow-lg">
              <img src="/brand/wechat-qr.jpg" alt="GenieFront WeChat support QR code" className="h-28 w-28 rounded-xl object-cover" />
            </div>
            <p className="mt-3 text-[10px] font-semibold leading-4 text-white/45">{legalCopy[4]}</p>
          </div>
        </div>

        <div className="flex flex-col gap-4 pt-7 text-[10px] font-semibold leading-5 text-white/40 md:flex-row md:items-end md:justify-between">
          <p className="max-w-2xl">{t.footer.disclaimer}</p>
          <p className="shrink-0">{t.footer.copyright}</p>
        </div>
      </div>
    </footer>
  );
};
