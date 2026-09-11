import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isStandaloneApp, useGoBack, useOpenInternalRoute } from './navigation';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

function mockStandalone(standalone: boolean) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: standalone } as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
  navigate.mockReset();
});

describe('useOpenInternalRoute', () => {
  it('独立窗口下压入当前历史栈，不开新标签页', () => {
    mockStandalone(true);
    const open = vi.spyOn(window, 'open');
    renderHook(() => useOpenInternalRoute()).result.current('/print/service-brief/t1');
    expect(open).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/print/service-brief/t1');
  });

  it('浏览器标签页环境下仍开新标签页', () => {
    mockStandalone(false);
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    renderHook(() => useOpenInternalRoute()).result.current('/print/service-brief/t1');
    expect(open).toHaveBeenCalledWith('/print/service-brief/t1', '_blank', 'noopener');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('新标签页被拦截时退回站内跳转，而不是静默无反应', () => {
    mockStandalone(false);
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderHook(() => useOpenInternalRoute()).result.current('/print/service-brief/t1');
    expect(navigate).toHaveBeenCalledWith('/print/service-brief/t1');
  });
});

describe('useGoBack', () => {
  it('有站内历史时原路退回', () => {
    window.history.replaceState({ idx: 3 }, '');
    renderHook(() => useGoBack('/queue')).result.current();
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it('冷启动直接进入该页面时退回兜底路由，而不是退出应用', () => {
    window.history.replaceState({ idx: 0 }, '');
    renderHook(() => useGoBack('/queue')).result.current();
    expect(navigate).toHaveBeenCalledWith('/queue', { replace: true });
  });

  it('历史状态缺失（外部直接打开）同样走兜底路由', () => {
    window.history.replaceState(null, '');
    renderHook(() => useGoBack('/queue')).result.current();
    expect(navigate).toHaveBeenCalledWith('/queue', { replace: true });
  });
});

describe('isStandaloneApp', () => {
  it('iOS 的 navigator.standalone 也算独立窗口', () => {
    mockStandalone(false);
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
    expect(isStandaloneApp()).toBe(true);
    Reflect.deleteProperty(window.navigator, 'standalone');
  });
});
