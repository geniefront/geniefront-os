import { useState } from 'react';
import type { BookingPolicy } from '@gf/scheduling';
import { LanguageProvider, useLanguage } from '@/LanguageContext';
import { BookingCapacityFields } from '@/features/setup/BookingCapacityFields';
export default function BookingCapacityPreview() {
  return <LanguageProvider><Preview /></LanguageProvider>;
}
function Preview() {
  const { language, setLanguage, ready } = useLanguage();
  const [policy, setPolicy] = useState<BookingPolicy>({ mode: 'staff', baseCapacity: null, bufferEnabled: true, bufferExtra: 1, requestBufferEnabled: false, requestBufferExtra: 1 });
  return <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-900">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-teal-700">LOCAL PREVIEW</p>
          <h1 className="mt-2 text-xl font-bold">{language === 'zh-Hans' ? '员工与预约设置' : 'Staff & booking settings'}</h1></div>
        <div className="flex gap-2">{(['zh-Hans', 'en'] as const).map(lang => <button key={lang} onClick={() => setLanguage(lang)} className={`rounded-lg px-4 py-2 text-sm font-medium ${language === lang ? 'bg-teal-600 text-white' : 'border border-slate-200 bg-white'}`}>{lang === 'en' ? 'English' : '中文'}</button>)}</div>
      </header>
      <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">{ready && <BookingCapacityFields policy={policy} onChange={setPolicy} />}</section>
      <p className="text-center text-xs text-slate-500">{language === 'zh-Hans' ? '本地示例 · 可以切换语言、修改数字和开关，不会保存到门店。' : 'Local demo · Try the language, numbers and switch. Changes are not saved to any shop.'}</p>
    </div>
  </main>;
}
