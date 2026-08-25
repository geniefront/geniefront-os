/**
 * 转圈。**只用在按钮里**，表示「这一下正在发出去」。
 *
 * ⚠️ 不要拿它当整页的加载态 —— 那是 `<Loading>`。
 * 一个转圈的圈不告诉人在等什么，而前台等超过两秒就会再点一次；
 * 按钮里的转圈之所以够用，是因为按钮上的字已经说了在干什么。
 */
import { cn } from './cn';

export const Spinner = ({ className }: { className?: string }) => (
  <span
    aria-hidden
    className={cn(
      'inline-block size-4 shrink-0 animate-spin rounded-full',
      'border-2 border-current border-t-transparent opacity-70',
      className,
    )}
  />
);
