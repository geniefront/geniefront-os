import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { LanguageProvider } from '@/LanguageContext';
import { Messages } from './Messages';

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  danger: vi.fn(),
}));

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast };
});

const refetch = vi.fn();
const smsState = {
  data: { messages: [], needsAttention: 0 },
  isLoading: false,
  isError: false,
  error: null as Error | null,
  refetch,
};

vi.mock('@/features/comms/api', () => ({
  useInboundSmsQuery: () => smsState,
  useSendDirectSms: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const tenDlcState = vi.hoisted(() => ({
  status: 'approved' as 'approved' | 'pending_review' | 'not_submitted',
}));

vi.mock('@/features/settings/api', () => ({
  useDeskSettingsQuery: () => ({ data: { tenDlc: { status: tenDlcState.status } } }),
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({
    membershipId: 'mem-1',
    context: { timezone: 'America/Los_Angeles' },
  }),
}));

function renderPage() {
  return render(
    <BrowserRouter>
      <LanguageProvider>
        <Messages />
      </LanguageProvider>
    </BrowserRouter>,
  );
}

describe('Messages refresh copy', () => {
  beforeEach(() => {
    toast.success.mockReset();
    toast.danger.mockReset();
    refetch.mockReset();
    tenDlcState.status = 'approved';
    smsState.isLoading = false;
    smsState.isError = false;
    smsState.error = null;
    refetch.mockResolvedValue({ data: smsState.data, error: null });
  });

  it('says Refreshed after a successful refetch, not stream synced', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /刷新|Refresh/i }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/已刷新|Refreshed/)));
    expect(toast.success.mock.calls.flat().join(' ')).not.toMatch(/synced|stream/i);
  });

  it('does not claim success when refetch fails', async () => {
    refetch.mockResolvedValue({ data: undefined, error: new Error('offline') });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /刷新|Refresh/i }));
    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('Messages 10DLC pending banner', () => {
  it('describes GenieFront internal review, not a carrier filing', () => {
    tenDlcState.status = 'pending_review';
    renderPage();
    expect(document.body.textContent).toMatch(/GenieFront/);
    expect(document.body.textContent).not.toMatch(/filing on your behalf|向运营商代办报备/i);
  });
});

vi.mock('@/features/billing/useEntitlements', () => ({ useEntitlements: () => ({ data: { plan: 'growth' } }) }));
