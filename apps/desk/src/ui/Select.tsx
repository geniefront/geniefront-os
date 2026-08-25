/**
 * 下拉选择。
 *
 * ⚠️ 用**原生 `<select>`**，不是 Radix 的那个。
 *
 * 原因只有一条，但它压倒别的：前台那台电脑常常是十年前的 Windows，
 * 而原生下拉的展开是**操作系统画的** —— 不受页面滚动、层级、
 * 焦点陷阱影响，也不会在低端机上掉帧。Radix 的 Select 好看，
 * 但它是一层 portal + 虚拟焦点，出问题时表现为「点了没反应」。
 *
 * 代价是样式可控范围小（选项列表长什么样由系统决定）。这一屏里
 * 下拉只出现在「题目类型」「回填到哪」这类地方，值得。
 */

import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(
          'min-h-tap w-full appearance-none rounded border border-line-2 bg-sunken',
          'pl-4 pr-10 text-base font-medium',
          'transition-[border-color,box-shadow,background-color] duration-100',
          'focus:border-ink focus:bg-surface focus:outline-none focus:ring-[3px] focus:ring-ink/6',
          'disabled:opacity-50',
          className,
        )}
        {...p}
      >
        {children}
      </select>
      <ChevronDown size={17}
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
    </div>
  );
}
