/**
 * 防抖的回归护栏。
 *
 * 这个 hook 的存在理由是「省请求」而不是「让渲染更顺」 ——
 * 因此断言的是**中间值不会被采纳**，而不是最终值对不对。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebounced } from './useDebounced';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useDebounced', () => {
  it('延迟未到时保持旧值 —— 逐字输入不会逐字发请求', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), {
      initialProps: { v: '1' },
    });
    rerender({ v: '12' });
    rerender({ v: '123' });
    expect(result.current).toBe('1');

    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current).toBe('1');
  });

  it('延迟到了取最后一个值，中间的几次全部丢弃', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), {
      initialProps: { v: '1' },
    });
    rerender({ v: '12' });
    rerender({ v: '1234' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe('1234');
  });
});
