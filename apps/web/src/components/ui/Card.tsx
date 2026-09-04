/**
 * HeroUI Card 的适配层。模板用的是扁平命名（CardHeader/CardTitle/CardContent），
 * HeroUI 是复合组件（Card.Header/...）。这里把扁平名字映射过去，页面不用改。
 */
import * as React from 'react';
import { Card as HeroCard } from '@heroui/react';
import { cn } from '@/lib/utils';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export const Card = React.forwardRef<HTMLDivElement, React.ComponentProps<typeof HeroCard>>(
  function Card({ className, ...props }, ref) {
    return (
      <HeroCard
        ref={ref}
        className={cn('rounded-2xl border border-slate-200 bg-white shadow-[var(--gf-shadow)]', className)}
        {...props}
      />
    );
  },
);

export const CardHeader = React.forwardRef<HTMLDivElement, DivProps>(
  function CardHeader({ className, ...props }, ref) {
    return <HeroCard.Header ref={ref} className={cn('gap-1 p-5 sm:p-6', className)} {...props} />;
  },
);

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return <HeroCard.Title ref={ref} className={cn('text-base font-semibold tracking-tight text-slate-950', className)} {...props} />;
  },
);

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function CardDescription({ className, ...props }, ref) {
    return <HeroCard.Description ref={ref} className={cn('text-sm leading-5 text-slate-500', className)} {...props} />;
  },
);

export const CardContent = React.forwardRef<HTMLDivElement, DivProps>(
  function CardContent({ className, ...props }, ref) {
    return <HeroCard.Content ref={ref} className={cn('p-5 pt-0 sm:p-6 sm:pt-0', className)} {...props} />;
  },
);

export const CardFooter = React.forwardRef<HTMLDivElement, DivProps>(
  function CardFooter({ className, ...props }, ref) {
    return <HeroCard.Footer ref={ref} className={cn(className)} {...props} />;
  },
);
