import React from 'react';
import { AlertCircle, RotateCcw, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';

export interface PageLoadingProps {
  title?: string;
  description?: string;
  className?: string;
}

export function PageLoading({
  title,
  description,
  className,
}: PageLoadingProps) {
  const { t } = useLanguage();
  const loadingTitle = title || t('loading') || 'Loading data...';
  const loadingDesc = description || 'Connecting to secure server and synchronizing data...';

  return (
    <div
      className={cn(
        'min-h-[420px] flex flex-col items-center justify-center p-8 text-center space-y-4 animate-fade-in',
        className
      )}
    >
      <div className="relative">
        <div className="w-14 h-14 rounded-2xl bg-teal-50 border border-teal-100 flex items-center justify-center shadow-xs">
          <RefreshCw className="w-7 h-7 text-teal-600 animate-spin" />
        </div>
        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-white flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
        </div>
      </div>
      <div className="space-y-1 max-w-sm">
        <h3 className="text-sm sm:text-base font-bold text-slate-800 tracking-tight">{loadingTitle}</h3>
        <p className="text-xs text-slate-500 leading-relaxed">{loadingDesc}</p>
      </div>
    </div>
  );
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
