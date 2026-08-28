/**
 * 崩溃兜底页的行为约束。
 *
 * ⚠️ 崩溃页是最不该出现单一语言的地方：门店里遇到崩溃的往往是非中文母语的
 * 前台，一屏读不懂的文字既没有指引作用，也让人无法判断该不该继续操作。
 * 本文件同时锁住「页面崩溃不会波及整个应用」这一前提。
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LanguageProvider } from '@/LanguageContext';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('boom: ticket payload malformed');
}

beforeEach(() => {
  localStorage.clear();
  // 边界捕获时 React 与组件本身都会打日志，测试中不必让它们污染输出
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('未出错时原样渲染子节点', () => {
    render(
      <LanguageProvider>
        <ErrorBoundary>
          <p>正常内容</p>
        </ErrorBoundary>
      </LanguageProvider>,
    );
    expect(screen.getByText('正常内容')).toBeInTheDocument();
  });

  it('子树抛错时呈现兜底页而非整页白屏', () => {
    render(
      <LanguageProvider>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </LanguageProvider>,
    );
    expect(screen.getByText('页面加载时遇到异常')).toBeInTheDocument();
    // 具体报错原文保留给排查用，但不作为主要信息呈现
    expect(screen.getByText(/ticket payload malformed/)).toBeInTheDocument();
  });

  it('兜底页跟随界面语言，而非固定一种语言', () => {
    localStorage.setItem('gf.lang', 'en');
    render(
      <LanguageProvider>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </LanguageProvider>,
    );
    expect(screen.getByText('Error Loading Page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('调用方传入的标题走文案 key，随语言切换', () => {
    // 传成品字符串会让标题停留在传入时的语言，因此接口收的是 key
    localStorage.setItem('gf.lang', 'en');
    render(
      <LanguageProvider>
        <ErrorBoundary fallbackTitleKey="rotation">
          <Boom />
        </ErrorBoundary>
      </LanguageProvider>,
    );
    expect(screen.getByText('Rotation')).toBeInTheDocument();
  });

  it('未传标题 key 时使用通用兜底标题', () => {
    render(
      <LanguageProvider>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </LanguageProvider>,
    );
    expect(screen.getByText('页面加载时遇到异常')).toBeInTheDocument();
  });
});
