import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * 该字段的校验错误。
   *
   * 传入后输入框转为错误态（红框 + `aria-invalid`），读屏用户与视觉用户同时
   * 得到「是这一格出了问题」的信息。传字符串时会连带渲染出错误文案，传
   * `true` 则只标红 —— 后者用于错误文案由外部统一排版的场景。
   */
  error?: string | boolean;
}

/**
 * 通用标准文本输入框组件。
 * 具备整齐的边框、圆角、背景色、统一字号与全宽 Block 布局，
 * 避免外部 flex/inline 容器导致 label 与 input 产生黏连挤压问题。
 *
 * ⚠️ **校验失败不要只弹 toast。** toast 几秒后消失，且不指明是哪一格；
 * 在设置页的项目编辑、营销页的套餐表单这类十几个字段的表单里，用户读完
 * 「名称不能为空」之后依然要自己去找是哪个名称。错误必须落到字段本身上，
 * 用本组件的 `error` 配合 `lib/formFeedback` 的 `useFieldErrors`。
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, type = 'text', error, id, ...props }, ref) {
    const hasError = Boolean(error);
    const message = typeof error === 'string' && error ? error : null;
    const reactId = React.useId();
    const errorId = message ? `${id ?? reactId}-error` : undefined;

    const field = (
      <input
        ref={ref}
        type={type}
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={errorId ?? props['aria-describedby']}
        className={cn(
          "block min-h-10 w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-900 shadow-none",
          "placeholder:text-slate-400 transition-all",
          "disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed",
          hasError
            ? "border-red-400 focus:border-red-500 focus:outline-none focus:ring-3 focus:ring-red-500/15"
            : "border-slate-300 focus:border-teal-600 focus:outline-none focus:ring-3 focus:ring-teal-500/12",
          className
        )}
        {...props}
      />
    );

    if (!message) return field;

    return (
      <>
        {field}
        <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-red-600">
          {message}
        </p>
      </>
    );
  },
);

Input.displayName = 'Input';
