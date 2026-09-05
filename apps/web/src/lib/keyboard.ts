/**
 * 前台快捷键（q/c/r/）不得在输入中触发。
 *
 * HeroUI / contenteditable / role=textbox 的实际 keydown target
 * 不一定是 INPUT 节点本身，只判断 tagName 会把正在打字的前台送去看板。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]',
    ),
  );
}
