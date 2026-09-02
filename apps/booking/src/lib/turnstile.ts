const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export interface TurnstileApi {
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
      const tick = (n: number) => {
        if (window.turnstile) return resolve(window.turnstile);
        if (n <= 0) return reject(new Error('turnstile missing'));
        requestAnimationFrame(() => tick(n - 1));
      };
      tick(30);
    };
    el.onerror = () => reject(new Error('turnstile failed to load'));
    document.head.appendChild(el);
  });
  return loading;
}
