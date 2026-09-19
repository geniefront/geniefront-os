import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { LanguageProvider } from '@/LanguageContext';
import { Activate } from './Activate';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ hash: '', pathname: '/activate' }),
  };
});

const mockSessionState = {
  session: {
    user: { id: 'user-1', email: 'owner@maildrop.cc' },
  } as any,
  claimable: {
    locationId: 'loc-1',
    shopName: 'Lotus Spa',
    plan: 'growth',
  },
  claimStore: vi.fn().mockResolvedValue(undefined),
  reloadLocations: vi.fn().mockResolvedValue(undefined),
  membership: null as any,
};

vi.mock('@/lib/session', () => ({
  useSession: () => mockSessionState,
}));

const mockUpdateUser = vi.fn().mockResolvedValue({ error: null });
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      updateUser: (...args: unknown[]) => mockUpdateUser(...args),
    },
  },
}));

function renderComponent() {
  return render(
    <BrowserRouter>
      <LanguageProvider>
        <Activate />
      </LanguageProvider>
    </BrowserRouter>
  );
}

describe('Activate 首次开店与密码设置页面', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = {
      user: { id: 'user-1', email: 'owner@maildrop.cc' },
    } as any;
    mockSessionState.claimable = {
      locationId: 'loc-1',
      shopName: 'Lotus Spa',
      plan: 'growth',
    };
    mockSessionState.membership = null;
    mockUpdateUser.mockResolvedValue({ error: null });
  });

  it('展示待开通的门店名称、邮箱账号与密码设置表单', () => {
    renderComponent();

    expect(screen.getByText('Lotus Spa')).toBeInTheDocument();
    expect(screen.getByText('设置店主账号密码')).toBeInTheDocument();
    expect(screen.getByDisplayValue('owner@maildrop.cc')).toBeInTheDocument();
    expect(screen.getByLabelText(/店主姓名/)).toHaveValue('owner');
  });

  it('当两次密码不一致时进行拦截提示', async () => {
    renderComponent();

    const passwordInput = screen.getByLabelText(/^密码/);
    const confirmInput = screen.getByLabelText(/确认密码/);
    const submitBtn = screen.getByRole('button', { name: /设置密码并进入开店向导/ });

    fireEvent.change(passwordInput, { target: { value: 'password123' } });
    fireEvent.change(confirmInput, { target: { value: 'different123' } });
    fireEvent.click(submitBtn);

    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSessionState.claimStore).not.toHaveBeenCalled();
  });

  it('清空店主姓名后不会被邮箱前缀填回，并会提交空值', async () => {
    renderComponent();

    const nameInput = screen.getByLabelText(/店主姓名/);
    fireEvent.change(nameInput, { target: { value: '' } });
    await waitFor(() => expect(nameInput).toHaveValue(''));

    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText(/确认密码/), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /设置密码并进入开店向导/ }));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({
        password: 'secret123',
        data: { full_name: '' },
      });
    });
  });

  it('提交成功后依次设置密码、认领门店并导向 /setup 向导', async () => {
    renderComponent();

    const passwordInput = screen.getByLabelText(/^密码/);
    const confirmInput = screen.getByLabelText(/确认密码/);
    const submitBtn = screen.getByRole('button', { name: /设置密码并进入开店向导/ });

    fireEvent.change(passwordInput, { target: { value: 'secret123' } });
    fireEvent.change(confirmInput, { target: { value: 'secret123' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({
        password: 'secret123',
        data: { full_name: 'owner' },
      });
      expect(mockSessionState.claimStore).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/setup', { replace: true });
    });
  });

  it('认领失败时不显示成功也不跳进向导', async () => {
    mockSessionState.claimStore.mockRejectedValueOnce(new Error('claim failed'));
    renderComponent();

    fireEvent.change(screen.getByLabelText(/^密码/), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText(/确认密码/), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /设置密码并进入开店向导/ }));

    await waitFor(() => expect(mockSessionState.claimStore).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalledWith('/setup', { replace: true });
  });

  it('若已经是 setup 状态的门店，自动跳转至向导', async () => {
    mockSessionState.membership = {
      membershipId: 'mem-1',
      locationStatus: 'setup',
    };

    renderComponent();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/setup', { replace: true });
    });
  });
});
