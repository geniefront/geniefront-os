/**
 * 测试用的「系统编排」入口（AUD-01）。
 *
 * ## 为什么必须有这么一个显式的东西
 *
 * 审计里那条 P0 之所以能潜伏到最后，根本原因不在代码，在**测试的写法**：
 * `billing.test.ts` 从一条真实的 owner membership 建 ctx，然后直接
 * `dispatch('billing.syncSubscription', …)` 二十几次，全绿。
 * 于是「老板能把自己写成 growth/active」这件事，在测试里长得和
 * 「Stripe webhook 把订阅状态同步下来」一模一样 ——
 * 而它们是两件完全不同的事，只是恰好走同一个函数。
 *
 * `TEST_DATA_AUDIT.md` 甚至把这个写法当成修复方案推广了一次
 * （giftcard 套件从裸 SQL 改成 dispatch），把洞洗成了规范。
 *
 * 所以这里不是一个语法糖，是一处**语义声明**：
 * 调用 `dispatchSystem` 就等于在说「这一步在生产里由服务端编排代码
 * 在核验完外部凭据之后执行，浏览器到不了这里」。
 * 而普通的 `dispatch` 留给租户真的能发起的那些命令。
 *
 * 两者在测试里分开，「租户能不能调这条命令」才重新变成一个
 * **测试有能力回答**的问题 —— `systemOnly.test.ts` 就是那个答案。
 */

import { dispatch, type DispatchOptions, type DispatchResult } from '../bus';
import type { CommandContext } from '@gf/contracts';

/** 生产里由 Stripe 验签 / 扣款回执 / 模型回执触发的那一类调用。 */
export function dispatchSystem<T = unknown>(
  commandName: string,
  input: unknown,
  ctx: CommandContext,
  opts: Omit<DispatchOptions, 'systemOrigin'> = {},
): Promise<DispatchResult<T>> {
  return dispatch<T>(commandName, input, ctx, {
    ...opts,
    systemOrigin: 'test_system_orchestrator',
  });
}
