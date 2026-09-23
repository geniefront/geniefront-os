import type { BookingPolicy } from '@gf/scheduling';
import { useLanguage } from '@/LanguageContext';
import { Input } from '@/components/ui/Input';
import { Field } from './primitives';

export function BookingCapacityFields({ policy: p, onChange }: {
  policy: BookingPolicy; onChange: (policy: BookingPolicy) => void;
}) {
  const { t } = useLanguage();
  const automatic = p.baseCapacity === null;
  const total = (p.baseCapacity ?? 2) + (p.bufferEnabled ? p.bufferExtra : 0);
  return <div className="space-y-6">
    <h3 className="text-lg font-bold text-slate-900">{t('capacityPlainTitle')}</h3>
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label={t('capacityPlainTitle')}>
      {[true, false].map(auto => <button key={String(auto)} type="button" aria-pressed={automatic === auto}
        onClick={() => onChange({ ...p, mode: 'staff', baseCapacity: auto ? null : p.baseCapacity ?? 2 })}
        className={`rounded-xl border p-4 text-left transition-colors ${automatic === auto ? 'border-teal-600 bg-teal-50 ring-1 ring-teal-600' : 'border-slate-200 bg-white hover:border-slate-400'}`}>
        <span className="flex items-center justify-between gap-3 text-sm font-semibold text-slate-900">
          {t(auto ? 'capacityAuto' : 'capacityCustom')}
          <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${automatic === auto ? 'border-teal-600 bg-teal-600' : 'border-slate-300'}`}>
            {automatic === auto && <span className="size-1.5 rounded-full bg-white" />}
          </span>
        </span>
        <span className="mt-1.5 block text-xs text-slate-500">{t(auto ? 'capacityAutoHint' : 'capacityCustomHint')}</span>
      </button>)}
    </div>
    {!automatic && <Field label={t('capacityBaseLabel')}>
      <Input className="max-w-32" type="number" min="1" max="100" value={p.baseCapacity ?? ''}
        onChange={e => onChange({ ...p, baseCapacity: e.target.value === '' ? null : Number(e.target.value), mode: 'staff' })} />
    </Field>}
    <div className="space-y-4 border-t border-slate-100 pt-5">
      <button type="button" role="switch" aria-checked={p.bufferEnabled}
        onClick={() => onChange({ ...p, bufferEnabled: !p.bufferEnabled })}
        className="flex w-full items-center justify-between gap-4 text-left text-sm font-semibold text-slate-900">
        {t('capacityExtraLabel')}
        <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${p.bufferEnabled ? 'bg-teal-600' : 'bg-slate-300'}`}>
          <span className={`absolute top-1 size-4 rounded-full bg-white shadow-sm transition-transform ${p.bufferEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </span>
      </button>
      {p.bufferEnabled && <div className="space-y-2">
        <label className="flex items-center justify-between gap-4 text-sm text-slate-600">
          {t('capacityExtraCount')}
          <Input className="w-24" type="number" min="1" max="10" value={p.bufferExtra}
            onChange={e => onChange({ ...p, bufferExtra: Number(e.target.value) })} />
        </label>
        <p className="text-xs leading-5 text-slate-500">{t('capacityExtraHelp')}</p>
      </div>}
    </div>
    <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600" aria-live="polite">
      {t(automatic ? 'capacitySummaryAuto' : 'capacitySummaryFixed', { total })}
    </p>
  </div>;
}
