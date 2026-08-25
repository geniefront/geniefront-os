/**
 * 输入框。
 *
 * 高度 56px —— 和按钮同一条规矩。原来输入框是 2px 粗边 + 白底，
 * 那是为了在白卡上画出边界；现在改成**下沉底色 + 细边**，
 * 聚焦时才升到白底并加一圈焦点环，边界不再靠画粗线。
 */
import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from './cn';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 手机号、金额这类要逐位核对的，用等宽数字 */
  mono?: boolean;
  /**
   * ⚠️ React 19 里 `ref` 就是一个普通 prop（不再需要 forwardRef），
   * 但**类型上要自己声明** —— 少了这一行，`<Field ref={…}>` 只在
   * 类型检查时报错，运行时其实是通的，很容易被当成「React 的锅」。
   *
   * 要它的地方是真的要：客户搜索进屏就聚焦、按 `/` 回到搜索框（决策 18）。
   */
  ref?: Ref<HTMLInputElement>;
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
