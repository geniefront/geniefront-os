/**
 * 分段选择器 —— 「近 7 天 / 近 30 天」「全部 / 只看订上单的」这类。
 *
 * 为什么不用 `<select>`：这类选项**只有两三个，而且要一眼看全**。
 * 下拉框把「现在是哪一档」和「还有哪些档」藏进了一次点击之后，
 * 前台在忙的时候会反复点开确认自己选的是什么。
 *
 * ⚠️ 每一段都是 44px 起（`tap-sm`）。它常出现在页头右侧，
 * 属于「次要动作」那一档 —— 但仍然是要用手指点的。
 */

import { cn } from './cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** 右上角的数。0 不显示 —— 一个常年挂着 0 的角标只会让人忽略角标 */
  count?: number;
}

export function Segmented<T extends string>({
  value, onChange, options, className, ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  className?: string;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel}
         className={cn('inline-flex rounded-sm border border-line-2 bg-sunken p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex min-h-tap-sm items-center gap-1.5 rounded-sm px-3.5 text-xs font-semibold',
              'cursor-pointer transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
              on
                ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(15_15_15/0.08)]'
                : 'text-ink-2 hoverable:hover:text-ink',
            )}
          >
            {o.label}
            {o.count !== undefined && o.count > 0 && (
              <span className="tnum text-2xs text-ink-3">{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
