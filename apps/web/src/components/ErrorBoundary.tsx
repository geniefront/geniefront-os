import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RotateCcw, Home } from 'lucide-react';
import { Button } from './ui/Button';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';

interface Props {
  children: ReactNode;
  /**
   * 崩溃页标题所用的文案 key。
   *
   * ⚠️ 接受的是 key 而非成品字符串：错误边界是类组件，无法使用 hook 取词，
   * 若由调用方传入已翻译的文本，取词时机会早于用户切换语言，
   * 且各页面各自硬编码一份标题的做法此前已导致整块崩溃页停留在单一语言。
   */
  fallbackTitleKey?: TranslationKey;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * 崩溃页的呈现部分。
 *
 * 拆成函数组件仅为取用 `useLanguage()` —— 错误边界本身必须是类组件
 * （`getDerivedStateFromError` 无对应 hook），而崩溃提示同样需要跟随界面语言：
 * 门店里看到崩溃页的往往是非中文母语的前台，一屏英文对他们没有指引作用。
 */
function ErrorFallback({
  titleKey,
  error,
  onReset,
}: {
  titleKey?: TranslationKey;
  error: Error | null;
  onReset: () => void;
}) {
  const { t } = useLanguage();

  return (
    <div className="min-h-[400px] flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-md w-full p-6 bg-white rounded-3xl border border-red-200 shadow-lg space-y-4 text-center">
        <div className="w-12 h-12 rounded-2xl bg-red-50 text-red-600 mx-auto flex items-center justify-center border border-red-100">
          <AlertCircle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-bold text-slate-900">
            {t(titleKey ?? 'errorBoundaryFallback')}
          </h3>
          <p className="text-xs text-slate-500 leading-relaxed">{t('errorBoundaryDesc')}</p>
        </div>

        {error && (
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-left font-mono text-[11px] text-red-700 break-all max-h-32 overflow-y-auto">
            {error.message || String(error)}
          </div>
        )}

        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              window.location.href = '/dashboard';
            }}
            className="gap-1.5 font-bold text-xs"
          >
            <Home className="w-3.5 h-3.5 text-slate-500" />
            <span>{t('dashboard')}</span>
          </Button>
          <Button
            size="sm"
            className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1.5 text-xs"
            onClick={onReset}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('reload')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          titleKey={this.props.fallbackTitleKey}
          error={this.state.error}
          onReset={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}
