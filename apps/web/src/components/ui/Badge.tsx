import * as React from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'success'
  | 'warning'
  | 'error'
  | 'destructive';

const STYLES: Record<BadgeVariant, string> = {
  default: 'bg-teal-50 text-teal-800 border-teal-200',
  secondary: 'bg-slate-100 text-slate-700 border-slate-200',
  outline: 'bg-transparent text-slate-600 border-slate-300',
  success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  warning: 'bg-amber-50 text-amber-900 border-amber-200',
  error: 'bg-red-50 text-red-800 border-red-200',
  destructive: 'bg-red-600 text-white border-transparent',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = 'default', children, ...props }: BadgeProps) {
  const variantClass = (variant && STYLES[variant]) ? STYLES[variant] : STYLES.default;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center font-medium rounded-full px-2 py-0.5 text-xs border transition-colors',
        variantClass,
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
