import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { LanguageProvider } from '@/LanguageContext';
import { NoMembership } from './NoMembership';

const mockSessionState = {
  signOut: vi.fn().mockResolvedValue(undefined),
  reloadLocations: vi.fn().mockResolvedValue(undefined),
  claimable: null as any,
  claimStore: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/lib/session', () => ({
  useSession: () => mockSessionState,
}));

function renderComponent() {
  return render(
    <BrowserRouter>
      <LanguageProvider>
        <NoMembership />
      </LanguageProvider>
    </BrowserRouter>
  );
}

describe('NoMembership 页面待开通门店感知与引导', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.claimable = null;
  });

  it('当无待开通门店时，渲染无权限空状态与退出按钮', () => {
    renderComponent();

    expect(screen.getByText('当前账号没有可用门店')).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
    expect(screen.getByText('退出登录')).toBeInTheDocument();
  });

  it('当存在已付费待开通门店时，渲染待开通卡片并支持一键开通', async () => {
    mockSessionState.claimable = {
      locationId: 'loc-new-1',
      shopName: 'Green Lotus Nails',
      plan: 'essential',
    };

    renderComponent();

    expect(screen.getByText('发现待开通的门店')).toBeInTheDocument();
    expect(screen.getAllByText('Green Lotus Nails')).toHaveLength(2);
    expect(screen.getByText('essential Plan')).toBeInTheDocument();

    const claimBtn = screen.getByRole('button', { name: /立即开通门店/ });
    fireEvent.click(claimBtn);

    await waitFor(() => {
      expect(mockSessionState.claimStore).toHaveBeenCalled();
    });
  });
});
