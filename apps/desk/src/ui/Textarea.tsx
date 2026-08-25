/**
 * 多行输入。规矩和 Field 一样：下沉底色 + 细边，聚焦时升到白底。
 *
 * ⚠️ `rows` 默认 3 而不是浏览器默认的 2 —— 两行的框看起来像个坏掉的
 * 单行输入框，前台会以为自己点错了地方。
 */
import type { TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

export const Textarea = ({ className, rows = 3, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    rows={rows}
    className={cn(
      'w-full rounded border border-line-2 bg-sunken px-4 py-3 text-base font-medium leading-relaxed',
      'transition-[border-color,box-shadow,background-color] duration-100',
      'placeholder:font-normal placeholder:text-ink-3',
      'focus:border-ink focus:bg-surface focus:outline-none focus:ring-[3px] focus:ring-ink/6',
      'disabled:opacity-50',
      className,
    )}
    {...p}
  />
);
