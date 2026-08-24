/**
 * 输入框。
 *
 * 高度 56px —— 和按钮同一条规矩。原来输入框是 2px 粗边 + 白底，
 * 那是为了在白卡上画出边界；现在改成**下沉底色 + 细边**，
 * 聚焦时才升到白底并加一圈焦点环，边界不再靠画粗线。
 */
import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 手机号、金额这类要逐位核对的，用等宽数字 */
  mono?: boolean;
}

export const Field = ({ className, mono, ...p }: FieldProps) => (
  <input
    className={cn(
      'min-h-tap w-full rounded border border-line-2 bg-sunken px-4 text-base font-medium',
      'transition-[border-color,box-shadow,background-color] duration-100',
      'placeholder:font-normal placeholder:text-ink-3',
      'focus:border-ink focus:bg-surface focus:outline-none focus:ring-[3px] focus:ring-ink/6',
      'disabled:opacity-50',
      mono && 'tnum',
      className,
    )}
    {...p}
  />
);
