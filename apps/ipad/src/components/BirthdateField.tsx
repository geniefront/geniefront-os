import { useEffect, useId, useMemo, useState } from 'react';
import {
  type BirthdateParts, type BirthdateError,
  isoToParts, partsToISO, parseBirthdateParts,
} from '@gf/contracts';
import { useLanguage } from '../context/LanguageContext';

/**
 * iPad 自助端生日输入：年直接输 4 位数字，月 / 日下拉选，不逐月翻几十年。
 * 校验规则来自 `@gf/contracts.parseBirthdateParts`，与 Web / 公开表单同一份。
 *
 * `value` / `onChange` 走 `YYYY-MM-DD`；填一半时 `onChange('')`。
 */
export function BirthdateField({
  label, value, onChange, today, optional,
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  today?: string | null;
  optional?: boolean;
}) {
  const { t } = useLanguage();
  const baseId = useId();
  const [parts, setParts] = useState<BirthdateParts>(() => isoToParts(value));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const incoming = isoToParts(value);
    const current = partsToISO(parts) ?? '';
    if (value !== current) setParts(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (next: BirthdateParts) => {
    setParts(next);
    onChange(partsToISO(next) ?? '');
  };

  const dayCount = useMemo(() => {
    const y = Number(parts.year);
    const mo = Number(parts.month);
    if (!/^\d{4}$/.test(parts.year) || !mo) return 31;
    if (mo === 2) {
      const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
      return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(mo) ? 30 : 31;
  }, [parts.year, parts.month]);

  const result = parseBirthdateParts(parts, { today, optional });
  const errText: Record<BirthdateError, string> = {
    incomplete: '',
    format: t('health.dobInvalid'),
    invalid_date: t('health.dobBadDay'),
    future: t('health.dobFuture'),
  };
  const showError = touched && !result.ok && result.reason !== 'incomplete';

  const control =
    'mt-1.5 rounded-xl border-2 border-slate-200 bg-slate-50 px-3 py-3 font-medium outline-none focus:border-teal-600 focus:bg-white min-h-[44px]';

  return (
    <fieldset className="text-sm font-bold text-slate-700">
      <legend>{label}</legend>
      <div className="flex items-center gap-2" onBlur={() => setTouched(true)}>
        <input
          id={`${baseId}-y`}
          aria-label={`${label} ${t('health.dobYear')}`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          placeholder="YYYY"
          value={parts.year}
          onChange={(e) => update({ ...parts, year: e.target.value.replace(/\D/g, '').slice(0, 4) })}
          className={`${control} w-24 text-center`}
        />
        <select
          id={`${baseId}-m`}
          aria-label={`${label} ${t('health.dobMonth')}`}
          value={parts.month}
          onChange={(e) => update({ ...parts, month: e.target.value })}
          className={control}
        >
          <option value="">MM</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
          ))}
        </select>
        <select
          id={`${baseId}-d`}
          aria-label={`${label} ${t('health.dobDay')}`}
          value={parts.day}
          onChange={(e) => update({ ...parts, day: e.target.value })}
          className={control}
        >
          <option value="">DD</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d} disabled={d > dayCount}>{String(d).padStart(2, '0')}</option>
          ))}
        </select>
      </div>
      {showError && !result.ok && (
        <p className="mt-1 text-xs font-medium text-rose-600">{errText[result.reason]}</p>
      )}
    </fieldset>
  );
}
