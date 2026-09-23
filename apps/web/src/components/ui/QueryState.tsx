import React from 'react';
import { AlertCircle, RotateCcw, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import type { SkeletonLayout } from './Skeleton';
import { LoadingSpinner } from './LoadingSpinner';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';

export interface PageLoadingProps {
  title?: string;
  description?: string;
  className?: string;
  /** Retained for caller compatibility; loading uses one consistent spinner. */
  layout?: SkeletonLayout;
}

export function PageLoading({ title, className }: PageLoadingProps) {
  return <div className={cn('flex min-h-48 w-full items-center justify-center p-8', className)}>
    <LoadingSpinner label={title} />
  </div>;
}

export interface PageErrorProps {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

export function PageError({
  title,
  error,
  onRetry,
  className,
}: PageErrorProps) {
  const { t } = useLanguage();
  const errorTitle = title || t('loadFailed') || 'Failed to load data';

  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as any).message)
      : error
      ? String(error)
      : 'Network timeout or service unavailable. Please check your connection.';

  return (
    <div
      className={cn(
        'min-h-[400px] flex items-center justify-center p-6 bg-slate-50/50 rounded-3xl animate-fade-in',
        className
      )}
    >
      <div className="max-w-md w-full p-6 sm:p-8 bg-white rounded-3xl border border-red-200/90 shadow-lg space-y-5 text-center">
        <div className="w-14 h-14 rounded-2xl bg-red-50 text-red-600 mx-auto flex items-center justify-center border border-red-100 shadow-xs">
          <AlertCircle className="w-7 h-7" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-base font-bold text-slate-900 tracking-tight">{errorTitle}</h3>
          <p className="text-xs text-slate-500 leading-relaxed">
            Unable to retrieve the latest data from server.
          </p>
        </div>

        {errorMessage && (
          <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 text-left font-mono text-[11px] text-red-700 break-all max-h-32 overflow-y-auto custom-scrollbar">
            {errorMessage}
          </div>
        )}

        <div className="flex items-center justify-center gap-3 pt-2">
          {onRetry && (
            <Button
              size="sm"
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1.5 text-xs px-5 py-2 rounded-xl shadow-sm"
              onClick={onRetry}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('retry')}</span>
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
            className="gap-1.5 font-bold text-xs px-4 py-2 rounded-xl"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            <span>{t('reload') || 'Reload'}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface SectionErrorProps {
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

/**
 * 区块级加载失败。
 *
 * `PageError` 占整页，只适合「这一页什么都没取到」。列表、面板、抽屉里的
 * 局部请求失败需要一个体量相称的呈现 —— 否则常见的写法是干脆不处理，
 * 于是**加载失败与「暂无数据」长得一模一样**：用户据此认定店里今天没有
 * 通知、没有待办、没有单据，而实际上只是请求挂了。
 *
 * 因此这里必须与空状态明确区分：红色、说明失败、并给出重试。
 */
export function SectionError({ error, onRetry, className }: SectionErrorProps) {
  const { t } = useLanguage();
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : null;

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-center',
        className,
      )}
      role="alert"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-600">
        <AlertCircle className="h-5 w-5" />
      </div>
      <p className="text-sm font-bold text-slate-800">{t('loadFailed') || 'Failed to load data'}</p>
      {detail && <p className="max-w-sm break-all font-mono text-[11px] text-slate-400">{detail}</p>}
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-1 gap-1.5 text-xs font-bold" onClick={onRetry}>
          <RotateCcw className="h-3.5 w-3.5" />
          <span>{t('retry')}</span>
        </Button>
      )}
    </div>
  );
}
