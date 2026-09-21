import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import { UI_LANGUAGES } from '@/i18n/types';
import { cn } from '@/lib/utils';

export function AuthLayout({ children }: { children?: ReactNode }) {
  const { t, language, setLanguage } = useLanguage();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center bg-[var(--gf-canvas)] p-4 pt-24 sm:p-8">
      <div className="absolute left-5 top-5 sm:left-8 sm:top-8">
        <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="h-9 w-auto sm:h-10" />
      </div>
      <div className="absolute right-5 top-5 z-20 sm:right-8 sm:top-8" ref={menuRef}>
        <button
          type="button"
          aria-label={t('language')}
          onClick={() => setOpen((v) => !v)}
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-500 hover:bg-white hover:text-slate-800"
        >
          <Globe className="h-5 w-5" />
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-2 w-36 rounded-xl border border-slate-100 bg-white py-1 shadow-lg">
            {UI_LANGUAGES.map(({ code, label }) => (
              <button
                key={code}
                type="button"
                onClick={() => {
                  setLanguage(code);
                  setOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm',
                  language === code ? 'bg-teal-50 font-bold text-teal-700' : 'text-slate-600 hover:bg-slate-50',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {children ?? <Outlet />}
    </div>
  );
}
