/**
 * 骨架屏的回归护栏。
 *
 * 两条约定：骨架本身对读屏用户不可见（它没有内容），但**说明正在加载什么的
 * 那句话必须保留** —— 从转圈换成骨架屏时最容易顺手丢掉的就是它。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageLoading } from './QueryState';
import { PageSkeleton, type SkeletonLayout } from './Skeleton';
import { LanguageProvider } from '@/LanguageContext';

const LAYOUTS: SkeletonLayout[] = ['board', 'list', 'table', 'cards', 'detail', 'calendar'];

describe('PageSkeleton', () => {
  it.each(LAYOUTS)('%s 版式渲染出占位块，且整块对读屏隐藏', (layout) => {
    const { container } = render(<PageSkeleton layout={layout} />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('PageLoading', () => {
  it('兼容旧版式参数，并保留统一加载器的可读状态文案', () => {
    render(
      <LanguageProvider>
        <PageLoading layout="board" title="正在同步运营看板" />
      </LanguageProvider>,
    );

    const status=screen.getByRole('status');
    expect(status).toHaveTextContent('正在同步运营看板');
    expect(status).not.toHaveAttribute('aria-hidden','true');
  });

  it('没给版式时退回原有的居中转圈，行为不变', () => {
    const { container } = render(
      <LanguageProvider>
        <PageLoading title="正在同步运营看板" />
      </LanguageProvider>,
    );

    /*
     * 不能拿 `.animate-pulse` 的数量判定 —— 转圈版本自己就有一个脉冲小圆点。
     * 判定依据用骨架的容器：只有骨架分支才渲染 aria-hidden 的整块占位。
     */
    expect(container.querySelector('[aria-hidden="true"] .animate-pulse')).toBeNull();
    expect(screen.getByText('正在同步运营看板')).toBeInTheDocument();
  });
});
