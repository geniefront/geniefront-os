import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/LanguageContext';
import { Support } from './Support';

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  danger: vi.fn(),
}));

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast };
});

vi.mock('@/lib/session', () => ({
  useSession: () => ({ membershipId: 'mem-1', status: 'ready', can: () => true }),
}));

vi.mock('@/features/support/api', () => ({
  useSubmitSupportRequest: () => ({ mutateAsync, isPending: false }),
}));

function renderPage() {
  return render(
    <LanguageProvider>
      <Support />
    </LanguageProvider>,
  );
}

describe('Support submission surface', () => {
  beforeEach(() => {
    toast.success.mockReset();
    toast.danger.mockReset();
    mutateAsync.mockReset();
  });

  it('submits subject, message, and category through support.submitRequest', async () => {
    mutateAsync.mockResolvedValue({
      requestId: '11111111-1111-4111-8111-111111111111',
      status: 'open',
      createdAt: '2026-08-30T16:00:00.000Z',
    });
    renderPage();
    await userEvent.type(screen.getByRole('textbox', { name: '主题' }), 'Need help');
    await userEvent.type(screen.getByRole('textbox', { name: '说明' }), 'The desk printer is offline.');
    await userEvent.click(screen.getByRole('button', { name: '提交请求' }));
    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mutateAsync.mock.calls[0]![0]).toEqual(expect.objectContaining({
      category: 'general',
      subject: 'Need help',
      description: 'The desk printer is offline.',
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    }));
    expect(toast.success).toHaveBeenCalled();
    expect(screen.getByText('支持请求已提交。')).toBeInTheDocument();
  });

  it('rapid double-click issues one submit with one idempotency key', async () => {
    let resolveFirst!: (value: unknown) => void;
    mutateAsync.mockImplementation(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    renderPage();
    await userEvent.type(screen.getByRole('textbox', { name: '主题' }), 'Need help');
    await userEvent.type(screen.getByRole('textbox', { name: '说明' }), 'The desk printer is offline.');
    const button = screen.getByRole('button', { name: '提交请求' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const key = mutateAsync.mock.calls[0]![0].idempotencyKey as string;
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
    resolveFirst({
      requestId: '11111111-1111-4111-8111-111111111111',
      status: 'open',
      createdAt: '2026-08-30T16:00:00.000Z',
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledTimes(1);
    });
    expect(toast.danger).not.toHaveBeenCalled();
  });

  it('shows an error state when the command fails', async () => {
    mutateAsync.mockRejectedValue(new Error('UPSTREAM_UNAVAILABLE'));
    renderPage();
    await userEvent.type(screen.getByRole('textbox', { name: '主题' }), 'Need help');
    await userEvent.type(screen.getByRole('textbox', { name: '说明' }), 'Still broken.');
    await userEvent.click(screen.getByRole('button', { name: '提交请求' }));
    await waitFor(() => {
      expect(toast.danger).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
