/**
 * 幂等键的回归护栏。
 *
 * 断言的是**语义**而不是实现：重试沿用、成功换新。
 * 写反了任何一边都有具体后果 —— 重试换新键会重复写入，成功不换键会让
 * 第二次真实操作被服务端当成重放丢掉，而后者不报错，只有对账时才发现。
 */
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAttemptKey } from './idempotency';

describe('useAttemptKey', () => {
  it('同一次意图内反复取到的是同一个键 —— 超时重按才能被服务端去重', () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = result.current.take();
    expect(result.current.take()).toBe(first);
    expect(result.current.take()).toBe(first);
  });

  it('落定之后换新键 —— 第二次真实操作不该被当成重放丢掉', () => {
    const { result } = renderHook(() => useAttemptKey());
    const first = result.current.take();
    act(() => { result.current.settle(); });
    expect(result.current.take()).not.toBe(first);
  });

  it('落定前后都返回合法的 uuid', () => {
    const { result } = renderHook(() => useAttemptKey());
    expect(result.current.take()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
