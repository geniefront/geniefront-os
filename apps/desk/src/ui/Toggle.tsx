/**
 * 勾选 / 开关。
 *
 * ⚠️ **不做纯色滑块开关。** 宪法第 11 条：状态不能只靠颜色表达
 * （色觉障碍 + 廉价 iPad 屏）。所以这里是「方框 + 对勾 + 一句文字」，
 * 关掉的时候方框是空的 —— 隔着一米也分得出来。
 *
 * 整行都可点（56px），不是只有那个小方框可点：前台戴着手套。
 */

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

export function Toggle({ checked, onChange, label, hint, disabled, className }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-tap w-full cursor-pointer items-center gap-3.5 rounded border px-4 py-3 text-left',
        'transition-colors disabled:pointer-events-none disabled:opacity-40',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        checked ? 'border-ink bg-surface' : 'border-line-2 bg-sunken hoverable:hover:border-ink-3/40',
        className,
      )}
    >
      <span className={cn(
        'grid size-6 shrink-0 place-items-center rounded-sm border',
        checked ? 'border-ink bg-ink text-white' : 'border-line-2 bg-surface',
      )}>
        {checked && <Check size={15} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-snug">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-3 leading-snug">{hint}</span>}
      </span>
    </button>
  );
}
