/**
 * 全局 Toast 提示配置增强。
 *
 * 默认 HeroUI 的 Toast 超时时间仅为 4000ms（4 秒），在前台繁忙业务场景下极易
 * 造成错误信息（如排班冲突、必填校验）来不及看清便消失。
 *
 * 此处统一增强默认超时：
 * - 错误 / 危险 (danger)：8,000ms（8 秒），给操作员充足时间阅读原因并采取行动；
 * - 警告 (warning)：7,000ms（7 秒）；
 * - 成功 / 普通 (success / default / accent)：5,000ms（5 秒）；
 * - 若调用方显式传递了 timeout，则遵从调用方的指定值。
 */
import { toastQueue, toast as baseToast } from '@heroui/react';

const originalAdd = toastQueue.add.bind(toastQueue);

// Monkey-patch toastQueue.add 方法，赋予全局更人性化的展示时长
toastQueue.add = function (content: any, options?: any) {
  let timeout = options?.timeout;
  // HeroUI 默认 timeout 是 4000 或者未指定
  if (timeout === 4000 || timeout === undefined) {
    if (content?.variant === 'danger') {
      timeout = 8000;
    } else if (content?.variant === 'warning') {
      timeout = 7000;
    } else {
      timeout = 5000;
    }
  }
  return originalAdd(content, { ...options, timeout });
};

export { baseToast as toast, toastQueue };
