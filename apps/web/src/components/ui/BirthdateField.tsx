import { useEffect, useId, useMemo, useState } from 'react';
import {
  type BirthdateParts, type BirthdateError,
  isoToParts, partsToISO, parseBirthdateParts,
} from '@gf/contracts';

/**
 * 生日 / date-only 输入：年直接输 4 位数字，月 / 日下拉选，不逐月翻几十年。
 * 校验规则来自 `@gf/contracts` 的 `parseBirthdateParts`（Web / iPad / 公开表单共用）。
 *
 * `value` / `onChange` 走 `YYYY-MM-DD` 字符串；填一半时 `onChange('')`，
 * 父组件提交时再用同一套规则做最终校验。
 */
export interface BirthdateFieldProps {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  /** 门店日历今天 YYYY-MM-DD；给出时禁止未来日期。未加载就不传。 */
  today?: string | null;
  /** 模板 / 场景未要求生日时允许留空。 */
  optional?: boolean;
  required?: boolean;
  /** 本地化错误文案；缺省用内置英文。 */
  errorText?: Partial<Record<BirthdateError, string>>;
  className?: string;
}

const DEFAULT_ERRORS: Record<BirthdateError, string> = {
  incomplete: 'Enter year, month and day.',
  format: 'Use a valid date.',
  invalid_date: 'That day does not exist in the chosen month.',
  future: 'Date of birth cannot be in the future.',
};

const selectClass =
  'rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs min-h-[44px] focus:border-teal-500 focus:outline-none';

export function BirthdateField({
  label, value, onChange, today, optional, required, errorText, className,
}: BirthdateFieldProps) {
  const baseId = useId();
  const [parts, setParts] = useState<BirthdateParts>(() => isoToParts(value));
  const [touched, setTouched] = useState(false);

  // 外部值变化（回显 / 重置）时同步；避免把用户正在编辑的一半冲掉
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

  const result = parseBirthdateParts(parts, { today, optional: optional ?? !required });
  const showError = touched && !result.ok && result.reason !== 'incomplete';
  const errMsg = !result.ok
    ? (errorText?.[result.reason] ?? DEFAULT_ERRORS[result.reason])
    : '';

  return (
    <fieldset className={className}>
      <legend className="block font-bold text-slate-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </legend>
      <div className="flex items-center gap-2" onBlur={() => setTouched(true)}>
        <input
          id={`${baseId}-year`}
          aria-label={`${label} — year`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          placeholder="YYYY"
          value={parts.year}
          onChange={(e) => update({ ...parts, year: e.target.value.replace(/\D/g, '').slice(0, 4) })}
          className={`${selectClass} w-20 text-center`}
        />
        <select
          id={`${baseId}-month`}
          aria-label={`${label} — month`}
          value={parts.month}
          onChange={(e) => update({ ...parts, month: e.target.value })}
          className={selectClass}
        >
          <option value="">MM</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
          ))}
        </select>
        <select
          id={`${baseId}-day`}
          aria-label={`${label} — day`}
          value={parts.day}
          onChange={(e) => update({ ...parts, day: e.target.value })}
          className={selectClass}
        >
          <option value="">DD</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
            // 越界的日不移除也不静默改月：列出但禁用，配合下方红字提示
            <option key={d} value={d} disabled={d > dayCount}>{String(d).padStart(2, '0')}</option>
          ))}
        </select>
      </div>
      {showError && <p className="mt-1 text-[11px] font-medium text-red-600">{errMsg}</p>}
    </fieldset>
  );
}
