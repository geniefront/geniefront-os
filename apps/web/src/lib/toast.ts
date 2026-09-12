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

/*
 * ⚠️ 这是一次 monkey patch，且必须容忍队列不存在。
 *
 * 本模块唯一的职责是把默认展示时长改得更宽松。当 `@heroui/react` 被测试替身
 * 取代、而替身没有提供 `toastQueue` 时，正确的行为是**什么都不做** —— 没有
 * 队列可改并不是错误。此前这里直接取 `toastQueue.add` 会在模块加载期抛错，
 * 于是任何一个 mock 了 HeroUI 的测试，只要其被测组件间接引用到 toast，
 * 整个测试文件就会以一条与被测行为毫不相干的错误失败。
 */
try {
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
} catch {
  /*
   * 队列不可用时保持默认时长即可。
   *
   * 用 try/catch 而不是 `toastQueue?.add` 判空：Vitest 的模块替身在**读取**
   * 未声明的导出时就会抛错，可选链一样会踩上去。捕获之后，测试只需按自己关心
   * 的范围去 mock HeroUI，不必为了一个与被测行为无关的 monkey patch 补全导出。
   */
}

export { baseToast as toast, toastQueue };
