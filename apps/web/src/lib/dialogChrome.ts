import { useEffect, useRef } from 'react';

/**
 * 自制浮层的键盘与读屏行为。
 *
 * 绝大多数弹窗走 `components/ui/Modal`（HeroUI / react-aria 已经把这些做完了）。
 * 但少数浮层出于版式需要是手写的 `<div className="fixed inset-0">` ——
 * 那样的浮层**在视觉上是弹窗，在键盘和读屏上什么都不是**：
 *
 *   · 读屏用户不知道弹窗打开了（没有 role="dialog" / aria-modal）
 *   · 焦点仍留在背后的页面上，Tab 会走进被遮住的内容里
 *   · 按 Esc 关不掉 —— 而这个应用里其他每一个弹窗都能
 *
 * 本 hook 补齐这三件事：绑定 Esc、把焦点收进浮层并锁在里面、关闭后归还焦点。
 *
 * ⚠️ ARIA 属性要调用方自己写在容器上（`role="dialog"` `aria-modal="true"`
 * `aria-labelledby`）—— 标题在哪只有调用方知道，这里不猜。
 */
export function useDialogChrome(isOpen: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    restoreRef.current = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((el) => {
      /*
       * 可见性不用 `offsetParent !== null` 判 —— 它依赖真实布局，
       * 在 jsdom 里恒为 null，会让这套逻辑在测试里变成「永远没有可聚焦元素」，
       * 于是护栏本身失效而没人发现。
       */
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    /* 打开时把焦点送进去。没有可聚焦元素就聚到容器本身，读屏才会念出标题 */
    const first = focusables()[0] ?? containerRef.current;
    first?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) { event.preventDefault(); return; }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;

      /* 到头了就绕回去 —— 不绕的话 Tab 会走进被遮住的页面里 */
      if (event.shiftKey && (active === firstItem || !containerRef.current?.contains(active))) {
        event.preventDefault(); lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault(); firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [isOpen, onClose]);

  return containerRef;
}
