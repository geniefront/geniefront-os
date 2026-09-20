import { forwardRef, useId, useState, type InputHTMLAttributes } from 'react';
import { formatPhoneInput, normalizePhoneE164 } from '@gf/contracts/phone';

/** Editable international prefix, US by default; no truncation or silent letter removal. */
export const PhoneInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function PhoneInput({ value, defaultValue, onChange, onBlur, onFocus, required, ...props }, ref) {
    const [focused, setFocused] = useState(false);
    const [editing, setEditing] = useState('');
    const [internal, setInternal] = useState(String(defaultValue ?? ''));
    const [error, setError] = useState(false);
    const id = useId();
    const raw = String(value ?? internal);
    const locale = props.lang ?? (typeof document === 'undefined' ? 'en' : document.documentElement.lang);
    const message = locale.startsWith('zh') ? '请输入完整电话号码和国家区号，例如 +1 667 660 6667。'
      : 'Enter a complete phone number, including country code (for example +1 667 660 6667).';
    return <>
      <input {...props} ref={ref} type="tel" inputMode="tel" autoComplete={props.autoComplete ?? 'tel'} required={required}
        value={focused ? editing : (formatPhoneInput(raw) || '+1')}
        aria-invalid={error || props['aria-invalid']}
        aria-describedby={[props['aria-describedby'], error ? id : null].filter(Boolean).join(' ') || undefined}
        onFocus={e => { setEditing(e.currentTarget.value); setFocused(true); onFocus?.(e); }}
        onChange={e => {
          const next = e.currentTarget.value.normalize('NFKC');
          if (!/^[+\d\s().-]*$/.test(next) || (next.match(/\+/g)?.length ?? 0) > 1 || (next.includes('+') && !next.trimStart().startsWith('+'))) {
            e.currentTarget.setCustomValidity(message); setError(true); return;
          }
          // A bare default prefix is an empty optional field, not a phone number.
          const stored = next.trim() === '+1' ? '' : next;
          e.currentTarget.value = stored;
          setEditing(next); setInternal(stored); setError(false); e.currentTarget.setCustomValidity(''); onChange?.(e);
        }}
        onBlur={e => {
          setFocused(false);
          const invalid = raw.trim() ? !normalizePhoneE164(raw) : Boolean(required);
          setError(invalid); e.currentTarget.setCustomValidity(invalid ? message : '');
          onBlur?.(e);
        }} />
      {error && <span id={id} role="alert" className="mt-1 block text-xs text-red-600">{message}</span>}
    </>;
  },
);
