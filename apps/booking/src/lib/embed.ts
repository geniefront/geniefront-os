const q = () => new URLSearchParams(location.search);

export const isEmbedded = (): boolean =>
  q().get('embed') === '1'
  || (() => { try { return window.self !== window.top; } catch { return true; } })();

export function reportHeight(): () => void {
  if (!isEmbedded()) return () => {};
  document.documentElement.style.height = 'auto';
  document.documentElement.classList.add('embed');

  let last = 0;
  const send = () => {
    const h = Math.ceil(Math.max(
      document.body.scrollHeight,
      document.querySelector('[data-shell]')?.getBoundingClientRect().height ?? 0,
    ));
    if (h <= 0) return;
    if (Math.abs(h - last) < 2) return;
    last = h;
    window.parent.postMessage({ type: 'gf-booking:height', height: h }, '*');
  };

  const ro = new ResizeObserver(send);
  ro.observe(document.body);
  const shell = document.querySelector('[data-shell]');
  if (shell) ro.observe(shell);
  const poll = setInterval(send, 250);
  const timers = [80, 300, 900, 2000].map((ms) => setTimeout(send, ms));
  window.addEventListener('load', send);
  send();
  return () => {
    ro.disconnect();
    window.removeEventListener('load',send);
    clearInterval(poll);
    timers.forEach(clearTimeout);
  };
}

/** Conversion ping for a parent website. Must never include PII or the manage token. */
export function bookedMessage(confirmationCode: string | null): { type: string; confirmationCode: string | null } {
  return { type: 'gf-booking:booked', confirmationCode };
}

export function reportBooked(confirmationCode: string | null): void {
  if (!isEmbedded()) return;
  window.parent.postMessage(bookedMessage(confirmationCode), '*');
}
