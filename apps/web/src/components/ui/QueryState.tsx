import React from 'react';
import { AlertCircle, RotateCcw, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { PageSkeleton, type SkeletonLayout } from './Skeleton';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/LanguageContext';

export interface PageLoadingProps {
  title?: string;
  description?: string;
  className?: string;
  /**
   * 该页面的版式。给了就渲染对应形状的骨架屏，不给则退回居中转圈。
   *
   * 骨架屏比转圈多说一件事：**将要出现什么**。结构提前占位之后，数据到达时
   * 内容落进已有的格子里，而不是把整块界面重排一遍 —— 前台的手指往往已经
   * 停在她预期按钮出现的位置上。
   *
   * ⚠️ 形状必须与该页真实版式大致对齐。对不上的骨架比转圈更糟：它承诺了一个
   * 并不会出现的版式，数据到达时照样重排，中间还多骗了用户一次。
   */
  layout?: SkeletonLayout;
}

export function PageLoading({
  title,
  description,
  className,
  layout,
}: PageLoadingProps) {
  const { t } = useLanguage();
  const loadingTitle = title || t('loading') || 'Loading data...';
  const loadingDesc = description || 'Connecting to secure server and synchronizing data...';

  if (layout) {
    return (
      <div className={cn('w-full space-y-3', className)}>
        {/*
          骨架本身对读屏用户无意义（它没有内容），因此整块 aria-hidden，
          另起一行可见且可读的状态文案说明正在加载哪一块数据 ——
          转圈版本原本就有这句话，换成骨架屏不能把它丢掉。
        */}
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs font-medium text-slate-500">
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-teal-600" aria-hidden="true" />
          {loadingTitle}
        </p>
        <PageSkeleton layout={layout} />
      </div>
    );
  }

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
