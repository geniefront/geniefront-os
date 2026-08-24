/**
 * Turnstile 挂载（docs/13 §6.1）。
 *
 * ## 三个坑，全在这个文件里
 *
 * 1. **脚本只能加载一次。** React 严格模式下 effect 会跑两遍，
 *    第二遍再插一个 `<script>` 会让 widget 渲染两次、拿到两个 token，
 *    而交上去的那个多半已经作废
 * 2. **token 用过即废、约 5 分钟过期。** 提交失败要重试时必须先 `reset()`
 *    拿一个新的 —— 拿旧的重试会一直 400 `bot_check_failed`，
 *    而那时候真正的原因（时段被抢走）已经被这个 400 盖掉了
 * 3. **site key 是从 `/shop` 拿的**，不是编译进来的。同一份预约页要
 *    服务所有门店，而 key 在服务端那边配着
 */

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => {
      // onload 时 window.turnstile 偶尔还没挂上，等一帧
      const tick = (n: number) => {
        if (window.turnstile) return resolve(window.turnstile);
        if (n <= 0) return reject(new Error('turnstile 没有挂到 window 上'));
        requestAnimationFrame(() => tick(n - 1));
      };
      tick(30);
    };
    el.onerror = () => reject(new Error('turnstile 脚本加载失败'));
    document.head.appendChild(el);
  });
  return loading;
}
