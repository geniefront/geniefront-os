/**
 * 「正在加载」。
 *
 * ⚠️ 这里刻意**不做骨架屏**。骨架屏在这个产品上是负收益：
 * 前台那台电脑常常很慢，一屏假的灰条闪几秒之后才被真数据替换，
 * 她会以为界面已经出来了、伸手就点 —— 点在一条还不存在的预约上。
 * 一句「正在加载」不会被误当成内容。
 */
import { cn } from './cn';

export function Loading({ label = '正在加载…', className }: {
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite"
         className={cn('grid min-h-[40vh] place-items-center p-6 text-sm text-ink-3', className)}>
      {label}
    </div>
  );
}
