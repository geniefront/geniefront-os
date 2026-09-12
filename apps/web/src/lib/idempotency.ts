import { useCallback, useRef } from 'react';

/**
 * 幂等键的生命周期：**一次意图一个键**。
 *
 * 门店的网不稳，超时是常态，而超时**不代表没写进去** —— 请求可能已经落库，
 * 只是回程丢了。前台看到报错会再按一次，这时唯一能防住重复写入的就是幂等键。
 *
 * ⚠️ 因此键**不能在 `mutationFn` 里现生成**。那样每次重按都是一个新键，
 * 服务端看到的是两条互不相干的命令，`idempotency: 'required'` 形同虚设 ——
 * 发现金小费会发两遍，派单会派两次。
 *
 * 本 hook 给的语义是：
 *
 *   第一次调用      → 生成键
 *   失败后再调用    → **沿用同一个键**（这正是重试，服务端据此去重）
 *   成功后再调用    → 换新键（这是另一次意图，本来就该写第二条）
 *
 * 与页面上已有的 `attemptKey` / `seatAttempt` 是同一个思路，只是收成了一处。
 */
export function useAttemptKey(): { take: (intent?: unknown) => string; settle: (intent?: unknown) => void } {
  const keyRef = useRef(new Map<string, string>());

  const take = useCallback((intent?: unknown) => {
    const fingerprint = JSON.stringify(intent) ?? 'default';
    const key = keyRef.current.get(fingerprint) ?? crypto.randomUUID();
    keyRef.current.set(fingerprint, key);
    return key;
  }, []);

  /** 本次意图已经落定（成功），下一次调用应当拿到新键。 */
  const settle = useCallback((intent?: unknown) => { keyRef.current.delete(JSON.stringify(intent) ?? 'default'); }, []);

  return { take, settle };
}
