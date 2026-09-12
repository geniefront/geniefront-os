import { useEffect, useState } from 'react';

/**
 * 防抖取值。用于「边打字边查服务端」。
 *
 * 不用 `useDeferredValue`：它只在渲染压力下让步，**不减少请求次数** ——
 * 而这里要省的正是请求。前台输入手机后四位时，逐字发四次查询对门店那条网
 * 是实打实的负担，而前三次的结果她一眼都不会看。
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
