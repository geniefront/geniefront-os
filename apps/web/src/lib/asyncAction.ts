/**
 * 写操作的统一反馈与防重。
 *
 * 前台对一次点击的期待只有三件事：**知道点上了、知道成不成、失败了知道为什么。**
 * 缺任何一件，用户的应对方式都是再点一次 —— 而这正是重复开单、重复退款、
 * 重复发短信的来源。
 *
 * 本模块把这三件事收敛成一个调用：
 *
 * ```tsx
 * const save = useAsyncAction(
 *   async () => { await saveMutation.mutateAsync(input); },
 *   { success: t('saved') },
 * );
 * // ...
 * <GuardedButton permission="…" isPending={save.isRunning} onPress={save.run}>保存</GuardedButton>
 * ```
 *
 * ⚠️ 不要用 `mutation.isPending` 替代 `isRunning`：
 * 一个处理函数常常串起多个 mutation（先开单再开始计时），任何一个的
 * `isPending` 都只覆盖其中一段，段与段之间按钮会短暂恢复可点。
 */
import { useCallback, useRef, useState } from 'react';
import { toast } from './toast';
import { useErrorMessage } from './errorMessage';

export interface AsyncActionOptions<R> {
  /** 成功提示。给函数则可依据返回值组织文案；返回空串表示这次不提示。 */
  success?: string | ((result: R) => string);
  /**
   * 覆盖默认的错误文案。默认走 `useErrorMessage()`，它把服务端错误码翻成
   * 母语可执行文案 —— 除非本操作有更具体的说法，否则不要覆盖。
   */
  error?: (err: unknown) => string;
  /** 成功后的后续动作（关弹窗、清表单）。抛错不会被当成操作失败。 */
  onSuccess?: (result: R) => void;
}

export interface AsyncAction<Args extends unknown[]> {
  run: (...args: Args) => Promise<void>;
  /** 进行中。绑到按钮的 `isPending` 上，转圈与防重都由它驱动。 */
  isRunning: boolean;
}

export function useAsyncAction<Args extends unknown[], R>(
  action: (...args: Args) => Promise<R>,
  options: AsyncActionOptions<R> = {},
): AsyncAction<Args> {
  const [isRunning, setIsRunning] = useState(false);
  /*
   * ref 与 state 两者都要。`setIsRunning(true)` 要等下一次渲染才反映到按钮上，
   * 而快速连击的两次 press 可能落在同一批更新里 —— 那时按钮还没禁用。
   * ref 是同步写入的，第二次调用立刻在这里被挡下。
   */
  const runningRef = useRef(false);
  const toMessage = useErrorMessage();

  const { success, error, onSuccess } = options;

  const run = useCallback(
    async (...args: Args) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setIsRunning(true);
      try {
        const result = await action(...args);
        const message = typeof success === 'function' ? success(result) : success;
        if (message) toast.success(message);
        onSuccess?.(result);
      } catch (err) {
        toast.danger(error ? error(err) : toMessage(err));
      } finally {
        runningRef.current = false;
        setIsRunning(false);
      }
    },
    [action, success, error, onSuccess, toMessage],
  );

  return { run, isRunning };
}
