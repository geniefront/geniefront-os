import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/**
 * 通用标准文本输入框组件。
 * 具备整齐的边框、圆角、背景色、统一字号与全宽 Block 布局，
 * 避免外部 flex/inline 容器导致 label 与 input 产生黏连挤压问题。
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, type = 'text', ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "w-full block px-3 py-2 text-xs border border-slate-200 rounded-xl bg-white text-slate-900 shadow-none",
          "placeholder:text-slate-400 transition-all",
          "focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500",
          "disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed",
          className
        )}
        {...props}
      />
    );
  },
);

Input.displayName = 'Input';

