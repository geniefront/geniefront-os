import React from 'react';
import { useLanguage } from '../context/LanguageContext';
import { 
  ShieldCheck, 
  Lock, 
  Users, 
  Database, 
  KeyRound, 
  WifiOff, 
  DownloadCloud, 
  AlertTriangle,
  FileText,
  Building
} from 'lucide-react';

export const SecurityAndTrust: React.FC = () => {
  const { t } = useLanguage();

  const trustIcons = [
    Lock,
    Users,
    Database,
    KeyRound,
    WifiOff,
    DownloadCloud,
  ];

  return (
    <section id="security" className="py-20 bg-slate-50/70 border-t border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider mb-3">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{t.security.badge}</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
            {t.security.title}
          </h2>
          <p className="mt-3.5 text-base text-slate-600 leading-relaxed">
            {t.security.subtitle}
          </p>
        </div>

        {/* 6 Security Pillars Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
          {t.security.items.map((item, idx) => {
            const Icon = trustIcons[idx] || ShieldCheck;
            return (
              <div
                key={idx}
                className="p-6 rounded-2xl bg-white border border-slate-200 shadow-xs hover:border-blue-400 hover:shadow-md transition-all"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4 border border-blue-100">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-base text-slate-900 mb-2">{item.title}</h3>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  {item.desc}
                </p>
              </div>
            );
          })}
        </div>

        {/* Explicit POS & Financial Separation Callout Banner (Critical Requirement) */}
        <div className="rounded-2xl bg-amber-50/80 border border-amber-300 p-6 sm:p-8 text-slate-900 shadow-xs mb-6">
          <div className="flex flex-col sm:flex-row items-start gap-4">
            <div className="p-2.5 rounded-xl bg-amber-100 text-amber-800 border border-amber-200 shrink-0">
              <AlertTriangle className="w-6 h-6 text-amber-700" />
            </div>
            <div className="space-y-2">
              <h4 className="text-base sm:text-lg font-bold text-amber-900">
                {t.security.posNoticeTitle}
              </h4>
              <p className="text-xs sm:text-sm text-slate-700 leading-relaxed font-sans">
                {t.security.posNoticeBody}
              </p>
            </div>
          </div>
        </div>

        {/* Compliance and Reality Honesty Notice */}
        <div className="p-4 rounded-xl bg-white border border-slate-200 text-center text-xs text-slate-600 leading-relaxed max-w-3xl mx-auto shadow-2xs">
          <span className="font-bold text-blue-600">✦ </span>
          {t.security.complianceNote}
        </div>
      </div>
    </section>
  );
};
