import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Globe2, Menu, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { languageOptions } from '../translations';
import { uiText } from '../translations/ui';
import type { LanguageCode } from '../types/i18n';
import { deskLoginUrl } from '../lib/desk';

export const Navbar: React.FC = () => {
  const { currentLang, setLanguage, t, openTrialModal } = useLanguage();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 16);
    handleScroll();
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && setMobileOpen(false);
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen]);

  const current = languageOptions.find((language) => language.code === currentLang) || languageOptions[0];
  const ui = uiText[currentLang];

  const handleLanguageChange = (code: LanguageCode) => {
    setLanguage(code);
    setLanguageOpen(false);
  };

  const navLinks = [
    { label: t.nav.product, href: '#product' },
    { label: t.nav.howItWorks, href: '#how-it-works' },
    { label: t.nav.industries, href: '#industries' },
    { label: t.nav.pricing, href: '#pricing' },
  ];

  return (
    <header className={`fixed inset-x-0 top-0 z-40 border-b transition-all duration-300 ${scrolled ? 'border-[#dfe5df] bg-[#f7f8f3]/95 shadow-sm backdrop-blur-xl' : 'border-transparent bg-[#f7f8f3]/82 backdrop-blur-md'}`}>
      <div className="site-shell flex h-[72px] items-center justify-between">
        <a href="#top" className="flex items-center rounded-xl" aria-label="GenieFront OS home">
          <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="h-9 w-auto sm:h-10" />
        </a>

        <nav className="hidden items-center gap-7 lg:flex" aria-label={ui.primaryNavigation}>
          {navLinks.map((link) => (
            <a key={link.href} href={link.href} className="text-[13px] font-bold text-[#53676a] transition-colors hover:text-[#096b61]">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setLanguageOpen((value) => !value)}
              className="flex h-10 items-center gap-2 rounded-xl border border-[#dfe5df] bg-white/80 px-3 text-xs font-bold text-[#20383b] transition hover:border-[#b9d6cc] hover:bg-white"
              aria-expanded={languageOpen}
              aria-haspopup="menu"
            >
              <Globe2 className="h-4 w-4 text-[#096b61]" />
              <span className="hidden sm:inline">{current.nativeLabel}</span>
              <span className="sm:hidden">{current.code.split('-')[0].toUpperCase()}</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${languageOpen ? 'rotate-180' : ''}`} />
            </button>

            {languageOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-label={ui.close} onClick={() => setLanguageOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-2xl border border-[#dfe5df] bg-white p-2 shadow-2xl" role="menu">
                  {languageOptions.map((language) => (
                    <button
                      key={language.code}
                      type="button"
                      role="menuitemradio"
                      aria-checked={currentLang === language.code}
                      onClick={() => handleLanguageChange(language.code)}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-xs font-bold ${currentLang === language.code ? 'bg-[#e8f5ef] text-[#096b61]' : 'text-[#53676a] hover:bg-[#f4f6f2]'}`}
                    >
                      <span>{language.nativeLabel}</span>
                      {currentLang === language.code && <Check className="h-4 w-4" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <a
            href={deskLoginUrl()}
            data-testid="nav-sign-in"
            className="inline-flex h-10 min-h-10 items-center rounded-xl px-3 text-[13px] font-bold text-[#096b61] transition hover:bg-white/80"
          >
            {t.nav.signIn}
          </a>

          <span className="hidden sm:inline-flex">
            <button type="button" onClick={() => openTrialModal()} className="primary-button h-10 min-h-0 px-4">
              {t.nav.startTrial}<ArrowUpRight className="h-4 w-4" />
            </button>
          </span>

          <button type="button" onClick={() => setMobileOpen((value) => !value)} className="grid h-10 w-10 place-items-center rounded-xl border border-[#dfe5df] bg-white transition hover:border-[#b9d6cc] lg:hidden" aria-label={mobileOpen ? ui.closeNavigation : ui.openNavigation} aria-expanded={mobileOpen} aria-controls="mobile-navigation">
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div id="mobile-navigation" className="mobile-menu-enter border-t border-[#dfe5df] bg-[#f7f8f3]/98 px-4 py-4 shadow-xl lg:hidden">
          <nav className="site-shell flex flex-col gap-1" aria-label={ui.mobileNavigation}>
            {navLinks.map((link) => (
              <a key={link.href} href={link.href} onClick={() => setMobileOpen(false)} className="rounded-xl px-3 py-3 text-sm font-bold text-[#20383b] hover:bg-white">
                {link.label}
              </a>
            ))}
            <a
              href={deskLoginUrl()}
              data-testid="nav-sign-in-mobile"
              onClick={() => setMobileOpen(false)}
              className="mt-2 rounded-xl px-3 py-3 text-sm font-bold text-[#096b61] hover:bg-white"
            >
              {t.nav.signIn}
            </a>
            <button type="button" onClick={() => { setMobileOpen(false); openTrialModal(); }} className="primary-button mt-2 w-full">
              {t.nav.startTrial}<ArrowUpRight className="h-4 w-4" />
            </button>
          </nav>
        </div>
      )}
    </header>
  );
};
